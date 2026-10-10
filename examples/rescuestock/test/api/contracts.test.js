// HTTP contract test (spec: Testing Strategy > Contract tests (a)). A route table drives the real application
// (in-process, fake adapters, RS-FIX-1 seed, fixed clock) through one scenario per example response in
// test/fixtures/contracts and checks, for every route present:
//   - the status code of the fixture;
//   - the envelope: JSON content type, X-Request-Id header, `requestId` at the top level of a success body and
//     inside `error` of a failure body (equal to the header), `error.code`/`error.message` strings, no stack text;
//   - the field types of the success body (or of the error envelope) against the fixture's `response`, by key set
//     and type, never by value (test/helpers/contract-shape.js).
// A route that is not registered yet is reported as SKIPPED with the reason, never as passed (phase E routes only,
// FU-18). A test also fails for every registered route that has no scenario in the table.
//
// Mismatches between a fixture and the server are named failures: "(fixture test/fixtures/contracts/<file>)" and the
// path of the field. The six fixture defects that c6 had marked `todo` were corrected by d4 (FU-13) and their table
// is gone: every mismatch now fails the test.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEMO_DATE, DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { compareShape } from '../helpers/contract-shape.js';
import { FIXTURE_DIR, createClient, uniqueUsername } from '../helpers/fixtures.js';
import { approvedPlan, canonicalFields, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { loadClearPhoto, setModelFault, uploadImage } from '../helpers/extraction.js';
import { ensureAdmin } from '../../src/services/users.js';

const CONTRACT_DIR = `${FIXTURE_DIR}/contracts`;
const fixturePath = (name) => `test/fixtures/contracts/${name}`;
const loadFixture = (name) => JSON.parse(readFileSync(`${CONTRACT_DIR}/${name}`, 'utf8'));

const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const CUSTOMER_PASSWORD = 'contract-test-password-1';
const BASE_ENV = Object.freeze({
  RS_ADMIN_PASSWORD: ADMIN_PASSWORD,
  RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
  RS_REGISTER_PER_IP_PER_HOUR: '1000',
  RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '1',
});

// Free-form members the spec types as `object` / `object[]` (Trace.inputs, Trace.candidates): not compared below the member.
const FREE_FORM = Object.freeze([/(^|\.)trace\.inputs$/, /(^|\.)trace\.candidates\[\]$/]);

// ---- worlds: one seeded application per group of scenarios -----------------------------------------------------------

async function makeWorld(env = {}) {
  const h = await startHarness({ seed: true, env: { ...BASE_ENV, ...env } });
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  const memo = new Map();
  const world = {
    h,
    once(key, make) {
      if (!memo.has(key)) memo.set(key, Promise.resolve().then(make));
      return memo.get(key);
    },
    anon: () => createClient(h.request),
    async customer() {
      const client = createClient(h.request);
      await client.register({ username: uniqueUsername('ct'), password: CUSTOMER_PASSWORD, displayName: 'Contract Customer' });
      return client;
    },
    async login(username, password = DEMO_PASSWORD) {
      const client = createClient(h.request);
      await client.signIn(username, password);
      return client;
    },
    // A new request with confirmed requirements; returns { requestId, client }.
    async confirmedRequest(client, overrides = {}) {
      const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
      assert.equal(created.status, 201, created.text);
      const requestId = created.json.request.id;
      const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE, overrides) });
      assert.equal(confirmed.status, 201, confirmed.text);
      return { requestId, confirmed };
    },
    // A new request (text only); returns its id.
    async newRequestId(client, text = 'I need 200 cups and 200 lids, 250 ml, by 11:00 today.') {
      const created = await client.post('/api/requests', { text });
      assert.equal(created.status, 201, created.text);
      return created.json.request.id;
    },
    // Keeps every customer under the plan rate limit of the fixed clock.
    async plan(client, requestId) {
      h.clock.advance(61_000);
      return client.post(`/api/requests/${requestId}/plan`, {});
    },
    async approved(client, overrides = {}) {
      h.clock.advance(61_000);
      return approvedPlan(client, DEMO_DATE, { overrides });
    },
  };
  return world;
}

