// API tests for POST /api/orders/:id/paypal/create (task e2-payment-flow). Case names start with the criterion id:
//   RS-19  the amount is supplier_orders.total_cents and the first create queues so:<id>:create_order:1 (call protocol)
//   RS-27  another customer's order is 404 and no provider call is made
//   RS-30  access control of the route
//   the preconditions, state-idempotence, "Try approval again" (A13) and the provider answer classes (rejected, retryable, unknown)
// The RS-04 half of this route is in approve-guards.test.js, RS-19 request bodies in amount-tampering.test.js.
// Runs against the DB-backed fake (its approval listener on a second loopback port) and against the Sandbox adapter talking to the
// loopback stub test/helpers/paypal-stub.js. No real PayPal host is contacted.
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
const harnesses = [];
const stubs = [];
after(async () => {
  for (const h of harnesses) await h.close();
  for (const s of stubs) await s.close();
});

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  harnesses.push(h);
  // The real void port (the app's default is a recorder): voids are queued in provider_calls and sent before the answer.
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
}

async function buyer(h, username = 'cafe1') {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

// A reserved plan: orders A (4000) and B (4400), payment operations `created`.
async function reservedPlan(h, client) {
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(client, DAY);
  const res = await reserve(client, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(res.status, 201, res.text);
  return { requestId, plan, orders: res.json.orders, reservation: res.json.reservation };
}

const create = (client, orderId, body = {}) => client.post(`/api/orders/${orderId}/paypal/create`, body);
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const calls = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);

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

describe('paypal/create against the fake adapter', () => {
  test('RS-19: the first call queues so:<id>:create_order:1, sends it with that PayPal-Request-Id and answers the Payment, the link and the position', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    assert.deepEqual([a.supplier.code, a.totals.totalCents, b.supplier.code, b.totals.totalCents], ['A', 4000, 'B', 4400]);

    const res = await create(cafe1, a.id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ['approvalIndex', 'approvalUrl', 'approvalsNeeded', 'payment', 'requestId']);
    assert.deepEqual([res.json.approvalIndex, res.json.approvalsNeeded], [1, 2]);
    const listener = h.app.payments.listener;
    assert.match(res.json.approvalUrl, new RegExp(`^http://127\\.0\\.0\\.1:${listener.port}/fake-paypal/checkout/FAKE-[0-9a-f]{32}$`));
    const { payment } = res.json;
    assert.deepEqual(
      { ...payment, id: undefined },
      {
        id: undefined, status: 'created', provider: 'fake', simulated: true, sandbox: false, amountCents: 4000, currency: 'USD', merchantMode: 'per-supplier',
        approvalUrl: res.json.approvalUrl, buyerCancelledAt: null, authorizationExpiresAt: null, cancelRequested: false, voidedLocally: false, voidFailed: false, lastErrorCode: null,
      },
    );

    const key = `so:${a.id}:create_order:1`;
    const [row] = calls(h, a.id, 'create_order');
    assert.deepEqual([row.operation_key, row.status, row.attempt, row.send_count, row.error_code], [key, 'succeeded', 1, 1, null]);
    assert.match(row.send_token ?? '', /^$|^[0-9a-f]{32}$/);
    assert.equal(op(h, a.id).provider_order_id, res.json.approvalUrl.split('/').pop());
    const sent = fakeCalls(h, 'create_order');
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].request_id, sent[0].merchant_key, sent[0].replayed], [key, 'A', 0]);
    assert.equal(h.db.prepare('SELECT amount_cents FROM fake_paypal_orders').get().amount_cents, 4000);

    const second = await create(cafe1, b.id);
    assert.equal(second.status, 200, second.text);
    assert.deepEqual([second.json.approvalIndex, second.json.approvalsNeeded, second.json.payment.amountCents], [2, 2, 4400]);
    assert.equal(fakeCalls(h, 'create_order')[1].request_id, `so:${b.id}:create_order:1`);
    assert.equal(fakeCalls(h, 'create_order')[1].merchant_key, 'B');
  });

  test('RS-20: a repeated call returns the stored link with no provider call, also two concurrent clicks', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const first = await create(cafe1, orders[0].id);
    assert.equal(first.status, 200);
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
    const again = await create(cafe1, orders[0].id);
    assert.equal(again.status, 200);
    assert.equal(again.json.approvalUrl, first.json.approvalUrl);
    assert.equal(again.json.payment.id, first.json.payment.id);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, before, 'no provider call, not even a read');

    const fresh = await Promise.all([create(cafe1, orders[1].id), create(cafe1, orders[1].id), create(cafe1, orders[1].id)]);
    assert.deepEqual(fresh.map((r) => r.status), [200, 200, 200], fresh.map((r) => r.text).join('\n'));
    assert.equal(new Set(fresh.map((r) => r.json.approvalUrl)).size, 1);
    assert.equal(fakeCalls(h, 'create_order').filter((c) => c.request_id === `so:${orders[1].id}:create_order:1`).length, 1, 'one effective call');
    assert.equal(calls(h, orders[1].id, 'create_order').length, 1);
  });

  test('RS-27: another customer\'s order, an unknown order and an archived request are 404 with no provider call and no row', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const cafe2 = await buyer(h, 'cafe2');
    const { orders, requestId } = await reservedPlan(h, cafe1);
    for (const id of [orders[0].id, 987654]) {
      const res = await create(cafe2, id);
      assert.equal(res.status, 404, res.text);
      assert.equal(res.json.error.code, 'NOT_FOUND');
      assert.equal(res.json.error.details, undefined);
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls').get().n, 0);
    h.db.prepare("UPDATE rescue_requests SET archived_at = '2026-10-20T06:00:00.000Z' WHERE id = ?").run(requestId);
    assert.equal((await create(cafe1, orders[0].id)).status, 404);
  });

  test('RS-30: anonymous is 401, a supplier 403, a missing CSRF token 403, a malformed id 400, an unparsable body 400', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    assert.equal((await create(createClient(h.request), orders[0].id)).status, 401);
    const supplier = await buyer(h, 'supplier-a');
    const forbidden = await create(supplier, orders[0].id);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, 'FORBIDDEN');
    const noCsrf = await cafe1.send({ method: 'POST', path: `/api/orders/${orders[0].id}/paypal/create`, jsonBody: {}, headers: { 'X-CSRF-Token': 'nope' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.error.code, 'CSRF_FAILED');
    assert.equal((await create(cafe1, 'abc')).status, 400);
    const broken = await cafe1.send({ method: 'POST', path: `/api/orders/${orders[0].id}/paypal/create`, body: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, 'INVALID_JSON');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, 0);
  });

  test('preconditions: superseded and non-executable plans, a plan that is not approved, an expired reservation and an operation that is not `created`', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const order = orders[0];
    const noCalls = () => assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, 0);

    h.db.prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = 'PRICE_CHANGED' WHERE id = ?").run(plan.id);
    let res = await create(cafe1, order.id);
    assert.deepEqual([res.status, res.json.error.code], [409, 'PLAN_SUPERSEDED']);
    h.db.prepare("UPDATE plan_versions SET status = 'non_executable', supersede_reason = NULL, non_executable_reason = 'SUPPLIER_REFUSED' WHERE id = ?").run(plan.id);
    res = await create(cafe1, order.id);
    assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'PLAN_NOT_EXECUTABLE', { reason: 'SUPPLIER_REFUSED' }]);
    for (const status of ['executing', 'executed', 'proposed']) {
      h.db.prepare("UPDATE plan_versions SET status = ?, non_executable_reason = NULL WHERE id = ?").run(status, plan.id);
      res = await create(cafe1, order.id);
      assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'INVALID_STATE', { from: status, to: 'payment' }], status);
    }
    h.db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(plan.id);

    for (const status of ['authorized', 'approved', 'voided']) {
      h.db.prepare('UPDATE payment_operations SET status = ? WHERE supplier_order_id = ?').run(status, order.id);
      res = await create(cafe1, order.id);
      assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'INVALID_STATE', { from: status, to: 'created' }], status);
    }
    h.db.prepare("UPDATE payment_operations SET status = 'created' WHERE supplier_order_id = ?").run(order.id);

    h.clock.advance(31 * 60 * 1000); // past the 30-minute reservation, before any expiry pass
    res = await create(cafe1, order.id);
    assert.deepEqual([res.status, res.json.error.code], [409, 'RESERVATION_EXPIRED']);
    noCalls();
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls').get().n, 0);
    const denied = h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'payment.create' AND outcome = 'denied' ORDER BY id").all().map((r) => JSON.parse(r.detail_json).code);
    assert.ok(denied.includes('PLAN_SUPERSEDED') && denied.includes('RESERVATION_EXPIRED'), 'refusals are audited with the code only');
  });

  test('RS-18: "Try approval again" after a cancel reads the order and, while it is approvable, returns the same link without a new order', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const first = await create(cafe1, orders[0].id);
    const token = first.json.approvalUrl.split('/').pop();
    const cancelled = await cafe1.get(`/api/paypal/cancel?token=${token}`);
    assert.equal(cancelled.status, 303);

    const again = await create(cafe1, orders[0].id);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.approvalUrl, first.json.approvalUrl);
    assert.notEqual(again.json.payment.buyerCancelledAt, null, 'the cancel time stays in history');
    assert.equal(fakeCalls(h, 'create_order').length, 1, 'no new order');
    assert.equal(fakeCalls(h, 'get_order').length, 1, 'one read of the order');
    assert.equal(calls(h, orders[0].id, 'create_order').length, 1);
    assert.equal(op(h, orders[0].id).create_attempt, 1);
  });

  test('RS-18 (A13): when the provider order is no longer approvable a new order is created as attempt 2, and the old token answers 404', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const first = await create(cafe1, orders[0].id);
    const oldToken = first.json.approvalUrl.split('/').pop();
    await cafe1.get(`/api/paypal/cancel?token=${oldToken}`);
    h.db.prepare("UPDATE fake_paypal_orders SET status = 'VOIDED' WHERE id = ?").run(oldToken);

    const again = await create(cafe1, orders[0].id);
    assert.equal(again.status, 200, again.text);
    const newToken = again.json.approvalUrl.split('/').pop();
    assert.notEqual(newToken, oldToken);
    assert.deepEqual(calls(h, orders[0].id, 'create_order').map((c) => [c.operation_key, c.status]), [
      [`so:${orders[0].id}:create_order:1`, 'succeeded'],
      [`so:${orders[0].id}:create_order:2`, 'succeeded'],
    ]);
    assert.equal(op(h, orders[0].id).create_attempt, 2);
    assert.equal(op(h, orders[0].id).provider_order_id, newToken);
    assert.equal(fakeCalls(h, 'create_order').length, 2);

    const stale = await cafe1.get(`/api/paypal/return?token=${oldToken}&PayerID=FAKEPAYER`);
    assert.equal(stale.status, 404, 'the replaced token is unknown now');
    assert.equal(fakeCalls(h, 'authorize').length, 0);
  });

  test('a rejected create (4xx) is 502 PROVIDER_ERROR with the issue code; the next click makes attempt 2', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    arm(h, 'http_400:create_order');
    const res = await create(cafe1, orders[0].id);
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.error.code, 'PROVIDER_ERROR');
    assert.deepEqual(res.json.error.details, { issue: 'INJECTED_BAD_REQUEST' });
    assert.deepEqual(calls(h, orders[0].id, 'create_order').map((c) => [c.operation_key, c.status, c.error_code]), [[`so:${orders[0].id}:create_order:1`, 'failed', 'INJECTED_BAD_REQUEST']]);
    assert.equal(op(h, orders[0].id).last_error_code, 'INJECTED_BAD_REQUEST');
    assert.equal(op(h, orders[0].id).status, 'created');

    const retry = await create(cafe1, orders[0].id);
    assert.equal(retry.status, 200, retry.text);
    assert.deepEqual(calls(h, orders[0].id, 'create_order').map((c) => [c.attempt, c.status]), [[1, 'failed'], [2, 'succeeded']]);
    assert.equal(op(h, orders[0].id).last_error_code, null);
  });

  test('a retryable answer (429) is 503 PROVIDER_UNAVAILABLE and the call goes back to queued with a 5 s back-off; the next click sends it', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    arm(h, 'http_429:create_order');
    const res = await create(cafe1, orders[0].id);
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'PROVIDER_UNAVAILABLE');
    const [queued] = calls(h, orders[0].id, 'create_order');
    assert.deepEqual([queued.status, queued.started_at, queued.send_token, queued.send_count], ['intent', null, null, 1]);
    assert.equal(queued.next_attempt_at, new Date(h.clock.now() + 5000).toISOString());
    assert.equal(op(h, orders[0].id).status, 'created');

    const ok = await create(cafe1, orders[0].id);
    assert.equal(ok.status, 200, ok.text);
    const [sent] = calls(h, orders[0].id, 'create_order');
    assert.deepEqual([sent.operation_key, sent.status, sent.send_count], [`so:${orders[0].id}:create_order:1`, 'succeeded', 2]);
    assert.equal(fakeCalls(h, 'create_order').length, 2, 'the fake counts the throttled attempt too');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 1, 'but it applied nothing: one order');
    assert.deepEqual(fakeCalls(h, 'create_order').map((c) => c.request_id), [`so:${orders[0].id}:create_order:1`, `so:${orders[0].id}:create_order:1`]);
  });

  test('an unknown outcome (lost response) is 503; the next click re-sends the same key and the fake replays the stored order', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    arm(h, 'lost_response:create_order');
    const res = await create(cafe1, orders[0].id);
    assert.equal(res.status, 503, res.text);
    const [lost] = calls(h, orders[0].id, 'create_order');
    assert.deepEqual([lost.status, lost.send_token, lost.error_code], ['unknown', null, 'NETWORK']);
    assert.notEqual(lost.unknown_since, null);
    assert.equal(op(h, orders[0].id).status, 'created', 'the payment machine has no created -> unknown edge');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 1, 'the effect was applied');

    const ok = await create(cafe1, orders[0].id);
    assert.equal(ok.status, 200, ok.text);
    const rows = fakeCalls(h, 'create_order');
    assert.deepEqual(rows.map((r) => [r.request_id, r.replayed]), [[`so:${orders[0].id}:create_order:1`, 0], [`so:${orders[0].id}:create_order:1`, 1]]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 1, 'still one order');
    const [done] = calls(h, orders[0].id, 'create_order');
    assert.deepEqual([done.status, done.send_count], ['succeeded', 2]);
    assert.equal(op(h, orders[0].id).provider_order_id, ok.json.approvalUrl.split('/').pop());
  });

  test('RS-34: the Payment says fake and simulated, never sandbox, and the order view carries the same labels', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders, requestId } = await reservedPlan(h, cafe1);
    await create(cafe1, orders[0].id);
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    const payments = view.orders.map((o) => o.payment);
    assert.deepEqual(payments.map((p) => [p.status, p.provider, p.simulated, p.sandbox, p.merchantMode]), [
      ['created', 'fake', true, false, 'per-supplier'],
      ['created', 'fake', true, false, 'per-supplier'],
    ]);
    assert.match(payments[0].approvalUrl, /^http:\/\/127\.0\.0\.1:\d+\/fake-paypal\/checkout\/FAKE-/);
    assert.equal(payments[1].approvalUrl, null, 'no link before the first create call');
  });
});

