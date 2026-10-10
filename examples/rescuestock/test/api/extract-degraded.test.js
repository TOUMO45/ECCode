// API tests for the degraded path of extraction (task d3-extraction-service), RS-03: when the provider times out, errors,
// returns invalid or schema-invalid output, or is refused by the daily budget or the rate limit, the extraction row has
// schema_ok = 0 and an error code, every field is unknown, the response carries degraded: true, and the journey continues with
// manual provenance. Faults come from the fake_model:* rows of fault_flags (c3's convention: name <kind>:<fault>, remaining
// count or NULL). The provider is simulated; the pipeline and the harness are what these tests prove.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_DATE, DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { compareShape } from '../helpers/contract-shape.js';
import { createClient } from '../helpers/fixtures.js';
import { canonicalFields } from '../helpers/plan-flow.js';
import { createAiRuntime } from '../../src/services/extraction.js';
import { createFakeProvider } from '../../src/ai/fake.js';
import { ProviderError } from '../../src/ai/provider.js';

const EN = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
const NINE = ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups'];
const WINDOW_MS = 11 * 60 * 1000;

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function newRequest(client, text = EN) {
  const res = await client.post('/api/requests', { text });
  assert.equal(res.status, 201, res.text);
  return res.json.request.id;
}

const extract = (client, id) => client.post(`/api/requests/${id}/extract`, {});
const setFault = (h, fault, remaining) =>
  h.db.prepare("INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES (?, '', ?, ?)").run(`fake_model:${fault}`, remaining, new Date(h.clock.now()).toISOString());
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;

function assertDegraded(extraction, errorCode) {
  assert.equal(extraction.degraded, true);
  assert.equal(extraction.schemaOk, false);
  assert.equal(extraction.errorCode, errorCode);
  assert.deepEqual(Object.keys(extraction.fields), NINE);
  for (const name of NINE) assert.deepEqual(extraction.fields[name], { value: null, status: 'unknown', provenance: 'none', originalWording: null }, name);
  assert.deepEqual(extraction.questions, []);
  assert.equal(extraction.addressedToAssistant, false);
}

