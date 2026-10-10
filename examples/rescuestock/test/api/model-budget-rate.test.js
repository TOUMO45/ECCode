// API tests for the runtime controls on model calls (task d3-extraction-service): NFR6 (daily budget in integer micro-dollars,
// per-customer extract/upload rate limit, haiku by default) and SEC-10 (one call in flight per customer, per-customer daily share).
// The provider is the simulated fake with a configured per-call cost; no model is called.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { loadAdapterFactories } from '../../src/main.js';
import { createAiRuntime, takeModelFault } from '../../src/services/extraction.js';
import { createFakeProvider } from '../../src/ai/fake.js';

const EN = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('label')]);
const WINDOW_MS = 10 * 60 * 1000;

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
const upload = (client, id) => client.send({ method: 'POST', path: `/api/requests/${id}/image`, headers: { 'Content-Type': 'image/png' }, body: PNG });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;

// A harness whose provider is the fake wrapped in a call counter.
async function harnessWith(env) {
  const h = await startHarness({ seed: true, env });
  const state = { calls: 0 };
  const inner = createFakeProvider({ imageMap: {}, clock: h.clock, costMicroUsd: h.config.fakeModelCostMicroUsd, faults: () => takeModelFault(h.db) });
  const runtime = createAiRuntime({
    db: h.db, clock: h.clock, config: h.config,
    provider: { ...inner, extract: async (input) => { state.calls += 1; return inner.extract(input); } },
  });
  h.app.deps.ai = runtime;
  return { h, state, runtime };
}

