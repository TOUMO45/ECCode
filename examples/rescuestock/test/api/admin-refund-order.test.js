// The admin refund_order tool (task f2-compensation-takeover-admin; spec: Admin routes > faults > refund_order, Sender table):
//   refund_order is allowed only for an operation `captured` under an `executed` plan; it runs captured -> refund_requested ->
//   refund_pending -> refunded in one admin call: the transition and the queued call so:<id>:refund:1 commit together, then the
//   handler sends the refund; a refund that cannot be sent now stays queued for the reconciler.
//   Results: COMPLETED -> refunded, PENDING -> refund_pending (polled), FAILED -> refund_failed (escalation).
//   FU-42  the capture and the refund both take their amount from supplier_orders.total_cents, never from payment_operations.amount_cents
// Every call writes an audit event with the actor and the target ids (SEC-11).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { ensureAdmin } from '../../src/services/users.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  harnesses.push(h);
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  h.admin = await signIn(h, 'admin', ADMIN_PASSWORD);
  return h;
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

const confirmBody = (code) => ({ lines: [{ offerId: code === 'A' ? 1 : 2, committedBundles: 1 }], committedReadyAt: READY[code] });

// A plan that is paid for and executed: both operations captured.
async function executedWorld(h, { before = () => {} } = {}) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of ['A', 'B']) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
    const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
  }
  const w = { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
  before(w);
  assert.equal((await cafe1.post(`/api/plans/${plan.id}/execute`, {})).status, 202);
  await h.app.deps.saga.idle();
  return w;
}

const refundOrder = (h, supplierOrderId, client = h.admin) => client.post('/api/admin/faults', { kind: 'refund_order', supplierOrderId });
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const refundCall = (h, orderId) => h.db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(`so:${orderId}:refund:1`);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const totalOf = (h, orderId) => h.db.prepare('SELECT total_cents FROM supplier_orders WHERE id = ?').get(orderId).total_cents;
const auditRows = (h) => h.db.prepare("SELECT * FROM audit_events WHERE action = 'admin.fault' AND entity_type = 'supplier_order' ORDER BY id").all();
const reconcilerOf = (h) => createReconciler(h.app.deps, { saga: h.app.deps.saga });
const settle = async (h, rec) => {
  const summary = await rec.tick();
  await h.app.deps.saga.idle();
  return summary;
};
const rescue = async (w) => (await w.cafe1.get(`/api/requests/${w.requestId}`)).json.rescueStatus;

describe('refund_order: a captured operation of an executed plan', () => {
  test('refund_order: the transition and the queued call commit together and the handler sends the refund: refunded, one refund at the provider under the deterministic key, an audit event with the actor and the ids', async () => {
    const h = await start();
    const w = await executedWorld(h);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['captured', 'captured']);

    const res = await refundOrder(h, w.orders.A);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.applied, { kind: 'refund_order', supplierOrderId: w.orders.A });
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.match(op(h, w.orders.A).provider_refund_id, /^FAKEREF-/);
    assert.equal(op(h, w.orders.B).status, 'captured', 'the other order is untouched');
    const refunds = fakeCalls(h, 'refund');
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].request_id, `so:${w.orders.A}:refund:1`);
    const call = refundCall(h, w.orders.A);
    assert.deepEqual([call.status, call.send_count, call.attempt], ['succeeded', 1, 1]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls WHERE kind = ?').get('refund').n, 1);

    const [audit] = auditRows(h);
    assert.equal(audit.outcome, 'ok');
    assert.equal(audit.actor_user_id, h.admin.user.id);
    assert.equal(audit.actor_role, 'admin');
    assert.equal(audit.entity_id, w.orders.A);
    assert.deepEqual(JSON.parse(audit.detail_json), { kind: 'refund_order', supplierOrderId: w.orders.A });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 2, 'no capture is repeated');
  });

  test('refund_order: refunding every captured order of the plan makes the request cancelled ("All payments were refunded"); one refunded order is named in the collected message', async () => {
    const h = await start();
    const w = await executedWorld(h);
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    const partial = await rescue(w);
    assert.notEqual(partial.status, 'cancelled', 'one of two refunded is not "all refunded"');
    assert.equal((await refundOrder(h, w.orders.B)).status, 200);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['refunded', 'refunded']);
    const all = await rescue(w);
    assert.equal(all.status, 'cancelled');
    assert.match(all.message, /refunded by the organiser/);
  });

  test('FU-42: the capture and the refund both ask for supplier_orders.total_cents, even when payment_operations.amount_cents disagrees', async () => {
    const h = await start();
    const w = await executedWorld(h, {
      before: (world) => {
        // A column that disagrees with the order total (it is equal by construction in production; this pins which one is read).
        h.db.prepare('UPDATE payment_operations SET amount_cents = amount_cents - 1 WHERE supplier_order_id = ?').run(world.orders.A);
      },
    });
    const total = totalOf(h, w.orders.A);
    assert.equal(op(h, w.orders.A).amount_cents, total - 1);
    const capture = h.db.prepare('SELECT c.* FROM fake_paypal_captures c WHERE c.id = ?').get(op(h, w.orders.A).provider_capture_id);
    assert.equal(capture.amount_cents, total, 'the capture took the order total');

    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    const refund = h.db.prepare('SELECT * FROM fake_paypal_refunds WHERE id = ?').get(op(h, w.orders.A).provider_refund_id);
    assert.equal(refund.amount_cents, total, 'the refund returns exactly what the capture took');
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_captures WHERE id = ?').get(capture.id).status, 'REFUNDED', 'fully refunded at the provider');
  });
});

