// Supersession API tests (task f1-supersession-refusal-expiry; spec: Background Processing > Supersession, Void rule, Supplier
// routes PATCH /api/supplier/inventory, Rescue status derivation rows 4a and 12). Case names start with the criterion id:
//   RS-13  a price (or prep fee, ready time) change supersedes the approved plan version while the affected supplier has not
//          confirmed and the plan is not executing: every authorization of the old version ends voided with one void call each,
//          the reservation is released (one ledger row per item), the supplier orders are cancelled, reserve and execute on the
//          old version are 409 PLAN_SUPERSEDED, the re-plan stores a recalculated proposed version and the request reads
//          "Prices changed: review plan vN"; a change after that supplier confirmed, or after the execute claim, supersedes nothing;
//          other customers' reservations never supersede a plan
//   RS-32  (supersession half) the admin stock_depletion fault supersedes through the same service, under the void rule
//   a withdrawal or an on_hand drop reads "Review the new plan"
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { drainReplanQueue } from '../../src/services/reconciler.js';
import { createVoidRule } from '../../src/services/void-rule.js';
import { ensureAdmin } from '../../src/services/users.js';

const DAY = '2026-10-20';
const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '3', RS_ADMIN_PASSWORD: ADMIN_PASSWORD, ...env } });
  harnesses.push(h);
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
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
const productOf = (h, code) =>
  h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = ? AND p.kind = 'bundle'").get(code).id;
const patch = (client, items) => client.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items } });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const planRow = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const opOf = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const statusOf = async (w) => (await w.cafe1.get(`/api/requests/${w.requestId}`)).json;

