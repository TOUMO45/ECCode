// The void rule against a capture that lands first (task f2-compensation-takeover-admin; spec: Void rule steps 4 and 6, F-TR-6;
// phase E follow-ups FU-34 and FU-45):
//   F-TR-6  a void the provider rejects is settled by READING the authorization: VOIDED -> voided; CAPTURED -> the operation becomes
//           captured and, because a cancellation was requested, the refund is queued in the SAME transaction (refund_requested +
//           so:<id>:refund:1), so the end state is `refunded` with one capture, one void attempt and one refund call
//   FU-45   an authorization read back as EXPIRED holds no money: the operation is settled (voided), not escalated with void_failed = 1;
//           an authorization the provider refuses to void while it is still CREATED is escalated as before
//   FU-34   a webhook moves an operation of a cancelled plan to captured without the compensation hook; the reconciler's step-6
//           backstop refunds it on its next tick, once
// The test-only fault capture_lands_after_void_intent needs RS_TEST_HOOKS=1.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { FAKE_WEBHOOK_SECRET, buildEvent, signEvent } from '../helpers/webhook-signer.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function start(env = {}) {
  const h = await startHarness({
    seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_TEST_HOOKS: '1', RS_FAKE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET, ...env },
  });
  harnesses.push(h);
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
}

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
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

// An approved plan whose two orders are authorized: abandoning it fires the void rule for both.
async function world(h) {
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
  return { h, cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
}

const abandon = (w) => w.cafe1.post(`/api/plans/${w.planId}/abandon`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const callOf = (h, orderId, kind) => h.db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(`so:${orderId}:${kind}:1`);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const reconcilerOf = (h) => createReconciler(h.app.deps, { saga: h.app.deps.saga });
const settle = async (h, rec) => {
  const summary = await rec.tick();
  await h.app.deps.saga.idle();
  return summary;
};
// A fresh sign-in: tests move the pinned clock past the idle limit of the session they started with.
const rescue = async (w) => {
  const buyer = await signIn(w.h, 'cafe1');
  const res = await buyer.get(`/api/requests/${w.requestId}`);
  assert.equal(res.status, 200, res.text);
  return res.json.rescueStatus;
};
const iso = (ms) => new Date(ms).toISOString();

describe('F-TR-6: a capture lands before the void', () => {
  test('F-TR-6: capture_lands_after_void_intent: the void is rejected, the read shows CAPTURED, and the operation ends refunded: one capture, one void attempt, one refund call', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_lands_after_void_intent', { value: 'A' });
    const res = await abandon(w);
    assert.equal(res.status, 200, res.text);

    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.ok(op(h, w.orders.A).cancel_requested_at, 'the cancellation was requested, so the capture was refunded');
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1, 'one capture');
    assert.equal(fakeCalls(h, 'capture').length, 0, 'and it was not ours: we never sent a capture');
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.A}:void:1`).length, 1, 'one void attempt for A');
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`], 'one refund call');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 1);
    const voidCall = callOf(h, w.orders.A, 'void');
    assert.deepEqual([voidCall.status, voidCall.error_code], ['failed', 'AUTHORIZATION_ALREADY_CAPTURED']);
    assert.equal(op(h, w.orders.A).void_failed, 0, 'not an escalation: the money went back');
    assert.match(op(h, w.orders.A).provider_capture_id, /^FAKECAP-/, 'the capture id came from reading the order');
    assert.equal(callOf(h, w.orders.A, 'refund').status, 'succeeded');
    // a tick has nothing left to do
    const summary = await settle(h, reconcilerOf(h));
    assert.deepEqual([summary.resolved, summary.sent], [0, 0]);
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal((await rescue(w)).status, 'cancelled');
  });

  test('F-TR-6: `captured` and the queued refund are ONE transaction: when the refund cannot be queued nothing is left half done (no captured operation without a refund)', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_lands_after_void_intent', { value: 'A' });
    h.db.prepare("CREATE TRIGGER no_refund_rows BEFORE INSERT ON provider_calls WHEN NEW.kind = 'refund' BEGIN SELECT RAISE(ABORT, 'test: refund rows refused'); END").run();
    assert.equal((await abandon(w)).status, 200);
    const a = op(h, w.orders.A);
    assert.equal(a.status, 'authorized', 'rolled back as a whole: never captured/refund_requested without its refund call');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'refund'").get().n, 0);
    assert.ok(h.logEntries().some((l) => l.msg === 'provider.void_resolution_failed'), 'the failure is logged, not swallowed');
    assert.equal(fakeCalls(h, 'refund').length, 0);
  });

  test('F-TR-6: the void answer was lost and a capture landed PENDING: the reconciler reads it, the operation is capture_pending, and when the poll sees COMPLETED the refund is queued in that transaction and sent in the same tick', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:void', { value: 'A' });
    assert.equal((await abandon(w)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    // the capture landed at the provider meanwhile, still PENDING
    const authId = op(h, w.orders.A).provider_authorization_id;
    const total = h.db.prepare('SELECT total_cents FROM supplier_orders WHERE id = ?').get(w.orders.A).total_cents;
    h.db.prepare("INSERT INTO fake_paypal_captures (id, authorization_id, status, amount_cents, simulated, created_at) VALUES ('FAKECAP-LANDED01', ?, 'PENDING', ?, 1, ?)").run(authId, total, iso(h.clock.now()));
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'CAPTURED' WHERE id = ?").run(authId);

    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.equal(op(h, w.orders.A).provider_capture_id, 'FAKECAP-LANDED01');
    assert.equal(fakeCalls(h, 'refund').length, 0, 'nothing to refund before the capture completes');

    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED' WHERE id = 'FAKECAP-LANDED01'").run();
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`]);
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.A}:void:1`).length, 1, 'no second void after the read');
  });
});

