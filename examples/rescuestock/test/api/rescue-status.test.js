// API tests for the derived rescue status (task c2-requests-plans-view). RS-36: the rescue status is computed by
// src/domain/derive.js on every GET /api/requests/:id from persisted plan, reservation, payment-operation and
// fulfilment rows, and is never stored. The cases below build those rows directly in the test database and read
// the status through the live endpoint:
//   (i)   an operation of any plan version in refund_requested / refund_pending gives `refunding`
//   (ii)  a refusal or non_executable plan with an operation still authorized, authorization_pending or unknown
//         gives `cancelling`; refund_failed, a failed void or an over-age unknown gives `failed_needs_attention`
//   (iii) `collected` only when every captured order is collected; ready + collected is `ready_for_pickup`
//   (iv)  once every void completed and a new version is proposed, the status is `plan_found`
// FU-7: the view hands derive.js the snake_case rows of its header. "One query per table" is asserted by
// counting the statements the endpoint prepares.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const OP_COLUMNS = new Set(['status', 'prev_status', 'unknown_since', 'pending_since', 'cancel_requested_at', 'void_failed', 'buyer_cancelled_at', 'approval_url']);

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  client.tick = () => h.clock.advance(61_000); // keeps a customer under 10 plans per 10 minutes
  return client;
}

// A request with a proposed A+B plan, made through the API.
async function planned(client) {
  client.tick();
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json.request.id;
  assert.equal((await client.post(`/api/requests/${requestId}/confirm`, { fields: FIELDS })).status, 201);
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  assert.equal(made.status, 201, made.text);
  return { requestId, plan: made.json.plan };
}

// A timestamp `ms` before the harness clock, so an "unknown since" row has a known age at the moment of the read.
const ago = (h, ms) => new Date(h.clock.now() - ms).toISOString();
const supplierId = (h, code) => h.db.prepare('SELECT id FROM suppliers WHERE code = ?').get(code).id;

function setPlan(h, planId, status, reason = null, detail = '{}') {
  h.db.prepare('UPDATE plan_versions SET status = ?, non_executable_reason = ?, reason_detail_json = ? WHERE id = ?').run(status, reason, detail, planId);
}

function addReservation(h, plan, customerId, status) {
  const key = `key-${plan.id}-${status}-0001`;
  const info = h.db
    .prepare(
      "INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-20T07:00:00.000Z', '2026-10-20T06:00:00.000Z')",
    )
    .run(plan.id, customerId, key, `res:${customerId}:${plan.id}:${key}`, status);
  return Number(info.lastInsertRowid);
}

// One supplier order and one payment operation per supplier of the plan. `states` = { A: [fulfilment, opStatus], ... }.
function addOrders(h, plan, reservationId, states) {
  const out = {};
  for (const s of plan.body.suppliers) {
    const [fulfilment, opStatus] = states[s.supplierCode];
    const orderId = Number(
      h.db
        .prepare(
          "INSERT INTO supplier_orders (plan_version_id, supplier_id, reservation_id, lines_json, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, created_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, '2026-10-20T06:00:00.000Z')",
        )
        .run(plan.id, supplierId(h, s.supplierCode), reservationId, s.subtotalCents, s.prepFeeCents, s.taxCents, s.totalCents, fulfilment).lastInsertRowid,
    );
    const prev = opStatus === 'unknown' ? 'authorized' : null;
    const opId = Number(
      h.db
        .prepare(
          "INSERT INTO payment_operations (supplier_order_id, status, prev_status, provider, merchant_key, amount_cents, currency, unknown_since, created_at, updated_at) VALUES (?, ?, ?, 'fake', ?, ?, 'USD', ?, '2026-10-20T06:00:00.000Z', '2026-10-20T06:00:00.000Z')",
        )
        .run(orderId, opStatus, prev, s.supplierCode, s.totalCents, opStatus === 'unknown' ? ago(h, 60_000) : null).lastInsertRowid,
    );
    out[s.supplierCode] = { orderId, opId };
  }
  return out;
}

