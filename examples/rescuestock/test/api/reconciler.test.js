// API tests for the reconciler (task e4-saga-reconciler; spec: Background Processing > Reconciler, Provider call protocol §5-7):
//   tick order      stale intents -> unknown, resolve unknown by reading, poll pending, expire reservations, take over lapsed leases,
//                   send queued calls per the Sender table, release check, re-plan drain, housekeeping -- each adjacency is shown by an
//                   outcome that needs the earlier step to run first in the SAME tick
//   protocol §6     void and refund calls left unknown are read before any re-send
//   RS-26 (part)    a takeover resumes at step 2 when no capture was ever sent and at step 3 otherwise
//   SEC-6 / FU-22   housekeeping: invalid/unverified webhook rows after 7 days, sessions, login failures, idempotency keys, stale model spend
//   wiring          startApp passes the real void port and starts the reconciler and the fake approval listener
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_PASSWORD, FIXED_NOW_MS, startHarness, testEnv } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { fixedClock, isoFromMs } from '../../src/clock.js';
import { createLogger } from '../../src/log.js';
import { startApp } from '../../src/main.js';
import { createVoidPort, queueCall, startCall } from '../../src/services/calls.js';
import { createReconciler, drainReplanQueue, housekeeping } from '../../src/services/reconciler.js';
import { createSaga } from '../../src/services/saga.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
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

async function world(h, { customer = 'cafe1', authorize = ['A', 'B'], confirm = ['A', 'B'] } = {}) {
  const cafe1 = await signIn(h, customer);
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${customer}-${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of confirm) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
  }
  const w = { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
  for (const code of authorize) assert.equal((await approveOrder(h, w, code)).status, 303);
  return w;
}

async function approveOrder(h, w, code) {
  const created = await w.cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(`${created.json.approvalUrl}/approve`);
  const target = new URL(approved.location);
  return w.cafe1.get(target.pathname + target.search);
}

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const reservation = (h, id) => h.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
const callOf = (h, key) => h.db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(key);
const callsOf = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeKinds = (h, sinceId = 0) => h.db.prepare('SELECT id, kind, request_id, replayed FROM fake_paypal_calls WHERE id > ? ORDER BY id').all(sinceId);
const lastFakeId = (h) => h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM fake_paypal_calls').get().n;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const reconcilerOf = (h, saga = h.app.deps.saga) => createReconciler(h.app.deps, { saga });
const settle = async (h, rec) => {
  const summary = await rec.tick();
  await h.app.deps.saga.idle();
  return summary;
};
const iso = (ms) => isoFromMs(ms);