// The flow world: customer 1 reserves A + B; then supplier, inventory and admin scenarios build on it (table order).
async function reservedFlow(w) {
  return w.once('reserved-flow', async () => {
    const client = await w.customer();
    const { requestId, plan } = await w.approved(client);
    const res = await reserve(client, plan.id, idempotencyKey('contract1'));
    assert.equal(res.status, 201, res.text);
    return { client, requestId, plan, res };
  });
}

class SkipScenario extends Error {}
const skip = (reason) => {
  throw new SkipScenario(reason);
};

// ---- the route table -----------------------------------------------------------------------------------------------
// { fixture | inline, route, status, world, run(w) -> response, optional?, free?, sameValues? }
//   sameValues: dotted paths whose VALUE (a capability flag) must equal the fixture's.
const TABLE = [
  // public and auth
  { inline: { status: 'ok', requestId: 'req-0000001' }, route: 'GET /api/health', status: 200, world: 'main', run: (w) => w.anon().get('/api/health') },
  { fixture: 'config.json', world: 'main', run: (w) => w.anon().get('/api/config') },
  { fixture: 'config-sandbox-test-mode.json', world: 'sandbox', run: (w) => w.anon().get('/api/config') },
  { fixture: 'auth-csrf.json', world: 'main', run: (w) => w.anon().get('/api/auth/csrf') },
  {
    fixture: 'auth-register.json',
    world: 'main',
    run: async (w) => {
      const c = w.anon();
      await c.get('/api/auth/csrf');
      return c.post('/api/auth/register', { username: uniqueUsername('reg'), password: CUSTOMER_PASSWORD, displayName: 'New Cafe' });
    },
  },
  {
    fixture: 'auth-signin.json',
    world: 'main',
    run: async (w) => {
      const c = w.anon();
      await c.get('/api/auth/csrf');
      return c.post('/api/auth/signin', { username: 'cafe1', password: DEMO_PASSWORD });
    },
  },
  { fixture: 'auth-session-anonymous.json', world: 'main', run: (w) => w.anon().get('/api/auth/session') },
  { fixture: 'auth-session-customer.json', world: 'main', run: async (w) => (await w.customer()).get('/api/auth/session') },
  { fixture: 'auth-signout.json', world: 'main', run: async (w) => (await w.customer()).post('/api/auth/signout', {}) },
  { fixture: 'error-unauthenticated.json', world: 'main', run: (w) => w.anon().get('/api/requests') },

  // customer requests and plans
  { fixture: 'requests-list-empty.json', world: 'main', run: async (w) => (await w.customer()).get('/api/requests') },
  {
    fixture: 'requests-list.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      await w.confirmedRequest(c);
      return c.get('/api/requests');
    },
  },
  { fixture: 'request-create.json', world: 'main', run: async (w) => (await w.customer()).post('/api/requests', { text: 'I need 200 cups and 200 lids, 250 ml, by 11:00 today.' }) },
  {
    fixture: 'request-image-upload.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const id = await w.newRequestId(c);
      return uploadImage(c, id, loadClearPhoto());
    },
  },
  {
    fixture: 'request-extract.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const id = await w.newRequestId(c, 'I need 200 cups and 200 lids, 250 ml, budget $120, at most 2 pickups. Please read the package label.');
      const up = await uploadImage(c, id, loadClearPhoto());
      assert.equal(up.status, 201, up.text);
      return c.post(`/api/requests/${id}/extract`, {});
    },
  },
  {
    fixture: 'request-extract-degraded.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const id = await w.newRequestId(c);
      setModelFault(w.h.db, w.h.clock, 'timeout', 1);
      return c.post(`/api/requests/${id}/extract`, {});
    },
  },
  {
    fixture: 'request-confirm.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const created = await c.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
      return c.post(`/api/requests/${created.json.request.id}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    },
  },
  {
    fixture: 'error-validation-failed.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const created = await c.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
      return c.post(`/api/requests/${created.json.request.id}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: -5 }) });
    },
  },
  {
    fixture: 'plan-create-feasible.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c);
      return w.plan(c, requestId);
    },
  },
  {
    fixture: 'plan-create-infeasible.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c, { budgetCents: 5000 });
      return w.plan(c, requestId);
    },
  },
  {
    fixture: 'plan-approve.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c);
      const { json } = await w.plan(c, requestId);
      return c.post(`/api/plans/${json.plan.id}/approve`, { expectedTotalCents: json.plan.body.totalCents, planHash: json.plan.planHash });
    },
  },
  {
    fixture: 'error-plan-changed.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c);
      const { json } = await w.plan(c, requestId);
      return c.post(`/api/plans/${json.plan.id}/approve`, { expectedTotalCents: json.plan.body.totalCents + 100, planHash: json.plan.planHash });
    },
  },
  {
    fixture: 'request-view-planned.json',
    optional: ['capabilities'], // additive key (d3, TR-C-4); these three fixtures predate it and are d4's
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c);
      await w.plan(c, requestId);
      return c.get(`/api/requests/${requestId}`);
    },
  },
  {
    fixture: 'request-view-infeasible.json',
    optional: ['capabilities'], // additive key (d3, TR-C-4); these three fixtures predate it and are d4's
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const { requestId } = await w.confirmedRequest(c, { budgetCents: 5000 });
      await w.plan(c, requestId);
      return c.get(`/api/requests/${requestId}`);
    },
  },
  {
    fixture: 'request-view-degraded.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      const id = await w.newRequestId(c);
      setModelFault(w.h.db, w.h.clock, 'timeout', 1);
      const extracted = await c.post(`/api/requests/${id}/extract`, {});
      assert.equal(extracted.status, 200, extracted.text);
      assert.equal(extracted.json.extraction.degraded, true, 'the view scenario needs a degraded extraction');
      return c.get(`/api/requests/${id}`);
    },
  },
  {
    fixture: 'request-delete.json',
    world: 'main',
    run: async (w) => {
      const c = await w.customer();
      return c.send({ method: 'DELETE', path: `/api/requests/${await w.newRequestId(c)}` });
    },
  },
  {
    // The image bytes are not JSON, so there is no fixture and no envelope: the status, the headers and the bytes are the
    // contract (SEC-14, T9: detected type, nosniff, sandbox CSP, no-store).
    route: 'GET /api/requests/:id/image',
    status: 200,
    world: 'main',
    binary: true,
    run: async (w) => {
      const c = await w.customer();
      const id = await w.newRequestId(c);
      const photo = loadClearPhoto();
      const up = await uploadImage(c, id, photo);
      assert.equal(up.status, 201, up.text);
      const res = await c.get(`/api/requests/${id}/image`);
      return { ...res, expectedBytes: photo };
    },
  },

  // reservation, orders and payments
  { fixture: 'plan-reserve.json', world: 'flow', run: async (w) => (await reservedFlow(w)).res },
  {
    fixture: 'error-reservation-limit.json',
    world: 'flow',
    run: async (w) => {
      const { client } = await reservedFlow(w);
      // The cap (1 live reservation) is checked before stock, so a second approved plan is refused with it.
      const second = await w.approved(client, { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 });
      return reserve(client, second.plan.id, idempotencyKey('contract2'));
    },
  },
  {
    fixture: 'request-view-reserved.json',
    optional: ['capabilities'], // additive key (d3, TR-C-4); these three fixtures predate it and are d4's
    world: 'flow',
    run: async (w) => {
      const { client, requestId } = await reservedFlow(w);
      return client.get(`/api/requests/${requestId}`);
    },
  },
  { fixture: 'plan-execute.json', world: 'flow', run: () => skip('POST /api/plans/:id/execute is not registered yet') },
  { fixture: 'plan-execute-replay.json', world: 'flow', run: () => skip('POST /api/plans/:id/execute is not registered yet') },
  { fixture: 'plan-abandon.json', world: 'flow', run: () => skip('POST /api/plans/:id/abandon is not registered yet') },
  { fixture: 'order-paypal-create.json', world: 'flow', run: () => skip('POST /api/orders/:id/paypal/create is not registered yet') },
  { fixture: 'order-receipt.json', world: 'flow', run: () => skip('POST /api/orders/:id/receipt is not registered yet') },

  // supplier
  {
    fixture: 'supplier-orders.json',
    world: 'flow',
    run: async (w) => {
      await reservedFlow(w);
      return (await w.login('supplier-a')).get('/api/supplier/orders');
    },
  },
  {
    fixture: 'supplier-order-confirm.json',
    world: 'flow',
    sameValues: ['order.canMarkReady'],
    run: async (w) => {
      await reservedFlow(w);
      const a = await w.login('supplier-a');
      const order = (await a.get('/api/supplier/orders')).json.orders[0];
      return a.post(`/api/supplier/orders/${order.id}/confirm`, {
        lines: order.lines.map((l) => ({ offerId: l.offerId, committedBundles: l.bundles })),
        committedReadyAt: order.catalogReadyAt,
      });
    },
  },
  {
    fixture: 'supplier-order-refuse.json',
    world: 'flow',
    run: async (w) => {
      await reservedFlow(w);
      const b = await w.login('supplier-b');
      const order = (await b.get('/api/supplier/orders')).json.orders[0];
      return b.post(`/api/supplier/orders/${order.id}/refuse`, { reason: 'Out of cups today' });
    },
  },
  { fixture: 'supplier-order-ready.json', world: 'flow', run: () => skip('a ready order needs an executed plan (POST /api/plans/:id/execute is not registered yet)') },
  { fixture: 'supplier-order-handover.json', world: 'flow', run: () => skip('a handover needs an executed plan (POST /api/plans/:id/execute is not registered yet)') },
  { fixture: 'supplier-inventory.json', world: 'flow', run: async (w) => (await w.login('supplier-c')).get('/api/supplier/inventory') },
  {
    fixture: 'supplier-inventory-patch.json',
    world: 'flow',
    run: async (w) => {
      const c = await w.login('supplier-c');
      const productId = (await c.get('/api/supplier/inventory')).json.items[0].productId;
      return c.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId, priceCents: 4700, readyAt: '2026-10-20T07:15:00.000Z' }] } });
    },
  },

  // admin
  {
    fixture: 'admin-metrics.json',
    world: 'flow',
    maps: ['counts.operationsByStatus', 'counts.plansByStatus', 'counts.reservationsByStatus', 'providerLatencyMs'],
    run: async (w) => (await adminOf(w)).get('/api/admin/metrics'),
  },
  // The timeline `detail` differs per event type (audit detail), so it is free-form.
  { fixture: 'admin-timeline.json', world: 'flow', free: ['events[].detail'], run: async (w) => (await adminOf(w)).get('/api/admin/timeline') },
  { fixture: 'admin-faults.json', world: 'flow', run: async (w) => (await adminOf(w)).post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'E' }) },
  {
    fixture: 'admin-reset-blocked.json',
    world: 'flow',
    run: async (w) => {
      await reservedFlow(w);
      const admin = await adminOf(w);
      const op = w.h.db.prepare('SELECT id FROM payment_operations ORDER BY id LIMIT 1').get();
      w.h.db.prepare("UPDATE payment_operations SET status = 'authorized', provider_authorization_id = 'FAKE-AUTH-1' WHERE id = ?").run(op.id);
      const res = await admin.post('/api/admin/reset', {});
      w.h.db.prepare("UPDATE payment_operations SET status = 'created', provider_authorization_id = NULL WHERE id = ?").run(op.id);
      return res;
    },
  },
  {
    fixture: 'admin-reset.json',
    world: 'flow',
    optional: ['stranded'],
    run: async (w) => (await adminOf(w)).post('/api/admin/reset', { force: true, reason: 'Contract test reset before the next scenario' }),
  },
];

