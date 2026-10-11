// ARCH-26 (lease takeover during an in-flight capture is not fenced by the provider) and RS-26: two real server processes serve one
// SQLite file, lease 1500 ms, provider timeout 500 ms, reconcile interval 200 ms. Process 1 executes the plan and then FREEZES ITSELF
// (the RS_TEST_HOOKS fault sends it SIGSTOP) in the middle of the capture of supplier A:
//   variant A  freeze_after_capture_apply   the fake applied the capture, the result was not recorded yet;
//   variant B  freeze_before_capture_apply  the capture was started (call `intent`, send token set) but never reached the provider.
// The lease runs out, the stale intent becomes `unknown` (2 x timeout), process 2 reads the provider's state, takes the plan over
// (epoch + 1) and completes it. The test then sends SIGCONT to process 1 and shows that its late result is fenced.
//   Expected, both variants:
//   - the plan ends `executed` under epoch 2, held by process 2, both operations `captured`;
//   - EXACTLY ONE non-replayed capture call per supplier order, each with PayPal-Request-Id so:<orderId>:capture:1, and N captures at
//     the provider (one per order); no capture with another request id;
//   - after SIGCONT process 1 logs saga.lease_lost and sends nothing of its own.
//   Variant A: process 2 READS the capture (it never sends supplier A's capture again), so the capture calls are exactly one per order.
//   Variant B: process 2 reads CREATED and sends the capture again with the SAME request id (the first non-replayed capture); the frozen
//   request of process 1 then reaches the provider and is answered as a REPLAY (replayed = 1), applying nothing.
// POSIX only (SIGSTOP/SIGCONT, /proc); on other platforms the suite is reported as skipped with the reason. Waits are for database
// rows and for the kernel's process state; the timeouts only bound a hang. The test process only reads the database.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_PASSWORD, armFault, assertHealthyLogs, authorizedPlan, fakeCallsSince, isLinux, lastFakeCallId, logLines, planStatus, processState,
  readDb, resume, signedIn, startPair, waitExecuted, waitForLog, waitStopped, waitTicks,
} from '../helpers/saga-flow.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const MUTATING = ['authorize', 'capture', 'void', 'refund', 'create_order'];
const TEST_TIMEOUT_MS = 180000;

async function runVariant({ fault, label }) {
  const { first, second, demoDate } = await startPair({ cleanups });
  const db = readDb(first.dbPath, cleanups);
  const { cafe1, plan, orders } = await authorizedPlan(first, demoDate, label, db);
  const admin = await signedIn(first, 'admin', ADMIN_PASSWORD);
  await armFault(admin, { fault, supplierCode: 'A' });
  const baseline = lastFakeCallId(db);

  // Process 1 claims the plan and starts the saga; it freezes itself in the capture of supplier A.
  const executed = await cafe1.post(`/api/plans/${plan.id}/execute`, {});
  assert.equal(executed.status, 202, executed.text);
  assert.equal(executed.json.claimed, true);
  await waitStopped(first.pid, 'process 1 to freeze itself (SIGSTOP) in the capture of supplier A');
  const claimed = planStatus(db, plan.id);
  assert.equal(claimed.status, 'executing');
  assert.equal(claimed.epoch, 1);
  assert.ok(claimed.executorId.includes(`:${first.pid}:`), `process 1 holds the lease (${claimed.executorId})`);
  const orderA = orders[0];
  const callA = db.prepare("SELECT status, send_count AS sendCount FROM provider_calls WHERE operation_key = ?").get(`so:${orderA.id}:capture:1`);
  assert.equal(callA.status, 'intent', 'the frozen capture was started and has no result');
  assert.equal(callA.sendCount, 1);

  // Process 2 takes over and completes the plan while process 1 is frozen.
  const done = await waitExecuted(db, plan.id);
  assert.equal(done.epoch, 2, 'exactly one takeover (epoch 1 -> 2)');
  assert.ok(done.executorId.includes(`:${second.pid}:`), `process 2 completed the plan (${done.executorId})`);
  assert.equal(processStillStopped(first), true, 'process 1 stayed frozen until the test continued it');
  const beforeResume = fakeCallsSince(db, baseline);
  const resumeMark = lastFakeCallId(db);
  const takeovers = db.prepare("SELECT detail_json AS detail FROM audit_events WHERE action = 'saga.takeover'").all().map((r) => JSON.parse(r.detail));
  assert.deepEqual(takeovers, [{ epoch: 2 }], 'one takeover audited');
  assert.ok(logLines(second, 'saga.takeover').length >= 1, 'process 2 logged saga.takeover');

  // SIGCONT: the frozen process goes on; its late result is fenced and it sends nothing of its own.
  await resume(first);
  await waitForLog(first, 'saga.lease_lost');
  await waitTicks(db, 3);
  assert.equal(planStatus(db, plan.id).status, 'executed', 'the late result of process 1 changed nothing');
  assert.equal(planStatus(db, plan.id).epoch, 2);
  const afterResume = fakeCallsSince(db, resumeMark);
  return { first, second, db, plan, orders, baseline, beforeResume, afterResume };
}

const processStillStopped = (server) => processState(server.pid) === 'T';

function capturesOf(calls, requestId) {
  return calls.filter((c) => c.kind === 'capture' && c.requestId === requestId);
}

