// Reservation expiry API tests (task c3-reservations-supplier-admin). Case names start with the criterion id:
//   RS-15 (part)  the expiry pass: an `active` reservation past expires_at -> `expired` exactly once, one `expire` ledger row
//                 per item and the stock back, the plan non_executable (RESERVATION_EXPIRED), the void rule for the
//                 operations still `created` (voided locally); a second pass is a no-op; a `consumed` reservation is
//                 never touched; the request reads "Reservation expired - no money was taken; re-plan with current stock"
//   the void rule's provider port: an `authorized` operation gets a void queued through the port; a queued authorize
//                 call is cancelled with its operation voided locally; a started authorize call is left to the protocol
// The authorization-void half of RS-15 (a real provider void) belongs to the payment phases; the port is what they plug into.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { request as httpRequest } from 'node:http';
import { expireDueReservations } from '../../src/services/reservations.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const TTL_MS = 30 * 60 * 1000;
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

// A customer with an approved, reserved plan on A and B.
async function reservedPlan(h, client, key = 'expiry-key-0000000001') {
  h.clock.advance(61_000);
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json.request.id;
  await client.post(`/api/requests/${requestId}/confirm`, { fields: FIELDS });
  const plan = (await client.post(`/api/requests/${requestId}/plan`, {})).json.plan;
  const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  assert.equal(approved.status, 200, approved.text);
  const reserved = await client.post(`/api/plans/${plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
  assert.equal(reserved.status, 201, reserved.text);
  return { requestId, plan, reservation: reserved.json.reservation, orders: reserved.json.orders };
}

const reservedStock = (h) => h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;
const ledgerCount = (h, reason) => count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = ?', reason);

describe('RS-15 (part): the expiry pass releases an expired reservation exactly once', () => {
  let h;
  let cafe1;
  let flow;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    flow = await reservedPlan(h, cafe1);
  });
  after(() => h.close());

  test('RS-15 (part): before expires_at the pass changes nothing', async () => {
    assert.equal(flow.reservation.expiresAt, new Date(h.clock.now() + TTL_MS).toISOString());
    h.clock.advance(TTL_MS - 1);
    const pass = expireDueReservations(h.app.deps);
    assert.deepEqual(pass.expired, []);
    assert.equal(h.db.prepare('SELECT status FROM reservations').get().status, 'active');
    assert.equal(reservedStock(h), 2);
    assert.equal(ledgerCount(h, 'expire'), 0);
  });

  test('RS-15 (part): at expires_at the reservation becomes expired once: stock back, one expire ledger row per item, plan non_executable (RESERVATION_EXPIRED), orders cancelled, created operations voided locally', async () => {
    h.clock.advance(1);
    const pass = expireDueReservations(h.app.deps);
    assert.deepEqual(pass.expired.map((e) => [e.reservationId, e.planVersionId, e.requestId]), [[flow.reservation.id, flow.plan.id, flow.requestId]]);

    const reservation = h.db.prepare('SELECT status, closed_at FROM reservations WHERE id = ?').get(flow.reservation.id);
    assert.equal(reservation.status, 'expired');
    assert.equal(reservation.closed_at, new Date(h.clock.now()).toISOString());
    assert.equal(reservedStock(h), 0, 'inventory returns to its prior value');
    const rows = h.db.prepare("SELECT reason, delta_on_hand, delta_reserved, reserved_after, ref_type, ref_id FROM inventory_ledger WHERE reason = 'expire' ORDER BY id").all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { reason: 'expire', delta_on_hand: 0, delta_reserved: -1, reserved_after: 0, ref_type: 'reservation', ref_id: flow.reservation.id },
      { reason: 'expire', delta_on_hand: 0, delta_reserved: -1, reserved_after: 0, ref_type: 'reservation', ref_id: flow.reservation.id },
    ]);
    assert.equal(ledgerCount(h, 'release'), 0, 'expiry writes expire rows, not release rows');

    const plan = h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id);
    assert.deepEqual({ ...plan }, { status: 'non_executable', non_executable_reason: 'RESERVATION_EXPIRED' });
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
    const ops = h.db.prepare('SELECT status, voided_locally, cancel_reason, cancel_requested_at FROM payment_operations ORDER BY id').all();
    assert.deepEqual(ops.map((o) => [o.status, o.voided_locally, o.cancel_reason]), [['voided', 1, 'RESERVATION_EXPIRED'], ['voided', 1, 'RESERVATION_EXPIRED']]);
    assert.ok(ops.every((o) => o.cancel_requested_at === new Date(h.clock.now()).toISOString()));
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'reservation.expire' AND outcome = 'ok'"), 1);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'void_rule.apply'"), 1);
  });

  test('RS-15 (part): the request shows the expired reservation and the exact message; the customer can re-plan', async () => {
    const view = await cafe1.get(`/api/requests/${flow.requestId}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.reservation.status, 'expired');
    const status = view.json.rescueStatus;
    const text = JSON.stringify(status);
    assert.ok(text.includes('Reservation expired — no money was taken; re-plan with current stock'), text);
    assert.equal(status.underlying.plan, 'non_executable');
    assert.equal(status.underlying.reservation, 'expired');
    assert.deepEqual(status.underlying.payments.map((p) => p.status), ['voided', 'voided']);
    h.clock.advance(61_000);
    const replan = await cafe1.post(`/api/requests/${flow.requestId}/plan`, {});
    assert.equal(replan.status, 201, replan.text);
    assert.equal(replan.json.plan.body.totalCents, 8400, 'the stock is back: A+B again');
  });

  test('RS-15 (part): a second pass is a no-op: no ledger row, no audit row, same state', async () => {
    const before = { ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), reserved: reservedStock(h) };
    for (let i = 0; i < 2; i += 1) {
      const pass = expireDueReservations(h.app.deps);
      assert.deepEqual(pass.expired, []);
    }
    assert.deepEqual(
      { ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), reserved: reservedStock(h) },
      before,
    );
    assert.equal(ledgerCount(h, 'expire'), 2);
  });
});

