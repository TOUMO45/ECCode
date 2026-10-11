// API tests for GET /api/paypal/cancel and POST /api/plans/:id/abandon (task e2-payment-flow). Case names start with the criterion id:
//   RS-18  cancelling on PayPal leaves the operation `created` with buyer_cancelled_at and no capture; "Abandon purchase" ends the
//          plan non_executable (PAYMENT_CANCELLED) and every outstanding authorization voided, the reservation released
//   RS-27  the cancel URL with another customer's token is 404 (no state change)
// Runs against the fake adapter and, for the void, against the Sandbox adapter and the loopback stub.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { startPaypalStub } from '../helpers/paypal-stub.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort, sendDueCalls } from '../../src/services/calls.js';
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
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
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

const create = async (client, orderId) => {
  const res = await client.post(`/api/orders/${orderId}/paypal/create`, {});
  assert.equal(res.status, 200, res.text);
  return res.json;
};
const tokenOf = (approvalUrl) => (approvalUrl.includes('token=') ? new URL(approvalUrl).searchParams.get('token') : approvalUrl.split('/').pop());

// Create, approve at the fake page and hit the return URL: the supplier's operation ends `authorized`.
async function authorizeAtFake(client, orderId) {
  const created = await create(client, orderId);
  const approved = await postTo(`${created.approvalUrl}/approve`);
  const target = new URL(approved.location);
  const res = await client.get(target.pathname + target.search);
  assert.equal(res.status, 303, res.text);
  return created;
}

const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const calls = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeTotal = (h) => h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
const planOf = (h, id) => h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(id);
const stockOf = (h, code) => h.db.prepare('SELECT i.on_hand, i.reserved FROM inventory i JOIN suppliers s ON s.id = i.supplier_id WHERE s.code = ?').get(code);

