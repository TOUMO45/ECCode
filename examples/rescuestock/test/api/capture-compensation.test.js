// Compensation and lease takeover of the payment saga (task f2-compensation-takeover-admin; spec: Payment saga steps 5 and 6,
// Provider call protocol sections 5-7, Reconciler step 5; follow-ups FU-41, FU-42):
//   RS-22   a capture that fails: ONE transaction under the fence moves the plan to non_executable (CAPTURE_FAILED | AUTHORIZATION_EXPIRED),
//           the reservation consumed -> reconciling, every open operation gets cancel_requested_at, queued captures are cancelled,
//           authorized -> void, captured -> refund_requested + so:<id>:refund:1; the reservation is released with restock rows only
//           when nothing is outstanding; a PENDING capture keeps lease_epoch constant across ticks (F-TR-7)
//   ARCH-23 / RS-26 (part)  a takeover bumps the epoch inside BEGIN IMMEDIATE only when lease_until <= now and no operation is
//           capture_pending or unknown; every open capture call is READ before anything is sent; a re-send reuses the same
//           PayPal-Request-Id and is preceded by the lease holder's own read of the authorization (FU-41a); a stalled sender's late
//           result is fenced by its send_token or by the epoch and logged
//   FU-41(b)  an operation that becomes capture_pending or unknown after the takeover and before the resumed run makes the saga pause and
//           send nothing (the condition in captureLoop that the reviewers' mutant M6 removes)
//   FU-42   the capture amount comes from supplier_orders.total_cents, not from payment_operations.amount_cents
// The saga continues in the background of the process that won the claim; the tests wait for it with saga.idle().
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { POLL_EVERY_TICK_MS, createReconciler } from '../../src/services/reconciler.js';
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

