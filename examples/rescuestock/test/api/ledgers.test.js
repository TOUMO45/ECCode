// RS-38 and FU-36 (task f2-compensation-takeover-admin; spec: Reservation, Payment saga step 1 and step 5, the inventory ledger):
//   RS-38  every reserve, release, expire, consume and restock writes a ledger row, so after every step and for every product
//          SUM(delta_on_hand) = inventory.on_hand and SUM(delta_reserved) = inventory.reserved
//   FU-36  the consume and restock rows are written by helpers in saga.js, not by ledger.js; they keep the inventory_ledger row
//          format (running balances, ref to the reservation, actor) so the two writers cannot be told apart by shape
// The saga continues in the background of the process that won the claim; the tests wait for it with saga.idle().
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  harnesses.push(h);
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  return h;
}

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
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

// A reserved plan. `pay` also confirms and authorizes both orders, so the plan is ready to execute.
async function world(h, { pay = true } = {}) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  if (pay) {
    for (const code of ['A', 'B']) {
      const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
      assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
      const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
      assert.equal(created.status, 200, created.text);
      const approved = await postTo(`${created.json.approvalUrl}/approve`);
      const target = new URL(approved.location);
      assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
    }
  }
  return { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
}

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const reservation = (h, id) => h.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
const itemCount = (h, reservationId) => h.db.prepare('SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?').get(reservationId).n;
const rowsOf = (h, reason, reservationId) =>
  h.db.prepare('SELECT * FROM inventory_ledger WHERE reason = ? AND ref_type = ? AND ref_id = ? ORDER BY id').all(reason, 'reservation', reservationId);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const reconcilerOf = (h) => createReconciler(h.app.deps, { saga: h.app.deps.saga });
const settle = async (h, rec) => {
  await rec.tick();
  await h.app.deps.saga.idle();
};

// RS-38: for every product the ledger sums equal the columns, and every row's running balance equals the balance after it.
function assertLedger(h, label) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all()) {
    let onHand = 0;
    let reserved = 0;
    for (const row of h.db.prepare('SELECT * FROM inventory_ledger WHERE product_id = ? ORDER BY id').all(inv.product_id)) {
      onHand += row.delta_on_hand;
      reserved += row.delta_reserved;
      assert.equal(row.on_hand_after, onHand, `${label}: on_hand_after of ledger row ${row.id} (${row.reason})`);
      assert.equal(row.reserved_after, reserved, `${label}: reserved_after of ledger row ${row.id} (${row.reason})`);
    }
    assert.equal(onHand, inv.on_hand, `${label}: SUM(delta_on_hand) of product ${inv.product_id}`);
    assert.equal(reserved, inv.reserved, `${label}: SUM(delta_reserved) of product ${inv.product_id}`);
  }
}

const reasonsOf = (h, sinceId = 0) => h.db.prepare('SELECT reason, COUNT(*) AS n FROM inventory_ledger WHERE id > ? GROUP BY reason ORDER BY reason').all(sinceId).map((r) => [r.reason, r.n]);
const lastLedgerId = (h) => h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM inventory_ledger').get().n;

