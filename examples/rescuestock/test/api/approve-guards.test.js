// API tests for plan approval (task c2-requests-plans-view). Case names start with the criterion id:
//   RS-12  approve requires expectedTotalCents and planHash; a mismatch is 409 PLAN_CHANGED with the current
//          values; a stored plan that fails server re-validation is 409 PLAN_INVALID
//   RS-04  (approve half) a missing budget is 409 MISSING_BUDGET, a missing deadline 409 MISSING_DEADLINE,
//          the budget first; the paypal/create half comes with the payment flow
//   RS-19  unknown body fields never change what is approved
//   RS-27  a foreign plan id is 404
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { canonicalHash } from '../../src/domain/canonical.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  // Each plan below moves the fixed clock by 61 s, so no customer ever has more than 10 plans in a 10-minute window.
  client.tick = () => h.clock.advance(61_000);
  return client;
}

// A proposed plan for a fresh request. `overrides` change the confirmed fields (null removes budget or deadline).
async function planned(client, overrides = {}) {
  client.tick();
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.request.id;
  const confirmed = await client.post(`/api/requests/${id}/confirm`, { fields: { ...FIELDS, ...overrides } });
  assert.equal(confirmed.status, 201, confirmed.text);
  const made = await client.post(`/api/requests/${id}/plan`, {});
  assert.equal(made.status, 201, made.text);
  assert.ok(made.json.plan, 'the base case is feasible');
  return { requestId: id, plan: made.json.plan };
}

const approveBody = (plan, extra = {}) => ({ expectedTotalCents: plan.body.totalCents, planHash: plan.planHash, ...extra });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const planStatus = (h, id) => h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(id).status;
const approvals = (h, id) => count(h, 'SELECT COUNT(*) AS n FROM plan_approvals WHERE plan_version_id = ?', id);