describe('NFR6: the daily model budget, in integer micro-dollars', () => {
  // The share is pinned to 1 in this environment on purpose (F-TR-18, decision dec-mv1e2i5k-01a1bebb): NFR6 asserts the GLOBAL
  // budget. With the production default share of 0.2, a customer's own allowance (0.2 x 0.25 = USD 0.05) would be smaller than the
  // per-call cap of USD 0.10, so the first call would already be refused for the customer and the global limit under test would
  // never be reached. The SEC-10 case below runs with the default 0.2.
  test('NFR6: with a fake per-call cost cap of USD 0.10 and RS_MODEL_DAILY_BUDGET_USD=0.25 the third extract is refused with 503 MODEL_BUDGET_EXHAUSTED without invoking the provider and enters the degraded path (RS_MODEL_CUSTOMER_DAILY_SHARE=1)', async () => {
    const { h, state } = await harnessWith({
      RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.25', RS_FAKE_MODEL_COST_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      const id = await newRequest(cafe1);
      const first = await extract(cafe1, id);
      const second = await extract(cafe1, id);
      assert.equal(first.status, 200, first.text);
      assert.equal(second.status, 200, second.text);
      assert.equal(first.json.extraction.degraded, false);
      assert.equal(state.calls, 2);
      assert.equal(count(h, "SELECT SUM(actual_micro_usd) AS n FROM model_spend WHERE status = 'settled'"), 200000);

      const third = await extract(cafe1, id); // 200000 + 100000 > 250000
      assert.equal(third.status, 503, third.text);
      assert.equal(third.json.error.code, 'MODEL_BUDGET_EXHAUSTED');
      assert.equal(third.json.error.details.scope, 'global');
      assert.equal(state.calls, 2, 'the provider was not invoked for the refused call');
      assert.equal(third.json.error.details.degraded, true);
      assert.equal(third.json.error.details.extraction.degraded, true);
      assert.equal(third.json.error.details.extraction.schemaOk, false);
      assert.equal(typeof third.json.error.details.extraction.errorCode, 'string');
      assert.ok(Object.values(third.json.error.details.extraction.fields).every((f) => f.status === 'unknown'));
      assert.equal(third.json.error.requestId, third.headers['x-request-id']);

      // The budget is global: another customer is refused as well.
      const cafe2 = await signIn(h, 'cafe2');
      const other = await extract(cafe2, await newRequest(cafe2));
      assert.equal(other.status, 503);
      assert.equal(other.json.error.details.scope, 'global');
      assert.equal(state.calls, 2);
    } finally {
      await h.close();
    }
  });

  test('NFR6: config inspection shows haiku as the default model and the amounts as integer micro-dollars', () => {
    const config = loadConfig({ RS_TEST_OFFLINE: '1' });
    assert.equal(config.model, 'haiku');
    assert.equal(config.modelCallCapMicroUsd, 50000);
    assert.equal(config.modelDailyBudgetMicroUsd, 1000000);
    assert.equal(config.fakeModelCostMicroUsd, 0);
    assert.equal(config.modelCustomerDailyShare, 0.2);
    const decimals = loadConfig({ RS_TEST_OFFLINE: '1', RS_MODEL_DAILY_BUDGET_USD: '0.0037', RS_MODEL_CALL_CAP_USD: '0.299999', RS_FAKE_MODEL_COST_USD: '0.1' });
    assert.deepEqual(
      [decimals.modelDailyBudgetMicroUsd, decimals.modelCallCapMicroUsd, decimals.fakeModelCostMicroUsd],
      [3700, 299999, 100000],
    );
  });

  test('NFR6: boundary, budget 0.30 with cap and cost 0.10: the third call is allowed (300000 = 300000), the fourth is refused', async () => {
    const { h, state } = await harnessWith({
      RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.30', RS_FAKE_MODEL_COST_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      const id = await newRequest(cafe1);
      // 0.1 + 0.1 + 0.1 is 0.30000000000000004 as a float: the comparison must be on integers.
      for (let i = 1; i <= 3; i += 1) assert.equal((await extract(cafe1, id)).status, 200, `call ${i}`);
      assert.equal((await extract(cafe1, id)).status, 503);
      assert.equal(state.calls, 3);
    } finally {
      await h.close();
    }
  });

  test('NFR6: boundary, budget 0.299999 with cap and cost 0.10: the third call is refused', async () => {
    const { h, state } = await harnessWith({
      RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.299999', RS_FAKE_MODEL_COST_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      const id = await newRequest(cafe1);
      assert.equal((await extract(cafe1, id)).status, 200);
      assert.equal((await extract(cafe1, id)).status, 200);
      const third = await extract(cafe1, id);
      assert.equal(third.status, 503, third.text);
      assert.equal(state.calls, 2);
    } finally {
      await h.close();
    }
  });

  test('NFR6: the budget is per Asia/Amman day: the next day starts empty', async () => {
    const { h, state } = await harnessWith({
      RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.10', RS_FAKE_MODEL_COST_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      const id = await newRequest(cafe1);
      assert.equal((await extract(cafe1, id)).status, 200);
      assert.equal((await extract(cafe1, id)).status, 503);
      h.clock.advance(24 * 3600 * 1000); // the session is gone after 12 h, so sign in again
      const later = await signIn(h, 'cafe1');
      assert.equal((await extract(later, id)).status, 200);
      assert.equal(state.calls, 2);
    } finally {
      await h.close();
    }
  });

  test('NFR6: a failed call gives its reservation back (a timeout costs nothing); a billed bad answer costs what the provider reported', async () => {
    const { h } = await harnessWith({
      RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_DAILY_BUDGET_USD: '0.25', RS_FAKE_MODEL_COST_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      const id = await newRequest(cafe1);
      const flag = (fault) => h.db.prepare("INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES (?, '', 1, '2026-10-20T06:00:00.000Z')").run(`fake_model:${fault}`);
      flag('timeout');
      assert.equal((await extract(cafe1, id)).json.extraction.errorCode, 'PROVIDER_TIMEOUT');
      assert.equal(count(h, "SELECT COALESCE(SUM(actual_micro_usd), 0) AS n FROM model_spend"), 0);
      flag('invalid_json');
      assert.equal((await extract(cafe1, id)).json.extraction.errorCode, 'PROVIDER_BAD_OUTPUT');
      assert.equal(count(h, "SELECT COALESCE(SUM(actual_micro_usd), 0) AS n FROM model_spend"), 100000);
      assert.equal(count(h, 'SELECT SUM(cost_micro_usd) AS n FROM extractions'), 100000);
    } finally {
      await h.close();
    }
  });
});

describe('SEC-10: one call in flight per customer, and a per-customer daily share (default 0.2)', () => {
  test('SEC-10: with fake cost = cap = 0.05 and the defaults, the 5th call of one customer is refused with scope customer; another customer succeeds', async () => {
    const { h, state } = await harnessWith({ RS_MODEL_CALL_CAP_USD: '0.05', RS_FAKE_MODEL_COST_USD: '0.05' });
    try {
      assert.equal(h.config.modelCustomerDailyShare, 0.2);
      const cafe1 = await signIn(h, 'cafe1');
      const cafe2 = await signIn(h, 'cafe2');
      const id = await newRequest(cafe1);
      for (let i = 1; i <= 4; i += 1) assert.equal((await extract(cafe1, id)).status, 200, `call ${i}`); // 4 x 50000 = 200000 = 0.2 x 1.00
      const fifth = await extract(cafe1, id);
      assert.equal(fifth.status, 503, fifth.text);
      assert.equal(fifth.json.error.code, 'MODEL_BUDGET_EXHAUSTED');
      assert.equal(fifth.json.error.details.scope, 'customer');
      assert.equal(fifth.json.error.details.degraded, true);
      assert.equal(state.calls, 4);
      const other = await extract(cafe2, await newRequest(cafe2));
      assert.equal(other.status, 200, other.text);
      assert.equal(state.calls, 5);
    } finally {
      await h.close();
    }
  });

  test('SEC-10: a second call while the first is in flight is 429 RATE_LIMITED model_concurrency; another customer is not held back', async () => {
    const h = await startHarness({ seed: true });
    try {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      const inner = createFakeProvider({ imageMap: {}, clock: h.clock });
      h.app.deps.ai = createAiRuntime({
        db: h.db, clock: h.clock, config: h.config,
        provider: { ...inner, extract: async (input) => { entered(); await gate; return inner.extract(input); } },
      });
      const cafe1 = await signIn(h, 'cafe1');
      const cafe2 = await signIn(h, 'cafe2');
      const id = await newRequest(cafe1);
      const idOther = await newRequest(cafe2);
      const first = extract(cafe1, id);
      await started;
      const second = await extract(cafe1, id);
      assert.equal(second.status, 429, second.text);
      assert.equal(second.json.error.details.limit, 'model_concurrency');
      assert.equal(second.json.error.details.degraded, true);
      assert.match(second.headers['retry-after'], /^\d+$/);
      release();
      const done = await first;
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.extraction.degraded, false);
      assert.equal((await extract(cafe2, idOther)).status, 200);
      assert.equal((await extract(cafe1, id)).status, 200, 'the customer is free again once the call settled');
    } finally {
      await h.close();
    }
  });
});

describe('NFR6: the 11th extract or image upload by one customer within ten minutes is 429 with Retry-After', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());
  beforeEach(() => h.clock.advance(WINDOW_MS + 1000));

  test('NFR6: ten extracts are served, the 11th is 429 RATE_LIMITED extract_upload with Retry-After; an upload is refused too', async () => {
    const id = await newRequest(cafe1);
    for (let i = 1; i <= 10; i += 1) assert.equal((await extract(cafe1, id)).status, 200, `extract ${i}`);
    const eleventh = await extract(cafe1, id);
    assert.equal(eleventh.status, 429, eleventh.text);
    assert.equal(eleventh.json.error.code, 'RATE_LIMITED');
    assert.equal(eleventh.json.error.details.limit, 'extract_upload');
    const retry = Number(eleventh.headers['retry-after']);
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 600, `Retry-After ${retry}`);
    const refusedUpload = await upload(cafe1, id);
    assert.equal(refusedUpload.status, 429);
    assert.equal(refusedUpload.json.error.details.limit, 'extract_upload');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 0, 'a refused upload stores nothing');
    // Another customer has their own window.
    assert.equal((await extract(cafe2, await newRequest(cafe2))).status, 200);
    // The window rolls: after Retry-After seconds the customer may call again.
    h.clock.advance(retry * 1000 + 1);
    assert.equal((await extract(cafe1, id)).status, 200);
  });

  test('NFR6: uploads and extracts share the one allowance: five of each use it up, and the 11th (an upload) is refused', async () => {
    const id = await newRequest(cafe1);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await upload(cafe1, id)).status, 201, `upload ${i + 1}`);
      assert.equal((await extract(cafe1, id)).status, 200, `extract ${i + 1}`);
    }
    const res = await upload(cafe1, id);
    assert.equal(res.status, 429, res.text);
    assert.equal(res.json.error.code, 'RATE_LIMITED');
    assert.ok(Number(res.headers['retry-after']) >= 1);
  });

  test('NFR6: a refused call by the rate limit does not extend the window (it is not counted)', async () => {
    const id = await newRequest(cafe1);
    for (let i = 0; i < 10; i += 1) await extract(cafe1, id);
    const first = await extract(cafe1, id);
    h.clock.advance(5000);
    const second = await extract(cafe1, id);
    assert.equal(first.status, 429);
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers['retry-after']) < Number(first.headers['retry-after']), 'the wait shrinks as time passes');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'extract_or_upload' AND user_key = ?", `u:${cafe1.user.id}`), 10);
  });
});