describe('RS-18: the cancel URL', () => {
  test('RS-18: the cancel sets buyer_cancelled_at, leaves the operation `created`, makes no authorize or capture and redirects with paypal=cancelled', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, orders } = await reservedPlan(h, cafe1);
    const created = await create(cafe1, orders[0].id);
    const base = fakeTotal(h);
    h.clock.advance(7000);
    const res = await cafe1.get(`/api/paypal/cancel?token=${tokenOf(created.approvalUrl)}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `/#/requests/${requestId}?paypal=cancelled&order=${orders[0].id}`);
    assert.equal(res.text, '');
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.buyer_cancelled_at, row.cancel_requested_at], ['created', new Date(h.clock.now()).toISOString(), null]);
    assert.equal(fakeTotal(h), base, 'the cancel makes no provider call');
    assert.equal(fakeCalls(h, 'authorize').length + fakeCalls(h, 'capture').length, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind IN ('authorize','capture')").get().n, 0);

    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.equal(view.orders[0].payment.buyerCancelledAt, new Date(h.clock.now()).toISOString());
    assert.equal(view.orders[0].payment.status, 'created');
    assert.equal(planOf(h, view.currentPlanId).status, 'approved', 'cancelling one approval does not end the plan');
  });

  test('RS-18: a cancel after the order moved on (authorized) changes nothing', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const created = await authorizeAtFake(cafe1, orders[0].id);
    const res = await cafe1.get(`/api/paypal/cancel?token=${tokenOf(created.approvalUrl)}`);
    assert.equal(res.status, 303);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.buyer_cancelled_at], ['authorized', null]);
  });

  test('RS-18: abandon after a cancel: the plan is non_executable (PAYMENT_CANCELLED), the other supplier\'s authorization is voided, the reservation released, nothing captured', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    await authorizeAtFake(cafe1, a.id);
    const second = await create(cafe1, b.id);
    await cafe1.get(`/api/paypal/cancel?token=${tokenOf(second.approvalUrl)}`);
    assert.deepEqual([stockOf(h, 'A').reserved, stockOf(h, 'B').reserved], [1, 1]);

    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ['plan', 'requestId', 'rescueStatus']);
    assert.deepEqual([res.json.plan.id, res.json.plan.status, res.json.plan.nonExecutableReason], [plan.id, 'non_executable', 'PAYMENT_CANCELLED']);
    assert.equal(res.json.rescueStatus.status, 'cancelled');
    assert.equal(res.json.rescueStatus.message, 'The purchase was abandoned. No money was taken; re-plan with current stock');
    assert.deepEqual(res.json.rescueStatus.underlying.payments, [{ orderId: a.id, status: 'voided' }, { orderId: b.id, status: 'voided' }]);
    assert.deepEqual(res.json.rescueStatus.underlying.fulfilment, [{ orderId: a.id, status: 'cancelled' }, { orderId: b.id, status: 'cancelled' }]);
    assert.equal(res.json.rescueStatus.underlying.reservation, 'released');

    // A's authorization went through the void protocol, B (never authorized) was voided locally.
    const [voidCall] = calls(h, a.id, 'void');
    assert.deepEqual([voidCall.operation_key, voidCall.status], [`so:${a.id}:void:1`, 'succeeded']);
    assert.equal(fakeCalls(h, 'void').length, 1);
    assert.equal(fakeCalls(h, 'void')[0].request_id, `so:${a.id}:void:1`);
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_authorizations').get().status, 'VOIDED');
    const rowA = op(h, a.id);
    const rowB = op(h, b.id);
    assert.deepEqual([rowA.status, rowA.voided_locally, rowA.cancel_reason, rowA.cancel_requested_at !== null], ['voided', 0, 'PAYMENT_CANCELLED', true]);
    assert.deepEqual([rowB.status, rowB.voided_locally, rowB.cancel_reason], ['voided', 1, 'PAYMENT_CANCELLED']);
    assert.equal(calls(h, b.id, 'void').length, 0, 'no provider void for an operation that never had an authorization');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 0);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(plan.id).status, 'released');
    assert.deepEqual([stockOf(h, 'A').reserved, stockOf(h, 'B').reserved], [0, 0]);
    const ledger = h.db.prepare("SELECT reason FROM inventory_ledger WHERE ref_type = 'reservation' ORDER BY id").all().map((r) => r.reason);
    assert.deepEqual(ledger, ['reserve', 'reserve', 'release', 'release']);
    const audit = h.db.prepare("SELECT outcome FROM audit_events WHERE action = 'void_rule.apply'").all();
    assert.equal(audit.length, 1);

    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.deepEqual(view.orders.map((o) => [o.payment.status, o.presentation, o.payment.cancelRequested]), [['voided', 'cancelled', true], ['voided', 'cancelled', true]]);
    assert.deepEqual(view.orders.map((o) => o.payment.approvalUrl), [null, null]);

    // Later hits on the old links are harmless refreshes.
    const base = fakeTotal(h);
    const late = await cafe1.get(`/api/paypal/return?token=${tokenOf(second.approvalUrl)}&PayerID=FAKEPAYER`);
    assert.equal(late.status, 303);
    assert.equal(fakeTotal(h), base);
    const noPay = await cafe1.post(`/api/orders/${b.id}/paypal/create`, {});
    assert.deepEqual([noPay.status, noPay.json.error.code], [409, 'PLAN_NOT_EXECUTABLE']);
  });

  test('abandon is state-idempotent: a repeat is 200 with the same plan and makes no provider call; a plan that is not approved is 409 INVALID_STATE', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorizeAtFake(cafe1, orders[0].id);
    const first = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    const base = fakeTotal(h);
    const again = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.plan, first.json.plan);
    assert.equal(fakeTotal(h), base);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'void'").get().n, 1);

    for (const [status, reason] of [['proposed', null], ['executing', null], ['executed', null], ['non_executable', 'SUPPLIER_REFUSED'], ['superseded', null]]) {
      h.db.prepare('UPDATE plan_versions SET status = ?, non_executable_reason = ?, supersede_reason = ? WHERE id = ?').run(
        status, status === 'non_executable' ? reason : null, status === 'superseded' ? 'PRICE_CHANGED' : null, plan.id,
      );
      const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
      assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'INVALID_STATE', { from: status, to: 'non_executable' }], status);
    }
    const denied = h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.abandon' AND outcome = 'denied'").get().n;
    assert.equal(denied, 5, 'each refused abandon is audited');
  });

  test('abandon with a queued, never-sent authorize: the call is cancelled and the operation voided locally, so no authorization can appear', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const created = await create(cafe1, orders[0].id);
    const approved = await postTo(`${created.approvalUrl}/approve`);
    h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES ('fake_paypal:crash_after_return_commit', '', 1, '2026-10-20T06:00:00.000Z')").run();
    h.app.deps.killProcess = () => {
      throw new Error('process killed');
    };
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 500);
    assert.equal(op(h, orders[0].id).status, 'approved');

    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    const [call] = calls(h, orders[0].id, 'authorize');
    assert.equal(call.status, 'cancelled');
    assert.deepEqual([op(h, orders[0].id).status, op(h, orders[0].id).voided_locally], ['voided', 1]);
    assert.deepEqual(await sendDueCalls(h.app.deps), []);
    assert.equal(fakeCalls(h, 'authorize').length, 0);
  });

  test('abandon access: a foreign plan is 404, anonymous 401, a supplier 403, a missing CSRF token 403, a malformed id 400', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const cafe2 = await buyer(h, 'cafe2');
    const { plan } = await reservedPlan(h, cafe1);
    const res = await cafe2.post(`/api/plans/${plan.id}/abandon`, {});
    assert.deepEqual([res.status, res.json.error.code], [404, 'NOT_FOUND']);
    assert.equal((await createClient(h.request).post(`/api/plans/${plan.id}/abandon`, {})).status, 401);
    assert.equal((await (await buyer(h, 'supplier-a')).post(`/api/plans/${plan.id}/abandon`, {})).status, 403);
    const noCsrf = await cafe1.send({ method: 'POST', path: `/api/plans/${plan.id}/abandon`, jsonBody: {}, headers: { 'X-CSRF-Token': 'nope' } });
    assert.deepEqual([noCsrf.status, noCsrf.json.error.code], [403, 'CSRF_FAILED']);
    assert.equal((await cafe1.post('/api/plans/abc/abandon', {})).status, 400);
    assert.equal(planOf(h, plan.id).status, 'approved');
  });
});