describe('RS-12: approval needs the plan hash and the expected total', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-12: approving with the current hash and total is 200, approvalsNeeded is the supplier count, and the status is RESERVE next', async () => {
    const { requestId, plan } = await planned(cafe1);
    const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.plan.status, 'approved');
    assert.equal(res.json.plan.id, plan.id);
    assert.equal(res.json.plan.planHash, plan.planHash);
    assert.equal(res.json.approvalsNeeded, 2);
    assert.equal(res.json.labels.priceNotice, 'Test prices, not market prices');
    assert.equal(typeof res.json.requestId, 'string');
    assert.equal(planStatus(h, plan.id), 'approved');
    const row = h.db.prepare('SELECT customer_id, approved_hash, approved_total_cents FROM plan_approvals WHERE plan_version_id = ?').get(plan.id);
    assert.deepEqual({ ...row }, { customer_id: cafe1.user.id, approved_hash: plan.planHash, approved_total_cents: 8400 });
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.equal(view.rescueStatus.status, 'plan_found');
    assert.equal(view.rescueStatus.nextStep.code, 'RESERVE');
    assert.equal(view.rescueStatus.underlying.plan, 'approved');
  });

  test('RS-12: an already approved plan with the same hash is 200 unchanged (one approval row); a different hash is PLAN_CHANGED', async () => {
    const { plan } = await planned(cafe1);
    const first = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    const again = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.plan, first.json.plan);
    assert.equal(approvals(h, plan.id), 1);
    const wrong = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan, { expectedTotalCents: 8300 }));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error.code, 'PLAN_CHANGED');
    assert.equal(planStatus(h, plan.id), 'approved');
    const both = await Promise.all([cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan)), cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan))]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    assert.equal(approvals(h, plan.id), 1);
  });

  test('RS-12: a tampered planHash or expectedTotalCents is 409 PLAN_CHANGED with the current values, and nothing is approved', async () => {
    const { plan } = await planned(cafe1);
    const tampered = [
      { planHash: '0'.repeat(64) },
      { planHash: plan.planHash.replace(/^./, plan.planHash[0] === 'a' ? 'b' : 'a') },
      { expectedTotalCents: plan.body.totalCents - 1 },
      { expectedTotalCents: plan.body.totalCents + 100 },
      { expectedTotalCents: 0 },
      { planHash: '1'.repeat(64), expectedTotalCents: 1 },
    ];
    for (const change of tampered) {
      const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan, change));
      assert.equal(res.status, 409, JSON.stringify(change));
      assert.equal(res.json.error.code, 'PLAN_CHANGED');
      assert.deepEqual(res.json.error.details, { currentPlanHash: plan.planHash, currentTotalCents: 8400 });
      assert.equal(res.json.error.message, 'The plan changed. Review the new plan.');
    }
    assert.equal(planStatus(h, plan.id), 'proposed');
    assert.equal(approvals(h, plan.id), 0);
  });

  test('RS-12: each refused approval is audited as denied with the code only', async () => {
    const { plan } = await planned(cafe1);
    await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan, { planHash: 'f'.repeat(64) }));
    const rows = h.db.prepare("SELECT outcome, detail_json, actor_user_id FROM audit_events WHERE action = 'plan.approve' AND entity_id = ?").all(plan.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'denied');
    assert.equal(rows[0].actor_user_id, cafe1.user.id);
    assert.deepEqual(JSON.parse(rows[0].detail_json), { code: 'PLAN_CHANGED' });
    const ok = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(ok.status, 200);
    const outcomes = h.db.prepare("SELECT outcome FROM audit_events WHERE action = 'plan.approve' AND entity_id = ? ORDER BY id").all(plan.id).map((r) => r.outcome);
    assert.deepEqual(outcomes, ['denied', 'ok']);
  });

  test('RS-12: a stored plan that fails server re-validation is 409 PLAN_INVALID, even with the matching hash and total', async () => {
    const mutate = (body) => {
      const copy = JSON.parse(JSON.stringify(body));
      return copy;
    };
    const cases = [
      ['cups_below_required', (b) => { b.lines[0].cups = 50; }],
      ['lids_below_required', (b) => { b.lines[1].lids = 10; }],
      ['too_many_pickups', (b) => { b.suppliers.push({ ...b.suppliers[0], supplierCode: 'Z' }); b.totalCents += b.suppliers[0].totalCents; }],
      ['total_mismatch', (b) => { b.totalCents -= 100; }],
      ['ready_after_deadline', (b) => { b.readyAt = '2026-10-20T08:30:00.000Z'; }],
    ];
    for (const [reason, change] of cases) {
      const { plan } = await planned(cafe1);
      const stored = h.db.prepare('SELECT plan_json FROM plan_versions WHERE id = ?').get(plan.id);
      const body = mutate(JSON.parse(stored.plan_json));
      change(body);
      // The row is rewritten consistently (hash and total follow the body), as a corrupted but self-consistent plan.
      h.db.prepare('UPDATE plan_versions SET plan_json = ?, plan_hash = ?, total_cents = ? WHERE id = ?').run(JSON.stringify(body), canonicalHash(body), body.totalCents, plan.id);
      const res = await cafe1.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: body.totalCents, planHash: canonicalHash(body) });
      assert.equal(res.status, 409, reason);
      assert.equal(res.json.error.code, 'PLAN_INVALID', reason);
      assert.deepEqual(res.json.error.details, { reason });
      assert.equal(planStatus(h, plan.id), 'proposed');
      assert.equal(approvals(h, plan.id), 0);
    }
  });

  test('RS-12: a stored plan whose body no longer matches its stored hash is PLAN_INVALID (hash_mismatch)', async () => {
    const { plan } = await planned(cafe1);
    const stored = JSON.parse(h.db.prepare('SELECT plan_json FROM plan_versions WHERE id = ?').get(plan.id).plan_json);
    stored.lines[0].bundles = 2;
    h.db.prepare('UPDATE plan_versions SET plan_json = ? WHERE id = ?').run(JSON.stringify(stored), plan.id);
    const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'PLAN_INVALID');
    assert.deepEqual(res.json.error.details, { reason: 'hash_mismatch' });
    h.db.prepare('UPDATE plan_versions SET plan_json = ? WHERE id = ?').run('{not json', plan.id);
    const garbled = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(garbled.status, 409);
    assert.deepEqual(garbled.json.error.details, { reason: 'unreadable' });
  });

  test('RS-19: the request body is validated (422) and unknown fields never change what is approved', async () => {
    const { plan } = await planned(cafe1);
    const bad = [
      [{}, [{ field: 'expectedTotalCents', rule: 'required' }, { field: 'planHash', rule: 'required' }]],
      [{ expectedTotalCents: '8400', planHash: plan.planHash }, [{ field: 'expectedTotalCents', rule: 'integer' }]],
      [{ expectedTotalCents: -5, planHash: plan.planHash }, [{ field: 'expectedTotalCents', rule: 'range:0..100000000000' }]],
      [{ expectedTotalCents: 84.5, planHash: plan.planHash }, [{ field: 'expectedTotalCents', rule: 'integer' }]],
      [{ expectedTotalCents: 8400, planHash: plan.planHash.toUpperCase() }, [{ field: 'planHash', rule: 'pattern' }]],
      [{ expectedTotalCents: 8400, planHash: 'abc' }, [{ field: 'planHash', rule: 'length:64..64' }]],
      [{ expectedTotalCents: 8400, planHash: null }, [{ field: 'planHash', rule: 'string' }]],
    ];
    for (const [body, fields] of bad) {
      const res = await cafe1.post(`/api/plans/${plan.id}/approve`, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(res.json.error.details.fields, fields);
    }
    assert.equal(planStatus(h, plan.id), 'proposed');
    const ok = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan, { amountCents: 1, supplierCode: 'Z', status: 'executed', customer_id: 99, totalCents: 1 }));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.plan.body.totalCents, 8400);
    assert.equal(h.db.prepare('SELECT approved_total_cents AS t FROM plan_approvals WHERE plan_version_id = ?').get(plan.id).t, 8400);
  });
});

