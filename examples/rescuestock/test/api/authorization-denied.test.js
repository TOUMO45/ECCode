// API tests for the authorization results and the void rule on provider authorizations (task e2-payment-flow). Case names start
// with the criterion id:
//   RS-21  one supplier's authorization is DENIED: the plan is non_executable (AUTHORIZATION_FAILED, naming the supplier), every other
//          authorization ends voided, the reservation is released, no capture, and the buyer reads the exact sentence
//   RS-18  (void half) abandon voids authorizations; void results: ok -> voided, rejected -> read the authorization
//   ARCH-22 the resolution hook: an authorize in flight when the cancellation arrives is voided as soon as it is authorized
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort, sendDueCalls } from '../../src/services/calls.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const DECLINED = (supplier) =>
  `PayPal declined the payment for ${supplier}. No money was taken; other authorizations were voided. Re-plan or try another PayPal account`;
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
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

// create + the buyer approves at the fake page; returns the path of the return URL (not yet requested)
async function approvedPath(client, orderId) {
  const created = await client.post(`/api/orders/${orderId}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(`${created.json.approvalUrl}/approve`);
  const target = new URL(approved.location);
  return target.pathname + target.search;
}

async function authorize(client, orderId) {
  const res = await client.get(await approvedPath(client, orderId));
  assert.equal(res.status, 303, res.text);
}

const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const calls = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const planOf = (h, id) => h.db.prepare('SELECT status, non_executable_reason, reason_detail_json FROM plan_versions WHERE id = ?').get(id);
const reservationOf = (h, planId) => h.db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(planId).status;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const noCaptures = (h) => {
  assert.equal(fakeCalls(h, 'capture').length, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 0);
};

describe('RS-21: a DENIED authorization', () => {
  test('RS-21: B is DENIED after A was authorized: plan non_executable (AUTHORIZATION_FAILED, supplier B), A voided at the provider, reservation released, the exact buyer message', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    await authorize(cafe1, a.id);
    const pathB = await approvedPath(cafe1, b.id);
    arm(h, 'authorize_denied', { value: 'B' });

    const res = await cafe1.get(pathB);
    assert.equal(res.status, 303, res.text);
    assert.equal(res.headers.location, `/#/requests/${requestId}?paypal=returned&order=${b.id}`);

    const rowB = op(h, b.id);
    assert.deepEqual([rowB.status, rowB.last_error_code, rowB.provider_authorization_id], ['authorization_failed', 'AUTHORIZATION_DENIED', null]);
    const failed = planOf(h, plan.id);
    assert.deepEqual([failed.status, failed.non_executable_reason, JSON.parse(failed.reason_detail_json)], ['non_executable', 'AUTHORIZATION_FAILED', { supplierCode: 'B' }]);
    const rowA = op(h, a.id);
    assert.deepEqual([rowA.status, rowA.cancel_reason], ['voided', 'AUTHORIZATION_FAILED']);
    assert.equal(h.db.prepare("SELECT status FROM fake_paypal_authorizations WHERE id = ?").get(rowA.provider_authorization_id).status, 'VOIDED');
    assert.deepEqual(fakeCalls(h, 'void').map((c) => c.request_id), [`so:${a.id}:void:1`]);
    assert.equal(reservationOf(h, plan.id), 'released');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM supplier_orders WHERE plan_version_id = ? AND fulfilment_status = 'cancelled'").get(plan.id).n, 2);
    noCaptures(h);

    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.equal(view.rescueStatus.message, DECLINED('Supplier B'));
    assert.equal(view.rescueStatus.nextStep.code, 'REPLAN_OR_OTHER_ACCOUNT');
    assert.equal(view.rescueStatus.nextStep.text, 'Re-plan or try another PayPal account');
    assert.deepEqual(view.orders.map((o) => o.payment.status), ['voided', 'authorization_failed']);
    assert.equal(view.plans[0].nonExecutableReason, 'AUTHORIZATION_FAILED');
    assert.equal(h.db.prepare("SELECT outcome FROM audit_events WHERE action = 'plan.non_executable' AND entity_id = ?").get(plan.id).outcome, 'ok');

    // The buyer cannot start another approval on a plan that can no longer be executed.
    const again = await cafe1.post(`/api/orders/${a.id}/paypal/create`, {});
    assert.deepEqual([again.status, again.json.error.code, again.json.error.details], [409, 'PLAN_NOT_EXECUTABLE', { reason: 'AUTHORIZATION_FAILED' }]);
  });

  test('RS-21: A is still `created` when B is DENIED: A is voided locally with no provider call, nothing is captured, the same message', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    const pathB = await approvedPath(cafe1, b.id);
    arm(h, 'authorize_denied', { value: 'B' });
    assert.equal((await cafe1.get(pathB)).status, 303);

    const rowA = op(h, a.id);
    assert.deepEqual([rowA.status, rowA.voided_locally], ['voided', 1]);
    assert.equal(calls(h, a.id, 'void').length, 0);
    assert.equal(fakeCalls(h, 'void').length, 0);
    assert.equal(reservationOf(h, plan.id), 'released');
    noCaptures(h);
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.equal(view.rescueStatus.message, DECLINED('Supplier B'));
    assert.equal(planOf(h, plan.id).non_executable_reason, 'AUTHORIZATION_FAILED');
  });

  test('RS-21: a definitive rejection of the authorize (4xx) is handled like DENIED and stores the issue code', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const path = await approvedPath(cafe1, orders[0].id);
    arm(h, 'http_422:authorize');
    assert.equal((await cafe1.get(path)).status, 303);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.last_error_code], ['authorization_failed', 'INJECTED_UNPROCESSABLE']);
    assert.deepEqual([planOf(h, plan.id).status, planOf(h, plan.id).non_executable_reason], ['non_executable', 'AUTHORIZATION_FAILED']);
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.equal(view.rescueStatus.message, DECLINED('Supplier A'));
    noCaptures(h);
  });
});