describe('refund_order: what it refuses', () => {
  test('refund_order: an unknown order is 404; an operation that is not captured is 409 INVALID_STATE with the states, an audit row `denied`, and no provider call', async () => {
    const h = await start();
    const cafe1 = await signIn(h, 'cafe1');
    h.clock.advance(61_000);
    const { requestId, plan: made } = await approvedPlan(cafe1, DAY);
    const reserved = await reserve(cafe1, made.id, idempotencyKey(`${requestId}-${made.id}`));
    const orderId = reserved.json.orders[0].id;
    const before = fakeCalls(h, 'refund').length;

    assert.equal((await refundOrder(h, 987654)).status, 404);
    const early = await refundOrder(h, orderId);
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, 'INVALID_STATE');
    assert.deepEqual(early.json.error.details, { from: 'created', to: 'refund_requested' });
    assert.equal(fakeCalls(h, 'refund').length, before);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'refund'").get().n, 0);
    const denied = auditRows(h).filter((r) => r.outcome === 'denied');
    assert.equal(denied.length, 1);
    assert.deepEqual(JSON.parse(denied[0].detail_json), { kind: 'refund_order', code: 'INVALID_STATE' });
  });

  test('refund_order: a captured operation under a plan that is NOT executed (the saga is still running) is refused; so is a second call for the same order', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'capture_pending', { value: 'B' }) });
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(op(h, w.orders.A).status, 'captured');
    const refused = await refundOrder(h, w.orders.A);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'INVALID_STATE');
    assert.equal(op(h, w.orders.A).status, 'captured', 'the compensation, not the admin tool, owns an unfinished plan');
    assert.equal(fakeCalls(h, 'refund').length, 0);

    // the plan finishes; now the tool works once and refuses the repeat
    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();
    await settle(h, reconcilerOf(h));
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    const again = await refundOrder(h, w.orders.A);
    assert.equal(again.status, 409);
    assert.deepEqual(again.json.error.details, { from: 'refunded', to: 'refund_requested' });
    assert.equal(fakeCalls(h, 'refund').length, 1);
  });

  test('refund_order: two simultaneous calls give one refund: one 200, one 409', async () => {
    const h = await start();
    const w = await executedWorld(h);
    const [first, second] = await Promise.all([refundOrder(h, w.orders.A), refundOrder(h, w.orders.A)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_refunds").get().n, 1);
    assert.equal(op(h, w.orders.A).status, 'refunded');
  });

  test('refund_order: only the admin may call it (customer and supplier 403, anonymous 401) and nothing changes', async () => {
    const h = await start();
    const w = await executedWorld(h);
    const supplier = await signIn(h, 'supplier-a');
    assert.equal((await refundOrder(h, w.orders.A, w.cafe1)).status, 403);
    assert.equal((await refundOrder(h, w.orders.A, supplier)).status, 403);
    assert.equal((await refundOrder(h, w.orders.A, createClient(h.request))).status, 401);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(fakeCalls(h, 'refund').length, 0);
  });

  test('refund_order: an operation the demo reset archived is not found', async () => {
    const h = await start();
    const w = await executedWorld(h);
    h.db.prepare('UPDATE payment_operations SET archived_at = ? WHERE supplier_order_id = ?').run(new Date(h.clock.now()).toISOString(), w.orders.A);
    assert.equal((await refundOrder(h, w.orders.A)).status, 404);
    assert.equal(fakeCalls(h, 'refund').length, 0);
  });
});

describe('refund_order: the other answers of the provider', () => {
  test('refund_order: PENDING -> refund_pending, polled by the reconciler until the provider completes it; the reconciler does not send a second refund', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'refund_pending', { value: 'A' }) });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refund_pending', 'the provider still says PENDING');
    h.db.prepare("UPDATE fake_paypal_refunds SET status = 'COMPLETED'").run();
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(fakeCalls(h, 'refund').length, 1, 'polled, never re-sent');
    assert.ok(fakeCalls(h, 'get_refund').length >= 1);
  });

  test('refund_order: FAILED -> refund_failed (terminal, an escalation: the request needs attention) and the refund is not sent again', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'refund_failed', { value: 'A' }) });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'refund_failed');
    assert.equal(op(h, w.orders.A).last_error_code, 'REFUND_FAILED');
    assert.equal((await rescue(w)).status, 'failed_needs_attention');
    await settle(h, reconcilerOf(h));
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal((await refundOrder(h, w.orders.A)).status, 409, 'a failed refund is for the organiser to settle at PayPal');
  });

  test('refund_order: a retryable answer (429) leaves the refund queued with its back-off; the reconciler sends it with the same key once the back-off is over', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'http_429:refund', { value: 'A' }) });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    let call = refundCall(h, w.orders.A);
    assert.deepEqual([call.status, call.started_at], ['intent', null], 'provably unsent again');
    assert.equal(call.next_attempt_at, new Date(h.clock.now() + 5000).toISOString());
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    const rec = reconcilerOf(h);
    h.clock.advance(4000);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refund_pending', 'not before the back-off is over');
    h.clock.advance(1001);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    call = refundCall(h, w.orders.A);
    assert.equal(call.send_count, 2);
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`, `so:${w.orders.A}:refund:1`], 'the 429 and the send, one key');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 1);
  });

  test('refund_order: a lost answer (the refund applied) turns unknown and is READ: refunded, no second refund', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'lost_response:refund', { value: 'A' }) });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'refund_pending');
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(fakeCalls(h, 'refund').length, 1, 'read, not sent again');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 1);
  });

  test('refund_order: a timeout (nothing applied) turns unknown; the reconciler reads a COMPLETED capture with no refund and sends the SAME PayPal-Request-Id', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'timeout:refund', { value: 'A' }) });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 0);
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`, `so:${w.orders.A}:refund:1`]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 1, 'one refund at the provider');
    assert.equal(refundCall(h, w.orders.A).send_count, 2);
  });
});