describe('RS-04 (approve half): budget and deadline must exist before approval', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-04: approve without a budget is 409 MISSING_BUDGET', async () => {
    const { plan } = await planned(cafe1, { budgetCents: null });
    const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'MISSING_BUDGET');
    assert.equal(res.json.error.message, 'A budget is required.');
    assert.equal(planStatus(h, plan.id), 'proposed');
    assert.equal(approvals(h, plan.id), 0);
  });

  test('RS-04: approve without a deadline is 409 MISSING_DEADLINE', async () => {
    const { plan } = await planned(cafe1, { deadline: null });
    const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'MISSING_DEADLINE');
    assert.equal(planStatus(h, plan.id), 'proposed');
  });

  test('RS-04: with both missing the budget is reported first, and also ahead of a wrong hash', async () => {
    const { plan } = await planned(cafe1, { budgetCents: null, deadline: null });
    const both = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(both.status, 409);
    assert.equal(both.json.error.code, 'MISSING_BUDGET');
    const wrongHash = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan, { planHash: '0'.repeat(64) }));
    assert.equal(wrongHash.json.error.code, 'MISSING_BUDGET');
  });

  test('RS-04: once the customer confirms a budget and a deadline, the old plan is superseded, a new one is approvable', async () => {
    const { requestId, plan } = await planned(cafe1, { budgetCents: null, deadline: null });
    const reconfirm = await cafe1.post(`/api/requests/${requestId}/confirm`, { fields: FIELDS });
    assert.equal(reconfirm.status, 201);
    const stale = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'PLAN_SUPERSEDED');
    const replanned = await cafe1.post(`/api/requests/${requestId}/plan`, {});
    assert.equal(replanned.status, 201);
    const ok = await cafe1.post(`/api/plans/${replanned.json.plan.id}/approve`, approveBody(replanned.json.plan));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.plan.status, 'approved');
  });
});

describe('approve: plan states, isolation and access', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());

  test('RS-12: a superseded plan is 409 PLAN_SUPERSEDED, a non-executable one is 409 PLAN_NOT_EXECUTABLE with the reason', async () => {
    const { plan } = await planned(cafe1);
    h.db.prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = 'PRICE_CHANGED' WHERE id = ?").run(plan.id);
    const superseded = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(superseded.status, 409);
    assert.equal(superseded.json.error.code, 'PLAN_SUPERSEDED');
    h.db.prepare("UPDATE plan_versions SET status = 'non_executable', supersede_reason = NULL, non_executable_reason = 'PAYMENT_CANCELLED' WHERE id = ?").run(plan.id);
    const closed = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(closed.status, 409);
    assert.equal(closed.json.error.code, 'PLAN_NOT_EXECUTABLE');
    assert.deepEqual(closed.json.error.details, { reason: 'PAYMENT_CANCELLED' });
  });

  test('RS-12: an executing or executed plan is 409 INVALID_STATE', async () => {
    const { plan } = await planned(cafe1);
    for (const status of ['executing', 'executed']) {
      h.db.prepare('UPDATE plan_versions SET status = ? WHERE id = ?').run(status, plan.id);
      const res = await cafe1.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
      assert.equal(res.status, 409, status);
      assert.equal(res.json.error.code, 'INVALID_STATE');
      assert.deepEqual(res.json.error.details, { from: status, to: 'approved' });
    }
  });

  test('RS-27: another customer\'s plan is 404 (a body with the right hash does not matter) and stays proposed', async () => {
    const { plan } = await planned(cafe1);
    const res = await cafe2.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
    const unknown = await cafe2.post('/api/plans/987654/approve', approveBody(plan));
    assert.equal(unknown.status, 404);
    assert.equal(planStatus(h, plan.id), 'proposed');
    assert.equal(approvals(h, plan.id), 0);
    const archived = await planned(cafe1);
    h.db.prepare("UPDATE rescue_requests SET archived_at = '2026-10-20T06:00:00.000Z' WHERE id = ?").run(archived.requestId);
    assert.equal((await cafe1.post(`/api/plans/${archived.plan.id}/approve`, approveBody(archived.plan))).status, 404);
  });

  test('RS-30: approve is 401 anonymous, 403 for a supplier, 403 CSRF_FAILED without the token, 400 for a malformed id', async () => {
    const { plan } = await planned(cafe1);
    const anonymous = createClient(h.request);
    assert.equal((await anonymous.post(`/api/plans/${plan.id}/approve`, approveBody(plan))).status, 401);
    const supplier = await signIn(h, 'supplier-a');
    const forbidden = await supplier.post(`/api/plans/${plan.id}/approve`, approveBody(plan));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, 'FORBIDDEN');
    const noCsrf = await cafe1.send({ method: 'POST', path: `/api/plans/${plan.id}/approve`, jsonBody: approveBody(plan), headers: { 'X-CSRF-Token': 'nope' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.error.code, 'CSRF_FAILED');
    const malformed = await cafe1.post('/api/plans/abc/approve', approveBody(plan));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, 'BAD_REQUEST');
    assert.equal(planStatus(h, plan.id), 'proposed');
  });
});
