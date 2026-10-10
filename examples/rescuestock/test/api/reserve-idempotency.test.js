// API tests for POST /api/plans/:id/reserve (task c3-reservations-supplier-admin). Case names start with the criterion id:
//   RS-16  same Idempotency-Key and body -> the same reservation, no second reservation, ledger or order row; the same key
//          with another body -> 422 IDEMPOTENCY_KEY_REUSED; the same key on a second plan -> 422 with no rows, before and
//          after the key row is purged (F-TR-1); a concurrent same-key race resolves to one reservation
//   RS-14  (single-process half) the loser of the last bundle gets 409 OUT_OF_STOCK, not a lock error; reserved <= on_hand;
//          the plan becomes non_executable (OUT_OF_STOCK) and a re-plan is queued; with a held write lock reserve is 503 DB_BUSY
//   RS-38  every reserve writes one ledger row per product; SUM(delta) equals the inventory columns
//   SEC-8-style boundary checks: missing header 400, malformed 422, foreign plan 404
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const KEY = (n) => `idem-key-${String(n).padStart(8, '0')}-abcdef`;

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

// A new request with confirmed requirements, a plan and (unless approve is false) an approved plan.
async function approvedPlan(h, client, { approve = true, overrides = {} } = {}) {
  h.clock.advance(61_000); // keeps every customer under the 10-plans-per-10-minutes limit
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  assert.equal(created.status, 201, created.text);
  const requestId = created.json.request.id;
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: { ...FIELDS, ...overrides } });
  assert.equal(confirmed.status, 201, confirmed.text);
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  assert.equal(made.status, 201, made.text);
  const plan = made.json.plan;
  assert.ok(plan, 'the plan is feasible');
  if (approve) {
    const res = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
    assert.equal(res.status, 200, res.text);
  }
  return { requestId, plan };
}

const reserve = (client, planId, key, body = {}) => client.post(`/api/plans/${planId}/reserve`, body, { headers: { 'Idempotency-Key': key } });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const reservedOf = (h, code) =>
  h.db.prepare('SELECT i.reserved FROM inventory i JOIN suppliers s ON s.id = i.supplier_id WHERE s.code = ?').get(code).reserved;
const rows = (h) => ({
  reservations: count(h, 'SELECT COUNT(*) AS n FROM reservations'),
  items: count(h, 'SELECT COUNT(*) AS n FROM reservation_items'),
  ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
  orders: count(h, 'SELECT COUNT(*) AS n FROM supplier_orders'),
  operations: count(h, 'SELECT COUNT(*) AS n FROM payment_operations'),
  keys: count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'),
});

// For every product: SUM(delta_on_hand) = on_hand and SUM(delta_reserved) = reserved, and reserved <= on_hand.
function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `ledger reserved of product ${inv.product_id}`);
    assert.ok(inv.reserved <= inv.on_hand);
  }
}