describe('RS-27: the cancel URL belongs to the buyer', () => {
  test('RS-27: another customer\'s token and an unknown token are 404, nothing changes; anonymous is redirected, a supplier is 403, a bad token is 400', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const cafe2 = await buyer(h, 'cafe2');
    const { orders } = await reservedPlan(h, cafe1);
    const created = await create(cafe1, orders[0].id);
    const token = tokenOf(created.approvalUrl);
    const before = { ...op(h, orders[0].id) };
    const base = fakeTotal(h);

    for (const url of [`/api/paypal/cancel?token=${token}`, '/api/paypal/cancel?token=FAKE-00000000000000000000000000000000']) {
      const res = await cafe2.get(url);
      assert.equal(res.status, 404, res.text);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    }
    assert.deepEqual({ ...op(h, orders[0].id) }, before);
    assert.equal(fakeTotal(h), base);
    const anonymous = await createClient(h.request).get(`/api/paypal/cancel?token=${token}`);
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.location, '/#/signin?notice=paypal-return');
    assert.equal((await (await buyer(h, 'supplier-a')).get(`/api/paypal/cancel?token=${token}`)).status, 403);
    assert.equal((await cafe1.get('/api/paypal/cancel')).status, 400);
    assert.equal((await cafe1.get('/api/paypal/cancel?token=a%2Fb')).status, 400);
    assert.deepEqual({ ...op(h, orders[0].id) }, before);
  });
});

describe('RS-18 against the Sandbox adapter and the loopback stub', () => {
  test('RS-18: abandon voids the authorization at the stub with PayPal-Request-Id so:<id>:void:1, and no capture is ever sent', async () => {
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
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;

    const createdA = await create(cafe1, a.id);
    stub.approve(tokenOf(createdA.approvalUrl));
    const returned = await cafe1.get(`/api/paypal/return?token=${tokenOf(createdA.approvalUrl)}&PayerID=SANDBOXPAYER`);
    assert.equal(returned.status, 303, returned.text);
    assert.equal(op(h, a.id).status, 'authorized');
    assert.equal(stub.callsOf('authorize').length, 1);
    assert.equal(stub.callsOf('authorize')[0].requestId, `so:${a.id}:authorize:1`);

    const createdB = await create(cafe1, b.id);
    const cancelled = await cafe1.get(`/api/paypal/cancel?token=${tokenOf(createdB.approvalUrl)}`);
    assert.equal(cancelled.status, 303);

    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.rescueStatus.status, 'cancelled');
    assert.equal(stub.callsOf('void').length, 1);
    assert.equal(stub.callsOf('void')[0].requestId, `so:${a.id}:void:1`);
    assert.equal(stub.authorization(op(h, a.id).provider_authorization_id).status, 'VOIDED');
    assert.equal(stub.callsOf('capture').length, 0);
    assert.deepEqual([op(h, a.id).status, op(h, b.id).status, op(h, b.id).voided_locally], ['voided', 'voided', 1]);
  });
});