function adminOf(w) {
  return w.once('admin', () => w.login('admin', ADMIN_PASSWORD));
}

const WORLD_ENV = { main: {}, flow: {}, sandbox: { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'AaContractClientId12345', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'EeContractClientSecret12345', RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'WH-CONTRACT-12345' } };

// ---- checks ----------------------------------------------------------------------------------------------------------

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function assertEnvelope(res, expectedStatus, label) {
  assert.equal(res.status, expectedStatus, `${label}: status ${res.status}, body ${res.text.slice(0, 300)}`);
  assert.match(String(res.headers['content-type']), /^application\/json; charset=utf-8$/i, `${label}: content type`);
  const header = res.headers['x-request-id'];
  assert.match(String(header), REQUEST_ID_RE, `${label}: X-Request-Id header`);
  assert.ok(res.json !== null && typeof res.json === 'object', `${label}: JSON body`);
  if (expectedStatus >= 400) {
    const err = res.json.error;
    assert.ok(err && typeof err === 'object', `${label}: error envelope`);
    assert.deepEqual(Object.keys(res.json), ['error'], `${label}: an error body holds only the envelope`);
    assert.equal(typeof err.code, 'string', `${label}: error.code`);
    assert.equal(typeof err.message, 'string', `${label}: error.message`);
    assert.equal(err.requestId, header, `${label}: error.requestId equals the X-Request-Id header`);
    assert.doesNotMatch(res.text, /\bat .+\.js:\d+|SQLITE_|node:sqlite/, `${label}: no stack or SQL text`);
  } else {
    assert.equal(typeof res.json.requestId, 'string', `${label}: top-level requestId`);
    assert.equal(res.json.requestId, header, `${label}: requestId equals the X-Request-Id header`);
  }
}