// Two suppliers, both confirmed and authorized: the plan is ready to execute.
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

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const iso = (ms) => new Date(ms).toISOString();
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const reservation = (h, id) => h.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
const callOf = (h, orderId, kind) => h.db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(`so:${orderId}:${kind}:1`);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeKinds = (h, sinceId = 0) => h.db.prepare('SELECT id, kind, request_id FROM fake_paypal_calls WHERE id > ? ORDER BY id').all(sinceId);
const lastFakeId = (h) => h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM fake_paypal_calls').get().n;
const captureRequests = (h, orderId) => fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${orderId}:capture:1`);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const totalOf = (h, orderId) => h.db.prepare('SELECT total_cents FROM supplier_orders WHERE id = ?').get(orderId).total_cents;
const reconcilerOf = (h, saga = h.app.deps.saga) => createReconciler(h.app.deps, { saga });
const settle = async (h, rec, saga = h.app.deps.saga) => {
  const summary = await rec.tick();
  await saga.idle();
  await h.app.deps.saga.idle();
  return summary;
};
const logs = (h, msg) => h.logEntries().filter((l) => l.msg === msg);

describe('RS-22: compensation (step 5)', () => {
  test('RS-22: the second capture is declined: plan non_executable (CAPTURE_FAILED, supplier B), reservation reconciling then released, every operation carries the cancellation, void and refund keys are the deterministic ones', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();

    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason], ['non_executable', 'CAPTURE_FAILED']);
    assert.deepEqual(JSON.parse(row.reason_detail_json), { supplierCode: 'B' });
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['refunded', 'voided']);
    for (const code of ['A', 'B']) {
      assert.ok(op(h, w.orders[code]).cancel_requested_at, `${code}: cancel_requested_at`);
      assert.equal(op(h, w.orders[code]).cancel_reason, 'CAPTURE_FAILED');
    }
    assert.deepEqual(fakeCalls(h, 'refund').map((c) => c.request_id), [`so:${w.orders.A}:refund:1`]);
    assert.deepEqual(fakeCalls(h, 'void').map((c) => c.request_id), [`so:${w.orders.B}:void:1`]);
    assert.equal(captureRequests(h, w.orders.B).length, 1, 'a declined capture is never sent again');
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.ok(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.compensate' AND entity_id = ?").get(w.planId).n === 1, 'one compensation');
    assert.equal(logs(h, 'saga.lease_lost').length, 0);
  });

  test('RS-22: compensation after the post-claim authorization check (AUTHORIZATION_EXPIRED): the queued captures are cancelled, nothing was captured, both authorizations are voided', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare("UPDATE fake_paypal_authorizations SET expiration_time = ? WHERE id = ?").run(iso(h.clock.now() + 60_000), op(h, w.orders.B).provider_authorization_id);
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();

    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason], ['non_executable', 'AUTHORIZATION_EXPIRED']);
    assert.deepEqual(JSON.parse(row.reason_detail_json), { supplierCode: 'B' });
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.deepEqual(['A', 'B'].map((c) => callOf(h, w.orders[c], 'capture').status), ['cancelled', 'cancelled']);
    assert.deepEqual(['A', 'B'].map((c) => op(h, w.orders[c]).status), ['voided', 'voided']);
    assert.equal(reservation(h, w.reservationId).status, 'released');
  });

  test('RS-22: the refund results decide the release: refunded releases with restock rows, refund_pending keeps the reservation reconciling until it is polled to COMPLETED, refund_failed escalates and never releases', async () => {
    for (const [fault, expected] of [
      [null, { op: 'refunded', reservation: 'released', escalation: null, restock: 2 }],
      ['refund_pending', { op: 'refund_pending', reservation: 'reconciling', escalation: null, restock: 0 }],
      ['refund_failed', { op: 'refund_failed', reservation: 'reconciling', escalation: 'REFUND_FAILED', restock: 0 }],
    ]) {
      const h = await start();
      const w = await world(h);
      arm(h, 'capture_declined', { value: 'B' });
      if (fault) arm(h, fault, { value: 'A' });
      assert.equal((await execute(w)).status, 202);
      await h.app.deps.saga.idle();
      const rec = reconcilerOf(h);
      await settle(h, rec);
      const restock = () => h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'").get().n;
      assert.equal(op(h, w.orders.A).status, expected.op, `${fault}: operation`);
      assert.equal(reservation(h, w.reservationId).status, expected.reservation, `${fault}: reservation`);
      assert.equal(reservation(h, w.reservationId).escalation, expected.escalation, `${fault}: escalation`);
      assert.equal(restock(), expected.restock, `${fault}: restock rows`);
      if (fault === 'refund_pending') {
        h.db.prepare("UPDATE fake_paypal_refunds SET status = 'COMPLETED'").run();
        await settle(h, rec);
        assert.equal(op(h, w.orders.A).status, 'refunded');
        assert.equal(reservation(h, w.reservationId).status, 'released');
        assert.equal(restock(), 2, 'released once, with one restock row per item');
      }
      if (fault === 'refund_failed') {
        const buyer = await signIn(h, 'cafe1');
        assert.equal((await buyer.get(`/api/requests/${w.requestId}`)).json.rescueStatus.status, 'failed_needs_attention');
      }
      assert.equal(fakeCalls(h, 'refund').length, 1, `${fault}: the refund is sent once`);
    }
  });

  test('SEC-F-1: a compensation refund the provider REJECTS (http 422) ends refund_failed, never refunded: the reservation stays reconciling with REFUND_FAILED and is not restocked, and the buyer sees failed_needs_attention', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'http_422:refund', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const rec = reconcilerOf(h);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(20_000);
      await settle(h, rec);
    }
    // the outcome of the rejected refund (calls.js, APPLY.refund, outcome.kind 'rejected')
    assert.equal(op(h, w.orders.A).status, 'refund_failed', 'a rejected refund is refund_failed');
    assert.equal(op(h, w.orders.A).last_error_code, 'INJECTED_UNPROCESSABLE', 'with the provider issue');
    assert.equal(callOf(h, w.orders.A, 'refund').status, 'failed');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_refunds').get().n, 0, 'no money came back at the provider');
    assert.equal(fakeCalls(h, 'refund').length, 1, 'a rejected refund is not sent again');
    // the reservation
    const res = reservation(h, w.reservationId);
    assert.equal(res.status, 'reconciling');
    assert.equal(res.escalation, 'REFUND_FAILED');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'").get().n, 0, 'nothing is restocked');
    // the buyer
    const view = await w.cafe1.get(`/api/requests/${w.requestId}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.rescueStatus.status, 'failed_needs_attention');
    assert.equal(JSON.stringify(view.json).includes('"status":"refunded"'), false, 'nothing in the view reads refunded');
  });

  test('RS-22: compensation is ONE transaction under the fence: when it fails nothing is half done, and the next holder completes it', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    // The refund of the first capture is the last write of the compensation; refusing it must undo the plan, the reservation, the
    // cancellations and the void as well.
    h.db.prepare("CREATE TRIGGER no_refund_rows BEFORE INSERT ON provider_calls WHEN NEW.kind = 'refund' BEGIN SELECT RAISE(ABORT, 'test: refund rows refused'); END").run();
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();

    assert.equal(plan(h, w.planId).status, 'executing', 'rolled back as a whole');
    assert.equal(reservation(h, w.reservationId).status, 'consumed');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM payment_operations WHERE cancel_requested_at IS NOT NULL').get().n, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind IN ('void', 'refund')").get().n, 0);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(logs(h, 'saga.failed').length, 1, 'the failure is logged, not swallowed');

    h.db.prepare('DROP TRIGGER no_refund_rows').run();
    await settle(h, reconcilerOf(h));
    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason, row.lease_epoch], ['non_executable', 'CAPTURE_FAILED', 2]);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['refunded', 'voided']);
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'the captured operation was never captured again');
  });

  test('FU-42: capture and refund both use supplier_orders.total_cents although payment_operations.amount_cents disagrees', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare('UPDATE payment_operations SET amount_cents = amount_cents + 7').run();
    arm(h, 'capture_declined', { value: 'B' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refunded');
    const capture = h.db.prepare('SELECT amount_cents FROM fake_paypal_captures WHERE id = ?').get(op(h, w.orders.A).provider_capture_id);
    const refund = h.db.prepare('SELECT amount_cents FROM fake_paypal_refunds WHERE id = ?').get(op(h, w.orders.A).provider_refund_id);
    assert.equal(capture.amount_cents, totalOf(h, w.orders.A));
    assert.equal(refund.amount_cents, totalOf(h, w.orders.A), 'the refund returns what the capture took');
    assert.notEqual(op(h, w.orders.A).amount_cents, totalOf(h, w.orders.A));
  });
});