// A request with an approved plan (A + B). `reserve` reserves it; `authorize` creates and approves the PayPal orders; `confirm`
// lets suppliers confirm their order first.
async function world(h, { reserveIt = true, authorize = [], confirm = [], username = 'cafe1' } = {}) {
  const cafe1 = await signIn(h, username);
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const w = { cafe1, requestId, planId: plan.id, plan, orders: {}, reservationId: null };
  if (!reserveIt) return w;
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  w.orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  w.reservationId = reserved.json.reservation.id;
  for (const code of confirm) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${w.orders[code]}/confirm`, confirmBody(code))).status, 200);
  }
  for (const code of authorize) {
    const created = await cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    const ret = await cafe1.get(target.pathname + target.search);
    assert.equal(ret.status, 303, ret.text);
  }
  return w;
}

function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `ledger reserved of product ${inv.product_id}`);
  }
}

describe('RS-13: a price change supersedes the approved, reserved and authorized plan version', () => {
  test('RS-13: voids one per authorization, reservation released with one ledger row per item, orders cancelled, 409 PLAN_SUPERSEDED on reserve and execute, then a recalculated version and the exact message', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A', 'B'] });
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['authorized', 'authorized']);
    const ledgerBefore = count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger');

    const supplierB = await signIn(h, 'supplier-b');
    const res = await patch(supplierB, [{ productId: productOf(h, 'B'), priceCents: 3700 }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.superseded, [{ planVersionId: w.planId, requestId: w.requestId }]);

    const old = planRow(h, w.planId);
    assert.deepEqual([old.status, old.supersede_reason], ['superseded', 'PRICE_CHANGED']);
    // every authorization of the old version ends voided: one void call each, key so:<id>:void:1
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['voided', 'voided']);
    for (const code of ['A', 'B']) {
      const voids = h.db.prepare("SELECT operation_key, status FROM provider_calls WHERE kind = 'void' AND payment_operation_id = ?").all(opOf(h, w.orders[code]).id);
      assert.deepEqual(voids.map((v) => ({ ...v })), [{ operation_key: `so:${w.orders[code]}:void:1`, status: 'succeeded' }]);
    }
    assert.equal(fakeCalls(h, 'void').length, 2);
    // the reservation is released, one release row per item, stock back
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'release' AND ref_id = ?", w.reservationId), 2);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM inventory_ledger'), ledgerBefore + 2);
    assert.equal(count(h, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
    assertLedgerInvariant(h);

    // reserve and execute on the old version
    const reserveOld = await reserve(w.cafe1, w.planId, idempotencyKey('after-supersede-1'));
    assert.equal(reserveOld.status, 409);
    assert.equal(reserveOld.json.error.code, 'PLAN_SUPERSEDED');
    const executeOld = await w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
    assert.equal(executeOld.status, 409);
    assert.equal(executeOld.json.error.code, 'PLAN_SUPERSEDED');
    assert.equal(fakeCalls(h, 'capture').length, 0);

    // while the re-plan is queued the request waits; the voids are done, so it is not "cancelling"
    const waiting = (await statusOf(w)).rescueStatus;
    assert.deepEqual([waiting.status, waiting.rule, waiting.nextStep.code], ['replanning', '4a', 'WAIT']);

    // the drain stores the new version on the new price (A 4000 + B 3700 + 800 = 8500), points the old one at it
    assert.deepEqual(drainReplanQueue(h.app.deps), { drained: 1, failed: 0, dropped: 0 });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    const view = await statusOf(w);
    const current = view.plans.find((p) => p.id === view.currentPlanId);
    assert.equal(current.status, 'proposed');
    assert.equal(current.version, 2);
    assert.equal(current.body.totalCents, 8500);
    assert.notEqual(current.planHash, w.plan.planHash);
    assert.equal(planRow(h, w.planId).superseded_by, current.id);
    assert.deepEqual([view.rescueStatus.status, view.rescueStatus.rule, view.rescueStatus.nextStep.code], ['plan_found', '12', 'REVIEW_NEW_PLAN']);
    assert.equal(view.rescueStatus.message, 'Prices changed: review plan v2');
    assert.equal(view.rescueStatus.nextStep.text, 'Review the new plan');

    // the new version is approved and reserved: the stock returned by the release is available again
    const approved = await w.cafe1.post(`/api/plans/${current.id}/approve`, { expectedTotalCents: current.body.totalCents, planHash: current.planHash });
    assert.equal(approved.status, 200, approved.text);
    const reservedAgain = await reserve(w.cafe1, current.id, idempotencyKey('after-supersede-2'));
    assert.equal(reservedAgain.status, 201, reservedAgain.text);
  });

  test('RS-13: a prep fee and a ready-time change read "Prices changed" too; the fee change recalculates the total', async () => {
    const h = await start();
    const w = await world(h, { reserveIt: false });
    const supplierA = await signIn(h, 'supplier-a');
    const fee = await patch(supplierA, [{ productId: productOf(h, 'A'), prepFeeCents: 1100 }]);
    assert.equal(planRow(h, w.planId).supersede_reason, 'PREP_FEE_CHANGED');
    assert.deepEqual(fee.json.superseded.map((s) => s.planVersionId), [w.planId]);
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    let view = await statusOf(w);
    assert.equal(view.rescueStatus.message, 'Prices changed: review plan v2');
    assert.equal(view.plans.find((p) => p.id === view.currentPlanId).body.totalCents, 8500);

    const ready = await patch(supplierA, [{ productId: productOf(h, 'A'), readyAt: '2026-10-20T07:10:00.000Z' }]);
    assert.equal(ready.status, 200, ready.text);
    assert.equal(h.db.prepare("SELECT supersede_reason FROM plan_versions WHERE request_id = ? AND version = 2").get(w.requestId).supersede_reason, 'READY_TIME_CHANGED');
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    view = await statusOf(w);
    assert.equal(view.rescueStatus.message, 'Prices changed: review plan v3');
  });
});

describe('RS-13: where supersession does not apply', () => {
  test('RS-13: after the affected supplier confirmed, its price change supersedes nothing (asserted); another supplier\'s change still does', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['B'] });
    const supplierB = await signIn(h, 'supplier-b');
    const own = await patch(supplierB, [{ productId: productOf(h, 'B'), priceCents: 3800 }]);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.json.superseded, []);
    assert.equal(planRow(h, w.planId).status, 'approved');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'active');
    // the offer row is new, the committed order stands
    assert.equal(h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE id = ?').get(w.orders.B).fulfilment_status, 'confirmed');

    const supplierA = await signIn(h, 'supplier-a');
    const other = await patch(supplierA, [{ productId: productOf(h, 'A'), priceCents: 4100 }]);
    assert.deepEqual(other.json.superseded.map((s) => s.planVersionId), [w.planId]);
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
  });

  test('RS-13: after the execute claim a price, fee, ready-time or withdrawal change (and the admin depletion fault) supersedes nothing: the plan stays executing and its reservation consumed', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A', 'B'], authorize: ['A', 'B'] });
    h.app.deps.saga.autoRun = false;
    const claim = await w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
    assert.equal(claim.status, 202, claim.text);
    assert.equal(planRow(h, w.planId).status, 'executing');

    for (const [code, change] of [['A', { priceCents: 4500 }], ['A', { prepFeeCents: 1500 }], ['B', { readyAt: '2026-10-20T07:40:00.000Z' }], ['B', { withdrawn: true }]]) {
      const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
      const res = await patch(supplier, [{ productId: productOf(h, code), ...change }]);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.superseded, [], JSON.stringify(change));
    }
    assert.equal(planRow(h, w.planId).status, 'executing');
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'consumed');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    assert.equal(fakeCalls(h, 'void').length, 0);
    // the admin depletion fault takes the same selection
    const admin = await signIn(h, 'admin');
    const fault = await admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'A' });
    assert.equal(fault.status, 200, fault.text);
    assert.deepEqual(fault.json.superseded, []);
    assert.equal(planRow(h, w.planId).status, 'executing');
  });

  test('RS-13: a version that is executing is never selected, even if the changed supplier\'s order were not confirmed (forced state: the selection itself says "not executing")', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A', 'B'], authorize: ['A', 'B'] });
    h.app.deps.saga.autoRun = false;
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/execute`, {})).status, 202);
    h.db.prepare("UPDATE supplier_orders SET fulfilment_status = 'awaiting_supplier' WHERE id = ?").run(w.orders.B);
    const supplierB = await signIn(h, 'supplier-b');
    const res = await patch(supplierB, [{ productId: productOf(h, 'B'), priceCents: 3900 }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.superseded, []);
    assert.equal(planRow(h, w.planId).status, 'executing');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
  });

  test('RS-13: a plan that does not use the changed offer is untouched: a one-supplier plan on A ignores changes of B and E', async () => {
    const h = await start();
    const cafe1 = await signIn(h, 'cafe1');
    h.clock.advance(61_000);
    const { requestId, plan } = await approvedPlan(cafe1, DAY, { approve: false, overrides: { cupQuantity: 100, lidQuantity: 100, maxPickups: 1 } });
    assert.deepEqual(plan.body.suppliers.map((s) => s.supplierCode), ['A']);
    for (const [code, change] of [['B', { priceCents: 3700 }], ['B', { prepFeeCents: 900 }], ['E', { readyAt: '2026-10-20T07:50:00.000Z' }], ['B', { withdrawn: true }]]) {
      const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
      const res = await patch(supplier, [{ productId: productOf(h, code), ...change }]);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.superseded, [], `${code} ${JSON.stringify(change)}`);
    }
    assert.equal(planRow(h, plan.id).status, 'proposed');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue WHERE request_id = ?', requestId), 0);
    const supplierA = await signIn(h, 'supplier-a');
    assert.deepEqual((await patch(supplierA, [{ productId: productOf(h, 'A'), priceCents: 3100 }])).json.superseded.map((s) => s.planVersionId), [plan.id]);
  });

  test('RS-13: another customer\'s reservation never supersedes a plan: the second customer\'s approved plan stays as it is (a quote), no re-plan is queued, its reserve answers OUT_OF_STOCK', async () => {
    const h = await start();
    // both plans are computed on the same single bundle of A and B, then the first customer reserves it
    const mine = await world(h, { reserveIt: false, username: 'cafe1' });
    const theirs = await world(h, { reserveIt: false, username: 'cafe2' });
    const reserved = await reserve(mine.cafe1, mine.planId, idempotencyKey('other-customer-0'));
    assert.equal(reserved.status, 201, reserved.text);
    mine.reservationId = reserved.json.reservation.id;
    assert.equal(planRow(h, theirs.planId).status, 'approved', 'a plan without a reservation is only a quote');
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(mine.reservationId).status, 'active');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.supersede'"), 0);
    // the loser finds out when it reserves, and the answer is OUT_OF_STOCK, not PLAN_SUPERSEDED (RS-14 depends on it)
    const late = await reserve(theirs.cafe1, theirs.planId, idempotencyKey('other-customer-1'));
    assert.equal(late.status, 409);
    assert.equal(late.json.error.code, 'OUT_OF_STOCK');
    assert.equal(planRow(h, theirs.planId).non_executable_reason, 'OUT_OF_STOCK');
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(theirs.requestId).reason, 'OUT_OF_STOCK');
  });
});