describe('tick order: each step needs the one before it to have run in the same tick', () => {
  test('1 -> 2: a started intent older than 2 x the timeout is made unknown AND read in one tick (the authorization is found, no send)', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A'] });
    // order B: approved at the provider; the return handler queued and STARTED the authorize and the process died
    const created = await w.cafe1.post(`/api/orders/${w.orders.B}/paypal/create`, {});
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const token = new URL(approved.location).searchParams.get('token');
    h.db.prepare("UPDATE payment_operations SET status = 'approved' WHERE supplier_order_id = ?").run(w.orders.B);
    h.db.tx(() => queueCall(h.db, h.clock, { operationId: op(h, w.orders.B).id, supplierOrderId: w.orders.B, kind: 'authorize', attempt: 1 }));
    const call = callOf(h, `so:${w.orders.B}:authorize:1`);
    assert.ok(startCall(h.db, h.clock, call.id, { guard: null }));
    // the authorize reached the provider and was applied before the process died
    const sent = await h.app.deps.payments.authorizeOrder({ merchantKey: op(h, w.orders.B).merchant_key, requestId: call.operation_key, orderId: token });
    assert.equal(sent.kind, 'ok');
    h.clock.advance(2 * h.config.paypalTimeoutMs + 1);
    const mark = lastFakeId(h);

    await settle(h, reconcilerOf(h));

    assert.equal(callOf(h, call.operation_key).status, 'succeeded');
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.deepEqual(fakeKinds(h, mark).map((c) => c.kind), ['get_order'], 'one read, no second authorize');
  });

  test('2 -> 3: the call is resolved to authorization_pending and the pending poll of the same tick already sees CREATED', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h, { authorize: ['A', 'B'] });
    assert.equal(op(h, w.orders.B).status, 'unknown');
    // the provider moves the authorization to CREATED right after the order read of step 2
    const real = h.app.deps.payments;
    h.app.deps.payments = {
      ...real,
      async getOrder(args) {
        const outcome = await real.getOrder(args);
        h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'CREATED' WHERE status = 'PENDING'").run();
        return outcome;
      },
    };
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.B).status, 'authorized', 'read as PENDING by step 2, polled as CREATED by step 3 in the same tick');
    assert.deepEqual(fakeKinds(h).filter((c) => c.kind === 'get_authorization').length, 1);
  });

  test('4 -> 6: an expired reservation is voided in the tick that expires it (the void is queued by step 4 and sent before the tick ends)', async () => {
    const h = await start();
    const w = await world(h);
    h.clock.advance(h.config.reservationTtlMin * 60_000 + 1000);
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(reservation(h, w.reservationId).status, 'expired');
    assert.deepEqual([plan(h, w.planId).status, plan(h, w.planId).non_executable_reason], ['non_executable', 'RESERVATION_EXPIRED']);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['voided', 'voided']);
    assert.equal(fakeCalls(h, 'void').length, 2);
    const again = await settle(h, rec);
    assert.equal(again.expired, 0, 'exactly once');
    assert.equal(fakeCalls(h, 'void').length, 2);
  });

  test('6 -> 7: a queued refund is sent and the reservation released (restock rows) in the same tick', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'http_429:refund', { remaining: 1 });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_pending', 'the immediate send got a retryable answer: the call is queued again, the operation stays refund_pending');
    const refund = callOf(h, `so:${w.orders.A}:refund:1`);
    assert.deepEqual([refund.status, refund.started_at, refund.send_count], ['intent', null, 1]);
    assert.ok(refund.next_attempt_at > iso(h.clock.now()), 'backing off');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');

    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refund_pending', 'the back-off has not passed: nothing is sent');
    assert.equal(fakeCalls(h, 'refund').length, 1);
    h.clock.advance(5001);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'").get().n, 2);
    assert.equal(fakeCalls(h, 'refund').length, 2, 'the 429 attempt and the send; the same key');
  });

  test('5 -> 6: a lapsed plan is taken over and resumed; the next tick has nothing left to do', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    h.clock.advance(h.config.sagaLeaseMs + 1);
    const rec = reconcilerOf(h);
    const first = await settle(h, rec);
    assert.equal(first.takenOver, 1);
    assert.equal(plan(h, w.planId).status, 'executed');
    const second = await settle(h, rec);
    assert.deepEqual([second.takenOver, second.sent, second.resolved, second.polled, second.stale], [0, 0, 0, 0, 0]);
  });
});

describe('takeover resumes at step 2 or step 3 (spec: Payment saga step 6)', () => {
  test('no capture was ever sent: the new holder repeats step 2 (reads every authorization) before the first capture', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    h.clock.advance(h.config.sagaLeaseMs + 1);
    const mark = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    assert.deepEqual(fakeKinds(h, mark).map((c) => c.kind), ['get_authorization', 'get_authorization', 'capture', 'capture']);
    assert.equal(plan(h, w.planId).lease_epoch, 2);
  });

  test('a capture was sent: the new holder resumes at step 3 (no authorization reads) with the first operation not captured', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        const outcome = await real.captureAuthorization(args);
        if (args.requestId === `so:${w.orders.A}:capture:1`) void h.app.deps.saga.stop(); // the process shuts down after the first capture
        return outcome;
      },
    };
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(plan(h, w.planId).lease_until, iso(h.clock.now()), 'the stopping run paused its lease');
    h.app.deps.payments = real;

    const taker = createSaga(h.app.deps, { executorId: 'host-2:77:00112233' });
    const mark = lastFakeId(h);
    await reconcilerOf(h, taker).tick();
    await taker.idle();
    assert.deepEqual(fakeKinds(h, mark).map((c) => [c.kind, c.request_id]), [['capture', `so:${w.orders.B}:capture:1`]], 'step 3 only: no reads');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).executor_id, 'host-2:77:00112233');
  });
});