describe('RS-16: reserve is idempotent per (user, Idempotency-Key)', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-16: a new key reserves the plan: 201 with the reservation, one order and one created operation per supplier, labels and ledger rows', async () => {
    const { plan } = await approvedPlan(h, cafe1);
    const res = await reserve(cafe1, plan.id, KEY(1));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    const body = res.json;
    assert.equal(body.reservation.planVersionId, plan.id);
    assert.equal(body.reservation.status, 'active');
    assert.equal(body.reservation.expiresAt, new Date(h.clock.now() + 30 * 60 * 1000).toISOString());
    assert.deepEqual(body.reservation.items.map((i) => [i.supplierCode, i.bundles]), [['A', 1], ['B', 1]]);
    assert.equal(body.approvalsNeeded, 2);
    assert.deepEqual(body.orders.map((o) => [o.supplier.code, o.totals.totalCents, o.fulfilmentStatus, o.payment.status, o.payment.amountCents]), [
      ['A', 4000, 'awaiting_supplier', 'created', 4000],
      ['B', 4400, 'awaiting_supplier', 'created', 4400],
    ]);
    assert.equal(body.orders[0].payment.simulated, true);
    assert.equal(body.orders[0].presentation, 'active');
    assert.equal(body.labels.priceNotice, 'Test prices, not market prices');
    assert.equal(typeof body.requestId, 'string');

    assert.deepEqual(rows(h), { reservations: 1, items: 2, ledger: 5 + 2, orders: 2, operations: 2, keys: 1 });
    assert.deepEqual(h.db.prepare("SELECT reason, delta_reserved, ref_type, ref_id FROM inventory_ledger WHERE reason = 'reserve' ORDER BY id").all().map((r) => ({ ...r })), [
      { reason: 'reserve', delta_reserved: 1, ref_type: 'reservation', ref_id: body.reservation.id },
      { reason: 'reserve', delta_reserved: 1, ref_type: 'reservation', ref_id: body.reservation.id },
    ]);
    assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map((code) => reservedOf(h, code)), [1, 1, 0, 0, 0]);
    const op = h.db.prepare('SELECT provider, merchant_key, currency, status FROM payment_operations ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(op, [
      { provider: 'fake', merchant_key: 'A', currency: 'USD', status: 'created' },
      { provider: 'fake', merchant_key: 'B', currency: 'USD', status: 'created' },
    ]);
    assertLedgerInvariant(h);
  });

  test('RS-16: the same key and body returns the same reservation (stored answer, Idempotent-Replayed) and creates no second reservation, ledger or order row', async () => {
    const before = rows(h);
    const planId = h.db.prepare('SELECT plan_version_id AS id FROM reservations').get().id;
    const again = await reserve(cafe1, planId, KEY(1));
    assert.equal(again.status, 201);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    const original = h.db.prepare('SELECT id FROM reservations').get().id;
    assert.equal(again.json.reservation.id, original);
    assert.equal(again.json.orders.length, 2);
    assert.deepEqual(rows(h), before);
  });

  test('RS-16: the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const before = rows(h);
    const planId = h.db.prepare('SELECT plan_version_id AS id FROM reservations').get().id;
    const reused = await reserve(cafe1, planId, KEY(1), { note: 'different' });
    assert.equal(reused.status, 422);
    assert.equal(reused.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(typeof reused.json.error.requestId, 'string');
    assert.deepEqual(rows(h), before);
  });

  test('RS-16 (F-TR-1): the same key on a second plan is 422 with no reservation, ledger or order rows, before the key row is purged and after', async () => {
    // A and B are reserved now, so the second plan is a smaller one on E.
    const { plan: second } = await approvedPlan(h, cafe1, { overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    const before = rows(h);
    const withKeyRow = await reserve(cafe1, second.id, KEY(1));
    assert.equal(withKeyRow.status, 422);
    assert.equal(withKeyRow.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.deepEqual(rows(h), before);

    h.db.prepare('DELETE FROM idempotency_keys').run(); // the 24-hour purge
    const afterPurge = await reserve(cafe1, second.id, KEY(1));
    assert.equal(afterPurge.status, 422);
    assert.equal(afterPurge.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.deepEqual({ ...rows(h), keys: 0 }, { ...before, keys: 0 }, 'nothing written for the second plan');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM reservations WHERE plan_version_id = ?', second.id), 0);
  });

  test('RS-16: after the key row is purged, the same key on the same plan replays the current reservation (the reservation row is the guard)', async () => {
    h.db.prepare('DELETE FROM idempotency_keys').run();
    const row = h.db.prepare('SELECT id, plan_version_id FROM reservations').get();
    const before = rows(h);
    const replay = await reserve(cafe1, row.plan_version_id, KEY(1));
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.reservation.id, row.id);
    assert.equal(replay.json.orders.length, 2);
    assert.deepEqual(rows(h), before);
  });

  test('the same plan under a second key is 409 ALREADY_RESERVED with the reservation id and writes nothing', async () => {
    const row = h.db.prepare('SELECT id, plan_version_id FROM reservations').get();
    const before = rows(h);
    const res = await reserve(cafe1, row.plan_version_id, KEY(2));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'ALREADY_RESERVED');
    assert.deepEqual(res.json.error.details, { reservationId: row.id });
    assert.deepEqual(rows(h), before);
    const denied = h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'reservation.create' AND outcome = 'denied' AND detail_json LIKE '%ALREADY_RESERVED%'").get().n;
    assert.equal(denied, 1);
  });
});

