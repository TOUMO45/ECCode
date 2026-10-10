// Supplier orders and inventory API tests (task c3-reservations-supplier-admin). Case names start with the criterion id:
//   RS-28  suppliers see and change only their own orders and inventory (the PATCH ownership cases are in isolation.test.js)
//   RS-17  (supplier half) a refusal before execution: order refused, void rule (SUPPLIER_REFUSED), the plan non_executable,
//          a re-plan queued that leaves the refusing supplier out; after the claim 409 ORDER_EXECUTED
//   RS-13  (offer-change half) price, prep fee, ready time, withdrawal and an on_hand decrease create a new offer version
//          and supersede proposed/approved plan versions in the same transaction, void rule included; not after the
//          affected supplier confirmed; other customers' reservations never supersede a plan
//   RS-38  every inventory change writes a ledger row; SUM(delta) equals the inventory columns
//   COMMITMENT_INVALID, HANDOVER_BLOCKED, RESERVED_STOCK and INVALID_STATE are refused transitions: audit outcome denied
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { FIXTURE_DIR, createClient } from '../helpers/fixtures.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const fixture = (name) => JSON.parse(readFileSync(`${FIXTURE_DIR}/contracts/${name}.json`, 'utf8')).response;
const keysOf = (value) => Object.keys(value).sort();

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function plannedFor(h, client, { approve = true, overrides = {} } = {}) {
  h.clock.advance(61_000);
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json.request.id;
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: { ...FIELDS, ...overrides } });
  assert.equal(confirmed.status, 201, confirmed.text);
  const plan = (await client.post(`/api/requests/${requestId}/plan`, {})).json.plan;
  assert.ok(plan, 'feasible');
  if (approve) {
    const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
    assert.equal(approved.status, 200, approved.text);
  }
  return { requestId, plan };
}

