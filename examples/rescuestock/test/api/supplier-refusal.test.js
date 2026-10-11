// Supplier refusal API tests (task f1-supersession-refusal-expiry; spec: Supplier routes > refuse, Void rule, Supersession > Replan,
// derivation rows 4, 4a and 12). Case names start with the criterion id:
//   RS-17 [D]  a refusal before the execute claim: the order is `refused` (reason kept), every outstanding authorization of the plan
//              ends voided (one void call each), the reservation is released, the plan is non_executable (SUPPLIER_REFUSED), the
//              rescue status reads `cancelling` while a void is outstanding, the customer sees the refusal reason with the next step
//              "Review the new plan", and the new plan version leaves the refusing supplier out; after the claim: 409 ORDER_EXECUTED
//   RS-32 (refusal half)  the admin supplier_refusal fault runs the same service
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler, drainReplanQueue } from '../../src/services/reconciler.js';
import { ensureAdmin } from '../../src/services/users.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

// realVoids: the real void port (queued voids are sent after every request); false: the no-op recorder, so a void stays outstanding.
async function start({ realVoids = true, env = {} } = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_ADMIN_PASSWORD: ADMIN_PASSWORD, ...env } });
  harnesses.push(h);
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  if (realVoids) h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
}

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, username === 'admin' ? ADMIN_PASSWORD : DEMO_PASSWORD);
  return client;
}

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

const confirmBody = (code) => ({ lines: [{ offerId: code === 'A' ? 1 : 2, committedBundles: 1 }], committedReadyAt: READY[code] });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const planRow = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const opOf = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const viewOf = async (w) => (await w.cafe1.get(`/api/requests/${w.requestId}`)).json;