// GET /api/requests/:id/image: the one response that is not JSON. The detected type, the same bytes that were uploaded,
// nosniff, a sandboxing CSP and no caching.
function assertBinaryImage(res, expectedStatus, label) {
  assert.equal(res.status, expectedStatus, `${label}: status ${res.status}`);
  assert.equal(res.headers['content-type'], 'image/png', `${label}: content type is the detected type`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers['content-security-policy'], 'sandbox', `${label}: sandboxing CSP`);
  assert.match(String(res.headers['cache-control']), /no-store/, `${label}: no-store`);
  assert.match(String(res.headers['x-request-id']), REQUEST_ID_RE, `${label}: X-Request-Id header`);
  assert.ok(Buffer.isBuffer(res.bytes) && res.bytes.equals(res.expectedBytes), `${label}: the body is the uploaded image, byte for byte`);
}

function valueAt(obj, path) {
  return path.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), obj);
}

// ---- tests -----------------------------------------------------------------------------------------------------------

describe('NFR6: the contract shape comparer reports key and type differences', () => {
  test('NFR6: equal shapes agree, whatever the values; null matches anything; arrays compare every element with the first', () => {
    assert.deepEqual(compareShape({ a: 1, b: 'x', c: [{ d: true }], e: null }, { a: 9, b: 'y', c: [{ d: false }, { d: true }], e: { z: 1 } }), []);
    assert.deepEqual(compareShape({ a: [] }, { a: [1, 'x'] }), []);
  });

  test('NFR6: a missing key, an extra key and a changed type are each reported with their path; optional and free paths are skipped', () => {
    assert.deepEqual(compareShape({ a: 1, b: { c: 'x' } }, { a: 1, b: {} }), ['b.c: missing (the fixture has it)']);
    assert.deepEqual(compareShape({ a: 1 }, { a: 1, extra: 2 }), ['extra: extra (not in the fixture)']);
    assert.deepEqual(compareShape({ cursor: 3 }, { cursor: '3.1.2' }), ['cursor: expected number, got string']);
    assert.deepEqual(compareShape({ l: [{ k: 1 }] }, { l: [{ k: 1 }, { k: 'x' }] }), ['l[].k: expected number, got string']);
    assert.deepEqual(compareShape({ a: 1 }, { a: 1, extra: 2 }, { optional: ['extra'] }), []);
    assert.deepEqual(compareShape({ t: { x: 1 } }, { t: { y: 2 } }, { free: ['t'] }), []);
    assert.deepEqual(compareShape({ n: { created: 1 } }, { n: { voided: 4, captured: 2 } }, { maps: ['n'] }), []);
    assert.deepEqual(compareShape({ n: { created: 1 } }, { n: { voided: 'four' } }, { maps: ['n'] }), ['n.*: expected number, got string']);
  });
});

