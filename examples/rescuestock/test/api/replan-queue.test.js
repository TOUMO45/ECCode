// Re-plan queue API tests (task f1-supersession-refusal-expiry; spec: Re-plan queue semantics (F-TR-2), Supersession > Replan,
// derivation row 4a, decision dec-mv3vui7s-014f6e7c: the drain stays in reconciler.js and calls runPlanningFor). Case names:
//   F-TR-2  an entry is removed only in the transaction that stores the new planning run (feasible or infeasible), or when the
//           request is deleted or archived; a drain recomputes up to 3 times when offers_hash changed underneath it; a failed drain
//           keeps the entry with failed_drains + 1, next_attempt_at = now + min(5 min, 15 s x 2^failed_drains-before) and last_error;
//           after five failed drains the next step is REPLAN and the customer's own plan call answers the entry
//   row 4a  "Finding a new plan with current stock..." while the entry waits; 2 entries per tick; the entry survives a restart
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { REPLAN_BACKOFF_BASE_MS, REPLAN_BACKOFF_CAP_MS, createReconciler, drainReplanQueue } from '../../src/services/reconciler.js';
import { enqueueReplan } from '../../src/services/supersession.js';

const DAY = '2026-10-20';
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_PLAN_RATE_LIMIT: '1000', ...env } });
  harnesses.push(h);
  return h;
}

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const entryOf = (h, requestId) => h.db.prepare('SELECT * FROM replan_queue WHERE request_id = ?').get(requestId);
const planCalls = (h) => count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.create'");
const runsOf = (h, requestId) => count(h, 'SELECT COUNT(*) AS n FROM planning_runs WHERE request_id = ?', requestId);
const plansOf = (h, requestId) => h.db.prepare('SELECT id, version, status, superseded_by FROM plan_versions WHERE request_id = ? ORDER BY version').all(requestId).map((p) => ({ ...p }));
const statusOf = async (client, requestId) => (await client.get(`/api/requests/${requestId}`)).json;
const productOf = (h, code) =>
  h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = ? AND p.kind = 'bundle'").get(code).id;

// A customer whose proposed plan was superseded by a price change of B: one entry in the queue.
async function proposed(h, username = 'cafe1') {
  const client = await signIn(h, username);
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(client, DAY, { approve: false });
  return { client, requestId, planId: plan.id };
}

async function changeB(h) {
  const supplierB = await signIn(h, 'supplier-b');
  const res = await supplierB.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: productOf(h, 'B'), priceCents: 3700 }] } });
  assert.equal(res.status, 200, res.text);
  return res.json.superseded;
}

async function queued(h, username = 'cafe1') {
  const w = await proposed(h, username);
  await changeB(h);
  return w;
}

// The catalog changes underneath every planner run while `conflicts.left` > 0 (a supplier editing during the run).
function conflicting(h, conflicts) {
  const real = h.app.deps.planner;
  const calls = { n: 0 };
  h.app.deps.planner = (input) => {
    calls.n += 1;
    if (conflicts.left > 0 || conflicts.left === Infinity) {
      if (conflicts.left !== Infinity) conflicts.left -= 1;
      h.db.prepare('UPDATE offers SET prep_fee_cents = prep_fee_cents + 1 WHERE id = 1').run();
    }
    return real(input);
  };
  return { calls, restore: () => { h.app.deps.planner = real; } };
}