describe('RS-22: a PENDING capture keeps the lease epoch constant (F-TR-7)', () => {
  test('RS-22: capture_pending across many ticks, with the lease long lapsed: lease_epoch stays 1, nothing is sent, the second capture never starts; completion resumes under epoch 2', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.equal(plan(h, w.planId).lease_epoch, 1);
    const rec = reconcilerOf(h);
    const mark = lastFakeId(h);
    for (let i = 1; i <= 5; i += 1) {
      h.clock.advance(h.config.sagaLeaseMs + 1_000);
      const summary = await settle(h, rec);
      assert.equal(summary.takenOver, 0, `tick ${i}: no takeover`);
      assert.equal(plan(h, w.planId).lease_epoch, 1, `tick ${i}: lease_epoch constant`);
      assert.equal(plan(h, w.planId).status, 'executing');
      assert.equal(op(h, w.orders.A).status, 'capture_pending');
    }
    assert.ok(lastFakeId(h) > mark, 'the pending capture is polled');
    assert.ok(fakeKinds(h, mark).every((c) => c.kind === 'get_capture'), 'and nothing but polled');
    assert.equal(fakeCalls(h, 'capture').length, 1, 'the second capture was not started');

    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();
    h.clock.advance(POLL_EVERY_TICK_MS + 1); // after 5 minutes a pending state is polled every 5 minutes
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2, 'one takeover, after the pending state was resolved');
    assert.equal(fakeCalls(h, 'capture').length, 2);
    assert.equal(logs(h, 'saga.takeover').length, 1);
  });

  test('RS-22: an unknown capture that cannot be read yet (the provider answers 500) also keeps the epoch constant; once read, the same key is sent again after the saga\'s own read', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    arm(h, 'http_500:get_authorization', { remaining: 3 });
    const rec = reconcilerOf(h);
    for (let i = 1; i <= 3; i += 1) {
      h.clock.advance(h.config.sagaLeaseMs + 1_000);
      const summary = await settle(h, rec);
      assert.equal(summary.takenOver, 0, `tick ${i}`);
      assert.equal(plan(h, w.planId).lease_epoch, 1, `tick ${i}: lease_epoch constant while the operation is unknown`);
      assert.equal(op(h, w.orders.A).status, 'unknown');
    }
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'nothing was sent while the read failed');

    await settle(h, rec);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    assert.equal(captureRequests(h, w.orders.A).length, 2, 'the faulted send and the one re-send, one key');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'one capture per authorization');
  });
});

