// RS-19 / threat T5: a client-supplied amount, currency, supplier or merchant on any payment route is ignored; the PayPal order amount
// equals the server-approved supplier-order total (supplier_orders.total_cents). Runs against the fake adapter (the stored order)
// and against the Sandbox adapter and the loopback stub (the exact request body the provider received).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { startPaypalStub } from '../helpers/paypal-stub.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const TAMPERED = Object.freeze({
  amountCents: 1, amount: 1, amount_cents: 1, value: '0.01', totalCents: 1, total_cents: 1, expectedTotalCents: 1,
  currency: 'EUR', currency_code: 'EUR', supplierCode: 'E', supplier: 'E', merchantKey: 'E', merchant_key: 'E', supplierOrderId: 999, orderId: 'FAKE-0',
  providerOrderId: 'HIJACKED', createAttempt: 9, status: 'authorized', returnUrl: 'https://evil.example/r', cancelUrl: 'https://evil.example/c',
  approvalUrl: 'https://evil.example/approve', requestId: 'so:1:capture:1', invoiceId: 'evil', items: [{ amountCents: 1 }],
});
const harnesses = [];
const stubs = [];
after(async () => {
  for (const h of harnesses) await h.close();
  for (const s of stubs) await s.close();
});

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  harnesses.push(h);
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
}

async function startSandbox() {
  const stub = await startPaypalStub();
  stubs.push(stub);
  const h = await start({
    RS_PAYMENT_PROVIDER: 'paypal-sandbox',
    RS_PAYPAL_BASE_URL: stub.baseUrl,
    RS_PAYPAL_DEFAULT_CLIENT_ID: stub.merchants.DEFAULT.clientId,
    RS_PAYPAL_DEFAULT_CLIENT_SECRET: stub.merchants.DEFAULT.clientSecret,
    RS_PAYPAL_DEFAULT_WEBHOOK_ID: stub.merchants.DEFAULT.webhookId,
  });
  stub.appOrigin = `http://localhost:${h.port}`;
  return { h, stub };
}