describe('reserve: boundary checks', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());

  test('a missing Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED; a malformed one is 422 VALIDATION_FAILED; neither writes anything', async () => {
    const { plan } = await approvedPlan(h, cafe1);
    const before = rows(h);
    const missing = await cafe1.post(`/api/plans/${plan.id}/reserve`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    for (const bad of ['short', 'has spaces in it 1234567', 'a'.repeat(129), 'ünïcode-key-0123456789']) {
      const res = await cafe1.post(`/api/plans/${plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': bad } });
      assert.equal(res.status, 422, bad);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(res.json.error.details.fields, [{ field: 'Idempotency-Key', rule: 'pattern' }]);
    }
    assert.deepEqual(rows(h), before);
  });

  test('a foreign plan is 404 and a malformed id is 400; a body that is not a JSON object is 422', async () => {
    const { plan } = await approvedPlan(h, cafe1);
    const foreign = await reserve(cafe2, plan.id, KEY(10));
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error.code, 'NOT_FOUND');
    assert.equal((await reserve(cafe1, 'abc', KEY(11))).status, 400);
    assert.equal((await reserve(cafe1, 999999, KEY(12))).status, 404);
    const array = await cafe1.send({ method: 'POST', path: `/api/plans/${plan.id}/reserve`, body: '[]', headers: { 'Idempotency-Key': KEY(13), 'Content-Type': 'application/json' } });
    assert.equal(array.status, 422);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM reservations'), 0);
  });

  test('a plan that is only proposed is 409 INVALID_STATE (audited as denied, not stored under the key)', async () => {
    const { plan } = await approvedPlan(h, cafe1, { approve: false });
    const res = await reserve(cafe1, plan.id, KEY(20));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'INVALID_STATE');
    assert.deepEqual(res.json.error.details, { from: 'proposed', to: 'reserved' });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'), 0);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'reservation.create' AND outcome = 'denied'"), 1);
  });

  test('a superseded plan is 409 PLAN_SUPERSEDED and the refusal is stored: the same key replays it with Idempotent-Replayed', async () => {
    const { requestId, plan } = await approvedPlan(h, cafe1);
    h.clock.advance(1000);
    const changed = await cafe1.post(`/api/requests/${requestId}/confirm`, { fields: { ...FIELDS, maxPickups: 3 } });
    assert.equal(changed.status, 201, changed.text);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'superseded');

    const first = await reserve(cafe1, plan.id, KEY(30));
    assert.equal(first.status, 409);
    assert.equal(first.json.error.code, 'PLAN_SUPERSEDED');
    assert.equal(first.headers['idempotent-replayed'], undefined);
    const again = await reserve(cafe1, plan.id, KEY(30));
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'PLAN_SUPERSEDED');
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM reservations'), 0);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'), 1);
  });

  test('a non_executable plan is 409 PLAN_NOT_EXECUTABLE with its reason', async () => {
    const { plan } = await approvedPlan(h, cafe2);
    h.db.prepare("UPDATE plan_versions SET status = 'non_executable', non_executable_reason = 'PAYMENT_CANCELLED' WHERE id = ?").run(plan.id);
    const res = await reserve(cafe2, plan.id, KEY(40));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'PLAN_NOT_EXECUTABLE');
    assert.deepEqual(res.json.error.details, { reason: 'PAYMENT_CANCELLED' });
  });

  test('a plan stored without budget or deadline cannot be reserved: MISSING_BUDGET first, then MISSING_DEADLINE (RS-04)', async () => {
    const { plan } = await approvedPlan(h, cafe2);
    const requirements = h.db.prepare('SELECT id FROM requirements WHERE request_id = (SELECT request_id FROM plan_versions WHERE id = ?)').get(plan.id);
    h.db.prepare('UPDATE requirements SET deadline_at = NULL WHERE id = ?').run(requirements.id);
    const noDeadline = await reserve(cafe2, plan.id, KEY(50));
    assert.equal(noDeadline.status, 409);
    assert.equal(noDeadline.json.error.code, 'MISSING_DEADLINE');
    h.db.prepare('UPDATE requirements SET budget_cents = NULL WHERE id = ?').run(requirements.id);
    const noBudget = await reserve(cafe2, plan.id, KEY(51));
    assert.equal(noBudget.json.error.code, 'MISSING_BUDGET');
  });
});

describe('RS-14 (one process): the last bundle goes to exactly one reservation', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());

  test('RS-14: the loser gets 409 OUT_OF_STOCK (not a lock error), the plan becomes non_executable (OUT_OF_STOCK), a re-plan is queued and the 409 is stored', async () => {
    const one = await approvedPlan(h, cafe1);
    const two = await approvedPlan(h, cafe2);
    const win = await reserve(cafe1, one.plan.id, KEY(1));
    assert.equal(win.status, 201, win.text);
    const before = rows(h);

    const lose = await reserve(cafe2, two.plan.id, KEY(2));
    assert.equal(lose.status, 409, lose.text);
    assert.equal(lose.json.error.code, 'OUT_OF_STOCK');
    assert.deepEqual(lose.json.error.details, { supplierCodes: ['A', 'B'], newPlanVersionId: null });
    assert.deepEqual({ ...rows(h), keys: before.keys }, before, 'nothing of the loser was written but its stored answer');
    assert.equal(rows(h).keys, before.keys + 1);
    const planRow = h.db.prepare('SELECT status, non_executable_reason, reason_detail_json FROM plan_versions WHERE id = ?').get(two.plan.id);
    assert.equal(planRow.status, 'non_executable');
    assert.equal(planRow.non_executable_reason, 'OUT_OF_STOCK');
    assert.deepEqual(JSON.parse(planRow.reason_detail_json), { supplierCodes: ['A', 'B'] });
    const queue = h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(two.requestId);
    assert.equal(queue.reason, 'OUT_OF_STOCK');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(one.plan.id).status, 'approved', 'the winner is untouched');
    assertLedgerInvariant(h);

    const replay = await reserve(cafe2, two.plan.id, KEY(2));
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error.code, 'OUT_OF_STOCK');
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.deepEqual(rows(h), { ...before, keys: before.keys + 1 });

    const view = await cafe2.get(`/api/requests/${two.requestId}`);
    assert.equal(view.json.rescueStatus.status, 'replanning');
  });

  test('RS-14: several same-moment reserves of the one last bundle give exactly one active reservation and reserved <= on_hand', async () => {
    const h2 = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '5' } });
    try {
      const a = await signIn(h2, 'cafe1');
      const b = await signIn(h2, 'cafe2');
      const planA = await approvedPlan(h2, a);
      const planB = await approvedPlan(h2, b);
      const planA2 = await approvedPlan(h2, a);
      const results = await Promise.all([
        reserve(a, planA.plan.id, KEY(1)),
        reserve(b, planB.plan.id, KEY(2)),
        reserve(a, planA2.plan.id, KEY(3)),
      ]);
      const codes = results.map((r) => (r.status === 201 ? 'ok' : r.json.error.code));
      assert.equal(codes.filter((c) => c === 'ok').length, 1, codes.join(','));
      assert.deepEqual(codes.filter((c) => c !== 'ok'), ['OUT_OF_STOCK', 'OUT_OF_STOCK']);
      assert.equal(count(h2, "SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'"), 1);
      assertLedgerInvariant(h2);
    } finally {
      await h2.close();
    }
  });

  test('RS-16: a concurrent same-key race resolves to one reservation: every answer carries the same reservation id', async () => {
    const h2 = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    try {
      const client = await signIn(h2, 'cafe1');
      const { plan } = await approvedPlan(h2, client);
      const answers = await Promise.all(Array.from({ length: 6 }, () => reserve(client, plan.id, KEY(7))));
      assert.ok(answers.every((a) => a.status === 201), answers.map((a) => a.status).join(','));
      assert.equal(new Set(answers.map((a) => a.json.reservation.id)).size, 1);
      assert.equal(answers.filter((a) => a.headers['idempotent-replayed'] === 'true').length, 5);
      assert.deepEqual(rows(h2), { reservations: 1, items: 2, ledger: 7, orders: 2, operations: 2, keys: 1 });
      assertLedgerInvariant(h2);
    } finally {
      await h2.close();
    }
  });

  test('RS-14: with the write lock held by another connection and busy_timeout 0, reserve is 503 DB_BUSY with Retry-After and nothing stored; the same key succeeds after the lock is released (PB-4: server started first)', async () => {
    const h2 = await startHarness({ seed: true, dbBusyTimeoutMs: 0, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_DB_BUSY_TIMEOUT_MS: '0' } });
    const locker = new DatabaseSync(h2.config.dbPath);
    try {
      const client = await signIn(h2, 'cafe1');
      const { plan } = await approvedPlan(h2, client);
      locker.exec('PRAGMA busy_timeout = 0');
      locker.exec('BEGIN IMMEDIATE');
      const busy = await reserve(client, plan.id, KEY(9));
      assert.equal(busy.status, 503, busy.text);
      assert.equal(busy.json.error.code, 'DB_BUSY');
      assert.equal(busy.headers['retry-after'], '1');
      assert.equal(JSON.stringify(busy.json).includes('SQLITE'), false);
      locker.exec('ROLLBACK');
      assert.equal(count(h2, 'SELECT COUNT(*) AS n FROM reservations'), 0);
      assert.equal(count(h2, 'SELECT COUNT(*) AS n FROM idempotency_keys'), 0, 'a 5xx is not stored');
      const retry = await reserve(client, plan.id, KEY(9));
      assert.equal(retry.status, 201, retry.text);
    } finally {
      try {
        locker.close();
      } catch {
        // Already closed.
      }
      await h2.close();
    }
  });
});