function setOp(h, opId, fields) {
  for (const key of Object.keys(fields)) assert.ok(OP_COLUMNS.has(key), `unexpected column ${key}`);
  const sets = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  h.db.prepare(`UPDATE payment_operations SET ${sets} WHERE id = ?`).run(...Object.values(fields), opId);
}

function setFulfilment(h, orderId, status) {
  h.db.prepare('UPDATE supplier_orders SET fulfilment_status = ? WHERE id = ?').run(status, orderId);
}

async function statusOf(client, requestId) {
  const res = await client.get(`/api/requests/${requestId}`);
  assert.equal(res.status, 200, res.text);
  const s = res.json.rescueStatus;
  return { status: s.status, rule: s.rule, next: s.nextStep.code, message: s.message, underlying: s.underlying, view: res.json };
}

describe('RS-36: the rescue status is derived on every read', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-36 (i): refund_requested or refund_pending on any operation is `refunding`, even when everything else is collected', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'executed');
    const reservation = addReservation(h, plan, cafe1.user.id, 'consumed');
    const rows = addOrders(h, plan, reservation, { A: ['collected', 'captured'], B: ['collected', 'captured'] });
    const baseline = await statusOf(cafe1, requestId);
    assert.deepEqual([baseline.status, baseline.rule], ['collected', '7']);

    for (const refund of ['refund_requested', 'refund_pending']) {
      setOp(h, rows.B.opId, { status: refund });
      const now = await statusOf(cafe1, requestId);
      assert.deepEqual([now.status, now.rule, now.next], ['refunding', '3', 'WAIT'], refund);
    }
    // An unknown refund call is still a refund in progress.
    setOp(h, rows.B.opId, { status: 'unknown', prev_status: 'refund_pending', unknown_since: ago(h, 60_000) });
    assert.equal((await statusOf(cafe1, requestId)).status, 'refunding');
    // The same on an operation of an older plan version.
    setOp(h, rows.B.opId, { status: 'captured', prev_status: null, unknown_since: null });
    assert.equal((await statusOf(cafe1, requestId)).status, 'collected');
  });

  test('RS-36 (i): after the refunds finish the status is collected with the refund named, or cancelled when everything was refunded', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'executed');
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'consumed'), { A: ['collected', 'captured'], B: ['collected', 'refunded'] });
    const some = await statusOf(cafe1, requestId);
    assert.deepEqual([some.status, some.rule], ['collected', '7']);
    assert.equal(some.message, 'Order from Supplier B was refunded by the organiser');
    setOp(h, rows.A.opId, { status: 'refunded' });
    const all = await statusOf(cafe1, requestId);
    assert.deepEqual([all.status, all.rule, all.next], ['cancelled', '5a', 'NONE']);
    assert.equal(all.message, 'All payments were refunded by the organiser');
  });

  test('RS-36 (ii): a refusal with an operation still authorized, authorization_pending or unknown is `cancelling`', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'non_executable', 'SUPPLIER_REFUSED', JSON.stringify({ supplierCode: 'B', refusal: 'out of paper' }));
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'released'), { A: ['confirmed', 'authorized'], B: ['refused', 'voided'] });
    for (const open of ['authorized', 'authorization_pending']) {
      setOp(h, rows.A.opId, { status: open });
      const now = await statusOf(cafe1, requestId);
      assert.deepEqual([now.status, now.rule, now.next], ['cancelling', '4', 'WAIT'], open);
    }
    setOp(h, rows.A.opId, { status: 'unknown', prev_status: 'authorized', unknown_since: ago(h, 5 * 60_000) });
    const unknown = await statusOf(cafe1, requestId);
    assert.deepEqual([unknown.status, unknown.rule], ['cancelling', '4'], 'unknown within the escalation limit (15 min)');
    // Nothing newer exists, so the closed version is still the current one and its orders are `orders`.
    assert.equal(unknown.view.cancellingOrders.length, 0);
    assert.deepEqual(unknown.view.orders.map((o) => [o.supplier.code, o.fulfilmentStatus, o.presentation]), [['A', 'confirmed', 'cancelled_payment_incomplete'], ['B', 'refused', 'refused']]);
  });

  test('RS-36 (ii): refund_failed, a failed void or an over-age unknown is `failed_needs_attention`', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'non_executable', 'SUPPLIER_REFUSED');
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'released'), { A: ['confirmed', 'authorized'], B: ['refused', 'voided'] });
    assert.equal((await statusOf(cafe1, requestId)).status, 'cancelling');

    setOp(h, rows.A.opId, { void_failed: 1 });
    const voidFailed = await statusOf(cafe1, requestId);
    assert.deepEqual([voidFailed.status, voidFailed.rule, voidFailed.next], ['failed_needs_attention', '2', 'CONTACT_ORGANISER']);
    setOp(h, rows.A.opId, { void_failed: 0 });
    assert.equal((await statusOf(cafe1, requestId)).status, 'cancelling');

    setOp(h, rows.A.opId, { status: 'refund_failed' });
    assert.equal((await statusOf(cafe1, requestId)).status, 'failed_needs_attention');

    setOp(h, rows.A.opId, { status: 'unknown', prev_status: 'authorized', unknown_since: ago(h, 60 * 60_000) });
    const overAge = await statusOf(cafe1, requestId);
    assert.deepEqual([overAge.status, overAge.rule], ['failed_needs_attention', '2']);
    // The limit comes from the configuration and the injected clock: 10 minutes old is still inside the 15.
    setOp(h, rows.A.opId, { unknown_since: ago(h, 10 * 60_000) });
    assert.equal((await statusOf(cafe1, requestId)).status, 'cancelling');
    h.clock.advance(10 * 60 * 1000);
    assert.equal((await statusOf(cafe1, requestId)).status, 'failed_needs_attention', 'the same row ages into attention as the clock moves');
  });

  test('RS-36 (iii): collected needs every captured order collected; ready + collected is ready_for_pickup; confirmed + collected is purchase_confirmed', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'executed');
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'consumed'), { A: ['ready', 'captured'], B: ['collected', 'captured'] });
    const mixed = await statusOf(cafe1, requestId);
    assert.deepEqual([mixed.status, mixed.rule, mixed.next], ['ready_for_pickup', '8', 'COLLECT']);

    setFulfilment(h, rows.A.orderId, 'collected');
    const collected = await statusOf(cafe1, requestId);
    assert.deepEqual([collected.status, collected.rule], ['collected', '7']);

    setFulfilment(h, rows.A.orderId, 'confirmed');
    const confirmed = await statusOf(cafe1, requestId);
    assert.deepEqual([confirmed.status, confirmed.rule], ['purchase_confirmed', '9']);

    // Collected on one order but the other capture is not captured yet (plan executing): not collected.
    setPlan(h, plan.id, 'executing');
    setFulfilment(h, rows.A.orderId, 'collected');
    setOp(h, rows.A.opId, { status: 'capture_pending' });
    const capturing = await statusOf(cafe1, requestId);
    assert.deepEqual([capturing.status, capturing.rule], ['payment_authorized', '10']);
    assert.notEqual(capturing.status, 'collected');
  });

  test('RS-36 (iii): the view shows the pickup address only for an executed plan, and the receipt and handover flags', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'executed');
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'consumed'), { A: ['ready', 'captured'], B: ['collected', 'captured'] });
    const supplierUser = h.db.prepare("SELECT id FROM users WHERE username = 'supplier-b'").get().id;
    h.db.prepare("INSERT INTO pickup_confirmations (supplier_order_id, kind, by_user, at) VALUES (?, 'handover', ?, '2026-10-20T06:30:00.000Z')").run(rows.B.orderId, supplierUser);
    h.db.prepare("INSERT INTO pickup_confirmations (supplier_order_id, kind, by_user, at) VALUES (?, 'receipt', ?, '2026-10-20T06:31:00.000Z')").run(rows.B.orderId, cafe1.user.id);
    const { view } = await statusOf(cafe1, requestId);
    const [a, b] = view.orders;
    assert.equal(a.supplier.code, 'A');
    assert.deepEqual([a.handoverRecorded, a.receiptRecorded], [false, false]);
    assert.deepEqual([b.handoverRecorded, b.receiptRecorded], [true, true]);
    assert.match(b.pickup.address, /Demo pickup point B/);
    assert.equal(b.supplier.demo, true);
    assert.equal(b.totals.totalCents, 4400);
    assert.deepEqual(b.offer, { readyAt: '2026-10-20T07:30:00.000Z', bundles: 1 });
    assert.deepEqual(b.payment, {
      id: rows.B.opId, status: 'captured', provider: 'fake', simulated: true, sandbox: false, amountCents: 4400, currency: 'USD',
      merchantMode: 'per-supplier', approvalUrl: null, buyerCancelledAt: null, authorizationExpiresAt: null, cancelRequested: false,
      voidedLocally: false, voidFailed: false, lastErrorCode: null,
    });
    assert.equal(b.presentation, 'active');
    setPlan(h, plan.id, 'approved');
    const approved = (await statusOf(cafe1, requestId)).view.orders;
    assert.equal(approved[0].pickup, null);
  });

  test('RS-36 (iv): after every void completes and a new version is proposed, the status is plan_found with the refusal explained', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'non_executable', 'SUPPLIER_REFUSED', JSON.stringify({ supplierCode: 'B', refusal: 'out of paper' }));
    const rows = addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'released'), { A: ['confirmed', 'authorized'], B: ['refused', 'voided'] });
    h.db.prepare("UPDATE supplier_orders SET refusal_reason = 'out of paper' WHERE id = ?").run(rows.B.orderId);
    cafe1.tick();
    const replanned = await cafe1.post(`/api/requests/${requestId}/plan`, {});
    assert.equal(replanned.status, 201, replanned.text);
    assert.deepEqual(replanned.json.plan.body.lines.map((l) => l.supplierCode), ['A', 'E'], 'the refusing supplier is left out');

    const draining = await statusOf(cafe1, requestId);
    assert.deepEqual([draining.status, draining.rule], ['cancelling', '4'], 'A\'s authorization is not voided yet');
    // Only the order whose money is still outstanding is listed; B's void is already complete.
    assert.deepEqual(draining.view.cancellingOrders.map((o) => [o.supplier.code, o.payment.status, o.presentation]), [['A', 'authorized', 'cancelled_payment_incomplete']]);
    assert.deepEqual(draining.view.orders, [], 'the new version has no orders yet');

    setOp(h, rows.A.opId, { status: 'voided' });
    const done = await statusOf(cafe1, requestId);
    assert.deepEqual([done.status, done.rule, done.next], ['plan_found', '12', 'REVIEW_NEW_PLAN']);
    assert.equal(done.message, 'Supplier B refused the order: out of paper. No money was taken.');
    assert.equal(done.view.cancellingOrders.length, 0);
    assert.equal(done.view.currentPlanId, replanned.json.plan.id);
  });

  test('RS-36: the status is computed on every read; no write route and no row of rescue_requests changes between reads', async () => {
    const { requestId, plan } = await planned(cafe1);
    const rowBefore = JSON.stringify(h.db.prepare('SELECT * FROM rescue_requests WHERE id = ?').get(requestId));
    const first = await statusOf(cafe1, requestId);
    assert.equal(first.status, 'plan_found');
    setPlan(h, plan.id, 'approved');
    const reservation = addReservation(h, plan, cafe1.user.id, 'active');
    const rows = addOrders(h, plan, reservation, { A: ['awaiting_supplier', 'created'], B: ['awaiting_supplier', 'created'] });
    const reserved = await statusOf(cafe1, requestId);
    assert.deepEqual([reserved.status, reserved.rule, reserved.next], ['stock_reserved', '11', 'APPROVE_PAYMENTS']);
    assert.deepEqual(reserved.underlying, {
      plan: 'approved', reservation: 'active',
      payments: [{ orderId: rows.A.orderId, status: 'created' }, { orderId: rows.B.orderId, status: 'created' }].sort((x, y) => x.orderId - y.orderId),
      fulfilment: [{ orderId: rows.A.orderId, status: 'awaiting_supplier' }, { orderId: rows.B.orderId, status: 'awaiting_supplier' }],
    });
    assert.equal(reserved.view.reservation.status, 'active');
    assert.equal(reserved.view.reservation.planVersionId, plan.id);
    setOp(h, rows.A.opId, { status: 'authorized' });
    setOp(h, rows.B.opId, { status: 'authorized' });
    const authorized = await statusOf(cafe1, requestId);
    assert.deepEqual([authorized.status, authorized.rule, authorized.next], ['payment_authorized', '10', 'WAIT_FOR_SUPPLIERS']);
    assert.equal(JSON.stringify(h.db.prepare('SELECT * FROM rescue_requests WHERE id = ?').get(requestId)), rowBefore, 'reading never writes the request row');
    const listed = (await cafe1.get('/api/requests')).json.requests.find((r) => r.id === requestId);
    assert.equal(listed.rescueStatus.status, 'payment_authorized');
    assert.equal(listed.totalCents, 8400);
  });

  test('RS-36 / FU-7: row 14 is reported with derive.fallback in the log and a REPLAN next step, never a 500', async () => {
    const { requestId, plan } = await planned(cafe1);
    h.db.prepare('DELETE FROM plan_versions WHERE id = ?').run(plan.id); // a feasible run without its version: no table row matches
    const res = await statusOf(cafe1, requestId);
    assert.deepEqual([res.status, res.rule, res.next], ['replanning', '14', 'REPLAN']);
    const logged = h.logEntries().filter((e) => e.msg === 'derive.fallback');
    assert.ok(logged.length >= 1);
    assert.equal(logged.at(-1).code, 'DERIVE_FALLBACK');
    assert.equal(logged.at(-1).requestRef, requestId);
  });
});