describe('F-TR-2: what removes an entry', () => {
  test('F-TR-2: a supersession enqueues once; the entry is answered only by the stored run (a feasible version here) and a second enqueue keeps the failure count', async () => {
    const h = await start();
    const w = await queued(h);
    const entry = entryOf(h, w.requestId);
    assert.deepEqual({ reason: entry.reason, failed: entry.failed_drains, last: entry.last_error }, { reason: 'PRICE_CHANGED', failed: 0, last: null });
    assert.equal(entry.next_attempt_at, entry.enqueued_at, 'due at once');
    // nothing but a stored run removes it: reading the request, a second supersession and a failed attempt do not
    await statusOf(w.client, w.requestId);
    h.db.prepare('UPDATE replan_queue SET failed_drains = 3 WHERE request_id = ?').run(w.requestId);
    h.db.tx(() => enqueueReplan(h.db, w.requestId, 'OFFER_WITHDRAWN', '2026-10-20T06:05:00.000Z'));
    const again = entryOf(h, w.requestId);
    assert.deepEqual({ reason: again.reason, failed: again.failed_drains, enqueued: again.enqueued_at }, { reason: 'OFFER_WITHDRAWN', failed: 3, enqueued: entry.enqueued_at });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 1);

    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 1, failed: 0, dropped: 0 });
    assert.equal(entryOf(h, w.requestId), undefined);
    assert.equal(runsOf(h, w.requestId), 2);
    assert.deepEqual(plansOf(h, w.requestId).map((p) => [p.version, p.status]), [[1, 'superseded'], [2, 'proposed']]);
  });

  test('F-TR-2: an infeasible run answers the entry as well (no plan fits the stock): the request reads no_feasible_plan, not replanning', async () => {
    const h = await start();
    const w = await queued(h);
    h.db.prepare("UPDATE inventory SET on_hand = 0 WHERE product_id IN (SELECT id FROM products WHERE kind = 'bundle')").run();
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 1, failed: 0, dropped: 0 });
    assert.equal(entryOf(h, w.requestId), undefined);
    assert.equal(h.db.prepare('SELECT feasible FROM planning_runs WHERE request_id = ? ORDER BY id DESC').get(w.requestId).feasible, 0);
    assert.equal((await statusOf(w.client, w.requestId)).rescueStatus.status, 'no_feasible_plan');
  });

  test('F-TR-2: a request that was archived or deleted loses its entry without a planning run', async () => {
    const h = await start();
    const archived = await proposed(h, 'cafe1');
    const deleted = await proposed(h, 'cafe2');
    const removed = await proposed(h, 'cafe2');
    assert.equal((await changeB(h)).length, 3, 'one price change supersedes the three proposed plans');
    h.db.prepare('UPDATE rescue_requests SET archived_at = ? WHERE id = ?').run('2026-10-20T06:30:00.000Z', archived.requestId);
    h.db.prepare('UPDATE rescue_requests SET deleted_at = ? WHERE id = ?').run('2026-10-20T06:30:00.000Z', deleted.requestId);
    // the delete route itself takes the entry with the request (no order ever existed: a hard delete)
    const del = await removed.client.send({ method: 'DELETE', path: `/api/requests/${removed.requestId}` });
    assert.equal(del.status, 200, del.text);
    assert.equal(entryOf(h, removed.requestId), undefined);
    const runsBefore = [runsOf(h, archived.requestId), runsOf(h, deleted.requestId)];
    const summary = drainReplanQueue(h.app.deps);
    assert.deepEqual(summary, { drained: 0, failed: 0, dropped: 2 });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    assert.deepEqual([runsOf(h, archived.requestId), runsOf(h, deleted.requestId)], runsBefore, 'no run was stored for them');
  });
});

