// RS-26 (spec: Payment saga step 6, Recovery): the process that runs the saga is killed with SIGKILL right after the first capture, a
// new process starts on the same database, the lease runs out, and the reconciler completes the purchase. Lease 1500 ms, provider
// timeout 500 ms, reconcile interval 200 ms (the restart waits for the lease; nothing here sleeps for a time).
//
// The kill is made deterministic with the RS_TEST_HOOKS freeze (the process stops itself with SIGSTOP once the fake has applied the
// capture); the test waits for the stopped state, takes a snapshot of every money and stock row, and then sends SIGKILL.
//   Round 1  freeze_after_capture_apply on supplier A: A's capture is applied at the provider but its result was never recorded.
//   Round 2  the same hook on supplier B: A's capture is recorded (operation `captured`), B's is applied and not recorded.
//   Expected, both rounds, after the restart:
//   - the restarted process takes the plan over (epoch 2, one audited takeover) and the plan ends `executed`, both operations `captured`;
//   - the restarted process READS the provider before it does anything: no capture is sent again (exactly one capture call per order,
//     none replayed, request ids so:<id>:capture:1) and the provider holds exactly one capture per order;
//   - every row that existed at the kill is still there; append-only rows (ledger, audit, provider call log, captures) are unchanged;
//   - the reservation was consumed once (one consume ledger row per item) and the log of the new process holds no error line.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_PASSWORD, armFault, assertHealthyLogs, assertRowsPreserved, authorizedPlan, fakeCallsSince, isLinux, killHard, lastFakeCallId, logLines,
  planStatus, readDb, restartServer, signedIn, snapshotRows, startPair, waitExecuted, waitStopped, waitTicks,
} from '../helpers/saga-flow.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function round({ frozenSupplier, label }) {
  const { first, demoDate, env } = await startPair({ cleanups, second: false });
  const db = readDb(first.dbPath, cleanups);
  const { cafe1, plan, orders } = await authorizedPlan(first, demoDate, label, db);
  const admin = await signedIn(first, 'admin', ADMIN_PASSWORD);
  await armFault(admin, { fault: 'freeze_after_capture_apply', supplierCode: frozenSupplier });
  const baseline = lastFakeCallId(db);

  const executed = await cafe1.post(`/api/plans/${plan.id}/execute`, {});
  assert.equal(executed.status, 202, executed.text);
  await waitStopped(first.pid, `the process to freeze after the capture of supplier ${frozenSupplier}`);
  const captured = db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_captures").get().n;
  const recordedBeforeKill = db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'captured'").get().n;
  const frozenIndex = frozenSupplier === 'A' ? 1 : 2;
  assert.equal(captured, frozenIndex, `${frozenIndex} capture(s) applied at the provider when the process stopped`);
  assert.equal(recordedBeforeKill, frozenIndex - 1, 'the capture of the frozen call was applied but its result was not recorded');
  assert.equal(planStatus(db, plan.id).status, 'executing');
  const before = snapshotRows(db);

  // The kill, then the restart on the same database file.
  const killed = await killHard(first);
  assert.equal(killed.signal, 'SIGKILL');
  const restarted = await restartServer(first, env, cleanups);
  assert.equal(restarted.dbPath, first.dbPath);

  const done = await waitExecuted(db, plan.id);
  assert.equal(done.epoch, 2, 'one takeover: epoch 1 -> 2');
  assert.ok(done.executorId.includes(`:${restarted.pid}:`), `the restarted process completed the plan (${done.executorId})`);
  await waitTicks(db, 3);
  return { first, restarted, db, plan, orders, baseline, before };
}

function assertCompleted({ restarted, db, plan, orders, baseline, before }) {
  // All rows preserved.
  assertRowsPreserved(before, snapshotRows(db));

  // The purchase is complete exactly once.
  assert.equal(db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'executed');
  const ops = db.prepare('SELECT supplier_order_id AS orderId, status, provider_capture_id AS captureId FROM payment_operations ORDER BY supplier_order_id').all();
  assert.deepEqual(ops.map((o) => o.status), ['captured', 'captured']);
  assert.ok(ops.every((o) => /^FAKECAP-/.test(o.captureId)));
  assert.equal(db.prepare("SELECT status FROM reservations WHERE plan_version_id = ?").get(plan.id).status, 'consumed');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'consume'").get().n,
    db.prepare('SELECT COUNT(*) AS n FROM reservation_items').get().n,
    'consumed once',
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'").get().n, 0, 'nothing was restocked');
  assert.deepEqual(
    db.prepare("SELECT detail_json AS detail FROM audit_events WHERE action = 'saga.takeover'").all().map((r) => JSON.parse(r.detail)),
    [{ epoch: 2 }],
    'one takeover audited',
  );
  assert.ok(logLines(restarted, 'saga.takeover').length >= 1, 'the restarted process logged saga.takeover');

  // The provider: one capture per order, none sent twice.
  const calls = fakeCallsSince(db, baseline);
  const captures = calls.filter((c) => c.kind === 'capture');
  assert.deepEqual(
    captures.map((c) => c.requestId).sort(),
    orders.map((o) => `so:${o.id}:capture:1`).sort(),
    'exactly one capture call per supplier order, with request id so:<id>:capture:1',
  );
  assert.ok(captures.every((c) => c.replayed === 0), 'no capture was replayed: the new process read the provider instead of sending again');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, orders.length);
  assert.equal(calls.filter((c) => ['void', 'refund', 'authorize'].includes(c.kind)).length, 0, 'no void, refund or authorize call');
  assert.ok(calls.some((c) => c.pid === restarted.pid && c.kind.startsWith('get_')), 'the restarted process read the provider state');
  assertHealthyLogs(restarted);
}

describe('RS-26: SIGKILL after the first capture, restart, lease expiry, the reconciler completes the purchase', { skip: isLinux ? false : 'SIGSTOP and /proc are Linux only' }, () => {
  test('RS-26: killed with the first capture applied at the provider and not recorded: the new process reads it, captures supplier B, the plan is executed', { timeout: 180000 }, async () => {
    const ctx = await round({ frozenSupplier: 'A', label: 'rs26a' });
    // Supplier A's capture was made by the dead process; only supplier B's was sent by the new one.
    const calls = fakeCallsSince(ctx.db, ctx.baseline).filter((c) => c.kind === 'capture');
    assert.deepEqual(calls.map((c) => c.pid), [ctx.first.pid, ctx.restarted.pid]);
    assertCompleted(ctx);
  });

  test('RS-26: killed after the first capture was recorded and the second applied: the recorded row is kept, the second is read, the plan is executed', { timeout: 180000 }, async () => {
    const ctx = await round({ frozenSupplier: 'B', label: 'rs26b' });
    const calls = fakeCallsSince(ctx.db, ctx.baseline).filter((c) => c.kind === 'capture');
    assert.deepEqual(calls.map((c) => c.pid), [ctx.first.pid, ctx.first.pid], 'both captures were made by the dead process; the new one sent none');
    assertCompleted(ctx);
  });
});