describe('ARCH-22: the void rule on provider authorizations', () => {
  test('resolution hook: an authorize in flight when the plan is abandoned is voided the moment it is authorized (exactly one void call)', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const path = await approvedPath(cafe1, orders[0].id);

    const real = h.app.deps.payments;
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inFlight = new Promise((resolve) => { entered = resolve; });
    // (the adapter object is frozen, so a Proxy cannot wrap it; its methods are closures, so a copy with one method replaced works)
    h.app.deps.payments = {
      ...real,
      async authorizeOrder(args) {
        entered();
        await gate;
        return real.authorizeOrder(args);
      },
    };

    const returning = cafe1.get(path);
    let row;
    try {
      await inFlight;
      const [started] = calls(h, orders[0].id, 'authorize');
      assert.notEqual(started.started_at, null, 'the authorize is on the wire');
      const abandon = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
      assert.equal(abandon.status, 200, abandon.text);
      row = op(h, orders[0].id);
      assert.deepEqual([row.status, row.voided_locally, row.cancel_reason], ['approved', 0, 'PAYMENT_CANCELLED'], 'a started authorize is only marked');
      assert.equal(calls(h, orders[0].id, 'void').length, 0);
    } finally {
      release(); // never leave the request hanging: the harness cannot close while it is open
    }
    const res = await returning;
    assert.equal(res.status, 303, res.text);
    row = op(h, orders[0].id);
    assert.equal(row.status, 'voided', 'authorized and voided in turn');
    assert.deepEqual(calls(h, orders[0].id, 'void').map((c) => [c.operation_key, c.status]), [[`so:${orders[0].id}:void:1`, 'succeeded']]);
    assert.equal(fakeCalls(h, 'void').length, 1);
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_authorizations').get().status, 'VOIDED');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'void_rule.resolution_hook'").get().n, 1);
    noCaptures(h);
  });

  test('void result ok -> voided; the void call is exactly so:<id>:void:1 with that PayPal-Request-Id, and a second pass sends nothing', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(op(h, orders[0].id).status, 'voided');
    assert.deepEqual(await sendDueCalls(h.app.deps), []);
    assert.equal(fakeCalls(h, 'void').length, 1);
  });

  test('void result rejected -> the authorization is read; still CREATED keeps `authorized` with void_failed = 1 (escalates through derivation row 2)', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    arm(h, 'void_fail');
    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.void_failed, row.last_error_code, row.cancel_requested_at !== null], ['authorized', 1, 'VOID_REJECTED', true]);
    const [voidCall] = calls(h, orders[0].id, 'void');
    assert.deepEqual([voidCall.status, voidCall.error_code], ['failed', 'AUTHORIZATION_CANNOT_BE_VOIDED']);
    assert.equal(fakeCalls(h, 'get_authorization').length, 1, 'the authorization was read after the rejection');
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.deepEqual([view.orders[0].payment.status, view.orders[0].payment.voidFailed, view.orders[0].payment.cancelRequested], ['authorized', true, true]);
    assert.deepEqual(await sendDueCalls(h.app.deps), [], 'a failed void is not retried blindly');
  });

  test('void result rejected, but the provider shows VOIDED already -> voided', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'VOIDED'").run(); // voided elsewhere (the Sandbox dashboard, a webhook)
    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.void_failed], ['voided', 0]);
    assert.equal(calls(h, orders[0].id, 'void')[0].status, 'failed');
  });

  test('F-TR-6: a capture lands before the void: rejected void, the authorization reads CAPTURED, the operation becomes captured and is refunded (one capture, one void, one refund)', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    arm(h, 'capture_lands_after_void_intent');
    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    const row = op(h, orders[0].id);
    assert.equal(row.status, 'refunded');
    assert.match(row.provider_capture_id, /^FAKECAP-/);
    assert.match(row.provider_refund_id, /^FAKEREF-|^FAKE/);
    assert.deepEqual(calls(h, orders[0].id, 'void').map((c) => [c.operation_key, c.status, c.error_code]), [[`so:${orders[0].id}:void:1`, 'failed', 'AUTHORIZATION_ALREADY_CAPTURED']]);
    assert.deepEqual(calls(h, orders[0].id, 'refund').map((c) => [c.operation_key, c.status]), [[`so:${orders[0].id}:refund:1`, 'succeeded']]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1);
    assert.equal(fakeCalls(h, 'void').length, 1);
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal(fakeCalls(h, 'refund')[0].request_id, `so:${orders[0].id}:refund:1`);
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_captures').get().status, 'REFUNDED');
  });

  test('void result retryable (429) -> queued with a back-off; sendDueCalls sends it when due and the operation is voided', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    arm(h, 'http_429:void');
    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    let row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.cancel_requested_at !== null], ['authorized', true]);
    const [queued] = calls(h, orders[0].id, 'void');
    assert.deepEqual([queued.status, queued.started_at, queued.send_count], ['intent', null, 1]);
    assert.equal(queued.next_attempt_at, new Date(h.clock.now() + 5000).toISOString());

    assert.deepEqual(await sendDueCalls(h.app.deps), []);
    h.clock.advance(5000);
    const sent = await sendDueCalls(h.app.deps);
    assert.deepEqual(sent.map((s) => s.state), ['recorded']);
    row = op(h, orders[0].id);
    assert.equal(row.status, 'voided');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_authorizations WHERE status = 'VOIDED'").get().n, 1);
    assert.equal(calls(h, orders[0].id, 'void').length, 1, 'still one void call');
  });

  test('void result unknown (lost response) -> the call and the operation are unknown (prev_status authorized); nothing is re-sent before it is resolved', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    arm(h, 'lost_response:void');
    const res = await cafe1.post(`/api/plans/${plan.id}/abandon`, {});
    assert.equal(res.status, 200, res.text);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.prev_status], ['unknown', 'authorized']);
    assert.notEqual(row.unknown_since, null);
    const [call] = calls(h, orders[0].id, 'void');
    assert.deepEqual([call.status, call.send_token], ['unknown', null]);
    assert.deepEqual(await sendDueCalls(h.app.deps), []);
    assert.equal(fakeCalls(h, 'void').length, 1);
  });

  test('a void queued for an operation that is already voided is cancelled, not sent', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    await authorize(cafe1, orders[0].id);
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'VOIDED'").run();
    h.app.deps.voidRule.provider.queued.length = 0;
    // Queue the void, then let a webhook-like writer settle the operation before the sender runs.
    h.db.tx(() => {
      h.app.deps.voidRule.provider.queueVoid(h.db, {
        operationId: op(h, orders[0].id).id, supplierOrderId: orders[0].id, kind: 'void', attempt: 1, operationKey: `so:${orders[0].id}:void:1`, planVersionId: plan.id, reason: 'PAYMENT_CANCELLED',
      });
      h.db.prepare("UPDATE payment_operations SET status = 'voided' WHERE supplier_order_id = ?").run(orders[0].id);
    });
    assert.deepEqual(await sendDueCalls(h.app.deps), [{ id: calls(h, orders[0].id, 'void')[0].id, state: 'not_started' }]);
    assert.equal(calls(h, orders[0].id, 'void')[0].status, 'cancelled');
    assert.equal(fakeCalls(h, 'void').length, 0);
  });
});

describe('sender table: a void queued by another route is sent before that route answers', () => {
  test('a supplier refusal after the buyer authorized the other supplier: the void is queued by the void rule and sent by the app before the 200', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { plan, orders } = await reservedPlan(h, cafe1);
    const [a, b] = orders;
    await authorize(cafe1, a.id);
    const supplierB = await buyer(h, 'supplier-b');
    const refused = await supplierB.post(`/api/supplier/orders/${b.id}/refuse`, { reason: 'Out of cups today' });
    assert.equal(refused.status, 200, refused.text);
    assert.equal(planOf(h, plan.id).non_executable_reason, 'SUPPLIER_REFUSED');
    assert.equal(op(h, a.id).status, 'voided', 'voided when the refusal answered, not at the next reconciler tick');
    assert.deepEqual(fakeCalls(h, 'void').map((c) => c.request_id), [`so:${a.id}:void:1`]);
    assert.equal(h.app.deps.voidRule.provider.pending.size, 0);
    noCaptures(h);
  });
});
