// SEC-2 API tests (task c3-reservations-supplier-admin), with the DEFAULT limits (no RS_MAX_* override):
//   SEC-2  a customer holds at most one live (active) reservation: a second reserve is 409 RESERVATION_LIMIT with the
//          ids of the live ones and nothing written; another customer is unaffected; the cap is checked in the writing
//          transaction, so two same-moment reserves by one customer give one 201 and one 409; the refusal is not stored,
//          so the same key works once the first reservation has ended
//   SEC-2  the 11th request of a day is 429 RATE_LIMITED (requests_per_day) with Retry-After and no request row
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient, uniqueUsername } from '../helpers/fixtures.js';
import { expireDueReservations } from '../../src/services/reservations.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const KEY = (n) => `abuse-key-${String(n).padStart(8, '0')}-abcdef`;
const SMALL = Object.freeze({ cupQuantity: 100, lidQuantity: 100, maxPickups: 1 });

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function approvedPlan(h, client, overrides = {}) {
  h.clock.advance(61_000);
  const created = await client.post('/api/requests', { text: 'I need cups and lids by 11:00.' });
  assert.equal(created.status, 201, created.text);
  const requestId = created.json.request.id;
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: { ...FIELDS, ...overrides } });
  assert.equal(confirmed.status, 201, confirmed.text);
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  assert.equal(made.status, 201, made.text);
  assert.ok(made.json.plan, 'feasible');
  const plan = made.json.plan;
  const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  assert.equal(approved.status, 200, approved.text);
  return { requestId, plan };
}

const reserve = (client, planId, key) => client.post(`/api/plans/${planId}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const written = (h) => ({
  reservations: count(h, 'SELECT COUNT(*) AS n FROM reservations'),
  items: count(h, 'SELECT COUNT(*) AS n FROM reservation_items'),
  ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
  orders: count(h, 'SELECT COUNT(*) AS n FROM supplier_orders'),
  operations: count(h, 'SELECT COUNT(*) AS n FROM payment_operations'),
  keys: count(h, 'SELECT COUNT(*) AS n FROM idempotency_keys'),
});

describe('SEC-2: the live-reservation cap (default 1 per customer)', () => {
  let h;
  let cafe1;
  let cafe2;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());

  test('SEC-2: the defaults are 1 live reservation and 10 requests per day', () => {
    assert.equal(h.config.maxLiveReservationsPerCustomer, 1);
    assert.equal(h.config.maxRequestsPerCustomerPerDay, 10);
  });

  let first;
  let second;
  let secondKeyBefore;

  test('SEC-2: a second reserve by the same customer is 409 RESERVATION_LIMIT with the live reservation ids, and nothing is written', async () => {
    // Both plans are made while the stock is free, so both are approvable; only the cap stops the second.
    const one = await approvedPlan(h, cafe1);
    second = await approvedPlan(h, cafe1, SMALL);
    first = await reserve(cafe1, one.plan.id, KEY(1));
    assert.equal(first.status, 201, first.text);

    secondKeyBefore = written(h);
    const limited = await reserve(cafe1, second.plan.id, KEY(2));
    assert.equal(limited.status, 409, limited.text);
    assert.equal(limited.json.error.code, 'RESERVATION_LIMIT');
    assert.deepEqual(limited.json.error.details, { reservationIds: [first.json.reservation.id] });
    assert.equal(limited.json.error.message, 'The reservation limit for this account is reached.');
    assert.deepEqual(written(h), secondKeyBefore, 'no reservation, item, ledger, order, operation or key row');
    const inv = h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;
    assert.equal(inv, 2);
    assert.equal(
      count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'reservation.create' AND outcome = 'denied' AND detail_json LIKE '%RESERVATION_LIMIT%'"),
      1,
    );
  });

  test('SEC-2: another customer is not affected by the first customer\'s reservation', async () => {
    // A and B are taken; cafe2 asks for a smaller order that E can fill.
    const other = await approvedPlan(h, cafe2, SMALL);
    const res = await reserve(cafe2, other.plan.id, KEY(3));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.reservation.items[0].supplierCode, 'E');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'"), 2);
  });

  test('SEC-2: RESERVATION_LIMIT is not stored under the key: once the first reservation has expired, the same key reserves the second plan', async () => {
    h.clock.advance(31 * 60 * 1000);
    const pass = expireDueReservations(h.app.deps);
    assert.equal(pass.expired.length, 2);
    const retry = await reserve(cafe1, second.plan.id, KEY(2));
    assert.equal(retry.status, 201, retry.text);
    assert.equal(retry.json.reservation.planVersionId, second.plan.id);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status = 'active'", cafe1.user.id), 1);
  });

  test('SEC-2: two same-moment reserves by one customer give one 201 and one RESERVATION_LIMIT (the cap is checked in the writing transaction)', async () => {
    const h2 = await startHarness({ seed: true });
    try {
      const client = await signIn(h2, 'cafe1');
      const one = await approvedPlan(h2, client, SMALL);
      const two = await approvedPlan(h2, client, { ...SMALL, productType: 'cups_and_lids' });
      const answers = await Promise.all([reserve(client, one.plan.id, KEY(1)), reserve(client, two.plan.id, KEY(2))]);
      const statuses = answers.map((a) => a.status).sort();
      assert.deepEqual(statuses, [201, 409]);
      const loser = answers.find((a) => a.status === 409);
      assert.equal(loser.json.error.code, 'RESERVATION_LIMIT');
      assert.equal(count(h2, "SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'"), 1);
    } finally {
      await h2.close();
    }
  });
});

describe('SEC-2: request creation is limited per customer and Asia/Amman day', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true });
  });
  after(() => h.close());

  test('SEC-2: the 11th request of a day is 429 RATE_LIMITED (requests_per_day) with Retry-After and no new request row; another customer is unaffected', async () => {
    const client = createClient(h.request);
    await client.register({ username: uniqueUsername('burst'), password: 'a long enough password' });
    for (let i = 1; i <= 10; i += 1) {
      const res = await client.post('/api/requests', { text: `Request number ${i} for cups.` });
      assert.equal(res.status, 201, `request ${i}: ${res.text}`);
    }
    const eleventh = await client.post('/api/requests', { text: 'One request too many.' });
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(eleventh.json.error.details, { limit: 'requests_per_day' });
    assert.ok(Number(eleventh.headers['retry-after']) >= 1);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE customer_id = ?', client.user.id), 10);

    const other = await signIn(h, 'cafe2');
    assert.equal((await other.post('/api/requests', { text: 'Another customer is fine.' })).status, 201);
  });
});