describe('protocol §6: void and refund calls left unknown are read before any re-send', () => {
  test('void: the answer was lost after the void applied -> the read shows VOIDED, no second void', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:void', { value: 'A' });
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'authorized');
    const mark = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'voided');
    assert.equal(callOf(h, `so:${w.orders.A}:void:1`).status, 'succeeded');
    assert.equal(fakeKinds(h, mark).filter((c) => c.kind === 'void').length, 0, 'not sent again');
    assert.deepEqual(fakeKinds(h, mark).map((c) => c.kind), ['get_authorization']);
  });

  test('void: nothing was applied (a timeout) -> the read shows CREATED, the SAME key is sent again, once', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:void', { value: 'A' });
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    const mark = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'voided');
    assert.deepEqual(fakeKinds(h, mark).map((c) => [c.kind, c.request_id]), [['get_authorization', null], ['void', `so:${w.orders.A}:void:1`]]);
    assert.equal(callOf(h, `so:${w.orders.A}:void:1`).send_count, 2);
  });

  test('void (F-TR-6): the answer was lost and a capture had landed -> captured, then refunded by the compensation hook; one capture, one refund', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const w = await world(h);
    arm(h, 'capture_lands_after_void_intent', { value: 'A' });
    arm(h, 'lost_response:void', { value: 'A' });
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(fakeCalls(h, 'capture').length, 0, 'we never sent a capture; the landed one is the provider\'s');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1);
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal(callOf(h, `so:${w.orders.A}:void:1`).status, 'failed');
    assert.equal(op(h, w.orders.A).void_failed, 0);
  });

  test('refund: the answer was lost after the refund applied -> the read shows it COMPLETED, no second refund', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'lost_response:refund', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'refund_pending');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(fakeCalls(h, 'refund').length, 1, 'refunded once');
    assert.equal(reservation(h, w.reservationId).status, 'released');
  });

  test('refund: nothing was applied (a timeout) -> the capture is COMPLETED with no refund: the same key is sent again', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'timeout:refund', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => [c.request_id, c.replayed]), [[`so:${w.orders.A}:refund:1`, 0], [`so:${w.orders.A}:refund:1`, 0]]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 1);
    assert.equal(reservation(h, w.reservationId).status, 'released');
  });

  test('refund_pending is polled: COMPLETED -> refunded and the reservation is released; FAILED -> refund_failed and the reservation escalates', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'refund_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    h.db.prepare("UPDATE fake_paypal_refunds SET status = 'COMPLETED'").run();
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(reservation(h, w.reservationId).status, 'released');

    const h2 = await start();
    const w2 = await world(h2);
    arm(h2, 'capture_declined', { value: 'B' });
    arm(h2, 'refund_pending', { value: 'A' });
    assert.equal((await execute(w2)).status, 202);
    await h2.app.deps.saga.idle();
    h2.db.prepare("UPDATE fake_paypal_refunds SET status = 'FAILED'").run();
    await settle(h2, reconcilerOf(h2));
    assert.equal(op(h2, w2.orders.A).status, 'refund_failed');
    assert.equal(reservation(h2, w2.reservationId).status, 'reconciling');
    assert.equal(reservation(h2, w2.reservationId).escalation, 'REFUND_FAILED');
  });
});