describe('RS-15 (part): what the expiry pass must not touch', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-15 (part): a consumed reservation (execute claimed it) is never expired: the pass after the claim changes nothing', async () => {
    const flow = await reservedPlan(h, cafe1);
    h.db.prepare("UPDATE plan_versions SET status = 'executing', executor_id = 'test:1:abcd', lease_epoch = 1 WHERE id = ?").run(flow.plan.id);
    h.db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ?").run(flow.reservation.id);
    h.clock.advance(2 * TTL_MS);
    const before = { ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), reserved: reservedStock(h) };
    assert.deepEqual(expireDueReservations(h.app.deps).expired, []);
    assert.equal(h.db.prepare('SELECT status FROM reservations').get().status, 'consumed');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(flow.plan.id).status, 'executing');
    assert.deepEqual({ ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), reserved: reservedStock(h) }, before);
  });
});

describe('RS-15 (part): a supplier cannot confirm on a reservation past its expiry', () => {
  let h;
  let cafe1;
  let supplierA;
  let flow;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    supplierA = await signIn(h, 'supplier-a');
    flow = await reservedPlan(h, cafe1);
  });
  after(() => h.close());

  test('RS-15 (part): confirm after expires_at but before the pass is 409 RESERVATION_EXPIRED (audited as denied); after the pass the order is cancelled and confirm is INVALID_STATE', async () => {
    const order = flow.orders.find((o) => o.supplier.code === 'A');
    h.clock.advance(TTL_MS + 1000);
    const body = { lines: [{ offerId: 1, committedBundles: 1 }], committedReadyAt: '2026-10-20T07:00:00.000Z' };
    const late = await supplierA.post(`/api/supplier/orders/${order.id}/confirm`, body);
    assert.equal(late.status, 409, late.text);
    assert.equal(late.json.error.code, 'RESERVATION_EXPIRED');
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(order.id).fulfilment_status, 'awaiting_supplier');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.confirm' AND outcome = 'denied'"), 1);

    assert.equal(expireDueReservations(h.app.deps).expired.length, 1);
    const after = await supplierA.post(`/api/supplier/orders/${order.id}/confirm`, body);
    assert.equal(after.status, 409);
    assert.equal(after.json.error.code, 'INVALID_STATE');
    const listed = await supplierA.get('/api/supplier/orders');
    assert.equal(listed.json.orders[0].presentation, 'cancelled');
    assert.equal(listed.json.orders[0].canConfirm, false);
  });
});