async function buyer(h, username = 'cafe1') {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function reservedPlan(h, client) {
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(client, DAY);
  const res = await reserve(client, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(res.status, 201, res.text);
  return { requestId, plan, orders: res.json.orders };
}

function postTo(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}

const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const totalOf = (h, orderId) => h.db.prepare('SELECT total_cents FROM supplier_orders WHERE id = ?').get(orderId).total_cents;
const tokenOf = (approvalUrl) => (approvalUrl.includes('token=') ? new URL(approvalUrl).searchParams.get('token') : approvalUrl.split('/').pop());

describe('RS-19 against the fake adapter', () => {
  test('RS-19: every tampered field in the body of paypal/create is ignored: the fake order has the supplier-order total, USD, the order\'s own merchant and the server\'s URLs', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    const res = await cafe1.post(`/api/orders/${a.id}/paypal/create`, { ...TAMPERED });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.payment.amountCents, totalOf(h, a.id));
    assert.equal(res.json.payment.currency, 'USD');
    const fake = h.db.prepare('SELECT * FROM fake_paypal_orders').all();
    assert.equal(fake.length, 1);
    assert.deepEqual(
      { amount_cents: fake[0].amount_cents, currency: fake[0].currency, merchant_key: fake[0].merchant_key, return_url: fake[0].return_url, cancel_url: fake[0].cancel_url },
      { amount_cents: 4000, currency: 'USD', merchant_key: 'A', return_url: `http://localhost:${h.port}/api/paypal/return`, cancel_url: `http://localhost:${h.port}/api/paypal/cancel` },
    );
    const row = op(h, a.id);
    assert.deepEqual([row.provider_order_id, row.create_attempt, row.status, row.merchant_key], [tokenOf(res.json.approvalUrl), 1, 'created', 'A']);
    assert.equal(h.db.prepare('SELECT request_id FROM fake_paypal_calls WHERE kind = ?').get('create_order').request_id, `so:${a.id}:create_order:1`);
    assert.equal(op(h, b.id).provider_order_id, null, 'the other order was not touched by supplierOrderId / orderId in the body');

    const other = await cafe1.post(`/api/orders/${b.id}/paypal/create`, { ...TAMPERED, amountCents: 4000, supplierOrderId: a.id });
    assert.equal(other.status, 200);
    assert.deepEqual([other.json.payment.amountCents, other.json.approvalIndex], [4400, 2]);
    assert.equal(h.db.prepare("SELECT amount_cents FROM fake_paypal_orders WHERE merchant_key = 'B'").get().amount_cents, 4400);
  });

  test('RS-19: the amount comes from supplier_orders.total_cents even when the operation row disagrees, also for attempt 2', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const [a] = orders;
    h.db.prepare('UPDATE payment_operations SET amount_cents = 1 WHERE supplier_order_id = ?').run(a.id);
    const first = await cafe1.post(`/api/orders/${a.id}/paypal/create`, {});
    assert.equal(first.status, 200, first.text);
    assert.equal(h.db.prepare('SELECT amount_cents FROM fake_paypal_orders').get().amount_cents, totalOf(h, a.id));

    const oldToken = tokenOf(first.json.approvalUrl);
    await cafe1.get(`/api/paypal/cancel?token=${oldToken}`);
    h.db.prepare("UPDATE fake_paypal_orders SET status = 'VOIDED' WHERE id = ?").run(oldToken);
    h.db.prepare('UPDATE payment_operations SET amount_cents = 2 WHERE supplier_order_id = ?').run(a.id);
    const second = await cafe1.post(`/api/orders/${a.id}/paypal/create`, { amountCents: 3 });
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(h.db.prepare('SELECT amount_cents FROM fake_paypal_orders ORDER BY created_at, rowid').all().map((r) => r.amount_cents), [4000, 4000]);
  });

  test('RS-19: tampering on the other payment routes changes nothing: abandon, receipt, return and cancel ignore the body and the extra query', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const created = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    const token = tokenOf(created.json.approvalUrl);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    assert.equal(approved.status, 303);

    const early = await cafe1.get(`/api/paypal/cancel?token=${token}&amount=1&currency=EUR&supplier=E&status=authorized`);
    assert.equal(early.status, 303);
    assert.equal(early.headers.location, `/#/requests/${requestId}?paypal=cancelled&order=${orders[0].id}`);
    assert.equal(op(h, orders[0].id).status, 'created');

    const returned = await cafe1.get(`/api/paypal/return?token=${token}&PayerID=FAKEPAYER&amount=1&currency=EUR&status=captured&order=999`);
    assert.equal(returned.status, 303);
    assert.equal(returned.headers.location, `/#/requests/${requestId}?paypal=returned&order=${orders[0].id}`, 'the order id in the redirect is the server\'s');
    const row = op(h, orders[0].id);
    assert.equal(row.status, 'authorized');
    assert.equal(row.amount_cents, 4000);
    assert.equal(h.db.prepare('SELECT amount_cents FROM fake_paypal_authorizations').get().amount_cents, 4000);

    const receipt = await cafe1.post(`/api/orders/${orders[0].id}/receipt`, { ...TAMPERED });
    assert.equal(receipt.status, 409, 'not ready: INVALID_STATE regardless of the body');
    assert.equal(receipt.json.error.code, 'INVALID_STATE');
    const abandon = await cafe1.post(`/api/plans/${plan.id}/abandon`, { ...TAMPERED, reason: 'PAYMENT_CANCELLED' });
    assert.equal(abandon.status, 200, abandon.text);
    assert.equal(abandon.json.plan.nonExecutableReason, 'PAYMENT_CANCELLED');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 0);
  });

  test('RS-19: a body that is not an object, is invalid JSON or is too large is refused with a 4xx and creates nothing', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const path = `/api/orders/${orders[0].id}/paypal/create`;
    const send = (body) => cafe1.send({ method: 'POST', path, body, headers: { 'Content-Type': 'application/json' } });
    const cases = [['[1,2]', 422], ['"amount"', 422], ['null', 422], ['{broken', 400], [JSON.stringify({ pad: 'x'.repeat(70_000) }), 413]];
    for (const [body, status] of cases) {
      const res = await send(body);
      assert.equal(res.status, status, `${body.slice(0, 20)}: ${res.text.slice(0, 120)}`);
      assert.ok(res.json?.error?.code, 'an error envelope, never a stack');
      assert.equal(res.json.error.stack, undefined);
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls').get().n, 0);
  });
});