describe('paypal/create against the Sandbox adapter and the loopback stub', () => {
  test('RS-19: the Sandbox adapter creates the order at the stub; the link is the stub\'s approval page; the Payment is labelled sandbox, single-credential', async () => {
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
    assert.equal(h.app.payments.listener, null, 'the Sandbox adapter has no approval listener');
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    assert.equal(op(h, orders[0].id).provider, 'paypal-sandbox');
    assert.equal(op(h, orders[0].id).merchant_key, 'DEFAULT');

    const res = await create(cafe1, orders[0].id);
    assert.equal(res.status, 200, res.text);
    const call = stub.callsOf('create_order')[0];
    assert.equal(stub.callsOf('create_order').length, 1);
    assert.equal(res.json.approvalUrl, stub.approvalUrl(JSON.parse(call.responseBody).id));
    assert.match(res.json.approvalUrl, /^http:\/\/127\.0\.0\.1:\d+\/checkoutnow\?token=/);
    assert.deepEqual(
      { ...res.json.payment, id: undefined, approvalUrl: undefined },
      {
        id: undefined, status: 'created', provider: 'paypal-sandbox', simulated: false, sandbox: true, amountCents: 4000, currency: 'USD', merchantMode: 'single-credential',
        approvalUrl: undefined, buyerCancelledAt: null, authorizationExpiresAt: null, cancelRequested: false, voidedLocally: false, voidFailed: false, lastErrorCode: null,
      },
    );
    assert.equal(call.requestId, `so:${orders[0].id}:create_order:1`);
    assert.equal(call.body.purchase_units[0].amount.value, '40.00');
    assert.equal(stub.callsOf('capture').length, 0);

    const again = await create(cafe1, orders[0].id);
    assert.equal(again.json.approvalUrl, res.json.approvalUrl);
    assert.equal(stub.callsOf('create_order').length, 1, 'state-idempotent: no second order');
  });
});