describe('the void rule through the expiry pass: operations that already moved, and the provider port', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  const operations = () => h.db.prepare('SELECT po.id, po.supplier_order_id, po.status FROM payment_operations po ORDER BY po.id').all();
  const addCall = (operationId, soId, kind, { started = false, status = 'intent' } = {}) =>
    h.db
      .prepare('INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, started_at, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
      .run(operationId, kind, `so:${soId}:${kind}:1`, status, started ? '2026-10-20T06:10:00.000Z' : null, '2026-10-20T06:00:30.000Z');

  test('an authorized operation gets a void queued through the provider port (so:<id>:void:1) and keeps its status until the provider answers; a queued authorize call is cancelled and its operation voided locally', async () => {
    const flow = await reservedPlan(h, cafe1);
    const [opA, opB] = operations();
    h.db.prepare("UPDATE payment_operations SET status = 'authorized', provider_authorization_id = 'FAKE-AUTH-A', authorization_expires_at = '2026-11-18T06:00:00.000Z' WHERE id = ?").run(opA.id);
    h.db.prepare("UPDATE payment_operations SET status = 'approved' WHERE id = ?").run(opB.id);
    addCall(opB.id, opB.supplier_order_id, 'authorize');

    h.clock.advance(TTL_MS + 1);
    assert.equal(expireDueReservations(h.app.deps).expired.length, 1);

    const port = h.app.deps.voidRule.provider;
    assert.equal(port.name, 'noop');
    assert.deepEqual(port.queued.map((i) => [i.operationId, i.operationKey, i.kind, i.reason]), [[opA.id, `so:${opA.supplier_order_id}:void:1`, 'void', 'RESERVATION_EXPIRED']]);
    const after = h.db.prepare('SELECT id, status, voided_locally, cancel_requested_at, cancel_reason FROM payment_operations ORDER BY id').all();
    assert.deepEqual(after.map((o) => [o.status, o.voided_locally]), [['authorized', 0], ['voided', 1]]);
    assert.ok(after.every((o) => o.cancel_requested_at !== null && o.cancel_reason === 'RESERVATION_EXPIRED'));
    assert.equal(h.db.prepare("SELECT status FROM provider_calls WHERE kind = 'authorize'").get().status, 'cancelled');
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(flow.plan.id).status, 'non_executable');
  });

  test('an approved operation whose authorize call has started, and a pending authorization, are only marked: they resolve through the provider call protocol', async () => {
    h.db.prepare('DELETE FROM provider_calls').run();
    h.app.deps.voidRule.provider.queued.length = 0;
    const flow = await reservedPlan(h, cafe1, 'expiry-key-0000000002');
    const rows = h.db.prepare("SELECT po.id, po.supplier_order_id FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ? ORDER BY po.id").all(flow.plan.id);
    h.db.prepare("UPDATE payment_operations SET status = 'approved' WHERE id = ?").run(rows[0].id);
    addCall(rows[0].id, rows[0].supplier_order_id, 'authorize', { started: true });
    h.db.prepare("UPDATE payment_operations SET status = 'authorization_pending', pending_since = '2026-10-20T06:20:00.000Z' WHERE id = ?").run(rows[1].id);

    h.clock.advance(TTL_MS + 1);
    assert.equal(expireDueReservations(h.app.deps).expired.length, 1);
    const after = h.db.prepare('SELECT status, voided_locally, cancel_requested_at FROM payment_operations WHERE id IN (?, ?) ORDER BY id').all(rows[0].id, rows[1].id);
    assert.deepEqual(after.map((o) => [o.status, o.voided_locally, o.cancel_requested_at !== null]), [['approved', 0, true], ['authorization_pending', 0, true]]);
    assert.equal(h.db.prepare("SELECT status FROM provider_calls WHERE kind = 'authorize'").get().status, 'intent', 'the started call is not touched');
    assert.deepEqual(h.app.deps.voidRule.provider.queued, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// f1-supersession-refusal-expiry: RS-15 with provider authorizations, through the reconciler, and after the real execute claim.

const ALL_READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });

function postTo(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A reserved plan whose orders `confirm`ed by their suppliers and `authorize`d at the fake PayPal page; real void port installed.
async function authorizedPlan(h, { confirm = [], authorize = ['A', 'B'] } = {}) {
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  const cafe1 = await signIn(h, 'cafe1');
  const flow = await reservedPlan(h, cafe1, `expiry-auth-${h.clock.now()}-0001`);
  const orders = Object.fromEntries(flow.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of confirm) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    const body = { lines: [{ offerId: code === 'A' ? 1 : 2, committedBundles: 1 }], committedReadyAt: ALL_READY[code] };
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, body)).status, 200);
  }
  for (const code of authorize) {
    const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
  }
  return { ...flow, cafe1, orderIds: orders };
}

