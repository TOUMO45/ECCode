// F-TR-3 (spec: Return handler, Sender table; test hook crash_after_return_commit): the return handler commits `created -> approved`
// with the authorize call QUEUED (status `intent`, never started) and then the process dies. The call is provably unsent, and the
// Sender table names the reconciler as its sender. Two real server processes on one SQLite file for (c); a killed and a restarted
// process for (a) and (b).
//   (a) restart: after the reconciler's first ticks exactly ONE authorize call exists at the provider and the operation is `authorized`;
//   (b) the reservation expires before the restart (the stored expiry is moved into the past while no process runs): the queued call
//       ends `cancelled`, the operation `voided` locally, ZERO authorize calls exist, and the rescue status leaves `cancelling`;
//   (c) a retryable (429) authorize answer: the call goes back to the queue with next_attempt_at; no reconciler sends it before then;
//       afterwards it is sent again with the same request id and exactly one authorization is created.
// Waits are for database rows; the one real wait is the 5 s back-off of the first retryable answer (calls.js BACKOFF_MS).
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_PASSWORD, SETTLE_TIMEOUT_MS, armFault, armFlagDirect, assertHealthyLogs, confirmedPlan, fakeCallsSince, lastFakeCallId,
  payOrder, readDb, restartServer, signedIn, startPair, waitTicks, writeDb,
} from '../helpers/saga-flow.js';
import { approveAtFake, createPayment, waitFor } from '../helpers/payment-flow.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const operationOf = (db, orderId) => db.prepare('SELECT status, voided_locally AS voidedLocally, cancel_requested_at AS cancelRequestedAt, provider_authorization_id AS authorizationId FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const authorizeCall = (db, orderId) => db.prepare("SELECT status, started_at AS startedAt, send_count AS sendCount, send_token AS sendToken, next_attempt_at AS nextAttemptAt, http_status AS httpStatus FROM provider_calls WHERE operation_key = ?").get(`so:${orderId}:authorize:1`);
const authorizeCalls = (db, baseline = 0) => fakeCallsSince(db, baseline).filter((c) => c.kind === 'authorize');

// Buyer approves supplier A's PayPal order; the return request dies with the process (the connection is cut).
async function approveAndCrash(cafe1, order) {
  const created = await createPayment(cafe1, order.id);
  let failure = null;
  try {
    await approveAtFake(cafe1, created.json.approvalUrl);
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'the return request did not get an answer: the process died after the commit');
  assert.match(String(failure.message ?? failure.code), /socket hang up|ECONNRESET|aborted|terminated/i);
}

// Process 1 dies in the return handler of supplier A's order. Returns the state at the moment of death.
async function crashedAfterReturn(label) {
  const { first, demoDate, env } = await startPair({ cleanups, second: false });
  const db = readDb(first.dbPath, cleanups);
  const flow = await confirmedPlan(first, demoDate, label);
  const admin = await signedIn(first, 'admin', ADMIN_PASSWORD);
  await armFault(admin, { fault: 'crash_after_return_commit', supplierCode: 'A' });
  const baseline = lastFakeCallId(db);
  const [orderA] = flow.orders;
  await approveAndCrash(flow.cafe1, orderA);
  const killed = await first.exited;
  assert.equal(killed.signal, 'SIGKILL', 'the process killed itself');

  // The committed state at the moment of death: approved, and the authorize call queued and never sent.
  assert.equal(operationOf(db, orderA.id).status, 'approved');
  const call = authorizeCall(db, orderA.id);
  assert.equal(call.status, 'intent');
  assert.equal(call.startedAt, null, 'the call is queued: it was never started');
  assert.equal(call.sendCount, 0);
  assert.equal(authorizeCalls(db, baseline).length, 0, 'no authorize call reached the provider');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 0, 'no authorization exists at the provider');
  return { ...flow, first, env, db, baseline, orderA };
}