describe('RS-03: faults of the fake provider end in the degraded path', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());
  beforeEach(() => {
    h.clock.advance(WINDOW_MS);
    h.db.prepare('DELETE FROM fault_flags').run();
  });

  for (const [fault, errorCode] of [
    ['timeout', 'PROVIDER_TIMEOUT'],
    ['invalid_json', 'PROVIDER_BAD_OUTPUT'],
    ['schema_invalid', 'PROVIDER_BAD_OUTPUT'],
    ['error', 'PROVIDER_UNAVAILABLE'],
  ]) {
    test(`RS-03: fake_model:${fault} -> 200, degraded true, schemaOk false, ${errorCode}, every field unknown, the row is stored`, async () => {
      setFault(h, fault, 1);
      const id = await newRequest(cafe1);
      const res = await extract(cafe1, id);
      assert.equal(res.status, 200, res.text);
      assertDegraded(res.json.extraction, errorCode);
      assert.deepEqual(compareShape(JSON.parse(readFileSync(new URL('../fixtures/contracts/request-extract-degraded.json', import.meta.url), 'utf8')).response, res.json), []);
      const row = h.db.prepare('SELECT * FROM extractions WHERE request_id = ?').get(id);
      assert.equal(row.id, res.json.extraction.id);
      assert.equal(row.schema_ok, 0);
      assert.equal(row.degraded, 1);
      assert.equal(row.error_code, errorCode);
      assert.equal(h.db.prepare('SELECT intake_status FROM rescue_requests WHERE id = ?').get(id).intake_status, 'draft', 'a degraded row is not an extraction');
      assert.equal(count(h, 'SELECT COUNT(*) AS n FROM fault_flags'), 0, 'a fault with remaining 1 is used up by one call');
      // The reservation was released: nothing stays in flight, so the next call is not refused for concurrency.
      assert.equal(count(h, "SELECT COUNT(*) AS n FROM model_spend WHERE status = 'reserved'"), 0);
      const again = await extract(cafe1, id);
      assert.equal(again.status, 200);
      assert.equal(again.json.extraction.degraded, false);
      assert.equal(again.json.extraction.fields.cupQuantity.value, 200);
    });
  }

  test('RS-03: a fault with remaining 2 degrades two calls; a fault without a count stays until cleared', async () => {
    const id = await newRequest(cafe1);
    setFault(h, 'error', 2);
    assert.equal((await extract(cafe1, id)).json.extraction.degraded, true);
    assert.equal((await extract(cafe1, id)).json.extraction.degraded, true);
    assert.equal((await extract(cafe1, id)).json.extraction.degraded, false);
    setFault(h, 'timeout', null);
    for (let i = 0; i < 3; i += 1) assert.equal((await extract(cafe1, id)).json.extraction.errorCode, 'PROVIDER_TIMEOUT');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM fault_flags'), 1);
    h.db.prepare('DELETE FROM fault_flags').run();
    assert.equal((await extract(cafe1, id)).json.extraction.degraded, false);
  });

  test('RS-03: the journey continues: manual confirmation of every field gives manual provenance and planning proceeds', async () => {
    setFault(h, 'timeout', 1);
    const id = await newRequest(cafe1);
    const { extraction } = (await extract(cafe1, id)).json;
    assertDegraded(extraction, 'PROVIDER_TIMEOUT');
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.equal(view.extraction.degraded, true);
    assert.equal(view.labels.simulatedExtraction, true);
    assert.equal(view.rescueStatus.nextStep.code, 'ENTER_DETAILS');

    const confirmed = await cafe1.post(`/api/requests/${id}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    assert.equal(confirmed.status, 201, confirmed.text);
    for (const [name, field] of Object.entries(confirmed.json.requirements.fields)) {
      if (field.status === 'known') assert.deepEqual([field.provenance, field.originalWording], ['manual', null], name);
    }
    const planned = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(planned.status, 201, planned.text);
    assert.ok(planned.json.plan, 'a feasible plan was made from manually entered fields');
  });

  test('RS-03: a repeated refusal or failure replaces the newest degraded row; the table does not grow with each retry', async () => {
    setFault(h, 'error', null);
    const id = await newRequest(cafe1);
    for (let i = 0; i < 4; i += 1) await extract(cafe1, id);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM extractions WHERE request_id = ?', id), 1);
  });

  test('NFR6: no log line carries the request text or the extraction (ids and statuses only)', async () => {
    setFault(h, 'invalid_json', 1);
    const secret = 'ZEBRA-TEXT-4711 I need 200 cups';
    const id = await newRequest(cafe1, secret);
    await extract(cafe1, id);
    await extract(cafe1, id);
    const logs = h.lines.join('');
    assert.doesNotMatch(logs, /ZEBRA|4711/);
    assert.match(logs, /"requestId":"/);
  });
});

describe('RS-03: the provider call is bounded and never runs inside a transaction', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MODEL_TIMEOUT_MS: '60', RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());
  beforeEach(() => h.clock.advance(WINDOW_MS));

  const runtimeWith = (extractFn) =>
    createAiRuntime({
      db: h.db, clock: h.clock, config: h.config,
      provider: { id: 'fake', simulated: true, model: 'probe', extract: extractFn },
    });

  test('NFR6: the reservation exists and no transaction is open while the provider runs', async () => {
    let observed = null;
    h.app.deps.ai = runtimeWith(async () => {
      observed = {
        inTx: h.db.inTx,
        reserved: h.db.prepare("SELECT reserved_micro_usd FROM model_spend WHERE status = 'reserved'").all().map((r) => r.reserved_micro_usd),
      };
      throw new ProviderError('PROVIDER_UNAVAILABLE');
    });
    const id = await newRequest(cafe1);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200);
    assert.deepEqual(observed, { inTx: false, reserved: [50000] });
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM model_spend WHERE status = 'reserved'"), 0);
  });

  test('RS-03: a provider that never answers ends at RS_MODEL_TIMEOUT_MS as PROVIDER_TIMEOUT, charged at the cap', async () => {
    h.app.deps.ai = runtimeWith(() => new Promise(() => {}));
    const id = await newRequest(cafe1);
    const started = Date.now();
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    assertDegraded(res.json.extraction, 'PROVIDER_TIMEOUT');
    assert.ok(Date.now() - started < 3000);
    const spend = h.db.prepare('SELECT actual_micro_usd, status FROM model_spend WHERE request_id = ? ORDER BY id DESC').get(id);
    assert.deepEqual({ ...spend }, { actual_micro_usd: 50000, status: 'settled' });
  });

  test('RS-03: a provider that throws something unexpected is PROVIDER_UNAVAILABLE, with nothing of the error in the response', async () => {
    h.app.deps.ai = runtimeWith(async () => {
      throw new TypeError('secret internals: sk-live-should-not-leak SELECT * FROM users');
    });
    const id = await newRequest(cafe1);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200);
    assertDegraded(res.json.extraction, 'PROVIDER_UNAVAILABLE');
    assert.doesNotMatch(res.text, /secret|sk-live|SELECT/);
    assert.doesNotMatch(h.lines.join(''), /secret internals|sk-live/);
  });

  test('RS-03: an answer that is not a valid extraction, or whose usage is unreadable, is PROVIDER_BAD_OUTPUT', async () => {
    h.app.deps.ai = runtimeWith(async () => ({ output: { language: 'en', fields: {}, questions: [], addressedToAssistant: false }, usage: { costUsd: 0 } }));
    const a = await extract(cafe1, await newRequest(cafe1));
    assertDegraded(a.json.extraction, 'PROVIDER_BAD_OUTPUT');
    const valid = createFakeProvider({ imageMap: {}, clock: h.clock });
    h.app.deps.ai = runtimeWith(async (input) => ({ ...(await valid.extract(input)), usage: { costMicroUsd: -5 } }));
    const b = await extract(cafe1, await newRequest(cafe1));
    assertDegraded(b.json.extraction, 'PROVIDER_BAD_OUTPUT');
    const spend = h.db.prepare("SELECT actual_micro_usd FROM model_spend ORDER BY id DESC LIMIT 1").get();
    assert.equal(spend.actual_micro_usd, 50000, 'unreadable usage is charged at the cap, never at zero');
  });
});

describe('RS-03: refusals by the budget or the rate limit are degraded too, and the provider is not invoked', () => {
  let h;
  let cafe1;
  let calls;
  const countingRuntime = () => {
    const inner = createFakeProvider({ imageMap: {}, clock: h.clock, costMicroUsd: h.config.fakeModelCostMicroUsd });
    return createAiRuntime({
      db: h.db, clock: h.clock, config: h.config,
      provider: { ...inner, extract: async (input) => { calls += 1; return inner.extract(input); } },
    });
  };
  before(async () => {
    // Cap 0.10 and a budget of 0.05: even the first call would not fit.
    h = await startHarness({ seed: true, env: { RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.05' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());
  beforeEach(() => {
    calls = 0;
    h.clock.advance(WINDOW_MS);
    h.app.deps.ai = countingRuntime();
  });

  test('RS-03: a budget refusal is 503 MODEL_BUDGET_EXHAUSTED with details {scope, degraded, extraction}; a degraded row is stored; no call', async () => {
    const id = await newRequest(cafe1);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'MODEL_BUDGET_EXHAUSTED');
    assert.equal(res.json.error.details.scope, 'global');
    assert.equal(res.json.error.details.degraded, true);
    assertDegraded(res.json.error.details.extraction, 'PROVIDER_UNAVAILABLE');
    assert.equal(typeof res.json.error.requestId, 'string');
    assert.equal(calls, 0, 'the provider was never invoked');
    const row = h.db.prepare('SELECT schema_ok, degraded, error_code FROM extractions WHERE request_id = ?').get(id);
    assert.deepEqual({ ...row }, { schema_ok: 0, degraded: 1, error_code: 'PROVIDER_UNAVAILABLE' });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM model_spend'), 0, 'nothing was reserved');
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.equal(view.extraction.degraded, true);
  });

  test('RS-03: the concurrency refusal (one call in flight per customer) is 429 model_concurrency with Retry-After and a degraded row', async () => {
    const user = h.db.prepare("SELECT id FROM users WHERE username = 'cafe1'").get();
    // A reserved model_spend row is an in-flight call of this customer; the concurrency rule is tested before the budget.
    h.db.prepare("INSERT INTO model_spend (day, customer_id, request_id, purpose, reserved_micro_usd, status, created_at) VALUES ('2026-10-20', ?, NULL, 'extract', 1, 'reserved', ?)")
      .run(user.id, new Date(h.clock.now()).toISOString());
    const id = await newRequest(cafe1);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 429, res.text);
    assert.equal(res.json.error.code, 'RATE_LIMITED');
    assert.equal(res.json.error.details.limit, 'model_concurrency');
    assert.equal(res.json.error.details.degraded, true);
    assertDegraded(res.json.error.details.extraction, 'PROVIDER_BUSY');
    assert.match(res.headers['retry-after'], /^\d+$/);
    h.db.prepare("DELETE FROM model_spend WHERE reserved_micro_usd = 1").run();
  });
});

describe('RS-03: the 11th extract in ten minutes is a degraded 429', () => {
  let h;
  let cafe1;
  let calls = 0;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    const inner = createFakeProvider({ imageMap: {}, clock: h.clock });
    h.app.deps.ai = createAiRuntime({
      db: h.db, clock: h.clock, config: h.config,
      provider: { ...inner, extract: async (input) => { calls += 1; return inner.extract(input); } },
    });
  });
  after(() => h.close());

  test('RS-03: the rate refusal stores a degraded row, carries Retry-After, and does not call the provider', async () => {
    const id = await newRequest(cafe1);
    for (let i = 0; i < 10; i += 1) assert.equal((await extract(cafe1, id)).status, 200, `call ${i + 1}`);
    assert.equal(calls, 10);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 429, res.text);
    assert.equal(res.json.error.code, 'RATE_LIMITED');
    assert.equal(res.json.error.details.limit, 'extract_upload');
    assert.equal(res.json.error.details.degraded, true);
    assertDegraded(res.json.error.details.extraction, 'PROVIDER_BUSY');
    assert.ok(Number(res.headers['retry-after']) >= 1);
    assert.equal(calls, 10, 'no eleventh provider call');
    const latest = h.db.prepare('SELECT degraded, schema_ok, error_code FROM extractions WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(id);
    assert.deepEqual({ ...latest }, { degraded: 1, schema_ok: 0, error_code: 'PROVIDER_BUSY' });
  });
});