describe('the Sender table (step 6)', () => {
  test('a queued authorize whose operation has a cancellation request is cancelled and the operation voided locally; nothing is sent', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A'] });
    const created = await w.cafe1.post(`/api/orders/${w.orders.B}/paypal/create`, {});
    assert.equal(created.status, 200);
    h.db.prepare("UPDATE payment_operations SET status = 'approved', cancel_requested_at = ?, cancel_reason = 'PAYMENT_CANCELLED' WHERE supplier_order_id = ?").run(iso(h.clock.now()), w.orders.B);
    h.db.tx(() => queueCall(h.db, h.clock, { operationId: op(h, w.orders.B).id, supplierOrderId: w.orders.B, kind: 'authorize', attempt: 1 }));
    const base = fakeKinds(h).length;
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(op(h, w.orders.B).voided_locally, 1);
    assert.equal(callsOf(h, w.orders.B, 'authorize')[0].status, 'cancelled');
    assert.equal(fakeKinds(h).length, base, 'no provider call');
  });

  test('create_order is never sent by the reconciler, and a queued capture is sent only by the saga lease holder', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A'] });
    h.db.tx(() => queueCall(h.db, h.clock, { operationId: op(h, w.orders.B).id, supplierOrderId: w.orders.B, kind: 'create_order', attempt: 7 }));
    h.app.deps.saga.autoRun = false;
    // B has no authorization, so execute is refused; queue a capture by hand for A to show the sender table
    h.db.tx(() => queueCall(h.db, h.clock, { operationId: op(h, w.orders.A).id, supplierOrderId: w.orders.A, kind: 'capture', attempt: 1 }));
    const mark = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    assert.equal(callOf(h, `so:${w.orders.B}:create_order:7`).status, 'intent');
    assert.equal(callOf(h, `so:${w.orders.A}:capture:1`).status, 'intent');
    assert.equal(fakeKinds(h, mark).length, 0, 'nothing was sent');
  });

  test('backstops for transitions the webhook route makes without the hooks: a captured operation of a cancelled plan is refunded, an authorized one without a void gets it', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refunded');

    const h2 = await start();
    const w2 = await world(h2);
    // what a webhook does: authorized -> captured for an order whose plan is cancelled, with no refund queued
    assert.equal((await w2.cafe1.post(`/api/plans/${w2.planId}/abandon`, {})).status, 200);
    assert.equal(op(h2, w2.orders.A).status, 'voided');
    const captureId = 'FAKECAP-WEBHOOK01';
    h2.db.prepare("UPDATE payment_operations SET status = 'captured', provider_capture_id = ?, cancel_requested_at = ?, cancel_reason = 'PAYMENT_CANCELLED', void_failed = 0 WHERE supplier_order_id = ?").run(captureId, iso(h2.clock.now()), w2.orders.B);
    h2.db.prepare("INSERT INTO fake_paypal_captures (id, authorization_id, status, amount_cents, simulated, created_at) VALUES (?, ?, 'COMPLETED', ?, 1, ?)").run(
      captureId, op(h2, w2.orders.B).provider_authorization_id, op(h2, w2.orders.B).amount_cents, iso(h2.clock.now()),
    );
    await settle(h2, reconcilerOf(h2));
    assert.equal(op(h2, w2.orders.B).status, 'refunded');
    assert.equal(callsOf(h2, w2.orders.B, 'refund').length, 1);

    // an authorized operation whose cancellation was requested but whose void was never queued (a move the void rule did not see)
    const h3 = await start();
    const w3 = await world(h3);
    h3.db.prepare("UPDATE payment_operations SET cancel_requested_at = ?, cancel_reason = 'PAYMENT_CANCELLED' WHERE supplier_order_id = ?").run(iso(h3.clock.now()), w3.orders.A);
    assert.equal(callsOf(h3, w3.orders.A, 'void').length, 0);
    const rec3 = reconcilerOf(h3);
    await settle(h3, rec3);
    assert.equal(op(h3, w3.orders.A).status, 'voided');
    assert.equal(callsOf(h3, w3.orders.A, 'void').length, 1);
    await settle(h3, rec3);
    assert.equal(fakeCalls(h3, 'void').length, 1, 'once');
  });
});

