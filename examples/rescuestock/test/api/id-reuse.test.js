// RS-39 (deletion), FU-23 / TR-D-3: a hard delete must never let the next customer's rows take over the ids of the deleted
// ones. Before migration 006 rescue_requests, plan_versions, images and planning_runs used INTEGER PRIMARY KEY without
// AUTOINCREMENT, so after a hard delete of the highest id the next insert got the same id, and the audit rows and the
// model_spend row of the first customer then pointed at the second customer's request, plan version and image.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_DATE, DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { canonicalFields } from '../helpers/plan-flow.js';
import { ensureAdmin } from '../../src/services/users.js';

const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const PNG = (label) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
const TEXT = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

// A request with an image, an extraction (so a model_spend row names it), confirmed requirements and an approved plan version.
async function fullRequest(h, client) {
  h.clock.advance(11 * 60 * 1000);
  const created = await client.post('/api/requests', { text: TEXT });
  assert.equal(created.status, 201, created.text);
  const requestId = created.json.request.id;
  const up = await client.send({ method: 'POST', path: `/api/requests/${requestId}/image`, headers: { 'Content-Type': 'image/png' }, body: PNG(`photo-${requestId}`) });
  assert.equal(up.status, 201, up.text);
  const extracted = await client.post(`/api/requests/${requestId}/extract`, {});
  assert.equal(extracted.status, 200, extracted.text);
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE) });
  assert.equal(confirmed.status, 201, confirmed.text);
  const planned = await client.post(`/api/requests/${requestId}/plan`, {});
  assert.equal(planned.status, 201, planned.text);
  const plan = planned.json.plan;
  const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  assert.equal(approved.status, 200, approved.text);
  return { requestId, planVersionId: plan.id, imageId: up.json.image.id };
}

const one = (h, sql, ...args) => h.db.prepare(sql).get(...args);

describe('RS-39: ids are never reused after a hard delete (FU-23 / TR-D-3)', () => {
  let h;
  let cafe1;
  let cafe2;
  let admin;
  // X creates everything and hard-deletes it; Y then creates the same things.
  let x;
  let y;
  let xRun;
  let yRun;
  let xAudit;
  let xSpend;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
    admin = await signIn(h, 'admin', ADMIN_PASSWORD);

    x = await fullRequest(h, cafe1);
    xRun = one(h, 'SELECT id FROM planning_runs WHERE request_id = ?', x.requestId).id;
    xSpend = h.db.prepare('SELECT id FROM model_spend WHERE request_id = ?').all(x.requestId).map((r) => r.id);
    assert.ok(xSpend.length > 0, 'the extraction wrote a model_spend row naming the request');
    const del = await cafe1.send({ method: 'DELETE', path: `/api/requests/${x.requestId}` });
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.deleted, 'hard');
    xAudit = h.db
      .prepare("SELECT id FROM audit_events WHERE actor_user_id = ? AND entity_type IN ('request','plan_version','image','planning_run')")
      .all(cafe1.user.id)
      .map((r) => r.id);
    assert.ok(xAudit.length >= 4, `X left audit events behind: ${xAudit.length}`);
    y = await fullRequest(h, cafe2);
    yRun = one(h, 'SELECT id FROM planning_runs WHERE request_id = ?', y.requestId).id;
  });
  after(() => h.close());

  test("RS-39: Y's next request, plan version, planning run and image get new, larger ids than the ones X deleted", () => {
    const reused = [];
    if (y.requestId <= x.requestId) reused.push(`request ${y.requestId}`);
    if (y.planVersionId <= x.planVersionId) reused.push(`plan version ${y.planVersionId}`);
    if (yRun <= xRun) reused.push(`planning run ${yRun}`);
    if (y.imageId <= x.imageId) reused.push(`image ${y.imageId}`);
    assert.deepEqual(reused, [], 'ids reused after a hard delete');
  });

  test("RS-39: the admin timeline of Y's request lists none of X's audit events, and every audit event on it is Y's", async () => {
    const timeline = await admin.get(`/api/admin/timeline?requestId=${y.requestId}&limit=500`);
    assert.equal(timeline.status, 200, timeline.text);
    const audit = timeline.json.events.filter((e) => e.source === 'audit');
    assert.ok(audit.length > 0, 'Y has audit events');
    const ids = audit.map((e) => Number(e.cursor.split('.')[2]));
    assert.deepEqual(ids.filter((id) => xAudit.includes(id)), [], "audit events of X on Y's timeline");
    const foreign = ids.filter((id) => one(h, 'SELECT actor_user_id AS a FROM audit_events WHERE id = ?', id).a !== cafe2.user.id);
    assert.deepEqual(foreign, [], "audit events of another customer on Y's timeline");
  });

  test("RS-39: the model_spend row of the deleted request is kept for the budget but names no request (ON DELETE SET NULL), never Y's", () => {
    const kept = h.db.prepare(`SELECT request_id, customer_id FROM model_spend WHERE id IN (${xSpend.map(() => '?').join(',')})`).all(...xSpend);
    assert.equal(kept.length, xSpend.length, 'spend rows survive the delete: the daily budget must not shrink');
    for (const row of kept) {
      assert.equal(row.customer_id, cafe1.user.id);
      assert.equal(row.request_id, null, 'the spend row of the deleted request names no request');
    }
    assert.equal(one(h, 'SELECT COUNT(*) AS n FROM model_spend WHERE customer_id = ? AND request_id = ?', cafe1.user.id, y.requestId).n, 0);
  });
});