describe('ARCH-23 / step 6: the takeover', () => {
  test('ARCH-23: the epoch grows by exactly one, in one step, and only when lease_until <= now: one millisecond earlier nothing happens', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    const lease = plan(h, w.planId);
    assert.equal(lease.lease_epoch, 1);
    const rec = reconcilerOf(h);

    h.clock.advance(Date.parse(lease.lease_until) - h.clock.now() - 1);
    assert.equal((await settle(h, rec)).takenOver, 0, 'lease_until is still one millisecond away');
    assert.deepEqual([plan(h, w.planId).lease_epoch, plan(h, w.planId).executor_id], [1, lease.executor_id]);
    assert.equal(fakeCalls(h, 'capture').length, 0);

    h.clock.advance(1);
    assert.equal((await settle(h, rec)).takenOver, 1, 'lease_until <= now');
    const taken = plan(h, w.planId);
    assert.equal(taken.lease_epoch, 2);
    assert.equal(taken.status, 'executed');
    const audit = h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'saga.takeover' AND entity_id = ?").all(w.planId);
    assert.deepEqual(audit.map((a) => JSON.parse(a.detail_json)), [{ epoch: 2 }]);
    assert.deepEqual(captureRequests(h, w.orders.A).concat(captureRequests(h, w.orders.B)).length, 2, 'one capture per order');
  });

  test('ARCH-23: a stalled sender whose call went stale is READ by the reconciler (the capture is found) and its late result is fenced by the send_token, with no takeover and no second capture', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    let release;
    let applied;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const appliedSeen = new Promise((resolve) => {
      applied = resolve;
    });
    let held = false;
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        const outcome = await real.captureAuthorization(args);
        if (!held) {
          held = true;
          applied();
          await gate; // the answer is held back: a stalled executor
        }
        return outcome;
      },
    };
    assert.equal((await execute(w)).status, 202);
    await appliedSeen;
    const started = callOf(h, w.orders.A, 'capture');
    assert.ok(started.send_token && started.status === 'intent', 'started, not recorded');
    const lease = plan(h, w.planId);

    // Older than 2 x the provider timeout but inside the lease: the reconciler may make the call unknown and read, never take over.
    h.clock.advance(2 * h.config.paypalTimeoutMs + 1);
    assert.ok(h.clock.now() < Date.parse(lease.lease_until));
    const mark = lastFakeId(h);
    const otherProcess = createSaga(h.app.deps, { executorId: 'other-host:4242:cafebabe' });
    const summary = await reconcilerOf(h, otherProcess).tick(); // not settle(): the stalled run of this process is still held
    await otherProcess.idle();
    assert.equal(summary.stale, 1);
    assert.equal(summary.takenOver, 0);
    assert.equal(op(h, w.orders.A).status, 'captured', 'resolved by reading the provider');
    assert.deepEqual(fakeKinds(h, mark).map((c) => c.kind), ['get_authorization', 'get_order'], 'reads only: no capture is sent');
    assert.equal(callOf(h, w.orders.A, 'capture').send_token, null);

    release();
    await h.app.deps.saga.idle();
    assert.equal(logs(h, 'provider.result_fenced').length, 1, 'the late result was discarded');
    assert.equal(logs(h, 'saga.lease_lost').length, 1, 'and the stalled executor stopped');
    assert.deepEqual([plan(h, w.planId).lease_epoch, plan(h, w.planId).executor_id], [1, lease.executor_id], 'the epoch never changed');
    assert.equal(captureRequests(h, w.orders.A).length, 1);
    assert.equal(callOf(h, w.orders.A, 'capture').status, 'succeeded', 'the reconciler\'s resolution stands');

    // the lease lapses; the next holder captures B only
    h.app.deps.payments = real;
    h.clock.advance(h.config.sagaLeaseMs);
    const before = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.deepEqual(fakeKinds(h, before).filter((c) => c.kind === 'capture').map((c) => c.request_id), [`so:${w.orders.B}:capture:1`]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2);
  });

  test('ARCH-23: the epoch is a fence of its own: a capture result is refused after the epoch changed although its send_token is still valid; saga.lease_lost is logged and the stalled executor sends nothing more', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    let release;
    let applied;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const appliedSeen = new Promise((resolve) => {
      applied = resolve;
    });
    let held = false;
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        const outcome = await real.captureAuthorization(args);
        if (!held) {
          held = true;
          applied();
          await gate;
        }
        return outcome;
      },
    };
    assert.equal((await execute(w)).status, 202);
    await appliedSeen;
    const token = callOf(h, w.orders.A, 'capture').send_token;
    assert.ok(token);
    // another process took the plan over inside the lease window; the call row itself was not touched
    h.db.prepare("UPDATE plan_versions SET lease_epoch = lease_epoch + 1, executor_id = 'thief:1:00000000' WHERE id = ?").run(w.planId);
    release();
    await h.app.deps.saga.idle();
    const call = callOf(h, w.orders.A, 'capture');
    assert.deepEqual([call.status, call.send_token], ['intent', token], 'discarded, not recorded');
    assert.equal(op(h, w.orders.A).status, 'authorized');
    assert.equal(logs(h, 'provider.result_fenced').length, 1);
    assert.equal(logs(h, 'saga.lease_lost').length, 1);
    assert.equal(captureRequests(h, w.orders.B).length, 0, 'the stalled executor did not go on to the next order');
    assert.equal(plan(h, w.planId).executor_id, 'thief:1:00000000');
    assert.equal(plan(h, w.planId).status, 'executing');
  });

  test('ARCH-23: a capture is not started without the lease: after lease_until nobody has taken over, a start is refused (G(now) needs lease_until > now) and the reconciler resumes the plan', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    h.clock.advance(h.config.sagaLeaseMs + 1);
    assert.equal(await h.app.deps.saga.start(w.planId, 1), 'lost');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(plan(h, w.planId).lease_epoch, 1);
    await settle(h, reconcilerOf(h));
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
  });

  test('ARCH-23: the capture start itself needs the lease (step 3, not only step 2): a resumed run whose lease lapsed sends nothing', async () => {
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
    h.app.deps.payments = real;
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(plan(h, w.planId).lease_until, iso(h.clock.now()), 'paused: the lease is lapsed');

    // The same executor identity starts a run on its old lease: a capture was sent, so it resumes at step 3, where only G(now) stands guard.
    const same = createSaga(h.app.deps, { executorId: h.app.deps.saga.executorId });
    assert.equal(await same.start(w.planId, 1), 'paused');
    assert.equal(captureRequests(h, w.orders.B).length, 0, 'no capture without the lease');
    assert.equal(plan(h, w.planId).lease_epoch, 1);
    assert.equal(op(h, w.orders.B).status, 'authorized');
  });

  test('FU-41(a): before the lease holder sends an unknown capture again it reads the authorization itself; one that is CAPTURED by then is held, never sent, and resolved by the reconciler', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    const real = h.app.deps.payments;
    const authId = op(h, w.orders.A).provider_authorization_id;
    let reads = 0;
    h.app.deps.payments = {
      ...real,
      async getAuthorization(args) {
        reads += 1;
        // the reconciler's read (1) sees CREATED; a capture lands at the provider before the saga's own read (2)
        if (reads === 2) {
          const landed = await real.captureAuthorization({
            merchantKey: args.merchantKey, requestId: 'external-capture-0001', authorizationId: authId, amountCents: totalOf(h, w.orders.A), currency: 'USD', invoiceId: 'external-1',
          });
          assert.equal(landed.kind, 'ok');
        }
        return real.getAuthorization(args);
      },
    };
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(reads >= 2, true, 'the saga read the authorization again under its lease');
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'only the faulted send: the held operation was not sent again');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1, 'the external capture is the only one');
    // TR-F-1: a held read puts the operation back to unknown (prev_status authorized), so it is never taken over again until read
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'authorized');
    assert.equal(callOf(h, w.orders.A, 'capture').status, 'unknown');
    assert.equal(logs(h, 'saga.resend_held').length, 1);
    assert.equal(plan(h, w.planId).status, 'executing');

    h.app.deps.payments = real;
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'captured', 'resolved from the provider state');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'never sent again');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2);
  });

  test('FU-41(a): the saga\'s own read comes first in the trail of a re-send: get_authorization (reconciler), get_authorization (lease holder), then the capture with the SAME key', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const mark = lastFakeId(h);
    await settle(h, reconcilerOf(h));
    const trail = fakeKinds(h, mark);
    assert.deepEqual(trail.map((c) => c.kind), ['get_authorization', 'get_authorization', 'capture', 'capture']);
    assert.equal(trail[2].request_id, `so:${w.orders.A}:capture:1`);
    assert.equal(trail[3].request_id, `so:${w.orders.B}:capture:1`);
  });

  test('FU-41(a): a read that fails under the lease sends nothing; the operation stays unknown-resolvable and the next tick completes the plan', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const real = h.app.deps.payments;
    let reads = 0;
    h.app.deps.payments = {
      ...real,
      async getAuthorization(args) {
        reads += 1;
        if (reads === 2) return { kind: 'unknown', reason: 'timeout' }; // the saga's read
        return real.getAuthorization(args);
      },
    };
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'no send on a failed read');
    assert.equal(logs(h, 'saga.resend_read_failed').length, 1);
    assert.equal(plan(h, w.planId).status, 'executing');
    await settle(h, rec);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(captureRequests(h, w.orders.A).length, 2);
  });

  test('TR-F-1 (FU-49): the reconciler restores the operation to authorized (call still unknown) and every later read fails: the plan is not taken over every tick, it escalates after RS_UNKNOWN_ESCALATE_MIN, and once the reads recover the same key is sent once', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(plan(h, w.planId).lease_epoch, 1);
    const unknownSince = op(h, w.orders.A).unknown_since;
    assert.ok(unknownSince, 'the timeout set unknown_since');

    // The reconciler's first read (step 2) works and shows CREATED; from then on the provider's read endpoint is down.
    const real = h.app.deps.payments;
    let reads = 0;
    h.app.deps.payments = {
      ...real,
      async getAuthorization(args) {
        reads += 1;
        const out = await real.getAuthorization(args);
        if (reads === 1) arm(h, 'http_500:get_authorization', { remaining: null });
        return out;
      },
    };
    const rec = reconcilerOf(h);
    const status = async () => (await w.cafe1.get(`/api/requests/${w.requestId}`)).json.rescueStatus;
    const takeovers = () => h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'saga.takeover' AND entity_id = ?").get(w.planId).n;
    h.clock.advance(60_000); // the first tick comes a minute after the timeout: the escalation clock still starts at the timeout
    await settle(h, rec);
    const readsAfterFirstTick = reads;
    const epochs = [plan(h, w.planId).lease_epoch];
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      h.clock.advance(150_000); // 2.5 minutes a tick: 20 minutes in all, beyond RS_UNKNOWN_ESCALATE_MIN (15)
      await settle(h, rec);
      epochs.push(plan(h, w.planId).lease_epoch);
      statuses.push((await status()).status);
    }
    // no send while no read succeeds, and the plan is still waiting for the provider
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'nothing is sent while the reads fail');
    assert.equal(fakeCalls(h, 'capture').length, 1, 'B is not captured before A is resolved');
    assert.equal(plan(h, w.planId).status, 'executing');
    // The epoch is bounded: 1 at the timeout + exactly one takeover (the one the reconciler's successful read allowed). It does not grow
    // with the ticks (the reviewer measured 2..10 over these 8 ticks before the fix).
    assert.ok(Math.max(...epochs) <= 2, `lease_epoch stays <= 2: ${epochs.join(',')}`);
    assert.ok(takeovers() <= 1, `at most one takeover row: ${takeovers()}`);
    // one read a tick (the reconciler's): the holder does not read again once the operation is unknown
    assert.equal(reads - readsAfterFirstTick, 8, 'one failing read per tick, not two');
    // the unknown is measured from the original timeout, not from the holder's last attempt
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'authorized');
    assert.equal(op(h, w.orders.A).unknown_since, unknownSince, 'the original unknown_since is kept');
    // Row 2: not before RS_UNKNOWN_ESCALATE_MIN (15 min = tick 6 at 2.5 min), then failed_needs_attention
    assert.equal(statuses[3] === 'failed_needs_attention', false, `10 minutes: not escalated yet (${statuses[3]})`);
    assert.equal(statuses[7], 'failed_needs_attention', `20 minutes: escalated (${statuses.join(',')})`);

    // Recovery: the reads come back. The reconciler reads CREATED, the lease holder reads CREATED, the SAME key is sent once.
    h.db.prepare("DELETE FROM fault_flags WHERE name = 'fake_paypal:http_500:get_authorization'").run();
    h.clock.advance(150_000);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.B).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(captureRequests(h, w.orders.A).length, 2, 'the faulted send and ONE re-send, with the same PayPal-Request-Id');
    assert.equal(captureRequests(h, w.orders.B).length, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'one capture per authorization: money moved once');
    assert.equal(plan(h, w.planId).lease_epoch, 3, 'the recovery is one more takeover');
    assert.equal((await status()).status, 'purchase_confirmed');
  });

  test('TR-F-1 fencing (SEC-F-I2): a STALE holder whose pre-resend read fails after a takeover writes nothing: the operation stays authorized for the new holder, which sends once; the stale one logs saga.lease_lost', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const real = h.app.deps.payments;
    const gates = {};
    const open = {};
    for (const n of [2, 4]) gates[n] = new Promise((resolve) => { open[n] = resolve; });
    let reads = 0;
    h.app.deps.payments = {
      ...real,
      async getAuthorization(args) {
        reads += 1;
        const n = reads;
        // 1: reconciler (tick 1); 2: holder of epoch 2 (held, then FAILS); 3: reconciler (tick 2); 4: holder of epoch 3 (held, then reads for real)
        if (n === 2) {
          await gates[2];
          return { kind: 'unknown', reason: 'timeout' };
        }
        if (n === 4) {
          await gates[4];
        }
        return real.getAuthorization(args);
      },
    };
    const until = async (cond) => {
      for (let i = 0; i < 500 && !cond(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(cond(), 'condition reached');
    };
    const rec = reconcilerOf(h);
    await rec.tick(); // takeover to epoch 2; its run blocks in the held read
    await until(() => reads >= 2);
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    h.clock.advance(h.config.sagaLeaseMs + 1000); // the stale holder's lease lapses
    await rec.tick(); // takeover to epoch 3 (the operation is authorized, no unknown); its run blocks in the held read
    await until(() => reads >= 4);
    assert.equal(plan(h, w.planId).lease_epoch, 3);
    assert.equal(op(h, w.orders.A).status, 'authorized');

    open[2](); // the stale holder's read now fails: it must not touch the operation
    await until(() => logs(h, 'saga.lease_lost').length >= 1 || op(h, w.orders.A).status !== 'authorized');
    assert.equal(op(h, w.orders.A).status, 'authorized', 'the stale holder did not move the operation to unknown');
    assert.equal(logs(h, 'saga.lease_lost').length, 1, 'the stale holder logged saga.lease_lost');
    assert.equal(plan(h, w.planId).lease_epoch, 3);
    assert.equal(captureRequests(h, w.orders.A).length, 1, 'the stale holder sent nothing');

    open[4](); // the epoch-3 holder reads CREATED and sends the same key once
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(captureRequests(h, w.orders.A).length, 2);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'one capture per authorization');
  });

  test('FU-41(b): an operation that becomes unknown after the takeover and before the resumed run: the saga pauses and sends nothing, and does not compensate', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();

    const taker = createSaga(h.app.deps, { executorId: 'host-2:77:00112233' });
    const interposed = {
      executorId: taker.executorId,
      start(planId, epoch) {
        // between the takeover (epoch 2, committed) and the resumed run: B's capture turns unknown (an answer was lost elsewhere)
        h.db.prepare("UPDATE payment_operations SET status = 'unknown', prev_status = 'authorized', unknown_since = ? WHERE supplier_order_id = ?").run(iso(h.clock.now()), w.orders.B);
        return taker.start(planId, epoch);
      },
    };
    const sendsBefore = fakeCalls(h, 'capture').length;
    const mark = lastFakeId(h);
    const summary = await settle(h, reconcilerOf(h, interposed), taker);
    assert.equal(summary.takenOver, 1);
    assert.equal(op(h, w.orders.A).status, 'captured', 'the poll of the same tick completed A');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    assert.equal(op(h, w.orders.B).status, 'unknown', 'untouched');
    assert.equal(plan(h, w.planId).status, 'executing', 'not compensated, not executed');
    assert.equal(reservation(h, w.reservationId).status, 'consumed');
    assert.equal(fakeCalls(h, 'capture').length, sendsBefore, 'nothing was sent');
    assert.deepEqual(fakeKinds(h, mark).filter((c) => c.kind !== 'get_capture' && c.kind !== 'get_authorization'), []);
    assert.equal(plan(h, w.planId).lease_until, iso(h.clock.now()), 'paused: lease_until = now');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM payment_operations WHERE cancel_requested_at IS NOT NULL').get().n, 0);
  });

  test('FU-41(b): the same for an operation that becomes capture_pending after the takeover', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();

    const taker = createSaga(h.app.deps, { executorId: 'host-2:77:00112233' });
    const interposed = {
      executorId: taker.executorId,
      start(planId, epoch) {
        h.db.prepare("UPDATE payment_operations SET status = 'capture_pending', provider_capture_id = 'FAKECAP-ELSEWHERE', pending_since = ? WHERE supplier_order_id = ?").run(iso(h.clock.now()), w.orders.B);
        return taker.start(planId, epoch);
      },
    };
    const sendsBefore = fakeCalls(h, 'capture').length;
    await settle(h, reconcilerOf(h, interposed), taker);
    assert.equal(op(h, w.orders.B).status, 'capture_pending');
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(fakeCalls(h, 'capture').length, sendsBefore);
    assert.equal(reservation(h, w.reservationId).status, 'consumed');
  });

  test('ARCH-23: a capture that got a retryable answer (429) is resumed by a takeover once its back-off is over, with the same key', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'http_429:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const queued = callOf(h, w.orders.A, 'capture');
    assert.deepEqual([queued.status, queued.started_at], ['intent', null]);
    const rec = reconcilerOf(h);
    h.clock.advance(h.config.sagaLeaseMs); // the lease lapsed, the back-off (5 s) did too
    assert.equal(Date.parse(queued.next_attempt_at) < h.clock.now(), true);
    await settle(h, rec);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    assert.equal(captureRequests(h, w.orders.A).length, 2, 'the 429 and the re-send under the same key');
  });
});