describe('re-plan queue (F-TR-2) and housekeeping (SEC-6, FU-22)', () => {
  test('step 8: a due entry is drained by storing a run; a failing drain keeps the entry with failed_drains + 1 and a back-off; an archived request is dropped', async () => {
    const h = await start();
    const cafe1 = await signIn(h, 'cafe1');
    h.clock.advance(61_000);
    const { requestId } = await approvedPlan(cafe1, DAY, { approve: false });
    const now = iso(h.clock.now());
    const queue = (id, nextAt = now) =>
      h.db.prepare('INSERT OR REPLACE INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (?, ?, ?, 0, ?)').run(id, 'PRICE_CHANGED', now, nextAt);

    const real = h.app.deps.planner;
    h.app.deps.planner = () => {
      throw new Error('planner is down');
    };
    queue(requestId);
    let result = drainReplanQueue(h.app.deps);
    assert.deepEqual(result, { drained: 0, failed: 1, dropped: 0 });
    let row = h.db.prepare('SELECT * FROM replan_queue WHERE request_id = ?').get(requestId);
    assert.equal(row.failed_drains, 1, 'the entry is never dropped on failure');
    assert.equal(row.next_attempt_at, iso(h.clock.now() + 15_000), '15 s x 2^0');
    assert.equal(row.last_error, 'FAILED');
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 0, failed: 0, dropped: 0 }, 'not due yet');

    h.clock.advance(15_000);
    result = drainReplanQueue(h.app.deps);
    row = h.db.prepare('SELECT * FROM replan_queue WHERE request_id = ?').get(requestId);
    assert.deepEqual([result.failed, row.failed_drains, row.next_attempt_at], [1, 2, iso(h.clock.now() + 30_000)]);
    for (let n = 0; n < 6; n += 1) {
      h.clock.advance(300_000);
      drainReplanQueue(h.app.deps);
    }
    row = h.db.prepare('SELECT * FROM replan_queue WHERE request_id = ?').get(requestId);
    assert.ok(row.failed_drains >= 8);
    assert.ok(Date.parse(row.next_attempt_at) - h.clock.now() <= 300_000, 'the back-off is capped at 5 minutes');

    h.app.deps.planner = real;
    h.clock.advance(300_000);
    result = drainReplanQueue(h.app.deps);
    assert.deepEqual(result, { drained: 1, failed: 0, dropped: 0 });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?').get(requestId).n, 0, 'removed only with the stored run');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE request_id = ?').get(requestId).n, 2);

    h.db.prepare('UPDATE rescue_requests SET archived_at = ? WHERE id = ?').run(iso(h.clock.now()), requestId);
    queue(requestId);
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 0, failed: 0, dropped: 1 });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM replan_queue').get().n, 0);
  });

  test('step 9: invalid and unverified webhook rows older than 7 days, expired sessions, old login failures, old idempotency keys and stale model reservations are purged; the rest stays', async () => {
    const h = await start();
    const now = h.clock.now();
    const DAYS = 24 * 3600 * 1000;
    const hook = (id, status, at) =>
      h.db.prepare(
        "INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake', ?, 'A', ?, ?, 'x', ?)",
      ).run(id, status, status === 'valid' ? 'applied' : 'rejected', iso(at));
    hook('old-invalid', 'invalid', now - 7 * DAYS - 1000);
    hook('old-unverified', 'unverified', now - 8 * DAYS);
    hook('new-invalid', 'invalid', now - 6 * DAYS - 23 * 3600 * 1000);
    hook('old-valid', 'valid', now - 30 * DAYS);
    const cafe = h.db.prepare("SELECT id FROM users WHERE username = 'cafe1'").get().id;
    const session = (hash, lastSeen, expires) =>
      h.db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(hash, cafe, 'c', iso(now - DAYS), iso(lastSeen), iso(expires));
    session('expired', now - 1000, now - 1);
    session('idle', now - 61 * 60_000, now + 3600_000);
    session('live', now - 1000, now + 3600_000);
    h.db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?, ?, ?)').run('u', '1.2.3.4', iso(now - DAYS - 1000));
    h.db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?, ?, ?)').run('u', '1.2.3.4', iso(now - DAYS + 60_000));
    const key = (name, at) => h.db.prepare("INSERT INTO idempotency_keys (user_id, key, fingerprint, status_code, response_json, created_at) VALUES (?, ?, 'f', 201, '{}', ?)").run(cafe, name, iso(at));
    key('old-key-0000000001', now - DAYS - 1000);
    key('new-key-0000000001', now - DAYS + 60_000);
    const spend = (status, at) =>
      h.db.prepare("INSERT INTO model_spend (day, customer_id, purpose, reserved_micro_usd, status, created_at) VALUES ('2026-10-20', ?, 'extract', 50000, ?, ?)").run(cafe, status, iso(at));
    spend('reserved', now - 2 * h.config.modelTimeoutMs - 1);
    spend('reserved', now - 1000);

    const summary = housekeeping(h.app.deps);
    assert.deepEqual(summary, { sessions: 2, loginFailures: 1, idempotencyKeys: 1, webhookRows: 2, staleSpend: 1 });
    assert.deepEqual(h.db.prepare('SELECT transmission_id FROM webhook_events ORDER BY id').all().map((r) => r.transmission_id), ['new-invalid', 'old-valid']);
    assert.deepEqual(h.db.prepare('SELECT id_hash FROM sessions WHERE id_hash IN (?, ?, ?) ORDER BY id_hash').all('expired', 'idle', 'live').map((r) => r.id_hash), ['live']);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM login_failures').get().n, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE '%-key-0000000001'").get().n, 1);
    const rows = h.db.prepare('SELECT status, actual_micro_usd FROM model_spend ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.status, r.actual_micro_usd]), [['settled', 50000], ['reserved', null]], 'settled at the cap, once');
    assert.deepEqual(housekeeping(h.app.deps), { sessions: 0, loginFailures: 0, idempotencyKeys: 0, webhookRows: 0, staleSpend: 0 }, 'a second pass finds nothing');
  });

  test('every tick writes reconciler_last_tick_at and reconciler_last_tick_ms for the metrics; a failing item does not stop the tick', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    const w = await world(h);
    const real = h.app.deps.payments;
    h.app.deps.payments = {
      ...real,
      getAuthorization() {
        throw new Error('boom');
      },
    };
    const now = h.clock.now();
    h.db.prepare("INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake', 'x', 'A', 'invalid', 'rejected', 'x', ?)").run(iso(now - 8 * 24 * 3600 * 1000));
    const summary = await reconcilerOf(h).tick();
    assert.deepEqual(summary.failed, [], 'the item error is contained in the item');
    assert.equal(h.logEntries().filter((l) => l.msg === 'reconcile.item_failed').length, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0, 'housekeeping ran after the failing poll');
    assert.equal(h.db.prepare("SELECT value FROM meta WHERE key = 'reconciler_last_tick_at'").get().value, iso(now));
    assert.match(h.db.prepare("SELECT value FROM meta WHERE key = 'reconciler_last_tick_ms'").get().value, /^\d+$/);
    assert.equal(op(h, w.orders.B).status, 'authorization_pending');
  });

  test('a tick that is already running is joined, not started twice', async () => {
    const h = await start();
    const rec = reconcilerOf(h);
    const [a, b] = [rec.tick(), rec.tick()];
    assert.equal(a, b);
    await a;
    assert.notEqual(rec.tick(), a);
  });
});