describe('F-TR-2: recomputing when the catalog changes underneath a drain', () => {
  test('F-TR-2: offers_hash changed during two attempts: the third stores the plan, the entry is removed, the stored run carries the final hash', async () => {
    const h = await start();
    const w = await queued(h);
    const spy = conflicting(h, { left: 2 });
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 1, failed: 0, dropped: 0 });
    assert.equal(spy.calls.n, 3, 'two conflicts and one stored result');
    assert.equal(entryOf(h, w.requestId), undefined);
    assert.equal(runsOf(h, w.requestId), 2, 'only the stored attempt is a planning run');
    assert.deepEqual(plansOf(h, w.requestId).map((p) => p.status), ['superseded', 'proposed']);
  });

  test('F-TR-2: three conflicting attempts: nothing stored, the entry stays with failed_drains 1, last_error DB_BUSY and next_attempt_at +15 s', async () => {
    const h = await start();
    const w = await queued(h);
    const before = entryOf(h, w.requestId);
    const spy = conflicting(h, { left: Infinity });
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 0, failed: 1, dropped: 0 });
    assert.equal(spy.calls.n, 3, 'exactly three attempts');
    const entry = entryOf(h, w.requestId);
    assert.deepEqual(
      { reason: entry.reason, failed: entry.failed_drains, error: entry.last_error, next: entry.next_attempt_at, enqueued: entry.enqueued_at },
      { reason: 'PRICE_CHANGED', failed: 1, error: 'DB_BUSY', next: new Date(h.clock.now() + REPLAN_BACKOFF_BASE_MS).toISOString(), enqueued: before.enqueued_at },
    );
    assert.equal(runsOf(h, w.requestId), 1, 'no planning run was stored');
    assert.deepEqual(plansOf(h, w.requestId).map((p) => p.status), ['superseded']);
    assert.equal((await statusOf(w.client, w.requestId)).rescueStatus.status, 'replanning', 'still waiting for its plan');
  });

  test('F-TR-2: the back-off doubles with the failure count before the increment (15 s, 30 s, 1 min, 2 min, 4 min, then 5 min) and an entry that is not due is left alone', async () => {
    const h = await start();
    const w = await queued(h);
    const spy = conflicting(h, { left: Infinity });
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      const callsBefore = spy.calls.n;
      const summary = drainReplanQueue(h.app.deps);
      assert.equal(summary.failed, 1, `drain ${i + 1}`);
      assert.equal(spy.calls.n - callsBefore, 3);
      const entry = entryOf(h, w.requestId);
      assert.equal(entry.failed_drains, i + 1);
      const wait = Date.parse(entry.next_attempt_at) - h.clock.now();
      delays.push(wait);
      // one millisecond before it is due, the drain does nothing
      h.clock.advance(wait - 1);
      const idle = spy.calls.n;
      assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 0, failed: 0, dropped: 0 });
      assert.equal(spy.calls.n, idle);
      h.clock.advance(1);
    }
    assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 240_000, REPLAN_BACKOFF_CAP_MS]);
    assert.ok(entryOf(h, w.requestId), 'never dropped');
  });

  test('F-TR-2: after five failed drains the next step is REPLAN (before: WAIT); the customer\'s own plan call stores the run and answers the entry', async () => {
    const h = await start();
    const w = await queued(h);
    const spy = conflicting(h, { left: Infinity });
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(drainReplanQueue(h.app.deps).failed, 1);
      const status = (await statusOf(w.client, w.requestId)).rescueStatus;
      assert.equal(status.status, 'replanning');
      assert.equal(status.rule, '4a');
      assert.equal(status.nextStep.code, i < 5 ? 'WAIT' : 'REPLAN', `after ${i} failed drains`);
      if (i < 5) assert.equal(status.nextStep.text, 'Finding a new plan with current stock…');
      h.clock.advance(Date.parse(entryOf(h, w.requestId).next_attempt_at) - h.clock.now());
    }
    assert.equal(entryOf(h, w.requestId).failed_drains, 5);
    spy.restore();

    h.clock.advance(61_000);
    const replan = await w.client.post(`/api/requests/${w.requestId}/plan`, {});
    assert.equal(replan.status, 201, replan.text);
    assert.equal(entryOf(h, w.requestId), undefined, 'removed in the transaction that stored the run');
    const view = await statusOf(w.client, w.requestId);
    assert.deepEqual([view.rescueStatus.status, view.rescueStatus.nextStep.code], ['plan_found', 'REVIEW_NEW_PLAN']);
    assert.equal(view.rescueStatus.message, 'Prices changed: review plan v2');
  });

  test('F-TR-2: the drain also fails and keeps the entry when the request cannot be planned now (a live reservation exists: PLAN_IN_PROGRESS), then succeeds once it is released', async () => {
    const h = await start();
    const client = await signIn(h, 'cafe1');
    h.clock.advance(61_000);
    const { requestId, plan } = await approvedPlan(client, DAY);
    const reserved = await reserve(client, plan.id, idempotencyKey('queue-live-1'));
    assert.equal(reserved.status, 201, reserved.text);
    // a queue entry left behind (for example by a re-plan racing a reservation) must not plan over a live reservation
    h.db.prepare("INSERT INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (?, 'PRICE_CHANGED', ?, 0, ?)").run(requestId, '2026-10-20T06:00:00.000Z', '2026-10-20T06:00:00.000Z');
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 0, failed: 1, dropped: 0 });
    const entry = entryOf(h, requestId);
    assert.deepEqual([entry.failed_drains, entry.last_error], [1, 'PLAN_IN_PROGRESS']);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'approved', 'the reserved plan is untouched');
    assert.equal(h.db.prepare('SELECT status FROM reservations').get().status, 'active');
  });
});

describe('F-TR-2: the reconciler drains, two entries per tick, and the entry survives a restart', () => {
  test('row 4a: a tick drains at most two due entries; the third waits for the next tick', async () => {
    const h = await start();
    const first = await queued(h, 'cafe1');
    // two more requests of the second customer share the queue: queue them directly
    const cafe2 = await signIn(h, 'cafe2');
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      h.clock.advance(61_000);
      const created = await approvedPlan(cafe2, DAY, { approve: false });
      ids.push(created.requestId);
      h.db.prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = 'PRICE_CHANGED' WHERE id = ?").run(created.plan.id);
      h.db.prepare("INSERT INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (?, 'PRICE_CHANGED', ?, 0, ?)").run(created.requestId, '2026-10-20T06:00:00.000Z', '2026-10-20T06:00:00.000Z');
    }
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 3);
    const rec = createReconciler(h.app.deps);
    await rec.tick();
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 1, 'two drained by the first tick');
    const left = h.db.prepare('SELECT request_id FROM replan_queue').get().request_id;
    assert.ok([first.requestId, ...ids].includes(left));
    await rec.tick();
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
  });

  test('F-TR-2: a queued entry is data: a reconciler started later (after a restart) drains it with the same result', async () => {
    const h = await start();
    const w = await queued(h);
    const before = planCalls(h);
    assert.equal(entryOf(h, w.requestId).failed_drains, 0);
    const fresh = createReconciler(h.app.deps); // no state of an earlier reconciler is needed
    await fresh.tick();
    assert.equal(entryOf(h, w.requestId), undefined);
    assert.equal(planCalls(h), before + 1);
    assert.deepEqual(plansOf(h, w.requestId).map((p) => p.status), ['superseded', 'proposed']);
  });
});