let keyCounter = 0;
async function reservedPlan(h, client, options) {
  const flow = await plannedFor(h, client, options);
  keyCounter += 1;
  const res = await client.post(`/api/plans/${flow.plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': `supplier-flow-key-${String(keyCounter).padStart(8, '0')}` } });
  assert.equal(res.status, 201, res.text);
  return { ...flow, reservation: res.json.reservation, orders: res.json.orders };
}

const orderOf = (flow, code) => flow.orders.find((o) => o.supplier.code === code);
const confirmBody = (code, bundles = 1) => ({ lines: [{ offerId: code === 'A' ? 1 : 2, committedBundles: bundles }], committedReadyAt: READY[code] });
const productOf = (h, code) =>
  h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = ? AND p.kind = 'bundle'").get(code).id;
const patch = (client, items) => client.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items } });
const planStatus = (h, id) => h.db.prepare('SELECT status, supersede_reason, non_executable_reason FROM plan_versions WHERE id = ?').get(id);
const deniedAudit = (h, action, code) =>
  count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = ? AND outcome = 'denied' AND detail_json LIKE ?", action, `%${code}%`);

function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `ledger reserved of product ${inv.product_id}`);
    assert.ok(inv.reserved <= inv.on_hand);
  }
}

describe('supplier orders: listing, confirm, ready and handover', () => {
  let h;
  let cafe1;
  let supplierA;
  let supplierB;
  let flow;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    supplierA = await signIn(h, 'supplier-a');
    supplierB = await signIn(h, 'supplier-b');
    flow = await reservedPlan(h, cafe1);
  });
  after(() => h.close());

  test('RS-28: a supplier lists only its own orders, in the SupplierOrder shape, without the buyer\'s username or payer data', async () => {
    const res = await supplierA.get('/api/supplier/orders');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.orders.length, 1);
    const order = res.json.orders[0];
    assert.deepEqual(keysOf(order), keysOf(fixture('supplier-orders').orders[0]));
    assert.equal(order.id, orderOf(flow, 'A').id);
    assert.equal(order.ref, `R${flow.requestId}-V1`);
    assert.deepEqual(order.buyer, { displayName: 'Cafe 1 (demo)' });
    assert.deepEqual(order.lines, [{ offerId: 1, productName: 'Supplier A bundle: 100 cups + 100 lids', bundles: 1, cups: 100, lids: 100 }]);
    assert.equal(order.totalCents, 4000);
    assert.equal(order.catalogReadyAt, READY.A);
    assert.equal(order.deadlineAt, '2026-10-20T08:00:00.000Z');
    assert.equal(order.fulfilmentStatus, 'awaiting_supplier');
    assert.equal(order.commitment, null);
    assert.deepEqual(order.payment, { status: 'created', simulated: true, sandbox: false });
    assert.equal(order.presentation, 'active');
    assert.deepEqual([order.canConfirm, order.canMarkReady, order.canHandover, order.demo], [true, false, false, true]);
    assert.equal(JSON.stringify(res.json).includes('cafe1'), false);

    const other = await supplierB.get('/api/supplier/orders');
    assert.deepEqual(other.json.orders.map((o) => o.id), [orderOf(flow, 'B').id]);
    const filtered = await supplierA.get('/api/supplier/orders?status=confirmed');
    assert.deepEqual(filtered.json.orders, []);
    const invalid = await supplierA.get('/api/supplier/orders?status=nonsense');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'BAD_REQUEST');
  });

  test('COMMITMENT_INVALID: an offer that is not in the order, a missing or duplicate line, or a ready time after the deadline is 422 and changes nothing', async () => {
    const id = orderOf(flow, 'A').id;
    const cases = [
      [{ lines: [{ offerId: 2, committedBundles: 1 }], committedReadyAt: READY.A }, ['unknown_offer', 'missing_offer']],
      [{ lines: [{ offerId: 1, committedBundles: 1 }, { offerId: 1, committedBundles: 1 }], committedReadyAt: READY.A }, ['duplicate_offer']],
      [{ lines: [{ offerId: 1, committedBundles: 1 }], committedReadyAt: '2026-10-20T08:00:00.001Z' }, ['after_deadline']],
    ];
    for (const [body, rules] of cases) {
      const res = await supplierA.post(`/api/supplier/orders/${id}/confirm`, body);
      assert.equal(res.status, 422, res.text);
      assert.equal(res.json.error.code, 'COMMITMENT_INVALID');
      assert.deepEqual(res.json.error.details.fields.map((f) => f.rule).sort(), [...rules].sort());
    }
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(id).fulfilment_status, 'awaiting_supplier');
    assert.equal(deniedAudit(h, 'order.confirm', 'COMMITMENT_INVALID'), 3);
  });

  test('confirm validates its body: committedBundles >= 1, a real offer id, a Ts for the ready time -> 422 VALIDATION_FAILED', async () => {
    const id = orderOf(flow, 'A').id;
    for (const body of [
      {},
      { lines: [], committedReadyAt: READY.A },
      { lines: [{ offerId: 1, committedBundles: 0 }], committedReadyAt: READY.A },
      { lines: [{ offerId: 'x', committedBundles: 1 }], committedReadyAt: READY.A },
      { lines: [{ offerId: 1, committedBundles: 1 }], committedReadyAt: '2026-10-20 07:00' },
      { lines: 'all', committedReadyAt: READY.A },
    ]) {
      const res = await supplierA.post(`/api/supplier/orders/${id}/confirm`, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
  });

  test('confirm: awaiting_supplier -> confirmed with the commitment shown separately; a repeat with identical values is 200 and unchanged; other values are 409 INVALID_STATE', async () => {
    const id = orderOf(flow, 'A').id;
    const res = await supplierA.post(`/api/supplier/orders/${id}/confirm`, confirmBody('A'));
    assert.equal(res.status, 200, res.text);
    const order = res.json.order;
    assert.deepEqual(keysOf(order), keysOf(fixture('supplier-order-confirm').order));
    assert.equal(order.fulfilmentStatus, 'confirmed');
    assert.deepEqual(order.commitment, { bundles: 1, readyAt: READY.A, confirmedAt: new Date(h.clock.now()).toISOString() });
    assert.deepEqual([order.canConfirm, order.canMarkReady, order.canHandover], [false, false, false], 'ready needs an executed plan');

    h.clock.advance(5000);
    const repeat = await supplierA.post(`/api/supplier/orders/${id}/confirm`, confirmBody('A'));
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.order.commitment.confirmedAt, order.commitment.confirmedAt, 'unchanged');
    const different = await supplierA.post(`/api/supplier/orders/${id}/confirm`, confirmBody('A', 2));
    assert.equal(different.status, 409);
    assert.equal(different.json.error.code, 'INVALID_STATE');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.confirm' AND outcome = 'ok'"), 1);
    assert.equal(deniedAudit(h, 'order.confirm', 'INVALID_STATE'), 1);
  });

  test('ready on an order that is not confirmed is 409 INVALID_STATE; ready and handover before the plan is executed are 409 HANDOVER_BLOCKED (audited as denied)', async () => {
    const aId = orderOf(flow, 'A').id;
    const bId = orderOf(flow, 'B').id;
    const early = await supplierB.post(`/api/supplier/orders/${bId}/ready`, {});
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, 'INVALID_STATE');
    const ready = await supplierA.post(`/api/supplier/orders/${aId}/ready`, {});
    assert.equal(ready.status, 409);
    assert.equal(ready.json.error.code, 'HANDOVER_BLOCKED');
    const handover = await supplierA.post(`/api/supplier/orders/${aId}/handover`, {});
    assert.equal(handover.status, 409);
    assert.equal(handover.json.error.code, 'HANDOVER_BLOCKED');
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(aId).fulfilment_status, 'confirmed');
    assert.equal(deniedAudit(h, 'order.ready', 'HANDOVER_BLOCKED'), 1);
    assert.equal(deniedAudit(h, 'order.handover', 'HANDOVER_BLOCKED'), 1);
  });

  test('ready and handover: with the plan executed they work (confirmed -> ready -> collected), an unsettled operation of the plan blocks them, repeats are 200', async () => {
    const aId = orderOf(flow, 'A').id;
    const ops = h.db.prepare('SELECT id, supplier_order_id FROM payment_operations ORDER BY id').all();
    h.db.prepare("UPDATE plan_versions SET status = 'executed' WHERE id = ?").run(flow.plan.id);
    h.db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ?").run(flow.reservation.id);
    h.db.prepare("UPDATE payment_operations SET status = 'captured' WHERE id = ?").run(ops[0].id);
    h.db.prepare("UPDATE payment_operations SET status = 'capture_pending' WHERE id = ?").run(ops[1].id);

    const blocked = await supplierA.post(`/api/supplier/orders/${aId}/ready`, {});
    assert.equal(blocked.status, 409, 'an operation of the plan is capture_pending');
    assert.equal(blocked.json.error.code, 'HANDOVER_BLOCKED');

    h.db.prepare("UPDATE payment_operations SET status = 'captured' WHERE id = ?").run(ops[1].id);
    const ready = await supplierA.post(`/api/supplier/orders/${aId}/ready`, {});
    assert.equal(ready.status, 200, ready.text);
    assert.equal(ready.json.order.fulfilmentStatus, 'ready');
    assert.deepEqual([ready.json.order.canMarkReady, ready.json.order.canHandover], [false, true]);
    assert.equal((await supplierA.post(`/api/supplier/orders/${aId}/ready`, {})).status, 200, 'repeat');

    const done = await supplierA.post(`/api/supplier/orders/${aId}/handover`, {});
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.order.fulfilmentStatus, 'collected');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM pickup_confirmations WHERE supplier_order_id = ? AND kind = 'handover'", aId), 1);
    assert.equal((await supplierA.post(`/api/supplier/orders/${aId}/handover`, {})).status, 200, 'repeat');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM pickup_confirmations WHERE kind = 'handover'"), 1);
    const view = await cafe1.get(`/api/requests/${flow.requestId}`);
    assert.equal(view.json.orders.find((o) => o.supplier.code === 'A').handoverRecorded, true);
  });
});

describe('COMMITMENT_INVALID: the committed quantity must cover the planned bundles', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
  });
  after(() => h.close());

  test('a commitment below the planned quantity is 422 below_planned; the planned quantity (or more) confirms', async () => {
    h.db.prepare("UPDATE inventory SET on_hand = 2 WHERE supplier_id = (SELECT id FROM suppliers WHERE code = 'A')").run();
    h.db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) SELECT supplier_id, product_id, 'restock', 1, 0, 2, 0, 'supplier_patch', 'test', '2026-10-20T06:00:00.000Z' FROM inventory WHERE on_hand = 2").run();
    const cafe1 = await signIn(h, 'cafe1');
    const supplierA = await signIn(h, 'supplier-a');
    const flow = await reservedPlan(h, cafe1);
    const order = orderOf(flow, 'A');
    assert.equal(order.offer.bundles, 2, 'A x2 covers the 200 cups alone');
    const low = await supplierA.post(`/api/supplier/orders/${order.id}/confirm`, confirmBody('A', 1));
    assert.equal(low.status, 422, low.text);
    assert.equal(low.json.error.code, 'COMMITMENT_INVALID');
    assert.deepEqual(low.json.error.details.fields, [{ field: 'lines', rule: 'below_planned' }]);
    const ok = await supplierA.post(`/api/supplier/orders/${order.id}/confirm`, confirmBody('A', 3));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.order.commitment.bundles, 3);
  });
});

describe('RS-17 (supplier half): a refusal before execution voids the plan and queues a re-plan without that supplier', () => {
  let h;
  let cafe1;
  let supplierA;
  let supplierB;
  let flow;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    supplierA = await signIn(h, 'supplier-a');
    supplierB = await signIn(h, 'supplier-b');
    flow = await reservedPlan(h, cafe1);
  });
  after(() => h.close());

  test('RS-17: refusing needs a reason of 1-300 characters (422) and an order of the caller (404)', async () => {
    const bId = orderOf(flow, 'B').id;
    for (const reason of ['', '   ', 'x'.repeat(301), 5, 'bad\u0000text']) {
      const res = await supplierB.post(`/api/supplier/orders/${bId}/refuse`, { reason });
      assert.equal(res.status, 422, JSON.stringify(reason).slice(0, 20));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
    assert.equal((await supplierB.post('/api/supplier/orders/987654/refuse', { reason: 'no' })).status, 404);
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(bId).fulfilment_status, 'awaiting_supplier');
  });

  test('RS-17: supplier B refuses after A confirmed: B refused, A\'s confirmed order cancelled, reservation released with release rows, plan non_executable (SUPPLIER_REFUSED), operations voided locally, re-plan queued', async () => {
    const aId = orderOf(flow, 'A').id;
    const bId = orderOf(flow, 'B').id;
    assert.equal((await supplierA.post(`/api/supplier/orders/${aId}/confirm`, confirmBody('A'))).status, 200);
    const res = await supplierB.post(`/api/supplier/orders/${bId}/refuse`, { reason: 'Out of cups today' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keysOf(res.json.order), keysOf(fixture('supplier-order-refuse').order));
    assert.equal(res.json.order.fulfilmentStatus, 'refused');
    assert.equal(res.json.order.refusalReason, 'Out of cups today');
    assert.equal(res.json.order.presentation, 'refused');
    assert.deepEqual([res.json.order.canConfirm, res.json.order.canMarkReady, res.json.order.canHandover], [false, false, false]);
    assert.equal(res.json.order.payment.status, 'voided');

    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'refused']);
    const plan = h.db.prepare('SELECT status, non_executable_reason, reason_detail_json FROM plan_versions WHERE id = ?').get(flow.plan.id);
    assert.equal(plan.status, 'non_executable');
    assert.equal(plan.non_executable_reason, 'SUPPLIER_REFUSED');
    assert.deepEqual(JSON.parse(plan.reason_detail_json), { supplierCode: 'B', refusal: 'Out of cups today' });
    assert.equal(h.db.prepare('SELECT status FROM reservations').get().status, 'released');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'release' AND delta_reserved = -1"), 2);
    assert.equal(count(h, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    assert.deepEqual(h.db.prepare('SELECT status, voided_locally, cancel_reason FROM payment_operations ORDER BY id').all().map((o) => [o.status, o.voided_locally, o.cancel_reason]), [
      ['voided', 1, 'SUPPLIER_REFUSED'], ['voided', 1, 'SUPPLIER_REFUSED'],
    ]);
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(flow.requestId).reason, 'SUPPLIER_REFUSED');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.refuse' AND outcome = 'ok'"), 1);
    assertLedgerInvariant(h);

    const view = await cafe1.get(`/api/requests/${flow.requestId}`);
    assert.equal(view.json.rescueStatus.status, 'replanning');
    const aOrder = (await supplierA.get('/api/supplier/orders')).json.orders[0];
    assert.equal(aOrder.presentation, 'cancelled');
    assert.deepEqual([aOrder.canConfirm, aOrder.canMarkReady, aOrder.canHandover], [false, false, false]);
  });

  test('RS-17: a repeat of the refusal is 200 and writes nothing more; the re-plan leaves the refusing supplier out (A+E at 9500)', async () => {
    const bId = orderOf(flow, 'B').id;
    const before = { audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger') };
    const repeat = await supplierB.post(`/api/supplier/orders/${bId}/refuse`, { reason: 'Out of cups today' });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.order.fulfilmentStatus, 'refused');
    assert.deepEqual({ audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger') }, before);

    h.clock.advance(61_000);
    const replan = await cafe1.post(`/api/requests/${flow.requestId}/plan`, {});
    assert.equal(replan.status, 201, replan.text);
    assert.deepEqual(replan.json.plan.body.suppliers.map((s) => s.supplierCode), ['A', 'E']);
    assert.equal(replan.json.plan.body.totalCents, 9500);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM replan_queue').get().n, 0, 'the stored run answers the queue entry');
  });

  test('RS-17: after the execute claim a refusal is 409 ORDER_EXECUTED and nothing changes (audited as denied)', async () => {
    const other = await reservedPlan(h, cafe1, { overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    const order = other.orders[0];
    const supplier = order.supplier.code === 'A' ? supplierA : await signIn(h, `supplier-${order.supplier.code.toLowerCase()}`);
    h.db.prepare("UPDATE plan_versions SET status = 'executing', executor_id = 'test:1:abcd', lease_epoch = 1 WHERE id = ?").run(other.plan.id);
    h.db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ?").run(other.reservation.id);
    const res = await supplier.post(`/api/supplier/orders/${order.id}/refuse`, { reason: 'too late' });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'ORDER_EXECUTED');
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(order.id).fulfilment_status, 'awaiting_supplier');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(other.plan.id).status, 'executing');
    assert.equal(deniedAudit(h, 'order.refuse', 'ORDER_EXECUTED'), 1);
  });
});

describe('supplier inventory: GET, PATCH, offer versions and ledger rows', () => {
  let h;
  let supplierA;
  let supplierB;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    supplierA = await signIn(h, 'supplier-a');
    supplierB = await signIn(h, 'supplier-b');
  });
  after(() => h.close());

  test('GET lists the supplier\'s own products with stock and the current offer, with labels', async () => {
    const res = await supplierA.get('/api/supplier/inventory');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keysOf(res.json), ['items', 'labels', 'requestId']);
    assert.equal(res.json.items.length, 1);
    const item = res.json.items[0];
    assert.deepEqual(keysOf(item), keysOf(fixture('supplier-inventory').items[0]));
    assert.deepEqual(
      { kind: item.kind, capacityMl: item.capacityMl, diameterMm: item.diameterMm, onHand: item.onHand, reserved: item.reserved, demo: item.demo },
      { kind: 'bundle', capacityMl: 250, diameterMm: 90, onHand: 1, reserved: 0, demo: true },
    );
    assert.deepEqual(item.offer, { id: 1, version: 1, priceCents: 3000, prepFeeCents: 1000, readyAt: READY.A, status: 'active' });
    assert.equal(res.json.labels.priceNotice, 'Test prices, not market prices');
  });

  test('PATCH validates the whole body: 1-20 items, a product id, at least one change per item, no duplicates, real values -> 422 with item paths', async () => {
    const id = productOf(h, 'A');
    const bad = [
      [[], 'items'],
      [Array.from({ length: 21 }, (_, i) => ({ productId: id + i * 100, onHand: 1 })), 'items'],
      [[{ productId: id }], 'items.0'],
      [[{ productId: id, onHand: 1 }, { productId: id, priceCents: 5 }], 'items.1.productId'],
      [[{ productId: id, priceCents: -1 }], 'items.0.priceCents'],
      [[{ productId: id, onHand: 1.5 }], 'items.0.onHand'],
      [[{ productId: id, readyAt: 'noon' }], 'items.0.readyAt'],
      [[{ productId: id, withdrawn: 'yes' }], 'items.0.withdrawn'],
      [[{ productId: 'A' }], 'items.0.productId'],
    ];
    for (const [items, field] of bad) {
      const res = await patch(supplierA, items);
      assert.equal(res.status, 422, `${field}: ${res.text}`);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.ok(res.json.error.details.fields.some((f) => f.field === field), `${field} in ${JSON.stringify(res.json.error.details)}`);
    }
    const notObject = await supplierA.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: [] });
    assert.equal(notObject.status, 422);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM offers'), 5, 'nothing was changed');
  });

  test('RS-38: onHand changes write ledger rows (restock when it grows, adjust when it shrinks) and the sums still equal the stock; the same value writes nothing', async () => {
    const id = productOf(h, 'A');
    const up = await patch(supplierA, [{ productId: id, onHand: 4 }]);
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.items[0].onHand, 4);
    assert.deepEqual(up.json.superseded, []);
    const down = await patch(supplierA, [{ productId: id, onHand: 1 }]);
    assert.equal(down.status, 200);
    const same = await patch(supplierA, [{ productId: id, onHand: 1 }]);
    assert.equal(same.status, 200);
    const rows = h.db.prepare("SELECT reason, delta_on_hand, on_hand_after, ref_type, actor FROM inventory_ledger WHERE product_id = ? AND ref_type = 'supplier_patch' ORDER BY id").all(id).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { reason: 'restock', delta_on_hand: 3, on_hand_after: 4, ref_type: 'supplier_patch', actor: `supplier:${supplierA.user.id}` },
      { reason: 'adjust', delta_on_hand: -3, on_hand_after: 1, ref_type: 'supplier_patch', actor: `supplier:${supplierA.user.id}` },
    ]);
    assertLedgerInvariant(h);
  });

  test('an offer change creates a new offer version (the old row is replaced, valid_to set); unchanged values and the same withdrawn flag create none', async () => {
    const id = productOf(h, 'B');
    const res = await patch(supplierB, [{ productId: id, priceCents: 3700, prepFeeCents: 800, readyAt: READY.B, withdrawn: false }]);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.items[0].offer.version, 2);
    assert.equal(res.json.items[0].offer.priceCents, 3700);
    const offers = h.db.prepare('SELECT version, status, price_cents, valid_to FROM offers WHERE product_id = ? ORDER BY version').all(id);
    assert.deepEqual(offers.map((o) => [o.version, o.status, o.price_cents, o.valid_to !== null]), [[1, 'replaced', 3600, true], [2, 'active', 3700, false]]);
    const nothing = await patch(supplierB, [{ productId: id, priceCents: 3700, withdrawn: false }]);
    assert.equal(nothing.status, 200);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM offers WHERE product_id = ?', id), 2);

    const withdrawn = await patch(supplierB, [{ productId: id, withdrawn: true }]);
    assert.equal(withdrawn.json.items[0].offer.status, 'withdrawn');
    assert.equal(withdrawn.json.items[0].offer.version, 3);
    const back = await patch(supplierB, [{ productId: id, withdrawn: false }]);
    assert.equal(back.json.items[0].offer.status, 'active');
    assert.equal(back.json.items[0].offer.version, 4);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM offers WHERE product_id = ? AND status IN ('active','withdrawn')", id), 1);
  });
});

describe('RS-13 (offer-change half): supersession in the same transaction as the change', () => {
  let h;
  let cafe1;
  let cafe2;
  let supplierA;
  let supplierB;
  // A fresh database per case: every case changes offers, which would change the plans of the next one.
  beforeEach(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '3' } });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
    supplierA = await signIn(h, 'supplier-a');
    supplierB = await signIn(h, 'supplier-b');
  });
  afterEach(() => h.close());

  test('RS-13: a price change supersedes a proposed plan that uses the offer (PRICE_CHANGED) and queues its re-plan; plans of other offers are untouched', async () => {
    const flow = await plannedFor(h, cafe1, { approve: false });
    const res = await patch(supplierB, [{ productId: productOf(h, 'B'), priceCents: 3700 }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.superseded, [{ planVersionId: flow.plan.id, requestId: flow.requestId }]);
    assert.deepEqual({ ...planStatus(h, flow.plan.id) }, { status: 'superseded', supersede_reason: 'PRICE_CHANGED', non_executable_reason: null });
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(flow.requestId).reason, 'PRICE_CHANGED');
    const view = await cafe1.get(`/api/requests/${flow.requestId}`);
    assert.equal(view.json.rescueStatus.status, 'replanning');
    // the re-plan sees the new price: A 4000 + B (3700 + 800) = 8500
    h.clock.advance(61_000);
    const replan = await cafe1.post(`/api/requests/${flow.requestId}/plan`, {});
    assert.equal(replan.json.plan.body.totalCents, 8500);
    assert.equal(h.db.prepare('SELECT superseded_by FROM plan_versions WHERE id = ?').get(flow.plan.id).superseded_by, replan.json.plan.id);
  });

  test('RS-13: a ready-time change supersedes an approved plan with a reservation: reservation released with release rows, orders cancelled, operations voided locally, all in the one transaction', async () => {
    const flow = await reservedPlan(h, cafe1);
    const before = count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger');
    const res = await patch(supplierA, [{ productId: productOf(h, 'A'), readyAt: '2026-10-20T07:10:00.000Z' }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.superseded, [{ planVersionId: flow.plan.id, requestId: flow.requestId }]);
    assert.equal(planStatus(h, flow.plan.id).supersede_reason, 'READY_TIME_CHANGED');
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'released');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), before + 2, 'two release rows');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'release' AND ref_id = ?", flow.reservation.id), 2);
    assert.deepEqual(
      h.db.prepare('SELECT so.fulfilment_status, po.status, po.voided_locally FROM supplier_orders so JOIN payment_operations po ON po.supplier_order_id = so.id WHERE so.reservation_id = ? ORDER BY so.id').all(flow.reservation.id).map((r) => [r.fulfilment_status, r.status, r.voided_locally]),
      [['cancelled', 'voided', 1], ['cancelled', 'voided', 1]],
    );
    assertLedgerInvariant(h);
  });

  test('RS-13: a supplier that already confirmed keeps the plan: its own price change does not supersede, another supplier\'s change does and cancels the confirmed order too', async () => {
    h.clock.advance(61_000);
    const flow = await reservedPlan(h, cafe1);
    assert.equal((await supplierB.post(`/api/supplier/orders/${orderOf(flow, 'B').id}/confirm`, confirmBody('B'))).status, 200);
    const own = await patch(supplierB, [{ productId: productOf(h, 'B'), priceCents: 3800 }]);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.json.superseded, [], 'the commitment of B stands');
    assert.equal(planStatus(h, flow.plan.id).status, 'approved');

    const other = await patch(supplierA, [{ productId: productOf(h, 'A'), prepFeeCents: 1100 }]);
    assert.deepEqual(other.json.superseded.map((s) => s.planVersionId), [flow.plan.id]);
    assert.equal(planStatus(h, flow.plan.id).supersede_reason, 'PREP_FEE_CHANGED');
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE reservation_id = ? ORDER BY id').all(flow.reservation.id).map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
  });

  test('RS-13: a withdrawn offer supersedes (OFFER_WITHDRAWN); an on_hand decrease supersedes only plans whose quantity no longer fits (AVAILABILITY_DROPPED)', async () => {
    h.clock.advance(61_000);
    const wd = await plannedFor(h, cafe2, { approve: false, overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    assert.deepEqual(wd.plan.body.suppliers.map((s) => s.supplierCode), ['A']);
    const gone = await patch(supplierA, [{ productId: productOf(h, 'A'), withdrawn: true }]);
    assert.deepEqual(gone.json.superseded.map((s) => s.planVersionId), [wd.plan.id]);
    assert.equal(planStatus(h, wd.plan.id).supersede_reason, 'OFFER_WITHDRAWN');
    await patch(supplierA, [{ productId: productOf(h, 'A'), withdrawn: false }]);

    h.clock.advance(61_000);
    const drop = await plannedFor(h, cafe2, { approve: false, overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 6 }]);
    const fits = await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 1 }]);
    assert.deepEqual(fits.json.superseded, [], 'one bundle is still available for a one-bundle plan');
    assert.equal(planStatus(h, drop.plan.id).status, 'proposed');
    const none = await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 0 }]);
    assert.deepEqual(none.json.superseded.map((s) => s.planVersionId), [drop.plan.id]);
    assert.equal(planStatus(h, drop.plan.id).supersede_reason, 'AVAILABILITY_DROPPED');
    await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 1 }]);
  });

  test('RESERVED_STOCK: an on_hand below the reserved quantity is 409 with nothing changed (audited as denied); the supplier refuses the order instead', async () => {
    h.clock.advance(61_000);
    const flow = await reservedPlan(h, cafe1, { overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    const code = flow.orders[0].supplier.code;
    const supplier = code === 'A' ? supplierA : await signIn(h, `supplier-${code.toLowerCase()}`);
    const id = productOf(h, code);
    const before = h.db.prepare('SELECT on_hand, reserved, version FROM inventory WHERE product_id = ?').get(id);
    const res = await patch(supplier, [{ productId: id, onHand: 0, priceCents: 1 }]);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'RESERVED_STOCK');
    assert.deepEqual(res.json.error.details, { productId: id, reserved: 1 });
    assert.deepEqual({ ...h.db.prepare('SELECT on_hand, reserved, version FROM inventory WHERE product_id = ?').get(id) }, { ...before });
    assert.equal(h.db.prepare("SELECT price_cents FROM offers WHERE product_id = ? AND status = 'active'").get(id).price_cents !== 1, true, 'the offer part of the PATCH was rolled back too');
    assert.equal(planStatus(h, flow.plan.id).status, 'approved');
    assert.equal(deniedAudit(h, 'inventory.patch', 'RESERVED_STOCK'), 1);
  });

  test('RS-13: another customer\'s reservation never supersedes a plan: the second customer\'s approved plan stays approved (a quote) and no re-plan is queued', async () => {
    const mine = await plannedFor(h, cafe1); // approved
    const theirs = await plannedFor(h, cafe2); // approved, same stock
    const reserved = await cafe1.post(`/api/plans/${mine.plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': 'other-customer-key-00000001' } });
    assert.equal(reserved.status, 201, reserved.text);
    assert.equal(planStatus(h, theirs.plan.id).status, 'approved');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    // its owner finds out when reserving: OUT_OF_STOCK, not PLAN_SUPERSEDED
    const late = await cafe2.post(`/api/plans/${theirs.plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': 'other-customer-key-00000002' } });
    assert.equal(late.json.error.code, 'OUT_OF_STOCK');
  });
});