describe('RS-19 against the Sandbox adapter and the loopback stub: the request body the provider receives', () => {
  test('RS-19: create_order carries the supplier-order total, USD, the server\'s URLs and the deterministic request id, whatever the client sent', async () => {
    const { h, stub } = await startSandbox();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;

    const res = await cafe1.post(`/api/orders/${a.id}/paypal/create`, { ...TAMPERED });
    assert.equal(res.status, 200, res.text);
    const [call] = stub.callsOf('create_order');
    assert.equal(call.requestId, `so:${a.id}:create_order:1`);
    assert.equal(call.headers['paypal-request-id'], `so:${a.id}:create_order:1`);
    assert.equal(call.merchantKey, 'DEFAULT');
    assert.deepEqual(call.body, {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: `so-${a.id}`, custom_id: `so-${a.id}`, invoice_id: `rs-so-${a.id}-a1`, description: 'RescueStock demo order (Sandbox)',
        amount: { currency_code: 'USD', value: '40.00' },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `http://localhost:${h.port}/api/paypal/return`, cancel_url: `http://localhost:${h.port}/api/paypal/cancel`,
            user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'RescueStock Sandbox Demo',
          },
        },
      },
    });
    assert.equal(JSON.stringify(call.body).includes('evil.example'), false);
    assert.equal(JSON.stringify(call.body).includes('0.01'), false);

    const second = await cafe1.post(`/api/orders/${b.id}/paypal/create`, { amountCents: 1, currency: 'JPY', supplierCode: 'A' });
    assert.equal(second.status, 200, second.text);
    const bodyB = stub.callsOf('create_order')[1].body;
    assert.deepEqual(bodyB.purchase_units[0].amount, { currency_code: 'USD', value: '44.00' });
    assert.equal(bodyB.purchase_units[0].reference_id, `so-${b.id}`);
    assert.equal(stub.order(tokenOf(second.json.approvalUrl)).amountCents, 4400);
  });

  test('RS-19: the authorize and void requests carry no amount, and nothing is ever captured; the stored authorization amount is the order total', async () => {
    const { h, stub } = await startSandbox();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const created = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    const token = tokenOf(created.json.approvalUrl);
    stub.approve(token);
    const returned = await cafe1.get(`/api/paypal/return?token=${token}&PayerID=PAYER&amount=1`);
    assert.equal(returned.status, 303);
    const [authorize] = stub.callsOf('authorize');
    assert.equal(authorize.requestId, `so:${orders[0].id}:authorize:1`);
    assert.ok(authorize.rawBody === '' || authorize.rawBody === '{}', 'the authorize body is empty');
    const authId = op(h, orders[0].id).provider_authorization_id;
    assert.equal(stub.authorization(authId).amountCents, 4000);

    const abandoned = await cafe1.post(`/api/plans/${plan.id}/abandon`, { amountCents: 1 });
    assert.equal(abandoned.status, 200, abandoned.text);
    const [voided] = stub.callsOf('void');
    assert.equal(voided.requestId, `so:${orders[0].id}:void:1`);
    assert.ok(voided.rawBody === '' || voided.rawBody === '{}', 'the void body is empty');
    assert.equal(stub.callsOf('capture').length, 0);
    assert.equal(JSON.stringify(stub.calls.map((c) => c.rawBody)).includes('PAYER'), false, 'the payer id from the query is never sent anywhere');
  });

  test('RS-19: attempt 2 (A13) sends the same total with the next key', async () => {
    const { h, stub } = await startSandbox();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    h.db.prepare('UPDATE payment_operations SET amount_cents = 5 WHERE supplier_order_id = ?').run(orders[0].id);
    const first = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    const token = tokenOf(first.json.approvalUrl);
    await cafe1.get(`/api/paypal/cancel?token=${token}`);
    // the stub's order can no longer be approved: the buyer cancelled and the link expired at the provider
    stub.order(token); // the order exists
    const read = stub.callsOf('get_order').length;
    const approved = stub.order(token).status;
    assert.equal(approved, 'CREATED');
    // The provider forgets the order (a stub fault on the read): the adapter answers rejected 404, which is "not approvable".
    stub.fault('http_404:get_order');
    const second = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, { amountCents: 2 });
    assert.equal(second.status, 200, second.text);
    assert.equal(stub.callsOf('get_order').length, read + 1);
    const created = stub.callsOf('create_order');
    assert.deepEqual(created.map((c) => c.requestId), [`so:${orders[0].id}:create_order:1`, `so:${orders[0].id}:create_order:2`]);
    assert.deepEqual(created.map((c) => c.body.purchase_units[0].amount.value), ['40.00', '40.00']);
    assert.notEqual(tokenOf(second.json.approvalUrl), token);
  });
});