describe('wiring: startApp', () => {
  test('startApp passes the real void port, starts the fake approval listener and the reconciler (startup, then every RS_RECONCILE_INTERVAL_MS), and close() stops them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-reconciler-'));
    const clock = fixedClock(FIXED_NOW_MS);
    const lines = [];
    const running = await startApp({
      env: { ...testEnv(dir, { RS_RECONCILE_INTERVAL_MS: '20', RS_MODEL_PROVIDER: 'fake' }), RS_ADMIN_PASSWORD: undefined },
      log: createLogger({ write: (l) => lines.push(l), clock }),
      clock,
    });
    try {
      assert.equal(running.app.deps.voidRule.provider.name, 'provider_calls', 'the real void port, not the recorder');
      assert.ok(running.payments?.listener?.port > 0, 'the fake approval listener runs');
      assert.equal(running.payments.listener.host, '127.0.0.1');
      await running.reconcilerStarted;
      const msgs = lines.map((l) => JSON.parse(l).msg);
      assert.ok(msgs.indexOf('retention.sweep') >= 0 && msgs.indexOf('retention.sweep') < msgs.indexOf('reconcile.tick'), 'the startup tick follows the startup retention pass');
      assert.equal(running.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'reconciler_last_tick_at'").get().n, 1);
      const ticks = () => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'reconcile.tick').length;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && ticks() < 3) await new Promise((r) => setTimeout(r, 15));
      assert.ok(ticks() >= 3, 'the startup tick and the timer ticks');
      const logged = lines.join('');
      assert.doesNotMatch(logged, /password|secret|token/i);
    } finally {
      await running.close();
      const after = lines.length;
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(lines.length, after, 'no tick after close()');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
