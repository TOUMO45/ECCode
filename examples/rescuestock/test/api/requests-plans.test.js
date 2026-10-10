// API tests for requests, manual requirement confirmation and planning runs (task c2-requests-plans-view).
// Case names start with the id of the criterion they prove: RS-27 (isolation, request and plan half), SEC-2
// (requests per day), SEC-8 (the server derives provenance), RS-04 (budget and deadline are optional to confirm,
// required to approve), PB-3 / RISK-19 (planner limit is a typed 422; planning is rate-limited per customer),
// FU-1, FU-7, FU-8, RS-34 (labels). Runs the real app in-process through test/helpers/app-harness.js.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { createApp, resolvePlanRate } from '../../src/app.js';
import { fixedClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createLogger } from '../../src/log.js';
import { PlannerLimitError, search } from '../../src/domain/search.js';
import { plan as realPlanner } from '../../src/domain/planner.js';

// RS-FIX-1 base case: 200 cups + 200 lids, 250 ml, 90 mm, by 11:00 local, budget $120, at most 2 pickups.
const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const TEXT = 'I need 200 cups and 200 lids, 250 ml, by 11:00 today. Budget $120, at most 2 pickups.';

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function newRequest(client, text = TEXT) {
  const res = await client.post('/api/requests', { text });
  assert.equal(res.status, 201, res.text);
  return res.json.request.id;
}

async function confirm(client, id, overrides = {}) {
  return client.post(`/api/requests/${id}/confirm`, { fields: { ...FIELDS, ...overrides } });
}

const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;

