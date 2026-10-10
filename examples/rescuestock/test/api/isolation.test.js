// Isolation API tests (task c3-reservations-supplier-admin). Case names start with the criterion id:
//   RS-27  (reservation half) customer X cannot reserve, read or replay customer Y's plan or reservation: 404, nothing
//          written, no replay of Y's stored answer
//   RS-28  supplier A patching supplier B's inventory gets 403 and B's inventory, offer and ledger are unchanged; one
//          foreign product in a PATCH refuses the whole PATCH; another supplier's orders are 404
//   RS-30  customer and supplier sessions calling admin routes get 403, anonymous 401, admin 200; supplier routes refuse
//          customers and admins; customer plan routes refuse suppliers
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { ensureAdmin } from '../../src/services/users.js';

const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const KEY = (n) => `isolation-key-${String(n).padStart(6, '0')}-abc`;
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

async function approvedPlan(h, client) {
  h.clock.advance(61_000);
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json.request.id;
  await client.post(`/api/requests/${requestId}/confirm`, { fields: FIELDS });
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  const plan = made.json.plan;
  const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  assert.equal(approved.status, 200, approved.text);
  return { requestId, plan };
}

const reserve = (client, planId, key) => client.post(`/api/plans/${planId}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
const productOf = (h, code) =>
  h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = ? AND p.kind = 'bundle'").get(code).id;
const stockOf = (h, code) => ({
  ...h.db.prepare('SELECT i.on_hand, i.reserved, i.version FROM inventory i JOIN suppliers s ON s.id = i.supplier_id WHERE s.code = ?').get(code),
  offers: h.db.prepare('SELECT id, version, price_cents, status FROM offers o WHERE o.supplier_id = (SELECT id FROM suppliers WHERE code = ?) ORDER BY id').all(code).map((o) => ({ ...o })),
  ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE supplier_id = (SELECT id FROM suppliers WHERE code = ?)', code),
});

describe('RS-27: customers are isolated from each other (reservation half)', () => {
  let h;
  let cafe1;
  let cafe2;
  let planId;
  let otherPlanId;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
    planId = (await approvedPlan(h, cafe1)).plan.id;
    otherPlanId = (await approvedPlan(h, cafe2)).plan.id; // made while the stock is still free
  });
  after(() => h.close());

  test('RS-27: customer X reserving customer Y\'s plan is 404 NOT_FOUND and nothing is written, with a fresh key or with Y\'s own key', async () => {
    const mine = await reserve(cafe1, planId, KEY(1));
    assert.equal(mine.status, 201, mine.text);
    const snapshot = {
      reservations: count(h, 'SELECT COUNT(*) AS n FROM reservations'),
      ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
      keys: count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'),
      audit: count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE outcome = 'denied'"),
    };
    for (const key of [KEY(2), KEY(1)]) {
      const res = await reserve(cafe2, planId, key);
      assert.equal(res.status, 404, res.text);
      assert.equal(res.json.error.code, 'NOT_FOUND');
      assert.equal(res.headers['idempotent-replayed'], undefined, 'Y\'s stored answer is never replayed to X');
      assert.equal(res.json.reservation, undefined);
      assert.equal(res.json.error.details, undefined);
    }
    assert.deepEqual(
      {
        reservations: count(h, 'SELECT COUNT(*) AS n FROM reservations'),
        ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
        keys: count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'),
        audit: count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE outcome = 'denied'"),
      },
      snapshot,
    );
  });

  test('RS-27: X reading Y\'s request or plan is 404 and sees none of Y\'s orders', async () => {
    const requestId = h.db.prepare('SELECT request_id AS r FROM plan_versions WHERE id = ?').get(planId).r;
    const view = await cafe2.get(`/api/requests/${requestId}`);
    assert.equal(view.status, 404);
    assert.equal(view.json.error.code, 'NOT_FOUND');
    const approve = await cafe2.post(`/api/plans/${planId}/approve`, { expectedTotalCents: 8400, planHash: 'a'.repeat(64) });
    assert.equal(approve.status, 404);
    const list = await cafe2.get('/api/requests');
    assert.equal(list.json.requests.some((r) => r.id === requestId), false);
  });

  test('RS-27: the same key is a separate scope per user: X may use a key that Y used, for X\'s own plan', async () => {
    const res = await reserve(cafe2, otherPlanId, KEY(1));
    assert.equal(res.status, 409, 'A and B are taken by Y, but the key itself is accepted for X');
    assert.equal(res.json.error.code, 'OUT_OF_STOCK');
  });

  test('RS-30: anonymous reserve is 401; supplier and admin sessions are 403 on a customer plan route', async () => {
    const anon = createClient(h.request);
    assert.equal((await reserve(anon, planId, KEY(5))).status, 401);
    const supplier = await signIn(h, 'supplier-a');
    assert.equal((await reserve(supplier, planId, KEY(5))).status, 403);
  });
});

describe('RS-28: suppliers are isolated from each other', () => {
  let h;
  let supplierA;
  let supplierB;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    supplierA = await signIn(h, 'supplier-a');
    supplierB = await signIn(h, 'supplier-b');
  });
  after(() => h.close());

  const patch = (client, items) => client.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items } });

  test('RS-28: supplier A patching supplier B\'s inventory is 403 FORBIDDEN and B\'s stock, offer and ledger are unchanged', async () => {
    const before = stockOf(h, 'B');
    const res = await patch(supplierA, [{ productId: productOf(h, 'B'), onHand: 0, priceCents: 1, withdrawn: true }]);
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error.code, 'FORBIDDEN');
    assert.deepEqual(stockOf(h, 'B'), before);
  });

  test('RS-28: one foreign product in a PATCH refuses the whole PATCH: A\'s own product is unchanged too', async () => {
    const beforeA = stockOf(h, 'A');
    const beforeB = stockOf(h, 'B');
    const res = await patch(supplierA, [
      { productId: productOf(h, 'A'), onHand: 5, priceCents: 3100 },
      { productId: productOf(h, 'B'), onHand: 9 },
    ]);
    assert.equal(res.status, 403);
    assert.deepEqual(stockOf(h, 'A'), beforeA);
    assert.deepEqual(stockOf(h, 'B'), beforeB);
    assert.ok(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inventory.patch' AND outcome = 'denied'") >= 2);
  });

  test('RS-28: an unknown product id is 404; B sees only its own inventory', async () => {
    assert.equal((await patch(supplierA, [{ productId: 987654, onHand: 1 }])).status, 404);
    const own = await supplierB.get('/api/supplier/inventory');
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.items.map((i) => i.productId), [productOf(h, 'B')]);
  });

  test('RS-28: another supplier\'s order is 404 for every order route, and the list shows only the caller\'s orders', async () => {
    const cafe1 = await signIn(h, 'cafe1');
    const { plan } = await approvedPlan(h, cafe1);
    assert.equal((await reserve(cafe1, plan.id, KEY(1))).status, 201);
    const bOrder = h.db.prepare("SELECT so.id FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE s.code = 'B'").get().id;
    const before = h.db.prepare('SELECT fulfilment_status, refusal_reason FROM supplier_orders WHERE id = ?').get(bOrder);
    for (const [action, body] of [
      ['confirm', { lines: [{ offerId: 2, committedBundles: 1 }], committedReadyAt: '2026-10-20T07:30:00.000Z' }],
      ['refuse', { reason: 'not mine to refuse' }],
      ['ready', {}],
      ['handover', {}],
    ]) {
      const res = await supplierA.post(`/api/supplier/orders/${bOrder}/${action}`, body);
      assert.equal(res.status, 404, `${action}: ${res.text}`);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    }
    assert.deepEqual({ ...h.db.prepare('SELECT fulfilment_status, refusal_reason FROM supplier_orders WHERE id = ?').get(bOrder) }, { ...before });
    const listA = await supplierA.get('/api/supplier/orders');
    assert.deepEqual(listA.json.orders.map((o) => o.lines[0].offerId), [1]);
    assert.equal(JSON.stringify(listA.json).includes('cafe1'), false, 'the buyer\'s username is never shown');
    assert.equal(listA.json.orders[0].buyer.displayName, 'Cafe 1 (demo)');
  });
});

describe('RS-30: the demo tools and the other roles\' routes are closed to the wrong role', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD } });
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  });
  after(() => h.close());

  const adminCalls = [
    ['POST', '/api/admin/reset', {}],
    ['POST', '/api/admin/faults', { kind: 'clear' }],
    ['GET', '/api/admin/timeline', undefined],
    ['GET', '/api/admin/metrics', undefined],
  ];

  test('RS-30: anonymous calls to every admin route are 401 UNAUTHENTICATED', async () => {
    const anon = createClient(h.request);
    await anon.get('/api/auth/csrf');
    for (const [method, path, jsonBody] of adminCalls) {
      const res = await anon.send({ method, path, jsonBody });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.json.error.code, 'UNAUTHENTICATED');
    }
  });

  test('RS-30: customer and supplier sessions calling admin fault and reset routes are 403 FORBIDDEN and nothing changes', async () => {
    const before = { audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), flags: count(h, 'SELECT COUNT(*) AS n FROM fault_flags'), archived: count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE archived_at IS NOT NULL') };
    for (const username of ['cafe1', 'supplier-b']) {
      const client = await signIn(h, username);
      for (const [method, path, jsonBody] of adminCalls) {
        const res = await client.send({ method, path, jsonBody });
        assert.equal(res.status, 403, `${username} ${method} ${path}`);
        assert.equal(res.json.error.code, 'FORBIDDEN');
      }
      const fault = await client.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'B' });
      assert.equal(fault.status, 403);
    }
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM offers WHERE status = 'withdrawn'"), 0, 'no offer was withdrawn');
    assert.deepEqual(
      { audit: count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'admin.%'"), flags: before.flags, archived: before.archived },
      { audit: 0, flags: 0, archived: 0 },
    );
  });

  test('RS-30: the admin session reaches the admin routes (200)', async () => {
    const admin = await signIn(h, 'admin', ADMIN_PASSWORD);
    assert.equal((await admin.get('/api/admin/metrics')).status, 200);
    assert.equal((await admin.get('/api/admin/timeline')).status, 200);
    assert.equal((await admin.post('/api/admin/faults', { kind: 'clear' })).status, 200);
  });

  test('RS-30: supplier routes refuse customers (403) and admins (403) and anonymous callers (401)', async () => {
    const anon = createClient(h.request);
    assert.equal((await anon.get('/api/supplier/inventory')).status, 401);
    for (const [username, password] of [['cafe1', DEMO_PASSWORD], ['admin', ADMIN_PASSWORD]]) {
      const client = await signIn(h, username, password);
      assert.equal((await client.get('/api/supplier/orders')).status, 403, username);
      assert.equal((await client.get('/api/supplier/inventory')).status, 403, username);
      assert.equal((await client.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: 3, onHand: 9 }] } })).status, 403, username);
    }
    const supplier = await signIn(h, 'supplier-a');
    assert.equal((await supplier.get('/api/requests')).status, 403);
    const admin = await signIn(h, 'admin', ADMIN_PASSWORD);
    assert.equal((await admin.get('/api/requests')).status, 403);
    assert.equal((await admin.post('/api/plans/1/reserve', {}, { headers: { 'Idempotency-Key': KEY(9) } })).status, 403);
  });
});