describe('FU-7: one query per table', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  // Wraps db.prepare to record the SQL text of every statement prepared while `fn` runs.
  async function recordSql(fn) {
    const original = h.db.prepare.bind(h.db);
    const seen = [];
    h.db.prepare = (sql) => {
      seen.push(sql);
      return original(sql);
    };
    try {
      await fn();
    } finally {
      delete h.db.prepare;
    }
    return seen;
  }

  const TABLES = ['plan_versions', 'planning_runs', 'requirements', 'reservations', 'reservation_items', 'supplier_orders', 'payment_operations', 'provider_calls', 'pickup_confirmations', 'replan_queue', 'extractions', 'images'];
  const perTable = (seen, table) => seen.filter((sql) => new RegExp(`\\bFROM\\s+${table}\\b`).test(sql)).length;

  test('FU-7: GET /api/requests/:id selects from each table once, however many versions and orders the request has', async () => {
    const { requestId, plan } = await planned(cafe1);
    setPlan(h, plan.id, 'non_executable', 'SUPPLIER_REFUSED');
    addOrders(h, plan, addReservation(h, plan, cafe1.user.id, 'released'), { A: ['confirmed', 'voided'], B: ['refused', 'voided'] });
    cafe1.tick();
    await cafe1.post(`/api/requests/${requestId}/plan`, {});
    cafe1.tick();
    await cafe1.post(`/api/requests/${requestId}/plan`, {});
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE request_id = ?').get(requestId).n, 3);
    const seen = await recordSql(async () => {
      assert.equal((await cafe1.get(`/api/requests/${requestId}`)).status, 200);
    });
    for (const table of TABLES) assert.equal(perTable(seen, table), 1, `${table}: ${perTable(seen, table)} statements`);
    assert.equal(perTable(seen, 'rescue_requests'), 1);
  });

  test('FU-7: GET /api/requests selects from each table once for the whole list', async () => {
    for (let i = 0; i < 3; i += 1) await planned(cafe1);
    const seen = await recordSql(async () => {
      const res = await cafe1.get('/api/requests');
      assert.equal(res.status, 200);
      assert.ok(res.json.requests.length >= 4);
    });
    for (const table of ['plan_versions', 'planning_runs', 'requirements', 'reservations', 'supplier_orders', 'payment_operations', 'provider_calls', 'replan_queue']) {
      assert.equal(perTable(seen, table), 1, `${table}: ${perTable(seen, table)} statements`);
    }
  });
});