describe('FU-45: an authorization that expired holds no money', () => {
  test('FU-45: the void is refused because the authorization EXPIRED: the operation is voided (settled), void_failed stays 0, and it never escalates', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'EXPIRED' WHERE id = ?").run(op(h, w.orders.A).provider_authorization_id);
    assert.equal((await abandon(w)).status, 200);

    const a = op(h, w.orders.A);
    assert.equal(a.status, 'voided');
    assert.equal(a.void_failed, 0);
    assert.equal(a.last_error_code, 'AUTHORIZATION_EXPIRED');
    assert.equal(callOf(h, w.orders.A, 'void').error_code, 'AUTHORIZATION_EXPIRED');
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(fakeCalls(h, 'refund').length, 0);

    h.clock.advance((h.config.pendingEscalateMin + 5) * 60_000);
    await settle(h, reconcilerOf(h));
    const view = await rescue(w);
    assert.equal(view.status, 'cancelled', 'nothing is held, so nothing needs attention');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM payment_operations WHERE void_failed = 1').get().n, 0);
  });

  test('FU-45: an unknown void (timeout) on an authorization that expired meanwhile is settled the same way by the reconciler', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:void', { value: 'A' });
    assert.equal((await abandon(w)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'EXPIRED' WHERE id = ?").run(op(h, w.orders.A).provider_authorization_id);
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'voided');
    assert.equal(op(h, w.orders.A).void_failed, 0);
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.A}:void:1`).length, 1, 'read, never sent again');
  });

  test('FU-45 (limit): a void the provider refuses while the authorization is still CREATED stays authorized with void_failed = 1 and escalates', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'void_fail', { value: 'A' });
    assert.equal((await abandon(w)).status, 200);
    const a = op(h, w.orders.A);
    assert.deepEqual([a.status, a.void_failed, a.last_error_code], ['authorized', 1, 'VOID_REJECTED']);
    h.clock.advance((h.config.pendingEscalateMin + 5) * 60_000);
    assert.equal((await rescue(w)).status, 'failed_needs_attention');
    assert.equal(fakeCalls(h, 'refund').length, 0);
  });
});

describe('FU-34: a webhook capture of a cancelled operation', () => {
  test('F-TR-6: a webhook capture of a cancelled operation is refunded on the next tick, exactly once', async () => {
    const h = await start();
    const w = await world(h);
    const a = op(h, w.orders.A);
    // The buyer's plan is cancelled (cancel_requested_at) but A's void has not been sent when the capture lands at the provider.
    h.db.prepare("UPDATE payment_operations SET cancel_requested_at = ?, cancel_reason = 'PAYMENT_CANCELLED' WHERE id = ?").run(iso(h.clock.now()), a.id);
    h.db.prepare("INSERT INTO fake_paypal_captures (id, authorization_id, status, amount_cents, simulated, created_at) VALUES ('FAKECAP-WEBHOOK02', ?, 'COMPLETED', ?, 1, ?)").run(
      a.provider_authorization_id, h.db.prepare('SELECT total_cents FROM supplier_orders WHERE id = ?').get(w.orders.A).total_cents, iso(h.clock.now()),
    );
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'CAPTURED' WHERE id = ?").run(a.provider_authorization_id);

    const event = buildEvent({
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'FAKECAP-WEBHOOK02', status: 'COMPLETED', supplementary_data: { related_ids: { authorization_id: a.provider_authorization_id } } },
    });
    const signed = signEvent({ event, transmissionTime: iso(h.clock.now()) });
    const res = await h.request({
      method: 'POST', path: `/api/webhooks/paypal/${a.merchant_key}`, record: false, body: signed.rawBody,
      headers: { 'Content-Type': 'application/json', ...signed.headers },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.outcome, 'applied');
    assert.ok(['captured', 'refund_requested', 'refund_pending', 'refunded'].includes(op(h, w.orders.A).status), `the webhook moved it: ${op(h, w.orders.A).status}`);

    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    await settle(h, rec);
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`], 'one refund, not two');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls WHERE operation_key = ?').get(`so:${w.orders.A}:refund:1`).n, 1);
  });
});