async function world(h, { confirm = [], authorize = [] } = {}) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const w = { cafe1, requestId, planId: plan.id, plan, orders: Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id])), reservationId: reserved.json.reservation.id };
  for (const code of confirm) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${w.orders[code]}/confirm`, confirmBody(code))).status, 200);
  }
  for (const code of authorize) {
    const created = await cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
  }
  return w;
}

function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand);
    assert.equal(sum.b, inv.reserved);
  }
}

describe('RS-17 [D]: a refusal before the execute claim, authorizations outstanding', () => {
  test('RS-17: the refusal is audited, the order refused with its reason, the other order cancelled, both authorizations voided once, the reservation released, the plan non_executable (SUPPLIER_REFUSED)', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A'], authorize: ['A', 'B'] });
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['authorized', 'authorized']);
    const supplierB = await signIn(h, 'supplier-b');
    const res = await supplierB.post(`/api/supplier/orders/${w.orders.B}/refuse`, { reason: 'Out of cups today' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.json.order.fulfilmentStatus, res.json.order.refusalReason, res.json.order.presentation], ['refused', 'Out of cups today', 'refused']);

    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'refused']);
    const plan = planRow(h, w.planId);
    assert.deepEqual([plan.status, plan.non_executable_reason, JSON.parse(plan.reason_detail_json)], ['non_executable', 'SUPPLIER_REFUSED', { supplierCode: 'B', refusal: 'Out of cups today' }]);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'release' AND ref_id = ?", w.reservationId), 2);
    assert.equal(count(h, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    for (const code of ['A', 'B']) {
      const voids = h.db.prepare("SELECT operation_key, status FROM provider_calls WHERE kind = 'void' AND payment_operation_id = ?").all(opOf(h, w.orders[code]).id);
      assert.deepEqual(voids.map((v) => ({ ...v })), [{ operation_key: `so:${w.orders[code]}:void:1`, status: 'succeeded' }]);
      assert.equal(opOf(h, w.orders[code]).status, 'voided');
      assert.equal(opOf(h, w.orders[code]).cancel_reason, 'SUPPLIER_REFUSED');
    }
    assert.equal(fakeCalls(h, 'void').length, 2);
    assert.equal(fakeCalls(h, 'capture').length, 0, 'no money was taken');
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(w.requestId).reason, 'SUPPLIER_REFUSED');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.refuse' AND outcome = 'ok'"), 1);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'void_rule.apply'"), 1);
    assertLedgerInvariant(h);
  });

  test('RS-17: while a void is outstanding the request reads cancelling with the refused order (reason and presentation) in cancellingOrders; after the void it reads replanning; the drain gives the new plan without the refusing supplier and the exact message', async () => {
    const h = await start({ realVoids: false });
    const w = await world(h, { authorize: ['A', 'B'] });
    const supplierA = await signIn(h, 'supplier-a');
    const refused = await supplierA.post(`/api/supplier/orders/${w.orders.A}/refuse`, { reason: 'Out of lids' });
    assert.equal(refused.status, 200, refused.text);
    // the no-op port only records the queued voids: both authorizations stay authorized with a cancellation requested
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['authorized', 'authorized']);
    assert.ok(opOf(h, w.orders.A).cancel_requested_at && opOf(h, w.orders.B).cancel_requested_at);

    const cancelling = await viewOf(w);
    assert.deepEqual([cancelling.rescueStatus.status, cancelling.rescueStatus.rule, cancelling.rescueStatus.nextStep.code], ['cancelling', '4', 'WAIT']);
    // the closed version is still the newest, so its orders are the current orders; the refused one carries the reason
    const shown = cancelling.orders.find((o) => o.id === w.orders.A);
    assert.deepEqual([shown.fulfilmentStatus, shown.refusalReason, shown.presentation, shown.payment.cancelRequested, shown.payment.status], ['refused', 'Out of lids', 'refused', true, 'authorized']);
    assert.deepEqual(cancelling.cancellingOrders, []);
    // the queue entry is there, and row 4 (cancelling) comes before row 4a (replanning)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 1);

    // the drain stores the new version while the voids are outstanding: the old orders move to cancellingOrders
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 1, failed: 0, dropped: 0 });
    const during = await viewOf(w);
    assert.deepEqual([during.rescueStatus.status, during.rescueStatus.rule], ['cancelling', '4']);
    assert.deepEqual(during.orders, []);
    assert.deepEqual(during.cancellingOrders.map((o) => [o.id, o.fulfilmentStatus, o.refusalReason, o.presentation, o.payment.cancelRequested]), [
      [w.orders.A, 'refused', 'Out of lids', 'refused', true],
      [w.orders.B, 'cancelled', null, 'cancelled', true],
    ]);

    // the voids go out (the real port): the request leaves "cancelling" for the new plan
    h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
    for (const code of ['A', 'B']) {
      h.db.prepare("INSERT OR IGNORE INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (?, 'void', 1, ?, 'intent', ?)").run(opOf(h, w.orders[code]).id, `so:${w.orders[code]}:void:1`, '2026-10-20T06:01:00.000Z');
    }
    await createReconciler(h.app.deps, { saga: h.app.deps.saga }).tick();
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['voided', 'voided']);
    assert.equal(fakeCalls(h, 'void').length, 2);

    const view = await viewOf(w);
    assert.deepEqual(view.cancellingOrders, []);
    const current = view.plans.find((p) => p.id === view.currentPlanId);
    assert.deepEqual([current.version, current.status], [2, 'proposed']);
    assert.deepEqual(current.body.suppliers.map((s) => s.supplierCode), ['B', 'E'], 'A refused: B and E');
    assert.notEqual(current.planHash, w.plan.planHash);
    assert.deepEqual([view.rescueStatus.status, view.rescueStatus.rule, view.rescueStatus.nextStep.code, view.rescueStatus.nextStep.text], ['plan_found', '12', 'REVIEW_NEW_PLAN', 'Review the new plan']);
    assert.equal(view.rescueStatus.message, 'Supplier A refused the order: Out of lids. No money was taken.');
    assert.deepEqual(JSON.parse(h.db.prepare('SELECT excluded_suppliers_json AS j FROM planning_runs WHERE request_id = ? ORDER BY id DESC').get(w.requestId).j), ['A']);
  });

  test('RS-17: the exclusion outlasts the next re-plans: a later plan call and a later supersession still leave the refusing supplier out', async () => {
    const h = await start();
    const w = await world(h);
    const supplierB = await signIn(h, 'supplier-b');
    assert.equal((await supplierB.post(`/api/supplier/orders/${w.orders.B}/refuse`, { reason: 'closed' })).status, 200);
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    h.clock.advance(61_000);
    const again = await w.cafe1.post(`/api/requests/${w.requestId}/plan`, {});
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.json.plan.body.suppliers.map((s) => s.supplierCode), ['A', 'E']);
    assert.equal(again.json.plan.body.totalCents, 9500);
    const supplierA = await signIn(h, 'supplier-a');
    const productA = h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = 'A' AND p.kind = 'bundle'").get().id;
    const changed = await supplierA.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: productA, priceCents: 3100 }] } });
    assert.equal(changed.json.superseded.length, 1);
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    const view = await viewOf(w);
    const current = view.plans.find((p) => p.id === view.currentPlanId);
    assert.ok(!current.body.suppliers.some((s) => s.supplierCode === 'B'));
    assert.equal(view.rescueStatus.message, 'Prices changed: review plan v4');
  });
});

describe('RS-17: who may refuse, and when', () => {
  test('RS-17: another supplier\'s order is 404 (nothing changes); a repeat is 200 and writes nothing; a confirmed order can still be refused before the claim', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A'] });
    const supplierB = await signIn(h, 'supplier-b');
    const supplierA = await signIn(h, 'supplier-a');
    const foreign = await supplierB.post(`/api/supplier/orders/${w.orders.A}/refuse`, { reason: 'not mine' });
    assert.equal(foreign.status, 404);
    assert.equal(planRow(h, w.planId).status, 'approved');
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(w.orders.A).fulfilment_status, 'confirmed');

    const first = await supplierA.post(`/api/supplier/orders/${w.orders.A}/refuse`, { reason: 'changed my mind' });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.order.fulfilmentStatus, 'refused');
    const before = { audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), queue: count(h, 'SELECT COUNT(*) AS n FROM replan_queue') };
    const repeat = await supplierA.post(`/api/supplier/orders/${w.orders.A}/refuse`, { reason: 'changed my mind' });
    assert.equal(repeat.status, 200);
    assert.deepEqual({ audit: count(h, 'SELECT COUNT(*) AS n FROM audit_events'), ledger: count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), queue: count(h, 'SELECT COUNT(*) AS n FROM replan_queue') }, before);
    // the sibling order of the same plan can no longer be refused: the plan is closed (INVALID_STATE, audited as denied)
    const late = await supplierB.post(`/api/supplier/orders/${w.orders.B}/refuse`, { reason: 'too' });
    assert.equal(late.status, 409);
    assert.equal(late.json.error.code, 'INVALID_STATE');
  });

  test('RS-17: after the execute claim the refusal is 409 ORDER_EXECUTED (audited as denied) and plan, reservation, orders and operations stay as they are', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A', 'B'], authorize: ['A', 'B'] });
    h.app.deps.saga.autoRun = false;
    const claim = await w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
    assert.equal(claim.status, 202, claim.text);
    const snapshot = () => JSON.stringify([
      planRow(h, w.planId).status,
      h.db.prepare('SELECT status FROM reservations').all(),
      h.db.prepare('SELECT fulfilment_status, refusal_reason FROM supplier_orders ORDER BY id').all(),
      h.db.prepare('SELECT status, cancel_requested_at FROM payment_operations ORDER BY id').all(),
      count(h, 'SELECT COUNT(*) AS n FROM replan_queue'),
      count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'),
    ]);
    const before = snapshot();
    for (const code of ['A', 'B']) {
      const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
      const res = await supplier.post(`/api/supplier/orders/${w.orders[code]}/refuse`, { reason: 'too late' });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.error.code, 'ORDER_EXECUTED');
    }
    assert.equal(snapshot(), before);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.refuse' AND outcome = 'denied' AND detail_json LIKE '%ORDER_EXECUTED%'"), 2);
    assert.equal(fakeCalls(h, 'void').length, 0);
  });

  test('RS-17: the refusal reason is validated at the boundary (1-300 characters, text only) before anything is read', async () => {
    const h = await start();
    const w = await world(h);
    const supplierB = await signIn(h, 'supplier-b');
    for (const reason of ['', '   ', 'x'.repeat(301), 7, null, 'bad\u0007text']) {
      const res = await supplierB.post(`/api/supplier/orders/${w.orders.B}/refuse`, { reason });
      assert.equal(res.status, 422, JSON.stringify(reason)?.slice(0, 20));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
    const ok = await supplierB.post(`/api/supplier/orders/${w.orders.B}/refuse`, { reason: 'x'.repeat(300) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(planRow(h, w.planId).non_executable_reason, 'SUPPLIER_REFUSED');
  });
});

describe('RS-32 (refusal half): the admin supplier_refusal fault runs the same service', () => {
  test('RS-32: refuses every open order of the supplier like the supplier\'s own route: refused with the reason, void rule, queued re-plan without that supplier', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A', 'B'] });
    const admin = await signIn(h, 'admin');
    const res = await admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'B', reason: 'Closed for the day' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.applied, { kind: 'supplier_refusal', supplierCode: 'B', supplierOrderIds: [w.orders.B] });
    const order = h.db.prepare('SELECT fulfilment_status, refusal_reason FROM supplier_orders WHERE id = ?').get(w.orders.B);
    assert.deepEqual({ ...order }, { fulfilment_status: 'refused', refusal_reason: 'Closed for the day' });
    const plan = planRow(h, w.planId);
    assert.deepEqual([plan.status, plan.non_executable_reason], ['non_executable', 'SUPPLIER_REFUSED']);
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['voided', 'voided']);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(w.requestId).reason, 'SUPPLIER_REFUSED');
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    const view = await viewOf(w);
    assert.equal(view.rescueStatus.message, 'Supplier B refused the order: Closed for the day. No money was taken.');
    assert.deepEqual(view.plans.find((p) => p.id === view.currentPlanId).body.suppliers.map((s) => s.supplierCode), ['A', 'E']);
    assertLedgerInvariant(h);
  });

  test('RS-32: after the claim the fault changes nothing (the order is not open any more)', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A', 'B'], authorize: ['A', 'B'] });
    h.app.deps.saga.autoRun = false;
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/execute`, {})).status, 202);
    const admin = await signIn(h, 'admin');
    const res = await admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'B', reason: 'late' });
    assert.equal(res.status, 200, res.text);
    assert.equal(planRow(h, w.planId).status, 'executing');
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(w.orders.B).fulfilment_status, 'confirmed');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
  });
});