describe('NFR6: provider selection', () => {
  test('NFR6: RS_TEST_OFFLINE=1 selects the simulated fake whatever RS_MODEL_PROVIDER says, and no real adapter is even loaded', async () => {
    for (const env of [{ RS_MODEL_PROVIDER: 'cli' }, { RS_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a-test-key-that-is-not-real' }, {}]) {
      const config = loadConfig({ RS_TEST_OFFLINE: '1', ...env });
      assert.equal(config.extractionProvider, 'fake');
      const factories = await loadAdapterFactories(config, { log: createLogger({ write: () => {} }), clock: { now: () => 0 } });
      assert.deepEqual(Object.keys(factories), []);
      const db = { tx: () => {}, prepare: () => ({}) };
      const runtime = createAiRuntime({ db, clock: { now: () => 0 }, config, factories });
      assert.deepEqual([runtime.provider.id, runtime.provider.simulated, runtime.selection.fellBack], ['fake', true, false]);
    }
  });

  test('NFR6: a configured real provider whose adapter is unavailable falls back to the labelled fake, never to a silent failure', () => {
    const config = loadConfig({ RS_MODEL_PROVIDER: 'cli' });
    assert.equal(config.model, 'haiku');
    const db = { tx: () => {}, prepare: () => ({}) };
    const runtime = createAiRuntime({ db, clock: { now: () => 0 }, config, factories: {} });
    assert.deepEqual([runtime.provider.id, runtime.provider.simulated, runtime.selection.fellBack, runtime.selection.requested], ['fake', true, true, 'cli']);
  });
});