describe('POST /api/orders/:id/receipt and the order presentation (F-TR-11)', () => {
  // The execute saga is a later task; the executed plan and the ready order are put in place with SQL.
  async function readyOrder(h, cafe1) {
    const flow = await reservedPlan(h, cafe1);
    h.db.prepare("UPDATE plan_versions SET status = 'executed' WHERE id = ?").run(flow.plan.id);
    h.db.prepare("UPDATE reservations SET status = 'consumed' WHERE plan_version_id = ?").run(flow.plan.id);
    h.db.prepare("UPDATE payment_operations SET status = 'captured' WHERE supplier_order_id IN (SELECT id FROM supplier_orders WHERE plan_version_id = ?)").run(flow.plan.id);
    h.db.prepare("UPDATE supplier_orders SET fulfilment_status = 'ready', confirmed_at = '2026-10-20T06:05:00.000Z', committed_qty_json = '[{\"offerId\":1,\"committedBundles\":1}]', committed_ready_at = '2026-10-20T07:00:00.000Z' WHERE plan_version_id = ?").run(flow.plan.id);
    return flow;
  }

  test('the buyer records the receipt of a ready order: 200 {order} with receiptRecorded, a repeat is 200 unchanged, one row, the order is still the buyer\'s', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await readyOrder(h, cafe1);
    const first = await cafe1.post(`/api/orders/${orders[0].id}/receipt`, {});
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(Object.keys(first.json).sort(), ['order', 'requestId']);
    assert.deepEqual([first.json.order.id, first.json.order.receiptRecorded, first.json.order.handoverRecorded, first.json.order.fulfilmentStatus], [orders[0].id, true, false, 'ready']);
    assert.equal(first.json.order.pickup.address, h.db.prepare("SELECT pickup_address FROM suppliers WHERE code = 'A'").get().pickup_address, 'the pickup address is shown once the plan is executed');
    assert.equal(first.json.order.payment.status, 'captured');
    assert.equal(first.json.order.presentation, 'active');
    const again = await cafe1.post(`/api/orders/${orders[0].id}/receipt`, {});
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.order, first.json.order);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM pickup_confirmations WHERE kind = 'receipt'").get().n, 1);
    assert.equal(h.db.prepare("SELECT by_user FROM pickup_confirmations WHERE kind = 'receipt'").get().by_user, cafe1.user.id);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.receipt' AND outcome = 'ok'").get().n, 1);

    h.db.prepare("UPDATE supplier_orders SET fulfilment_status = 'collected' WHERE id = ?").run(orders[0].id);
    const collected = await cafe1.post(`/api/orders/${orders[0].id}/receipt`, {});
    assert.equal(collected.status, 200);
    assert.equal(collected.json.order.fulfilmentStatus, 'collected');
  });

  test('a receipt before the order is ready is 409 INVALID_STATE (audited), and writes nothing', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    for (const status of ['awaiting_supplier', 'confirmed', 'cancelled', 'refused']) {
      h.db.prepare('UPDATE supplier_orders SET fulfilment_status = ? WHERE id = ?').run(status, orders[0].id);
      const res = await cafe1.post(`/api/orders/${orders[0].id}/receipt`, {});
      assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'INVALID_STATE', { from: status, to: 'receipt' }], status);
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM pickup_confirmations').get().n, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.receipt' AND outcome = 'denied'").get().n, 4);
  });

  test('F-TR-11: an order of a non_executable plan whose fulfilment is still confirmed reads cancelled_payment_incomplete for the buyer and the supplier, with every can* flag false', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    h.db.prepare("UPDATE supplier_orders SET fulfilment_status = 'confirmed', confirmed_at = '2026-10-20T06:05:00.000Z', committed_qty_json = '[{\"offerId\":1,\"committedBundles\":1}]', committed_ready_at = '2026-10-20T07:00:00.000Z' WHERE plan_version_id = ?").run(plan.id);
    const supplier = await buyer(h, 'supplier-a');
    const live = (await supplier.get('/api/supplier/orders')).json.orders[0];
    assert.deepEqual([live.presentation, live.canConfirm, live.canMarkReady, live.canHandover], ['active', false, false, false], 'confirmed but not executed: only the saga unlocks ready');

    h.db.prepare("UPDATE plan_versions SET status = 'non_executable', non_executable_reason = 'AUTHORIZATION_EXPIRED' WHERE id = ?").run(plan.id);
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.deepEqual(view.orders.map((o) => [o.fulfilmentStatus, o.presentation]), [['confirmed', 'cancelled_payment_incomplete'], ['confirmed', 'cancelled_payment_incomplete']]);
    const cancelled = (await supplier.get('/api/supplier/orders')).json.orders[0];
    assert.deepEqual([cancelled.presentation, cancelled.canConfirm, cancelled.canMarkReady, cancelled.canHandover], ['cancelled_payment_incomplete', false, false, false]);
    assert.equal(orders.length, 2);
  });
});