describe('RS-13 / RS-32 (supersession half): a withdrawn offer, a stock drop and the admin depletion fault', () => {
  test('RS-13: a withdrawn offer and an on_hand drop supersede with the reason, and the request reads "Review the new plan"', async () => {
    const h = await start();
    const w = await world(h, { reserveIt: false });
    const supplierB = await signIn(h, 'supplier-b');
    const gone = await patch(supplierB, [{ productId: productOf(h, 'B'), withdrawn: true }]);
    assert.deepEqual(gone.json.superseded.map((s) => s.planVersionId), [w.planId]);
    assert.equal(planRow(h, w.planId).supersede_reason, 'OFFER_WITHDRAWN');
    assert.equal(drainReplanQueue(h.app.deps).drained, 1);
    const view = await statusOf(w);
    assert.equal(view.rescueStatus.message, 'Review the new plan');
    assert.equal(view.rescueStatus.nextStep.code, 'REVIEW_NEW_PLAN');
    assert.ok(!view.plans.find((p) => p.id === view.currentPlanId).body.suppliers.some((s) => s.supplierCode === 'B'));

    const current = view.plans.find((p) => p.id === view.currentPlanId);
    const supplierA = await signIn(h, 'supplier-a');
    // a drop that still covers the planned bundles supersedes nothing; the one that does not, does
    assert.deepEqual((await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 6 }])).json.superseded, [], 'an increase is no drop');
    assert.deepEqual((await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 3 }])).json.superseded, [], 'the plan needs one bundle of A');
    assert.equal(planRow(h, current.id).status, 'proposed');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    const drop = await patch(supplierA, [{ productId: productOf(h, 'A'), onHand: 0 }]);
    assert.deepEqual(drop.json.superseded.map((s) => s.planVersionId), [current.id]);
    assert.equal(planRow(h, current.id).supersede_reason, 'AVAILABILITY_DROPPED');
    assert.equal(drainReplanQueue(h.app.deps).drained, 1, 'with A and B gone the run is stored as infeasible and answers the queue');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM replan_queue'), 0);
    assert.equal((await statusOf(w)).rescueStatus.status, 'no_feasible_plan');
  });

  test('RS-32 (supersession half): the admin stock_depletion fault withdraws the supplier\'s offers and supersedes an approved, authorized plan under the void rule', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A', 'B'] });
    const admin = await signIn(h, 'admin');
    const fault = await admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'B' });
    assert.equal(fault.status, 200, fault.text);
    assert.deepEqual(fault.json.applied, { kind: 'stock_depletion', supplierCode: 'B' });
    assert.deepEqual(fault.json.superseded, [w.planId]);
    const old = planRow(h, w.planId);
    assert.deepEqual([old.status, old.supersede_reason], ['superseded', 'OFFER_WITHDRAWN']);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.deepEqual([opOf(h, w.orders.A).status, opOf(h, w.orders.B).status], ['voided', 'voided']);
    assert.equal(fakeCalls(h, 'void').length, 2);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM offers WHERE status = 'withdrawn'"), count(h, "SELECT COUNT(*) AS n FROM offers o JOIN suppliers s ON s.id = o.supplier_id WHERE s.code = 'B' AND o.status = 'withdrawn'"));
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(w.requestId).reason, 'OFFER_WITHDRAWN');
    assertLedgerInvariant(h);
  });
});