const opOfOrder = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const fakeCallsOf = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const stockOf = (h) => h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all().map((r) => ({ ...r }));
const EXPIRED_TEXT = 'Reservation expired — no money was taken; re-plan with current stock';

describe('RS-15: expiry before the execute claim with authorizations outstanding (reconciler step 4)', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
  });
  after(() => h.close());

  test('RS-15: the tick releases the reservation once, voids every authorization once, the plan is non_executable (RESERVATION_EXPIRED) and the request shows the exact message with the next step REPLAN, not a queued re-plan', async () => {
    const stockBefore = stockOf(h);
    const flow = await authorizedPlan(h);
    assert.deepEqual([opOfOrder(h, flow.orderIds.A).status, opOfOrder(h, flow.orderIds.B).status], ['authorized', 'authorized']);
    assert.notDeepEqual(stockOf(h), stockBefore, 'stock is reserved');

    h.clock.advance(TTL_MS + 1);
    const rec = createReconciler(h.app.deps);
    await rec.tick();

    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'expired');
    assert.deepEqual(stockOf(h), stockBefore, 'inventory returns to its prior value');
    assert.equal(ledgerCount(h, 'expire'), 2, 'one expire row per item');
    assert.deepEqual({ ...h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id) }, { status: 'non_executable', non_executable_reason: 'RESERVATION_EXPIRED' });
    for (const code of ['A', 'B']) {
      const op = opOfOrder(h, flow.orderIds[code]);
      assert.equal(op.status, 'voided');
      assert.equal(op.cancel_reason, 'RESERVATION_EXPIRED');
      const voids = h.db.prepare("SELECT operation_key, status FROM provider_calls WHERE kind = 'void' AND payment_operation_id = ?").all(op.id);
      assert.deepEqual(voids.map((v) => ({ ...v })), [{ operation_key: `so:${flow.orderIds[code]}:void:1`, status: 'succeeded' }]);
    }
    assert.equal(fakeCallsOf(h, 'void').length, 2, 'one provider void per authorization');
    assert.equal(fakeCallsOf(h, 'capture').length, 0, 'no money was taken');
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0, 'expiry waits for the customer: no queued re-plan');

    const view = (await flow.cafe1.get(`/api/requests/${flow.requestId}`)).json;
    assert.deepEqual([view.rescueStatus.status, view.rescueStatus.rule, view.rescueStatus.nextStep.code], ['cancelled', '6', 'REPLAN']);
    assert.equal(view.rescueStatus.message, EXPIRED_TEXT);
    assert.equal(view.reservation.status, 'expired');
  });

  test('RS-15: a second tick is a no-op: no ledger row, no provider call, no audit row', async () => {
    const before = { ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), calls: count(h, 'SELECT COUNT(*) AS n FROM fake_paypal_calls'), stock: stockOf(h) };
    const rec = createReconciler(h.app.deps);
    for (let i = 0; i < 2; i += 1) await rec.tick();
    assert.deepEqual(
      { ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), calls: count(h, 'SELECT COUNT(*) AS n FROM fake_paypal_calls'), stock: stockOf(h) },
      before,
    );
  });

  test('RS-15: two reconcilers racing release it exactly once (the pass is a compare-and-set on status and expires_at)', async () => {
    const h2 = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    try {
      const flow = await authorizedPlan(h2, { authorize: [] });
      h2.clock.advance(TTL_MS + 1);
      await Promise.all([createReconciler(h2.app.deps).tick(), createReconciler(h2.app.deps).tick()]);
      assert.equal(count(h2, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'expire'"), 2);
      assert.equal(count(h2, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'reservation.expire' AND outcome = 'ok'"), 1);
      assert.equal(h2.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'expired');
      assert.equal(count(h2, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    } finally {
      await h2.close();
    }
  });
});

describe('RS-15: an expiry pass after the real execute claim changes nothing', () => {
  test('RS-15: claimed (202) and the time runs past expires_at before the first capture: the reservation stays consumed, the plan executing, stock, ledger and provider calls are unchanged', async () => {
    const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    try {
      const flow = await authorizedPlan(h, { confirm: ['A', 'B'] });
      h.app.deps.saga.autoRun = false;
      const claim = await flow.cafe1.post(`/api/plans/${flow.plan.id}/execute`, {});
      assert.equal(claim.status, 202, claim.text);
      const snapshot = () => JSON.stringify({
        reservation: h.db.prepare('SELECT status, closed_at FROM reservations').all(),
        plan: h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id),
        stock: stockOf(h),
        ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
        ops: h.db.prepare('SELECT status, cancel_requested_at FROM payment_operations ORDER BY id').all(),
        orders: h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all(),
        calls: count(h, 'SELECT COUNT(*) AS n FROM fake_paypal_calls'),
        audit: count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('reservation.expire','void_rule.apply')"),
      });
      const before = snapshot();
      assert.equal(h.db.prepare('SELECT status FROM reservations').get().status, 'consumed');
      h.clock.advance(3 * TTL_MS);
      assert.deepEqual(expireDueReservations(h.app.deps).expired, []);
      assert.equal(snapshot(), before);
      assert.equal(ledgerCount(h, 'expire'), 0);
      // the request does not show the expiry message either
      const again = await signIn(h, 'cafe1'); // the session idled out while the clock ran
      const view = (await again.get(`/api/requests/${flow.requestId}`)).json;
      assert.ok(!JSON.stringify(view.rescueStatus).includes('Reservation expired'), JSON.stringify(view.rescueStatus));
      assert.equal(view.rescueStatus.underlying.plan, 'executing');
      assert.equal(view.rescueStatus.underlying.reservation, 'consumed');
    } finally {
      await h.close();
    }
  });

  test('RS-15: past expires_at but before the pass, the execute claim is refused 409 RESERVATION_EXPIRED, runs the expiry inline (once), voids the authorizations and captures nothing', async () => {
    const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    try {
      const flow = await authorizedPlan(h, { confirm: ['A', 'B'] });
      h.app.deps.saga.autoRun = false;
      h.clock.advance(TTL_MS + 1);
      const claim = await flow.cafe1.post(`/api/plans/${flow.plan.id}/execute`, {});
      assert.equal(claim.status, 409, claim.text);
      assert.equal(claim.json.error.code, 'RESERVATION_EXPIRED');
      assert.equal(fakeCallsOf(h, 'capture').length, 0);
      assert.deepEqual({ ...h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id) }, { status: 'non_executable', non_executable_reason: 'RESERVATION_EXPIRED' });
      assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'expired');
      assert.equal(ledgerCount(h, 'expire'), 2);
      assert.deepEqual([opOfOrder(h, flow.orderIds.A).status, opOfOrder(h, flow.orderIds.B).status], ['voided', 'voided']);
      assert.equal(fakeCallsOf(h, 'void').length, 2);
      // the pass that follows finds nothing: exactly once
      assert.deepEqual(expireDueReservations(h.app.deps).expired, []);
      assert.equal(ledgerCount(h, 'expire'), 2);
    } finally {
      await h.close();
    }
  });
});