function assertEndState({ db, plan, orders, baseline }, { first, second }) {
  const ops = db.prepare('SELECT supplier_order_id AS orderId, status, provider_capture_id AS captureId FROM payment_operations ORDER BY supplier_order_id').all();
  assert.deepEqual(ops.map((o) => o.status), ['captured', 'captured']);
  assert.ok(ops.every((o) => /^FAKECAP-/.test(o.captureId)));
  assert.equal(db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'executed');
  assert.equal(db.prepare("SELECT status FROM reservations WHERE plan_version_id = ?").get(plan.id).status, 'consumed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, orders.length, 'one capture per supplier order exists at the provider');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_captures WHERE status = 'COMPLETED'").get().n, orders.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_authorizations WHERE status = 'CAPTURED'").get().n, orders.length);
  const all = fakeCallsSince(db, baseline);
  const captures = all.filter((c) => c.kind === 'capture');
  assert.deepEqual(
    captures.filter((c) => c.replayed === 0).map((c) => c.requestId).sort(),
    orders.map((o) => `so:${o.id}:capture:1`).sort(),
    'EXACTLY ONE non-replayed capture per supplier order, with request id so:<id>:capture:1',
  );
  assert.ok(captures.every((c) => orders.some((o) => c.requestId === `so:${o.id}:capture:1`)), 'no capture was sent under another request id');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE kind IN ('void', 'refund')").get().n, 0, 'nothing was voided or refunded');
  // The consumed stock was taken once.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'consume'").get().n,
    db.prepare('SELECT COUNT(*) AS n FROM reservation_items').get().n,
    'the reservation was consumed once: one consume ledger row per reserved item',
  );
  for (const server of [first, second]) assertHealthyLogs(server);
}

describe('ARCH-26 / RS-26: lease takeover during an in-flight capture (two processes, SIGSTOP / SIGCONT, lease 1500 ms, timeout 500 ms, interval 200 ms)', { skip: isLinux ? false : 'SIGSTOP/SIGCONT and /proc are POSIX/Linux only (the spec marks this test POSIX only)' }, () => {
  test('ARCH-26 variant A (freeze_after_capture_apply): process 2 reads the applied capture, completes the plan; the late result of process 1 is fenced', { timeout: TEST_TIMEOUT_MS }, async () => {
    const ctx = await runVariant({ fault: 'freeze_after_capture_apply', label: 'takeovera' });
    const { first, second, orders, beforeResume, afterResume } = ctx;
    const [orderA, orderB] = orders;

    // Supplier A's capture was made by process 1 (applied, then frozen) and is the only capture call of order A: process 2 read it.
    const captureA = capturesOf(beforeResume, `so:${orderA.id}:capture:1`);
    assert.equal(captureA.length, 1, 'order A: one capture call in all (process 2 read the applied capture, it did not send it again)');
    assert.equal(captureA[0].replayed, 0);
    assert.equal(captureA[0].pid, first.pid, 'order A was captured by process 1');
    const captureB = capturesOf(beforeResume, `so:${orderB.id}:capture:1`);
    assert.equal(captureB.length, 1);
    assert.equal(captureB[0].replayed, 0);
    assert.equal(captureB[0].pid, second.pid, 'order B was captured by process 2, the new lease holder');
    const reads = beforeResume.filter((c) => c.pid === second.pid && c.kind.startsWith('get_'));
    assert.ok(reads.length >= 1, 'process 2 read provider state before it sent anything');
    assert.ok(reads[0].id < captureB[0].id, 'the first read of process 2 precedes its capture');

    // After SIGCONT: process 1 sent nothing of its own.
    assert.deepEqual(afterResume.filter((c) => c.pid === first.pid && MUTATING.includes(c.kind)), [], 'process 1 sent no call after it continued');
    assert.deepEqual(afterResume.filter((c) => c.kind === 'capture'), [], 'no capture call after SIGCONT');
    assertEndState(ctx, { first, second });
  });

  test('ARCH-26 variant B (freeze_before_capture_apply): process 2 reads CREATED and sends the capture with the same request id; after SIGCONT the frozen request is a replay', { timeout: TEST_TIMEOUT_MS }, async () => {
    const ctx = await runVariant({ fault: 'freeze_before_capture_apply', label: 'takeoverb' });
    const { first, second, orders, beforeResume, afterResume } = ctx;
    const [orderA, orderB] = orders;

    // Before SIGCONT: nothing of process 1's capture reached the provider; process 2 sent both captures (first sends).
    const resentA = capturesOf(beforeResume, `so:${orderA.id}:capture:1`);
    assert.equal(resentA.length, 1, 'order A: one capture call before SIGCONT');
    assert.equal(resentA[0].replayed, 0, 'it is the first (non-replayed) capture of order A');
    assert.equal(resentA[0].pid, second.pid, 'order A was captured by process 2, with the same request id');
    const readsBefore = beforeResume.filter((c) => c.pid === second.pid && c.kind === 'get_authorization' && c.id < resentA[0].id);
    assert.ok(readsBefore.length >= 1, 'process 2 read the authorization (CREATED) before it sent the capture again');
    const resentB = capturesOf(beforeResume, `so:${orderB.id}:capture:1`);
    assert.equal(resentB.length, 1);
    assert.equal(resentB[0].pid, second.pid);
    assert.deepEqual(beforeResume.filter((c) => c.pid === first.pid && MUTATING.includes(c.kind)), [], 'process 1 had sent nothing to the provider when it froze');

    // After SIGCONT: the frozen request reaches the provider and is answered as a replay; process 1 sends nothing else.
    const lateMutating = afterResume.filter((c) => c.pid === first.pid && MUTATING.includes(c.kind));
    assert.equal(lateMutating.length, 1, 'process 1 completed exactly the one frozen request');
    assert.equal(lateMutating[0].kind, 'capture');
    assert.equal(lateMutating[0].requestId, `so:${orderA.id}:capture:1`);
    assert.equal(lateMutating[0].replayed, 1, 'the frozen request applied as a REPLAY of the same request id');
    assert.equal(afterResume.filter((c) => c.kind === 'capture').length, 1, 'no other capture call after SIGCONT');
    assertEndState(ctx, { first, second });
  });
});