describe('RS-27: customer isolation for requests and plans', () => {
  let h;
  let cafe1;
  let cafe2;
  let ownId;
  let ownPlan;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
    ownId = await newRequest(cafe1);
    assert.equal((await confirm(cafe1, ownId)).status, 201);
    ownPlan = (await cafe1.post(`/api/requests/${ownId}/plan`, {})).json.plan;
  });
  after(() => h.close());

  test('RS-27: a foreign request id is 404 NOT_FOUND on view, confirm and plan, and nothing changes', async () => {
    const before = {
      requirements: count(h, 'SELECT COUNT(*) AS n FROM requirements'),
      runs: count(h, 'SELECT COUNT(*) AS n FROM planning_runs'),
      events: count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'"),
    };
    for (const [method, path, body] of [
      ['GET', `/api/requests/${ownId}`],
      ['POST', `/api/requests/${ownId}/confirm`, { fields: FIELDS }],
      ['POST', `/api/requests/${ownId}/plan`, {}],
    ]) {
      const res = await cafe2.send({ method, path, jsonBody: body });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.json.error.code, 'NOT_FOUND');
      assert.equal(typeof res.json.error.requestId, 'string');
    }
    assert.deepEqual(
      {
        requirements: count(h, 'SELECT COUNT(*) AS n FROM requirements'),
        runs: count(h, 'SELECT COUNT(*) AS n FROM planning_runs'),
        events: count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'"),
      },
      before,
    );
  });

  test('RS-27: a foreign plan id is 404 on approve and the plan stays proposed', async () => {
    const res = await cafe2.post(`/api/plans/${ownPlan.id}/approve`, { expectedTotalCents: ownPlan.body.totalCents, planHash: ownPlan.planHash });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(ownPlan.id).status, 'proposed');
  });

  test('RS-27: the list holds only the caller\'s requests, newest first', async () => {
    const second = await newRequest(cafe1, 'second request');
    const mine = await cafe1.get('/api/requests');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.requests.map((r) => r.id), [second, ownId]);
    const theirs = await cafe2.get('/api/requests');
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.json.requests, []);
    assert.equal(mine.json.labels.priceNotice, 'Test prices, not market prices');
    assert.equal(mine.json.labels.demoData, true);
  });

  test('RS-27: an archived or deleted request is 404 for its owner too', async () => {
    const archived = await newRequest(cafe1, 'to archive');
    const deleted = await newRequest(cafe1, 'to delete');
    h.db.prepare("UPDATE rescue_requests SET archived_at = '2026-10-20T06:00:00.000Z' WHERE id = ?").run(archived);
    h.db.prepare("UPDATE rescue_requests SET deleted_at = '2026-10-20T06:00:00.000Z' WHERE id = ?").run(deleted);
    for (const id of [archived, deleted]) {
      assert.equal((await cafe1.get(`/api/requests/${id}`)).status, 404);
      assert.equal((await confirm(cafe1, id)).status, 404);
      assert.equal((await cafe1.post(`/api/requests/${id}/plan`, {})).status, 404);
    }
    const ids = (await cafe1.get('/api/requests')).json.requests.map((r) => r.id);
    assert.ok(!ids.includes(archived) && !ids.includes(deleted));
  });

  test('RS-27: anonymous is 401, a supplier is 403, a missing CSRF token is 403, a malformed id is 400', async () => {
    const anonymous = createClient(h.request);
    for (const [method, path] of [['GET', '/api/requests'], ['GET', `/api/requests/${ownId}`], ['POST', `/api/requests/${ownId}/plan`], ['POST', `/api/plans/${ownPlan.id}/approve`]]) {
      const res = await anonymous.send({ method, path, jsonBody: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.json.error.code, 'UNAUTHENTICATED');
    }
    const supplier = await signIn(h, 'supplier-a');
    for (const [method, path] of [['GET', '/api/requests'], ['GET', `/api/requests/${ownId}`], ['POST', `/api/requests/${ownId}/plan`], ['POST', `/api/plans/${ownPlan.id}/approve`]]) {
      const res = await supplier.send({ method, path, jsonBody: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.error.code, 'FORBIDDEN');
    }
    const noToken = await cafe1.send({ method: 'POST', path: '/api/requests', jsonBody: { text: 'x' }, headers: { 'X-CSRF-Token': 'wrong' } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.error.code, 'CSRF_FAILED');
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await cafe1.get(`/api/requests/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
    }
    assert.equal((await cafe1.get('/api/requests/987654')).status, 404);
  });
});

describe('SEC-2: requests per Asia/Amman day', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());

  test('SEC-2: the 11th request of the day is 429 RATE_LIMITED requests_per_day with Retry-After to local midnight', async () => {
    for (let i = 0; i < 10; i += 1) await newRequest(cafe1, `request ${i}`);
    const res = await cafe1.post('/api/requests', { text: 'one too many' });
    assert.equal(res.status, 429);
    assert.equal(res.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(res.json.error.details, { limit: 'requests_per_day' });
    // The harness clock is 09:00 in Amman, so midnight is 15 hours away.
    assert.equal(res.headers['retry-after'], String(15 * 3600));
    // Nothing was inserted by the refused call: 10 requests and 10 counted events.
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE customer_id = ?', cafe1.user.id), 10);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'request_create' AND user_key = ?", `u:${cafe1.user.id}`), 10);
    // Another customer is not affected.
    assert.equal((await cafe2.post('/api/requests', { text: 'mine' })).status, 201);
  });

  test('SEC-2: deleting requests does not reset the count, and the next local day starts at zero', async () => {
    h.db.prepare('DELETE FROM rescue_requests WHERE customer_id = ?').run(cafe1.user.id);
    assert.equal((await cafe1.post('/api/requests', { text: 'still blocked' })).status, 429);
    h.clock.advance(15 * 3600 * 1000); // 00:00 next day in Amman; the 15 h also end the old session
    const fresh = await signIn(h, 'cafe1');
    assert.equal((await fresh.post('/api/requests', { text: 'a new day' })).status, 201);
  });
});

describe('SEC-2: the daily count and the insert are one transaction', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('SEC-2: 14 parallel creations yield exactly 10 requests and 4 refusals', async () => {
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => cafe1.post('/api/requests', { text: `parallel ${i}` })));
    assert.equal(results.filter((r) => r.status === 201).length, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 4);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE customer_id = ?', cafe1.user.id), 10);
  });
});

describe('POST /api/requests: input validation and language', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-19: text is required, 1 to 4000 characters, and unknown fields are ignored', async () => {
    const cases = [[{}, 'required'], [{ text: '' }, 'length:1..4000'], [{ text: '   \n ' }, 'blank'], [{ text: 'a'.repeat(4001) }, 'length:1..4000'], [{ text: 42 }, 'string']];
    for (const [body, rule] of cases) {
      const res = await cafe1.post('/api/requests', body);
      assert.equal(res.status, 422, JSON.stringify(body).slice(0, 40));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(res.json.error.details.fields, [{ field: 'text', rule }]);
    }
    const ok = await cafe1.post('/api/requests', { text: 'a'.repeat(4000), customer_id: 999, intakeStatus: 'confirmed', id: 5 });
    assert.equal(ok.status, 201);
    assert.deepEqual(Object.keys(ok.json.request).sort(), ['createdAt', 'id', 'intakeStatus', 'language'].sort());
    assert.equal(ok.json.request.intakeStatus, 'draft');
    const row = h.db.prepare('SELECT customer_id, intake_status FROM rescue_requests WHERE id = ?').get(ok.json.request.id);
    assert.deepEqual({ ...row }, { customer_id: cafe1.user.id, intake_status: 'draft' });
    assert.equal(typeof ok.json.requestId, 'string');
  });

  test('RS-19: invalid JSON is 400, an oversized body is 413, a non-object body is 422', async () => {
    const bad = await cafe1.send({ method: 'POST', path: '/api/requests', body: '{"text":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_JSON');
    const big = await cafe1.send({ method: 'POST', path: '/api/requests', body: JSON.stringify({ text: 'x'.repeat(70000) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, 'PAYLOAD_TOO_LARGE');
    const list = await cafe1.send({ method: 'POST', path: '/api/requests', body: '[1]', headers: { 'Content-Type': 'application/json' } });
    assert.equal(list.status, 422);
  });

  test('RS-01: the language is ar, en, mixed or unknown from the letters of the text', async () => {
    const expected = [
      ['أحتاج مئتي كوب ومئتي غطاء قبل الساعة الحادية عشرة', 'ar'],
      ['I need two hundred cups before eleven', 'en'],
      ['I need 200 كوب and 200 غطاء before eleven today', 'mixed'],
      ['12345 !!!', 'unknown'],
    ];
    for (const [text, language] of expected) {
      const res = await cafe1.post('/api/requests', { text });
      assert.equal(res.status, 201);
      assert.equal(res.json.request.language, language, text);
    }
  });
});

describe('confirm: manual requirement confirmation and provenance (SEC-8)', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('SEC-8: without an extraction every confirmed field is manual, empty fields are unknown, and the version is 1', async () => {
    const id = await newRequest(cafe1);
    const res = await confirm(cafe1, id);
    assert.equal(res.status, 201, res.text);
    const { requirements, rescueStatus } = res.json;
    assert.equal(requirements.version, 1);
    assert.equal(typeof requirements.confirmedAt, 'string');
    for (const [name, value] of Object.entries(FIELDS)) {
      if (value === null) assert.deepEqual(requirements.fields[name], { value: null, status: 'unknown', provenance: 'none', originalWording: null }, name);
      else assert.deepEqual(requirements.fields[name], { value, status: 'known', provenance: 'manual', originalWording: null }, name);
    }
    assert.equal(rescueStatus.status, 'requirements_confirmed');
    assert.equal(rescueStatus.rule, '13');
    assert.deepEqual(rescueStatus.nextStep, { code: 'PLAN', text: 'Find a plan' });
    assert.equal(h.db.prepare('SELECT intake_status FROM rescue_requests WHERE id = ?').get(id).intake_status, 'confirmed');
    const again = await confirm(cafe1, id, { maxPickups: 3 });
    assert.equal(again.json.requirements.version, 2);
  });

  test('SEC-8: a client-sent provenance or wording is never used; the extraction decides only for equal values', async () => {
    const id = await newRequest(cafe1);
    h.db
      .prepare(
        "INSERT INTO extractions (request_id, provider, model, prompt_version, schema_ok, degraded, simulated, fields_json, questions_json, created_at) VALUES (?, 'fake', NULL, 'v1', 1, 0, 1, ?, '[]', ?)",
      )
      .run(
        id,
        JSON.stringify({
          cupQuantity: { value: 200, status: 'known', provenance: 'user_text', originalWording: '200 cups' },
          diameterMm: { value: 90, status: 'known', provenance: 'image', originalWording: 'Ø90' },
          capacityMl: { value: 300, status: 'known', provenance: 'user_text', originalWording: '300 ml' },
        }),
        '2026-10-20T06:00:05.000Z',
      );
    const res = await cafe1.post(`/api/requests/${id}/confirm`, {
      provenance: 'image',
      fields: { ...FIELDS, lidQuantity: 200, originalWording: 'forged', provenance: { cupQuantity: 'image' } },
    });
    assert.equal(res.status, 201, res.text);
    const f = res.json.requirements.fields;
    assert.deepEqual(f.cupQuantity, { value: 200, status: 'known', provenance: 'user_text', originalWording: '200 cups' });
    assert.deepEqual(f.diameterMm, { value: 90, status: 'known', provenance: 'image', originalWording: 'Ø90' });
    // The submitted capacity (250) differs from the extracted one (300): manual, no wording.
    assert.deepEqual(f.capacityMl, { value: 250, status: 'known', provenance: 'manual', originalWording: null });
    assert.deepEqual(f.lidQuantity, { value: 200, status: 'known', provenance: 'manual', originalWording: null });
    // Provenance as an object value is a validation failure, not a way to set it.
    const forged = await cafe1.post(`/api/requests/${id}/confirm`, { fields: { ...FIELDS, cupQuantity: { value: 200, provenance: 'image' } } });
    assert.equal(forged.status, 422);
    assert.deepEqual(forged.json.error.details.fields, [{ field: 'cupQuantity', rule: 'integer' }]);
  });

  test('SEC-8: a degraded extraction is ignored, so the manual path works when automatic reading is unavailable', async () => {
    const id = await newRequest(cafe1);
    h.db
      .prepare(
        "INSERT INTO extractions (request_id, provider, model, prompt_version, schema_ok, error_code, degraded, simulated, fields_json, questions_json, created_at) VALUES (?, 'fake', NULL, 'v1', 0, 'PROVIDER_TIMEOUT', 1, 1, ?, '[]', ?)",
      )
      .run(id, JSON.stringify({ cupQuantity: { value: 200, status: 'known', provenance: 'user_text', originalWording: 'forged' } }), '2026-10-20T06:00:05.000Z');
    const res = await confirm(cafe1, id);
    assert.equal(res.status, 201);
    assert.equal(res.json.requirements.fields.cupQuantity.provenance, 'manual');
  });

  test('RS-04: REQUIREMENTS_INCOMPLETE lists the missing core fields; budget and deadline are optional here', async () => {
    const id = await newRequest(cafe1);
    const fields = { ...FIELDS };
    delete fields.capacityMl;
    delete fields.maxPickups;
    fields.diameterMm = null;
    const res = await cafe1.post(`/api/requests/${id}/confirm`, { fields });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'REQUIREMENTS_INCOMPLETE');
    assert.deepEqual(res.json.error.details.fields, ['capacityMl', 'diameterMm', 'maxPickups']);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM requirements WHERE request_id = ?', id), 0);
    const noBudget = await confirm(cafe1, id, { budgetCents: null, deadline: null });
    assert.equal(noBudget.status, 201);
    assert.equal(noBudget.json.rescueStatus.status, 'needs_input');
    assert.equal(noBudget.json.rescueStatus.rule, '1');
    assert.match(noBudget.json.rescueStatus.message, /budget and deadline/);
  });

  test('RS-19: bad values are 422 VALIDATION_FAILED listing every field', async () => {
    const id = await newRequest(cafe1);
    const res = await confirm(cafe1, id, { productType: 'cakes', cupQuantity: -1, capacityMl: 250.5, diameterMm: 'wide', material: 'glass', deadline: '2026-13-40T99:00', budgetCents: 0, maxPickups: 6 });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    const named = Object.fromEntries(res.json.error.details.fields.map((f) => [f.field, f.rule]));
    assert.deepEqual(Object.keys(named).sort(), ['budgetCents', 'capacityMl', 'cupQuantity', 'deadline', 'diameterMm', 'material', 'maxPickups', 'productType']);
    for (const body of [{}, { fields: null }, { fields: [] }, { fields: 'x' }]) {
      const bad = await cafe1.post(`/api/requests/${id}/confirm`, body);
      assert.equal(bad.status, 422);
      assert.deepEqual(bad.json.error.details.fields, [{ field: 'fields', rule: 'object' }]);
    }
    const mismatch = await confirm(cafe1, id, { productType: 'cups', lidQuantity: 50 });
    assert.equal(mismatch.status, 422);
    assert.deepEqual(mismatch.json.error.details.fields, [{ field: 'lidQuantity', rule: 'zero_for_cups' }]);
  });

  test('confirm: changing the requirements supersedes the open plan, queues a re-plan (replanning), and the next plan answers the queue', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const first = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(first.status, 201);
    assert.equal(first.json.plan.status, 'proposed');
    const same = await confirm(cafe1, id);
    assert.equal(same.status, 201);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(first.json.plan.id).status, 'proposed', 'same values: no supersession');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?', id), 0);

    const changed = await confirm(cafe1, id, { maxPickups: 3 });
    assert.equal(changed.status, 201);
    assert.equal(changed.json.rescueStatus.status, 'replanning');
    assert.equal(changed.json.rescueStatus.rule, '4a');
    const old = h.db.prepare('SELECT status, supersede_reason FROM plan_versions WHERE id = ?').get(first.json.plan.id);
    assert.deepEqual({ ...old }, { status: 'superseded', supersede_reason: 'REQUIREMENTS_CHANGED' });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?', id), 1);

    const second = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(second.status, 201);
    assert.equal(second.json.plan.version, 2);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?', id), 0);
    assert.equal(h.db.prepare('SELECT superseded_by FROM plan_versions WHERE id = ?').get(first.json.plan.id).superseded_by, second.json.plan.id);
    const view = await cafe1.get(`/api/requests/${id}`);
    assert.deepEqual(view.json.plans.map((p) => [p.version, p.status]), [[2, 'proposed'], [1, 'superseded']]);
    assert.equal(view.json.currentPlanId, second.json.plan.id);
    assert.equal(view.json.plans[1].supersedeReason, 'REQUIREMENTS_CHANGED');
    assert.equal(view.json.plans[1].supersededBy, second.json.plan.id);
  });

  test('confirm: an executing or executed plan version is 409 PLAN_IN_PROGRESS; an approved plan with an active reservation is superseded and the reservation released by the void rule', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const planned = await cafe1.post(`/api/requests/${id}/plan`, {});
    const planId = planned.json.plan.id;
    h.db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(planId);
    h.db
      .prepare("INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (?, ?, 'key-live-0000000001', ?, 'active', '2026-10-20T07:00:00.000Z', '2026-10-20T06:00:00.000Z')")
      .run(planId, cafe1.user.id, `res:${cafe1.user.id}:${planId}:key-live-0000000001`);
    const reservationId = h.db.prepare('SELECT id FROM reservations WHERE plan_version_id = ?').get(planId).id;
    // One held bundle (supplier A's) so the release has stock to return.
    const offerA = h.db.prepare('SELECT o.id, o.product_id, o.supplier_id FROM offers o WHERE o.id = 1').get();
    h.db.prepare('INSERT INTO reservation_items (reservation_id, product_id, supplier_id, offer_id, qty) VALUES (?, ?, ?, ?, 1)').run(reservationId, offerA.product_id, offerA.supplier_id, offerA.id);
    h.db.prepare('UPDATE inventory SET reserved = 1 WHERE product_id = ?').run(offerA.product_id);

    const live = await confirm(cafe1, id, { maxPickups: 4 });
    assert.equal(live.status, 201, live.text);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM requirements WHERE request_id = ?', id), 2);
    const plan = h.db.prepare('SELECT status, supersede_reason FROM plan_versions WHERE id = ?').get(planId);
    assert.deepEqual({ ...plan }, { status: 'superseded', supersede_reason: 'REQUIREMENTS_CHANGED' });
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(reservationId).status, 'released');
    assert.equal(h.db.prepare('SELECT reserved FROM inventory WHERE product_id = ?').get(offerA.product_id).reserved, 0);
    const ledger = h.db.prepare("SELECT delta_reserved, ref_type, ref_id FROM inventory_ledger WHERE reason = 'release' AND ref_id = ?").all(reservationId);
    assert.deepEqual(ledger.map((r) => ({ ...r })), [{ delta_reserved: -1, ref_type: 'reservation', ref_id: reservationId }]);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?', id), 1);

    // An executing version is never superseded: the confirm is refused and writes nothing.
    h.db.prepare("UPDATE plan_versions SET status = 'executing' WHERE id = ?").run(planId);
    const running = await confirm(cafe1, id, { maxPickups: 3 });
    assert.equal(running.status, 409);
    assert.equal(running.json.error.code, 'PLAN_IN_PROGRESS');
  });
});

describe('plan: planning runs, versions, and the explanation', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2'); // a second customer keeps each one under the 10-plans-per-10-minutes limit
  });
  after(() => h.close());

  test('RS-06: POST /plan stores a proposed version A+B for 8400 cents with alternatives, planHash, trace and template explanation', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 201, res.text);
    const { planningRun, plan, labels } = res.json;
    assert.equal(planningRun.feasible, true);
    assert.equal(planningRun.requirementsVersion, 1);
    assert.deepEqual(planningRun.rejections, [
      { supplierCode: 'C', offerId: 3, codes: ['INCOMPATIBLE_LID_DIAMETER'] },
      { supplierCode: 'D', offerId: 4, codes: ['READY_AFTER_DEADLINE'] },
    ]);
    assert.equal(plan.status, 'proposed');
    assert.equal(plan.version, 1);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.body.totalCents, 8400);
    assert.equal(plan.body.pickupCount, 2);
    assert.equal(plan.body.readyAt, '2026-10-20T07:30:00.000Z');
    assert.deepEqual(plan.body.lines.map((l) => [l.supplierCode, l.bundles, l.unitPriceCents, l.demo]), [['A', 1, 3000, true], ['B', 1, 3600, true]]);
    assert.deepEqual(plan.body.suppliers.map((s) => [s.supplierCode, s.totalCents, s.demo]), [['A', 4000, true], ['B', 4400, true]]);
    assert.deepEqual(plan.body.surplus, { cups: 0, lids: 0 });
    assert.equal(plan.alternatives.length, 2);
    assert.equal(plan.alternatives[0].totalCents, 9500);
    assert.equal(plan.trace.inputs.deadlineAt, '2026-10-20T08:00:00.000Z');
    assert.equal(plan.trace.comparisons[0].decidedBy, 'total');
    assert.equal(plan.explanation.lines[0].text, 'Best plan: A+B for $84.00 in total, 2 pickups, ready by 10:30.');
    assert.equal(plan.explanation.rephrased, null);
    assert.deepEqual(planningRun.explanation, plan.explanation);
    assert.equal(plan.nonExecutableReason, null);
    assert.equal(plan.supersededBy, null);
    assert.equal(labels.priceNotice, 'Test prices, not market prices');
    assert.equal(labels.demoData, true);
    const row = h.db.prepare('SELECT total_cents, pickup_count, plan_hash FROM plan_versions WHERE id = ?').get(plan.id);
    assert.deepEqual({ ...row }, { total_cents: 8400, pickup_count: 2, plan_hash: plan.planHash });
  });

  test('RS-07: an infeasible run stores blocking constraints, candidate codes and relaxations and no plan version', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id, { budgetCents: 5000 });
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.plan, null);
    const run = res.json.planningRun;
    assert.equal(run.feasible, false);
    assert.ok(run.blocking.includes('OVER_BUDGET'));
    assert.ok(run.relaxations.some((r) => r.constraint === 'budget' && r.neededValue === 8400));
    assert.ok(run.candidateCodes.length > 0);
    assert.ok(run.explanation.lines.some((l) => l.code === 'NO_FEASIBLE_PLAN'));
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM plan_versions WHERE request_id = ?', id), 0);
    const view = await cafe1.get(`/api/requests/${id}`);
    assert.equal(view.json.rescueStatus.status, 'no_feasible_plan');
    assert.equal(view.json.planning.id, run.id);
    assert.equal(view.json.currentPlanId, null);
  });

  test('RS-04: a plan can be made without budget and deadline (unconstrained) but the request still needs input', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id, { budgetCents: null, deadline: null });
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 201);
    assert.equal(res.json.plan.status, 'proposed');
    assert.equal(res.json.plan.trace.inputs.budgetCents, null);
    assert.equal(res.json.plan.trace.inputs.deadlineAt, null);
    const view = await cafe1.get(`/api/requests/${id}`);
    assert.equal(view.json.rescueStatus.status, 'needs_input');
  });

  test('plan: no confirmed requirements is 409 INVALID_STATE and uses no planning slot', async () => {
    const id = await newRequest(cafe1);
    const slots = () => count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", `plan:u:${cafe1.user.id}`);
    const before = slots();
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'INVALID_STATE');
    assert.equal(slots(), before);
  });

  test('plan: planning again replaces the open version (REPLANNED) and never touches a version with a live reservation', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const one = (await cafe1.post(`/api/requests/${id}/plan`, {})).json.plan;
    const two = (await cafe1.post(`/api/requests/${id}/plan`, {})).json.plan;
    assert.equal(two.version, 2);
    const old = h.db.prepare('SELECT status, supersede_reason, superseded_by FROM plan_versions WHERE id = ?').get(one.id);
    assert.deepEqual({ ...old }, { status: 'superseded', supersede_reason: 'REPLANNED', superseded_by: two.id });
    h.db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(two.id);
    h.db
      .prepare("INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (?, ?, 'key-live-0000000002', ?, 'active', '2026-10-20T07:00:00.000Z', '2026-10-20T06:00:00.000Z')")
      .run(two.id, cafe1.user.id, `res:${cafe1.user.id}:${two.id}:key-live-0000000002`);
    const blocked = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'PLAN_IN_PROGRESS');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(two.id).status, 'approved');
  });

  test('RS-09: a supplier that refused an order of this request is left out of the next plan (A+E at 9500)', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const one = (await cafe1.post(`/api/requests/${id}/plan`, {})).json.plan;
    h.db.prepare("UPDATE plan_versions SET status = 'non_executable', non_executable_reason = 'SUPPLIER_REFUSED' WHERE id = ?").run(one.id);
    h.db
      .prepare("INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at, closed_at) VALUES (?, ?, 'key-refused-000001', ?, 'released', '2026-10-20T07:00:00.000Z', '2026-10-20T06:00:00.000Z', '2026-10-20T06:05:00.000Z')")
      .run(one.id, cafe1.user.id, `res:${cafe1.user.id}:${one.id}:key-refused-000001`);
    const reservationId = h.db.prepare('SELECT id FROM reservations WHERE plan_version_id = ?').get(one.id).id;
    const supplierB = h.db.prepare("SELECT id FROM suppliers WHERE code = 'B'").get().id;
    h.db
      .prepare("INSERT INTO supplier_orders (plan_version_id, supplier_id, reservation_id, lines_json, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, refusal_reason, created_at) VALUES (?, ?, ?, '[]', 3600, 800, 0, 4400, 'refused', 'out of paper', '2026-10-20T06:03:00.000Z')")
      .run(one.id, supplierB, reservationId);
    const next = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(next.status, 201, next.text);
    assert.deepEqual(next.json.plan.body.lines.map((l) => l.supplierCode), ['A', 'E']);
    assert.equal(next.json.plan.body.totalCents, 9500);
    assert.deepEqual(next.json.plan.trace.inputs.excludeSupplierCodes, ['B']);
  });

  test('RS-09: with B withdrawn, and separately with B out of stock, the best plan is A+E at 9500 on the live catalog', async () => {
    const id = await newRequest(cafe2);
    await confirm(cafe2, id);
    h.db.prepare("UPDATE offers SET status = 'withdrawn' WHERE id = 2").run();
    try {
      const res = await cafe2.post(`/api/requests/${id}/plan`, {});
      assert.equal(res.status, 201);
      assert.deepEqual(res.json.plan.body.lines.map((l) => l.supplierCode), ['A', 'E']);
      assert.equal(res.json.plan.body.totalCents, 9500);
      assert.ok(res.json.planningRun.rejections.some((r) => r.supplierCode === 'B' && r.codes.includes('OFFER_WITHDRAWN')));
    } finally {
      h.db.prepare("UPDATE offers SET status = 'active' WHERE id = 2").run();
    }
    const bProduct = h.db.prepare('SELECT product_id FROM offers WHERE id = 2').get().product_id;
    h.db.prepare('UPDATE inventory SET on_hand = 0 WHERE product_id = ?').run(bProduct);
    try {
      const res = await cafe2.post(`/api/requests/${id}/plan`, {});
      assert.equal(res.status, 201);
      assert.deepEqual(res.json.plan.body.lines.map((l) => l.supplierCode), ['A', 'E']);
      assert.ok(res.json.planningRun.rejections.some((r) => r.supplierCode === 'B' && r.codes.includes('OUT_OF_STOCK')));
    } finally {
      h.db.prepare('UPDATE inventory SET on_hand = 1 WHERE product_id = ?').run(bProduct);
    }
  });
});

describe('PB-3 / RISK-19: the planner limit and the planning rate limit', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => {
    h.app.deps.planner = realPlanner;
    return h.close();
  });

  // A genuine PlannerLimitError, produced by the planner's own search with a node cap of 1.
  function genuineLimitError() {
    const survivors = [
      { supplierCode: 'A', unitCups: 1, unitLids: 1, priceCents: 5, prepFeeCents: 0, readyMs: 0, bound: 10, ci: 0 },
      { supplierCode: 'B', unitCups: 1, unitLids: 1, priceCents: 6, prepFeeCents: 0, readyMs: 0, bound: 10, ci: 1 },
    ];
    try {
      search(survivors, { cups: 8, lids: 8 }, 0, { budget: Number.POSITIVE_INFINITY, maxPickups: Number.POSITIVE_INFINITY }, { maxNodes: 1 });
    } catch (err) {
      return err;
    }
    throw new Error('search did not reach maxNodes');
  }

  test('PB-3: FU-1 a planner limit is a typed 422 VALIDATION_FAILED (plan / planner_limit); no run is stored and the status is unchanged', async () => {
    const limit = genuineLimitError();
    assert.ok(limit instanceof PlannerLimitError);
    assert.equal(limit.code, 'PLANNER_LIMIT');
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const statusBefore = (await cafe1.get(`/api/requests/${id}`)).json.rescueStatus;
    h.app.deps.planner = () => {
      throw limit;
    };
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(res.json.error.details, { fields: [{ field: 'plan', rule: 'planner_limit' }] });
    assert.equal(typeof res.json.error.requestId, 'string');
    assert.ok(!JSON.stringify(res.json).includes('maxNodes') && !JSON.stringify(res.json).includes('PlannerLimitError'), 'no internals in the body');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM planning_runs WHERE request_id = ?', id), 0);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM plan_versions WHERE request_id = ?', id), 0);
    assert.deepEqual((await cafe1.get(`/api/requests/${id}`)).json.rescueStatus, statusBefore);
    h.app.deps.planner = realPlanner;
    assert.equal((await cafe1.post(`/api/requests/${id}/plan`, {})).status, 201, 'the same request plans normally once the limit is gone');
  });

  test('PB-3: FU-1 a limit hit during a re-plan keeps the open proposed version', async () => {
    const limit = genuineLimitError();
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const one = (await cafe1.post(`/api/requests/${id}/plan`, {})).json.plan;
    h.app.deps.planner = () => {
      throw limit;
    };
    const res = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 422);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(one.id).status, 'proposed', 'the rollback kept the open version');
    h.app.deps.planner = realPlanner;
  });

  test('RISK-19: FU-8 the 11th plan of a customer within 10 minutes is 429 RATE_LIMITED, details.limit plan, with Retry-After', async () => {
    const id = await newRequest(cafe2);
    await confirm(cafe2, id);
    const statusCodes = [];
    for (let i = 0; i < 10; i += 1) statusCodes.push((await cafe2.post(`/api/requests/${id}/plan`, {})).status);
    assert.deepEqual(statusCodes, Array(10).fill(201));
    const planCountBefore = count(h, 'SELECT COUNT(*) AS n FROM planning_runs WHERE request_id = ?', id);
    const res = await cafe2.post(`/api/requests/${id}/plan`, {});
    assert.equal(res.status, 429);
    assert.equal(res.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(res.json.error.details, { limit: 'plan' });
    assert.equal(res.headers['retry-after'], '600');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM planning_runs WHERE request_id = ?', id), planCountBefore, 'a refused call never ran the planner');
    // The count is per customer: another customer plans freely.
    const other = await newRequest(cafe1);
    await confirm(cafe1, other);
    assert.equal((await cafe1.post(`/api/requests/${other}/plan`, {})).status, 201);
  });

  test('RISK-19: FU-8 the planning count lives in rate_events (kind general, key plan:u:<id>) and expires with the window', async () => {
    const key = `plan:u:${cafe2.user.id}`;
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", key), 10);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", `u:${cafe2.user.id}`), 0, 'the general per-user limit keeps its own key');
    const ids = h.db.prepare('SELECT id FROM rescue_requests WHERE customer_id = ? ORDER BY id LIMIT 1').get(cafe2.user.id);
    h.clock.advance(10 * 60 * 1000);
    assert.equal((await cafe2.post(`/api/requests/${ids.id}/plan`, {})).status, 201);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", key), 1);
  });

  test('RISK-19: FU-8 a request that would not run the planner (404, no requirements) does not use a planning slot', async () => {
    const cafe = await signIn(h, 'cafe1');
    const key = `plan:u:${cafe.user.id}`;
    const before = count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", key);
    assert.equal((await cafe.post('/api/requests/999999/plan', {})).status, 404);
    const draft = await newRequest(cafe);
    assert.equal((await cafe.post(`/api/requests/${draft}/plan`, {})).status, 409);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?", key), before);
  });
});

describe('RISK-19: FU-8 the planning limit is configurable', () => {
  test('RISK-19: the default is 10 per 10 minutes; config.planRateLimit / planRateWindowMin and an injected planRate override it; bad values are refused', () => {
    assert.deepEqual({ ...resolvePlanRate({}) }, { limit: 10, windowMs: 600000 });
    assert.deepEqual({ ...resolvePlanRate({ planRateLimit: 3, planRateWindowMin: 1 }) }, { limit: 3, windowMs: 60000 });
    assert.deepEqual({ ...resolvePlanRate({ planRateLimit: 3, planRateWindowMin: 1 }, { limit: 2, windowMs: 5000 }) }, { limit: 2, windowMs: 5000 });
    for (const bad of [{ planRateLimit: 0 }, { planRateLimit: 1.5 }, { planRateWindowMin: 0 }]) assert.throws(() => resolvePlanRate(bad), RangeError);
  });

  test('RISK-19: an app created with a stricter planRate refuses the 3rd plan of a customer in the window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-planrate-'));
    const config = loadConfig({ PORT: '0', RS_DB_PATH: join(dir, 'app.db'), RS_UPLOAD_DIR: join(dir, 'uploads'), RS_TEST_OFFLINE: '1', RS_DEMO_DATE: '2026-10-20', RS_MODEL_PROVIDER: 'fake' });
    const clock = fixedClock(Date.UTC(2026, 9, 20, 6, 0, 0));
    const db = openDb(config.dbPath, { busyTimeoutMs: 100 });
    migrate(db, { clock });
    const { seedDatabase } = await import('../../scripts/seed.js');
    seedDatabase(db, { clock, demoDate: '2026-10-20', demoPassword: DEMO_PASSWORD });
    const app = createApp({ db, clock, config, log: createLogger({ write: () => {}, clock }), planRate: { limit: 2, windowMs: 60_000 } });
    const port = await app.listen(0, '127.0.0.1');
    try {
      const request = (options) => new Promise((resolve, reject) => {
        const payload = options.jsonBody === undefined ? undefined : JSON.stringify(options.jsonBody);
        const headers = { ...(options.headers ?? {}) };
        if (payload !== undefined) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers, agent: false }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
          });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
      const client = createClient(request);
      await client.signIn('cafe1', DEMO_PASSWORD);
      const id = (await client.post('/api/requests', { text: 'cups' })).json.request.id;
      assert.equal((await client.post(`/api/requests/${id}/confirm`, { fields: FIELDS })).status, 201);
      assert.equal((await client.post(`/api/requests/${id}/plan`, {})).status, 201);
      assert.equal((await client.post(`/api/requests/${id}/plan`, {})).status, 201);
      const third = await client.post(`/api/requests/${id}/plan`, {});
      assert.equal(third.status, 429);
      assert.deepEqual(third.json.error.details, { limit: 'plan' });
      assert.equal(third.headers['retry-after'], '60');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FU-7 and RS-34: view shapes and labels', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-34: GET /api/requests/:id carries labels and the planned shape of the contract fixture', async () => {
    const id = await newRequest(cafe1);
    await confirm(cafe1, id);
    const plan = (await cafe1.post(`/api/requests/${id}/plan`, {})).json.plan;
    const res = await cafe1.get(`/api/requests/${id}`);
    assert.equal(res.status, 200);
    const v = res.json;
    assert.deepEqual(Object.keys(v).sort(), ['cancellingOrders', 'currentPlanId', 'extraction', 'labels', 'orders', 'plans', 'planning', 'request', 'requestId', 'requirements', 'reservation', 'rescueStatus'].sort());
    assert.deepEqual(Object.keys(v.request).sort(), ['createdAt', 'id', 'image', 'intakeStatus', 'language', 'rawText']);
    assert.equal(v.request.rawText, TEXT);
    assert.equal(v.request.image, null);
    assert.equal(v.extraction, null);
    assert.equal(v.requirements.version, 1);
    assert.equal(v.planning.feasible, true);
    assert.equal(v.currentPlanId, plan.id);
    assert.equal(v.reservation, null);
    assert.deepEqual(v.orders, []);
    assert.deepEqual(v.cancellingOrders, []);
    assert.deepEqual(v.plans[0], plan);
    assert.deepEqual(v.labels, {
      simulatedPayments: true, simulatedExtraction: true, sandbox: false, demoData: true, priceNotice: 'Test prices, not market prices',
      merchantMode: 'per-supplier', singleCredentialNotice: null, testMode: true,
    });
    assert.equal(v.rescueStatus.status, 'plan_found');
    assert.equal(v.rescueStatus.rule, '12');
    assert.deepEqual(v.rescueStatus.nextStep, { code: 'APPROVE_PLAN', text: 'Approve the plan' });
    assert.equal(v.rescueStatus.message, null);
    assert.deepEqual(v.rescueStatus.underlying, { plan: 'proposed', reservation: null, payments: [], fulfilment: [] });
    const list = await cafe1.get('/api/requests');
    const row = list.json.requests.find((r) => r.id === id);
    assert.deepEqual(row, { id, createdAt: v.request.createdAt, rescueStatus: { status: 'plan_found', nextStep: { code: 'APPROVE_PLAN', text: 'Approve the plan' } }, totalCents: 8400 });
  });

  test('RS-34: a fresh draft request is needs_input / ENTER_DETAILS with no plans', async () => {
    const id = await newRequest(cafe1, 'cups please');
    const v = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.equal(v.rescueStatus.status, 'needs_input');
    assert.equal(v.rescueStatus.nextStep.code, 'ENTER_DETAILS');
    assert.deepEqual(v.plans, []);
    assert.equal(v.requirements, null);
    assert.equal(v.planning, null);
  });
});