describe('NFR6: every example response in test/fixtures/contracts has a scenario, and every fixture has the documented wrapper', () => {
  test('NFR6: the route table covers each fixture file exactly once', () => {
    const files = readdirSync(CONTRACT_DIR).filter((f) => f.endsWith('.json')).sort();
    const covered = TABLE.filter((s) => s.fixture).map((s) => s.fixture).sort();
    const missing = files.filter((f) => !covered.includes(f));
    const unknown = covered.filter((f) => !files.includes(f));
    const duplicated = covered.filter((f, i) => covered.indexOf(f) !== i);
    assert.deepEqual({ missing, unknown, duplicated }, { missing: [], unknown: [], duplicated: [] }, 'fixtures without a scenario, scenarios without a fixture, repeated fixtures');
  });

  test('NFR6: each fixture is {route, status, response} with a response object and a route of METHOD /api/... form', () => {
    for (const file of readdirSync(CONTRACT_DIR).filter((f) => f.endsWith('.json'))) {
      const fx = loadFixture(file);
      assert.match(fx.route, /^(GET|POST|PATCH|DELETE|PUT) \/api\//, `${fixturePath(file)}: route`);
      assert.ok(Number.isInteger(fx.status), `${fixturePath(file)}: status`);
      assert.ok(fx.response && typeof fx.response === 'object', `${fixturePath(file)}: response`);
    }
  });
});

const worlds = new Map();
const worldFor = (name) => {
  if (!worlds.has(name)) worlds.set(name, makeWorld(WORLD_ENV[name]));
  return worlds.get(name);
};

describe('NFR6: contract scenarios drive each registered route and compare status, envelope, requestId and field types with the fixtures', () => {
  after(async () => {
    for (const pending of worlds.values()) {
      try {
        await (await pending).h.close();
      } catch {
        // A world that failed to start has nothing to close.
      }
    }
  });

  for (const scenario of TABLE) {
    const fx = scenario.fixture ? loadFixture(scenario.fixture) : null;
    const route = fx ? fx.route : scenario.route;
    const status = fx ? fx.status : scenario.status;
    const expectedResponse = fx ? fx.response : scenario.inline;
    const label = scenario.fixture ? `fixture ${fixturePath(scenario.fixture)}` : `inline ${route}`;

    test(`NFR6: contract ${scenario.fixture ?? route}: ${route} -> ${status}${fx?.variant ? ` (${fx.variant.slice(0, 60)})` : ''}`, async (t) => {
      const w = await worldFor(scenario.world);
      const [method, template] = route.split(' ');
      const registered = w.h.app.router.list().some((r) => r.method === method && r.template === template);
      if (!registered) {
        t.skip(`${route} is not registered yet`);
        return;
      }
      let res;
      try {
        res = await scenario.run(w);
      } catch (err) {
        if (err instanceof SkipScenario) {
          t.skip(err.message);
          return;
        }
        throw err;
      }
      if (scenario.binary) {
        assertBinaryImage(res, status, label);
        return;
      }
      assertEnvelope(res, status, label);
      if (status >= 400) assert.equal(res.json.error.code, expectedResponse.error.code, `${label}: error code`);

      const problems = compareShape(expectedResponse, res.json, { optional: scenario.optional ?? [], free: [...FREE_FORM, ...(scenario.free ?? [])], maps: scenario.maps ?? [] });
      for (const path of scenario.sameValues ?? []) {
        const want = valueAt(expectedResponse, path);
        const got = valueAt(res.json, path);
        if (want !== got) problems.push(`${path}: value is ${JSON.stringify(got)}, the fixture shows ${JSON.stringify(want)}`);
      }
      assert.deepEqual(problems, [], `${label} differs from the server response`);
    });
  }

  test('NFR6: every registered route has a scenario in the table', async () => {
    const w = await worldFor('main');
    const driven = new Set(TABLE.map((s) => (s.fixture ? loadFixture(s.fixture).route : s.route)));
    const uncovered = w.h.app.router.list().map((r) => `${r.method} ${r.template}`).filter((r) => !driven.has(r));
    assert.deepEqual(uncovered, [], 'registered routes without a contract scenario (add a fixture and a table row)');
  });
});