describe('RS-38: every stock movement writes a ledger row', () => {
  test('RS-38: reserve writes one reserve row per item and abandon one release row per item; the sums hold after each step', async () => {
    const h = await start();
    assertLedger(h, 'seed');
    const mark = lastLedgerId(h);
    const w = await world(h, { pay: false });
    const items = itemCount(h, w.reservationId);
    assert.ok(items >= 2, 'the base case reserves at least two products');
    assert.deepEqual(reasonsOf(h, mark), [['reserve', items]]);
    assert.ok(rowsOf(h, 'reserve', w.reservationId).every((r) => r.delta_reserved > 0 && r.delta_on_hand === 0));
    assertLedger(h, 'after reserve');

    const abandoned = await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {});
    assert.equal(abandoned.status, 200, abandoned.text);
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.deepEqual(reasonsOf(h, mark), [['release', items], ['reserve', items]]);
    assert.ok(rowsOf(h, 'release', w.reservationId).every((r) => r.delta_reserved < 0 && r.delta_on_hand === 0));
    assertLedger(h, 'after release');
    assert.ok(h.db.prepare('SELECT reserved FROM inventory').all().every((r) => r.reserved === 0), 'nothing stays reserved');
  });

  test('RS-38: an expired reservation writes one expire row per item (exactly once, even if the pass runs twice)', async () => {
    const h = await start();
    const mark = lastLedgerId(h);
    const w = await world(h, { pay: false });
    const items = itemCount(h, w.reservationId);
    h.clock.advance((h.config.reservationTtlMin + 1) * 60_000);
    const rec = reconcilerOf(h);
    await settle(h, rec);
    await settle(h, rec);
    assert.equal(reservation(h, w.reservationId).status, 'expired');
    assert.deepEqual(reasonsOf(h, mark), [['expire', items], ['reserve', items]]);
    assertLedger(h, 'after expire');
  });

  test('RS-38: the claim writes one consume row per item (on_hand and reserved both go down); an executed plan writes no restock', async () => {
    const h = await start();
    const mark = lastLedgerId(h);
    const w = await world(h);
    const items = itemCount(h, w.reservationId);
    const before = h.db.prepare('SELECT product_id, on_hand FROM inventory').all();
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.deepEqual(reasonsOf(h, mark), [['consume', items], ['reserve', items]]);
    const consume = rowsOf(h, 'consume', w.reservationId);
    assert.ok(consume.every((r) => r.delta_on_hand < 0 && r.delta_on_hand === r.delta_reserved), 'consume takes the same quantity from both columns');
    for (const row of before) {
      const taken = consume.filter((r) => r.product_id === row.product_id).reduce((n, r) => n + r.delta_on_hand, 0);
      assert.equal(h.db.prepare('SELECT on_hand FROM inventory WHERE product_id = ?').get(row.product_id).on_hand, row.on_hand + taken);
    }
    assertLedger(h, 'after consume');
  });

  test('RS-38: a compensation writes one restock row per item when the reservation is released, and the stock is back', async () => {
    const h = await start();
    const seeded = h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all();
    const mark = lastLedgerId(h);
    const w = await world(h);
    const items = itemCount(h, w.reservationId);
    arm(h, 'capture_declined', { value: 'B' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.deepEqual(reasonsOf(h, mark), [['consume', items], ['reserve', items], ['restock', items]]);
    const restock = rowsOf(h, 'restock', w.reservationId);
    assert.ok(restock.every((r) => r.delta_on_hand > 0 && r.delta_reserved === 0));
    assert.deepEqual(h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all(), seeded, 'every product is back at its seeded stock');
    assertLedger(h, 'after restock');
  });

  test('RS-38: while a refund is outstanding nothing is restocked; two reconcilers that both see it settle restock exactly once', async () => {
    const h = await start();
    const mark = lastLedgerId(h);
    const w = await world(h);
    const items = itemCount(h, w.reservationId);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'refund_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    assert.equal(rowsOf(h, 'restock', w.reservationId).length, 0, 'no restock while the refund is pending');
    assertLedger(h, 'while reconciling');

    h.db.prepare("UPDATE fake_paypal_refunds SET status = 'COMPLETED'").run();
    await Promise.all([reconcilerOf(h).tick(), reconcilerOf(h).tick()]);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.deepEqual(reasonsOf(h, mark), [['consume', items], ['reserve', items], ['restock', items]]);
    assertLedger(h, 'after the release check');
  });

  test('RS-38: a supplier stock change writes a restock row (up) or an adjust row (down)', async () => {
    const h = await start();
    const supplierA = await signIn(h, 'supplier-a');
    const productId = h.db.prepare("SELECT product_id FROM inventory WHERE supplier_id = (SELECT id FROM suppliers WHERE code = 'A') ORDER BY product_id LIMIT 1").get().product_id;
    const stock = () => h.db.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(productId);
    const mark = lastLedgerId(h);
    const base = stock().on_hand;
    const patch = (onHand) => supplierA.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId, onHand }] } });
    assert.equal((await patch(base + 7)).status, 200);
    assert.equal((await patch(base + 2)).status, 200);
    assert.deepEqual(reasonsOf(h, mark), [['adjust', 1], ['restock', 1]]);
    assert.equal(stock().on_hand, base + 2);
    assertLedger(h, 'after the supplier patch');
  });
});

describe('FU-36: the consume and restock rows keep the ledger row format', () => {
  test('FU-36: a consume row and a restock row carry the same fields as a reserve row; the balances are the running sums; refs and actors are as documented', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    const res = await execute(w);
    assert.equal(res.status, 202);
    await h.app.deps.saga.idle();

    const [reserveRow] = rowsOf(h, 'reserve', w.reservationId);
    const [consumeRow] = rowsOf(h, 'consume', w.reservationId);
    const [restockRow] = rowsOf(h, 'restock', w.reservationId);
    assert.deepEqual(Object.keys(consumeRow).sort(), Object.keys(reserveRow).sort(), 'the same columns');
    assert.deepEqual(Object.keys(restockRow).sort(), Object.keys(reserveRow).sort());
    for (const row of [consumeRow, restockRow]) {
      assert.equal(row.ref_type, 'reservation');
      assert.equal(row.ref_id, w.reservationId);
      assert.ok(Number.isSafeInteger(row.supplier_id) && Number.isSafeInteger(row.product_id));
      assert.match(row.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    assert.equal(consumeRow.actor, `customer:${w.cafe1.user.id}`, 'consume is the customer\'s execute');
    assert.equal(consumeRow.request_id, res.json.requestId, 'consume carries the request id of the execute call');
    assert.equal(restockRow.actor, 'system', 'restock is the system\'s release check');
    assertLedger(h, 'running balances');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger WHERE supplier_id IS NULL OR actor IS NULL').get().n, 0);
  });
});
