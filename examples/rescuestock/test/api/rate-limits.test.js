// SEC-C-3 / FU-15: the general per-user limit (300 requests per minute, 429 RATE_LIMITED with
// details.limit "general" and Retry-After), enforced in the access hook for every non-public route.
// It is counted in rate_events as kind 'general' under the key u:<userId>; the planning limit uses
// plan:u:<userId> under the same kind, and the two never count each other's rows.
// The clock is fixed, so "a minute" is controlled by clock.advance.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function registerCustomer(h) {
  const client = createClient(h.request);
  await client.register({ password: 'a long enough password' });
  return client;
}

const userId = (h, username) => h.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
const countKey = (h, key) => h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(key).n;
const seed = (h, key, n, at) => {
  const insert = h.db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'general', ?)");
  for (let i = 0; i < n; i++) insert.run(key, at ?? new Date(h.clock.now()).toISOString());
};
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1];

describe('SEC-C-3: the general per-user limit', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true });
  });
  after(() => h.close());

  test('SEC-C-3: the 301st call of a signed-in user in one minute is refused with 429 RATE_LIMITED, details.limit general and Retry-After; p95 stays under 300 ms', async () => {
    assert.equal(h.config.generalRateLimit, 300);
    assert.equal(h.config.generalRateWindowSec, 60);
    const cafe1 = await signIn(h, 'cafe1');
    const cafe2 = await signIn(h, 'cafe2');
    const id = userId(h, 'cafe1');
    const latencies = [];
    for (let i = 1; i <= 300; i++) {
      const res = await cafe1.get('/api/requests');
      latencies.push(res.ms);
      assert.equal(res.status, 200, `call ${i}: ${res.text}`);
    }
    assert.equal(countKey(h, `u:${id}`), 300);

    const refused = await cafe1.get('/api/requests');
    latencies.push(refused.ms);
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(refused.json.error.details, { limit: 'general' });
    assert.equal(refused.headers['retry-after'], '60');
    assert.equal(typeof refused.json.error.requestId, 'string');
    assert.equal(countKey(h, `u:${id}`), 300, 'a refused call is not counted, so a flood cannot grow the table');

    // A write route is refused too, and the limit is per user: another customer is unaffected.
    const write = await cafe1.post('/api/requests', { text: 'cups' });
    assert.equal(write.status, 429, write.text);
    assert.deepEqual(write.json.error.details, { limit: 'general' });
    assert.equal((await cafe2.get('/api/requests')).status, 200);

    // Retry-After shrinks with the clock; after the whole window the user is served again.
    h.clock.advance(45_000);
    const later = await cafe1.get('/api/requests');
    assert.equal(later.status, 429);
    assert.equal(later.headers['retry-after'], '15');
    h.clock.advance(15_000);
    assert.equal((await cafe1.get('/api/requests')).status, 200);
    assert.equal(countKey(h, `u:${id}`), 1, 'rows older than the window were removed in the same transaction');

    assert.ok(p95(latencies) < 300, `p95 ${p95(latencies)} ms must stay under 300 ms (NFR5)`);
  });

  test('SEC-C-3: the general count never includes plan:u: keys, and the planning count never includes u: keys', async () => {
    const cafe3 = await registerCustomer(h);
    const id = cafe3.user.id;
    // 400 planning rows (older than the 10 minute planning window would not count either way; these are fresh).
    seed(h, `plan:u:${id}`, 400);
    for (let i = 1; i <= 299; i++) {
      const res = await cafe3.get('/api/requests');
      assert.equal(res.status, 200, `call ${i}: planning rows must not count as general calls`);
    }
    assert.equal(countKey(h, `u:${id}`), 299);
    assert.equal(countKey(h, `plan:u:${id}`), 400, 'the general limit never deletes or counts planning rows');

    // The reverse: 299 general rows, and a plan call (the 300th general call) still plans, because the
    // planning window holds no plan row of this user. Use a second customer so the counts are clean.
    const cafe4 = await registerCustomer(h);
    const id4 = cafe4.user.id;
    const created = await cafe4.post('/api/requests', { text: 'cups' });
    assert.equal(created.status, 201, created.text);
    const requestId = created.json.request.id;
    assert.equal((await cafe4.post(`/api/requests/${requestId}/confirm`, { fields: FIELDS })).status, 201);
    seed(h, `u:${id4}`, 300 - countKey(h, `u:${id4}`) - 1);
    assert.equal(countKey(h, `u:${id4}`), 299);
    const planned = await cafe4.post(`/api/requests/${requestId}/plan`, {});
    assert.equal(planned.status, 201, planned.text);
    assert.equal(countKey(h, `plan:u:${id4}`), 1);
    assert.equal(countKey(h, `u:${id4}`), 300);
    // The next call is the 301st general call, not a planning refusal.
    const next = await cafe4.post(`/api/requests/${requestId}/plan`, {});
    assert.equal(next.status, 429);
    assert.deepEqual(next.json.error.details, { limit: 'general' });
  });

  test('SEC-C-3: public routes and anonymous callers are not counted', async () => {
    const before = h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'").get().n;
    const anonymous = createClient(h.request);
    for (let i = 0; i < 305; i++) {
      const res = await anonymous.get('/api/auth/csrf');
      assert.equal(res.status, 200);
    }
    assert.equal((await anonymous.get('/api/requests')).status, 401);
    assert.equal((await anonymous.get('/api/auth/session')).status, 200);
    const after_ = h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'").get().n;
    assert.equal(after_, before, 'neither public routes nor a 401 write a rate_events row');
  });
});

describe('SEC-C-3: the general limit is configurable', () => {
  test('SEC-C-3: RS_GENERAL_RATE_LIMIT and RS_GENERAL_RATE_WINDOW_SEC set the limit and the window', async () => {
    const h = await startHarness({ seed: true, env: { RS_GENERAL_RATE_LIMIT: '4', RS_GENERAL_RATE_WINDOW_SEC: '10' } });
    try {
      const cafe1 = await signIn(h, 'cafe1');
      for (let i = 1; i <= 4; i++) assert.equal((await cafe1.get('/api/requests')).status, 200, `call ${i}`);
      const refused = await cafe1.get('/api/requests');
      assert.equal(refused.status, 429);
      assert.deepEqual(refused.json.error.details, { limit: 'general' });
      assert.equal(refused.headers['retry-after'], '10');
      h.clock.advance(10_000);
      assert.equal((await cafe1.get('/api/requests')).status, 200);
    } finally {
      await h.close();
    }
  });
});