describe('F-TR-3: the return handler commits and the process dies before it sends the authorize call', () => {
  test('F-TR-3 (a): restart: the reconciler sends the queued authorize exactly once and the operation is authorized', { timeout: 180000 }, async () => {
    const world = await crashedAfterReturn('retcrasha');
    const { db, orderA, baseline, first, env, requestId } = world;
    const restarted = await restartServer(first, env, cleanups);

    await waitFor(() => operationOf(db, orderA.id).status === 'authorized', { what: 'the operation to be authorized by the reconciler', timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 50 });
    await waitTicks(db, 3);
    const sent = authorizeCalls(db, baseline);
    assert.equal(sent.length, 1, 'exactly one authorize call in all');
    assert.equal(sent[0].requestId, `so:${orderA.id}:authorize:1`);
    assert.equal(sent[0].replayed, 0);
    assert.equal(sent[0].pid, restarted.pid, 'the restarted process sent it (the Sender table: the reconciler)');
    const call = authorizeCall(db, orderA.id);
    assert.equal(call.status, 'succeeded');
    assert.equal(call.sendCount, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 1, 'one authorization at the provider');
    assert.match(operationOf(db, orderA.id).authorizationId, /^FAKEAUTH-/);
    // Supplier B was never approved: its operation is untouched and nothing was sent for it.
    assert.equal(operationOf(db, world.orders[1].id).status, 'created');

    // The buyer sees the authorized payment of A and still has to approve B.
    const cafe1 = await signedIn(restarted, 'cafe1');
    const view = await cafe1.get(`/api/requests/${requestId}`);
    assert.equal(view.status, 200, view.text);
    assert.notEqual(view.json.rescueStatus.status, 'failed_needs_attention');
    assert.equal(view.json.orders.find((o) => o.supplier.code === 'A').payment.status, 'authorized');
    assertHealthyLogs(restarted);
  });

  test('F-TR-3 (b): the reservation expires before the restart: the queued call is cancelled, the operation voided locally, no authorize call, the status leaves cancelling', { timeout: 180000 }, async () => {
    const world = await crashedAfterReturn('retcrashb');
    const { db, orderA, baseline, first, env, requestId, plan } = world;

    // No process runs now. Move the stored expiry into the past: the stand-in for a restart after the TTL.
    const rw = writeDb(first.dbPath);
    try {
      rw.exec('PRAGMA busy_timeout = 10000');
      const moved = rw.prepare("UPDATE reservations SET expires_at = ? WHERE plan_version_id = ? AND status = 'active'").run(new Date(Date.now() - 60_000).toISOString(), plan.id).changes;
      assert.equal(moved, 1, 'the active reservation of the plan expired');
    } finally {
      rw.close();
    }
    const restarted = await restartServer(first, env, cleanups);

    await waitFor(() => operationOf(db, orderA.id).status === 'voided', { what: 'the operation to be voided', timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 50 });
    const op = operationOf(db, orderA.id);
    assert.equal(op.voidedLocally, 1, 'voided locally: the provider was never asked');
    assert.notEqual(op.cancelRequestedAt, null);
    const call = authorizeCall(db, orderA.id);
    assert.equal(call.status, 'cancelled', 'the queued authorize ended cancelled');
    assert.equal(call.sendCount, 0);
    await waitTicks(db, 3);
    assert.equal(authorizeCalls(db, baseline).length, 0, 'ZERO authorize calls reached the provider');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 0);
    assert.deepEqual(fakeCallsSince(db, baseline).filter((c) => ['authorize', 'void', 'capture', 'refund'].includes(c.kind)), [], 'no money call at all');
    assert.equal(db.prepare('SELECT status, non_executable_reason AS reason FROM plan_versions WHERE id = ?').get(plan.id).status, 'non_executable');
    assert.equal(db.prepare('SELECT non_executable_reason AS reason FROM plan_versions WHERE id = ?').get(plan.id).reason, 'RESERVATION_EXPIRED');
    assert.equal(db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(plan.id).status, 'expired');

    // The rescue status is no longer `cancelling`: nothing is outstanding.
    const cafe1 = await signedIn(restarted, 'cafe1');
    const view = await waitFor(async () => {
      const res = await cafe1.get(`/api/requests/${requestId}`);
      return res.status === 200 && res.json.rescueStatus.status !== 'cancelling' ? res : null;
    }, { what: 'the rescue status to leave cancelling', timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 50 });
    assert.equal(view.json.rescueStatus.status, 'cancelled');
    assert.equal(view.json.rescueStatus.message, 'Reservation expired — no money was taken; re-plan with current stock');
    assertHealthyLogs(restarted);
  });

  test('F-TR-3 (c): a retryable (429) authorize answer: queued again with next_attempt_at, sent again with the same request id after it, one authorization', { timeout: 180000 }, async () => {
    const { first, second, demoDate } = await startPair({ cleanups });
    const db = readDb(first.dbPath, cleanups);
    const flow = await confirmedPlan(first, demoDate, 'retcrashc');
    const [orderA] = flow.orders;
    armFlagDirect(first.dbPath, 'http_429:authorize', { value: 'A', remaining: 1 });
    const baseline = lastFakeCallId(db);
    const paid = await payOrder(flow.cafe1, orderA);
    assert.equal(paid.ret.status, 303, paid.ret.text);

    // The first send was answered 429: the call is queued again (nothing started), the operation is still `approved`.
    const queued = authorizeCall(db, orderA.id);
    assert.equal(queued.status, 'intent');
    assert.equal(queued.startedAt, null, 'queued again: provably unsent');
    assert.equal(queued.sendCount, 1);
    assert.equal(queued.httpStatus, 429);
    assert.equal(operationOf(db, orderA.id).status, 'approved');
    const [rejected] = authorizeCalls(db, baseline);
    assert.equal(authorizeCalls(db, baseline).length, 1, 'one authorize call so far: the 429');
    const retryAt = Date.parse(queued.nextAttemptAt);
    assert.ok(retryAt >= Date.parse(rejected.at) + 5000, 'next_attempt_at is the 429 plus the first back-off step (5 s)');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 0, 'nothing was authorized by the 429');

    // Both reconcilers tick while the call is not due: a tick that sends nothing leaves it queued.
    await waitTicks(db, 3);

    // After next_attempt_at the call is sent again, by one reconciler, with the same request id.
    await waitFor(() => operationOf(db, orderA.id).status === 'authorized', { what: 'the operation to be authorized after the back-off', timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 50 });
    await waitTicks(db, 3);
    const sent = authorizeCalls(db, baseline);
    assert.equal(sent.length, 2, 'the 429 and the one effective authorize');
    assert.ok(Date.parse(sent[1].at) >= retryAt, 'the call was sent again only at or after next_attempt_at');
    assert.deepEqual(sent.map((c) => c.requestId), [`so:${orderA.id}:authorize:1`, `so:${orderA.id}:authorize:1`], 'the same PayPal-Request-Id');
    assert.deepEqual(sent.map((c) => c.replayed), [0, 0]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 1, 'exactly one effective authorization');
    const call = authorizeCall(db, orderA.id);
    assert.equal(call.status, 'succeeded');
    assert.equal(call.sendCount, 2);
    assert.ok([first.pid, second.pid].includes(sent[1].pid));
    for (const server of [first, second]) assertHealthyLogs(server);
  });
});
