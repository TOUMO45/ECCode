// API tests for POST /api/plans/:id/execute and the capture saga (task e4-saga-reconciler; spec: Payment saga with lease fencing,
// Customer routes > execute check order). Case names start with the criterion id:
//   RS-20  one claim among N concurrent requests; the losers get 200 with the current state and make no provider call;
//          exactly one capture call per supplier order with PayPal-Request-Id = so:<id>:capture:1
//   RS-18  the 409 cases of the execute check order (a cancelled approval, a missing authorization, ...), no capture, no provider call
//   RS-22  a capture that fails on the second supplier: the first is refunded, the rest voided, the reservation reconciling and then
//          released with restock rows; refund_failed escalates
//   ARCH-23 / ARCH-26  the lease: a result that arrives after a takeover is fenced and discarded
// The saga continues in the background of the process that won the claim; these tests wait for it with saga.idle().
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { FIXTURE_DIR, createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { createSaga } from '../../src/services/saga.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

const fixture = (name) => JSON.parse(readFileSync(`${FIXTURE_DIR}/contracts/${name}.json`, 'utf8')).response;
const keysOf = (value) => Object.keys(value).sort();

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

// A reserved plan; `confirm` suppliers confirm their order, `authorize` orders are created, approved at the fake page and returned.
async function world(h, { confirm = ['A', 'B'], authorize = ['A', 'B'], cancelApproval = [] } = {}) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of confirm) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    const res = await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code));
    assert.equal(res.status, 200, res.text);
  }
  for (const code of [...authorize, ...cancelApproval]) {
    const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    if (cancelApproval.includes(code)) {
      const token = created.json.approvalUrl.split('/').pop();
      assert.equal((await cafe1.get(`/api/paypal/cancel?token=${token}`)).status, 303);
      continue;
    }
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    assert.equal(approved.status, 303);
    const target = new URL(approved.location);
    const ret = await cafe1.get(target.pathname + target.search);
    assert.equal(ret.status, 303, ret.text);
  }
  return { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
}

const execute = (w, planId = w.planId) => w.cafe1.post(`/api/plans/${planId}/execute`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const calls = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeTotal = (h) => h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
const reservation = (h, id) => h.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const denied = (h, code) =>
  h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.execute' AND outcome = 'denied' AND detail_json LIKE ?").get(`%${code}%`).n;

function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `ledger reserved of product ${inv.product_id}`);
  }
}

// A first tick of a reconciler that is NOT the one the app started (tests drive ticks by hand).
const reconcilerOf = (h, saga = h.app.deps.saga) => createReconciler(h.app.deps, { saga });

describe('RS-20: the execute claim', () => {
  test('RS-20: the claim answers 202 {claimed:true}, consumes the reservation and queues one capture per order, with no provider call inside it', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    const before = fakeTotal(h);
    const stockBefore = h.db.prepare('SELECT SUM(on_hand) AS on_hand, SUM(reserved) AS reserved FROM inventory').get();
    const res = await execute(w);
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(keysOf(res.json), keysOf(fixture('plan-execute')));
    assert.deepEqual(res.json.plan, { id: w.planId, status: 'executing' });
    assert.equal(res.json.claimed, true);
    assert.equal(fakeTotal(h), before, 'no provider call before or inside the claim');

    const row = plan(h, w.planId);
    assert.equal(row.status, 'executing');
    assert.equal(row.lease_epoch, 1);
    assert.equal(row.executor_id, h.app.deps.saga.executorId);
    assert.match(row.executor_id, /^.+:\d+:[0-9a-f]{8}$/);
    assert.equal(row.lease_until, new Date(h.clock.now() + h.config.sagaLeaseMs).toISOString());
    assert.equal(reservation(h, w.reservationId).status, 'consumed');
    for (const code of ['A', 'B']) {
      const [capture] = calls(h, w.orders[code], 'capture');
      assert.deepEqual([capture.operation_key, capture.status, capture.started_at, capture.send_count], [`so:${w.orders[code]}:capture:1`, 'intent', null, 0]);
    }
    const consume = h.db.prepare("SELECT * FROM inventory_ledger WHERE reason = 'consume' ORDER BY id").all();
    assert.equal(consume.length, 2, 'one consume row per reserved product');
    assert.ok(consume.every((r) => r.delta_on_hand < 0 && r.delta_on_hand === r.delta_reserved && r.ref_type === 'reservation' && r.ref_id === w.reservationId));
    const stockAfter = h.db.prepare('SELECT SUM(on_hand) AS on_hand, SUM(reserved) AS reserved FROM inventory').get();
    assert.equal(stockBefore.on_hand - stockAfter.on_hand, -consume.reduce((n, r) => n + r.delta_on_hand, 0));
    assert.equal(stockBefore.reserved - stockAfter.reserved, stockBefore.on_hand - stockAfter.on_hand);
    assertLedgerInvariant(h);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.execute' AND outcome = 'ok'").get().n, 1);
  });

  test('RS-20: the saga then reads each authorization, captures in supplier-code order with the deterministic keys and marks the plan executed', async () => {
    const h = await start();
    const w = await world(h);
    const base = fakeTotal(h);
    const res = await execute(w);
    assert.equal(res.status, 202, res.text);
    await h.app.deps.saga.idle();

    const row = plan(h, w.planId);
    assert.equal(row.status, 'executed');
    assert.equal(row.lease_until, null, 'the lease is cleared');
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['captured', 'captured']);
    const sequence = h.db.prepare('SELECT kind, request_id, replayed FROM fake_paypal_calls WHERE id > (SELECT MAX(id) - ? FROM fake_paypal_calls) ORDER BY id').all(fakeTotal(h) - base);
    assert.deepEqual(
      sequence.map((c) => c.kind),
      ['get_authorization', 'get_authorization', 'capture', 'capture'],
      'step 2 reads both authorizations before any capture, then step 3 captures one after the other',
    );
    assert.deepEqual(
      sequence.filter((c) => c.kind === 'capture').map((c) => [c.request_id, c.replayed]),
      [[`so:${w.orders.A}:capture:1`, 0], [`so:${w.orders.B}:capture:1`, 0]],
      'supplier A before supplier B, request id = the operation key',
    );
    for (const code of ['A', 'B']) {
      const [capture] = calls(h, w.orders[code], 'capture');
      assert.deepEqual([capture.status, capture.send_count, capture.lease_epoch], ['succeeded', 1, 1]);
      assert.match(op(h, w.orders[code]).provider_capture_id, /^FAKECAP-/);
    }
    assert.equal(reservation(h, w.reservationId).status, 'consumed');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2);
    const view = (await w.cafe1.get(`/api/requests/${w.requestId}`)).json;
    assert.equal(view.rescueStatus.status, 'purchase_confirmed');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.executed'").get().n, 1);
  });

  test('RS-20: five concurrent executes give one 202 and four 200 {claimed:false} with the current state; one claim, one capture per order', async () => {
    const h = await start();
    const w = await world(h);
    const base = fakeTotal(h);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => execute(w)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 202]);
    const winner = results.find((r) => r.status === 202);
    assert.equal(winner.json.claimed, true);
    for (const loser of results.filter((r) => r.status === 200)) {
      assert.equal(loser.json.claimed, false);
      assert.deepEqual(keysOf(loser.json), keysOf(fixture('plan-execute-replay')));
      assert.deepEqual(keysOf(loser.json.rescueStatus), keysOf(fixture('plan-execute-replay').rescueStatus));
      assert.equal(loser.json.plan.id, w.planId);
      assert.ok(['executing', 'executed'].includes(loser.json.plan.status));
    }
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'exactly one claim committed');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.execute' AND outcome = 'ok'").get().n, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'consume'").get().n, 2, 'the reservation is consumed once');
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    const captures = fakeCalls(h, 'capture');
    assert.equal(captures.length, 2, 'exactly one capture call per supplier order');
    assert.deepEqual(captures.map((c) => c.request_id).sort(), [`so:${w.orders.A}:capture:1`, `so:${w.orders.B}:capture:1`].sort());
    assert.equal(fakeTotal(h) - base, 4, 'two reads and two captures, nothing for the four losers');

    // A repeat after the plan is executed is still 200 with the current state and no provider call.
    const again = await execute(w);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.plan, { id: w.planId, status: 'executed' });
    assert.equal(again.json.rescueStatus.status, 'purchase_confirmed');
    assert.equal(fakeTotal(h) - base, 4);
  });

  test('RS-20: the losers are answered from stored data only: a loser makes no provider call even while the winner is mid-saga', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    const base = fakeTotal(h);
    const loser = await execute(w);
    assert.equal(loser.status, 200);
    assert.deepEqual(loser.json.plan, { id: w.planId, status: 'executing' });
    assert.equal(loser.json.rescueStatus.underlying.plan, 'executing');
    assert.equal(fakeTotal(h), base);
    assert.equal(plan(h, w.planId).lease_epoch, 1);
  });
});

describe('RS-18: the execute check order (a refusal changes nothing the provider can see)', () => {
  async function refuses(h, w, code, { planStatus = 'approved' } = {}) {
    const base = fakeTotal(h);
    const res = await execute(w);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, code);
    assert.equal(fakeTotal(h), base, 'no provider call for a refusal');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0, 'no capture call exists');
    assert.equal(plan(h, w.planId).status, planStatus);
    assert.ok(denied(h, code) >= 1, 'the refusal is audited as denied');
    return res;
  }

  test('RS-18: an approval the buyer cancelled leaves the operation created: 409 AUTHORIZATION_MISSING, no capture call or row', async () => {
    const h = await start();
    const w = await world(h, { authorize: ['A'], cancelApproval: ['B'] });
    assert.equal(op(h, w.orders.B).status, 'created');
    assert.notEqual(op(h, w.orders.B).buyer_cancelled_at, null);
    await refuses(h, w, 'AUTHORIZATION_MISSING');
    assert.equal(plan(h, w.planId).executor_id, null);
    assert.equal(reservation(h, w.reservationId).status, 'active');
  });

  test('RS-18: no operation authorized at all is AUTHORIZATION_MISSING too', async () => {
    const h = await start();
    const w = await world(h, { authorize: [] });
    await refuses(h, w, 'AUTHORIZATION_MISSING');
  });

  test('a supplier order that is not confirmed is 409 COMMITMENT_MISSING', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A'] });
    await refuses(h, w, 'COMMITMENT_MISSING');
  });

  test('an expired reservation is 409 RESERVATION_EXPIRED and the expiry pass runs: the plan is non_executable, the stock released, the voids sent', async () => {
    const h = await start();
    const w = await world(h);
    h.clock.advance(h.config.reservationTtlMin * 60_000 + 1000);
    const base = fakeTotal(h);
    const res = await execute(w);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'RESERVATION_EXPIRED');
    assert.equal(plan(h, w.planId).status, 'non_executable');
    assert.equal(plan(h, w.planId).non_executable_reason, 'RESERVATION_EXPIRED');
    assert.equal(reservation(h, w.reservationId).status, 'expired');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['voided', 'voided'], 'the authorizations are voided, not captured');
    assert.equal(fakeCalls(h, 'void').length, 2);
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(fakeTotal(h) - base, 2, 'only the two voids');
    assertLedgerInvariant(h);
    const again = await execute(w);
    assert.deepEqual([again.status, again.json.error.code, again.json.error.details], [409, 'PLAN_NOT_EXECUTABLE', { reason: 'RESERVATION_EXPIRED' }]);
  });

  test('a pending authorization wins over a missing one, and a missing one over an unconfirmed order (the check order)', async () => {
    const h = await start();
    const w = await world(h, { confirm: ['A'], authorize: ['A'] });
    // order B: created (missing) and unconfirmed (commitment) -> AUTHORIZATION_MISSING first
    await refuses(h, w, 'AUTHORIZATION_MISSING');
    h.db.prepare("UPDATE payment_operations SET status = 'authorization_pending', pending_since = '2026-10-20T06:00:00.000Z' WHERE supplier_order_id = ?").run(w.orders.B);
    await refuses(h, w, 'AUTHORIZATION_PENDING');
    h.db.prepare("UPDATE payment_operations SET status = 'approved' WHERE supplier_order_id = ?").run(w.orders.B);
    await refuses(h, w, 'AUTHORIZATION_PENDING');
    h.db.prepare("UPDATE payment_operations SET status = 'unknown', prev_status = 'approved', unknown_since = '2026-10-20T06:00:00.000Z' WHERE supplier_order_id = ?").run(w.orders.B);
    await refuses(h, w, 'AUTHORIZATION_PENDING');
  });

  test('the stored expiry decides AUTHORIZATION_EXPIRED: exactly at now + margin is refused, one millisecond later passes; the void rule ran in the refusal', async () => {
    const h = await start();
    const w = await world(h);
    const margin = h.config.authExpiryMarginMin * 60_000;
    h.db.prepare('UPDATE payment_operations SET authorization_expires_at = ? WHERE supplier_order_id = ?').run(new Date(h.clock.now() + margin + 1).toISOString(), w.orders.A);
    h.app.deps.saga.autoRun = false;
    const ok = await execute(w);
    assert.equal(ok.status, 202, 'one millisecond beyond the margin is claimable');

    const h2 = await start();
    const w2 = await world(h2);
    h2.db.prepare('UPDATE payment_operations SET authorization_expires_at = ? WHERE supplier_order_id = ?').run(new Date(h2.clock.now() + margin).toISOString(), w2.orders.A);
    const base = fakeTotal(h2);
    const res = await execute(w2);
    assert.deepEqual([res.status, res.json.error.code], [409, 'AUTHORIZATION_EXPIRED']);
    assert.equal(plan(h2, w2.planId).status, 'non_executable');
    assert.equal(plan(h2, w2.planId).non_executable_reason, 'AUTHORIZATION_EXPIRED');
    assert.equal(reservation(h2, w2.reservationId).status, 'released', 'the void rule released the reservation in the same transaction');
    assert.deepEqual([op(h2, w2.orders.A).status, op(h2, w2.orders.B).status], ['voided', 'voided']);
    assert.equal(fakeCalls(h2, 'capture').length, 0);
    assert.equal(fakeTotal(h2) - base, 2, 'two voids, no capture');
    assertLedgerInvariant(h2);
    assert.equal(denied(h2, 'AUTHORIZATION_EXPIRED'), 1);
  });

  test('a superseded plan is 409 PLAN_SUPERSEDED, an abandoned one 409 PLAN_NOT_EXECUTABLE with its reason; a proposed one is INVALID_STATE', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = 'REPLANNED' WHERE id = ?").run(w.planId);
    await refuses(h, w, 'PLAN_SUPERSEDED', { planStatus: 'superseded' });

    const h2 = await start();
    const w2 = await world(h2);
    assert.equal((await w2.cafe1.post(`/api/plans/${w2.planId}/abandon`, {})).status, 200);
    const res = await execute(w2);
    assert.deepEqual([res.status, res.json.error.code, res.json.error.details], [409, 'PLAN_NOT_EXECUTABLE', { reason: 'PAYMENT_CANCELLED' }]);
    assert.equal(fakeCalls(h2, 'capture').length, 0);

    const h3 = await start();
    const cafe1 = await signIn(h3, 'cafe1');
    h3.clock.advance(61_000);
    const { plan: proposed } = await approvedPlan(cafe1, DAY, { approve: false });
    const refused = await cafe1.post(`/api/plans/${proposed.id}/execute`, {});
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'INVALID_STATE']);
    const unreserved = await approvedPlan(cafe1, DAY);
    const noReservation = await cafe1.post(`/api/plans/${unreserved.plan.id}/execute`, {});
    assert.deepEqual([noReservation.status, noReservation.json.error.code], [409, 'INVALID_STATE'], 'approved but never reserved');
  });

  test('access: a foreign plan is 404 before anything is read, a supplier 403, an anonymous caller 401', async () => {
    const h = await start();
    const w = await world(h);
    const cafe2 = await signIn(h, 'cafe2');
    const base = fakeTotal(h);
    const foreign = await cafe2.post(`/api/plans/${w.planId}/execute`, {});
    assert.deepEqual([foreign.status, foreign.json.error.code], [404, 'NOT_FOUND']);
    assert.equal(foreign.json.error.details, undefined);
    const unknown = await w.cafe1.post('/api/plans/999999/execute', {});
    assert.equal(unknown.status, 404);
    const supplier = await signIn(h, 'supplier-a');
    assert.equal((await supplier.post(`/api/plans/${w.planId}/execute`, {})).status, 403);
    assert.equal((await createClient(h.request).post(`/api/plans/${w.planId}/execute`, {})).status, 401);
    assert.equal((await w.cafe1.post('/api/plans/abc/execute', {})).status, 400);
    assert.equal(fakeTotal(h), base);
    assert.equal(plan(h, w.planId).status, 'approved');
    assert.equal(denied(h, 'NOT_FOUND'), 0, 'a foreign id leaves no audit trace that confirms it exists');
  });
});

describe('RS-22: compensation when a capture fails', () => {
  test('RS-22: the second capture is declined: the first is refunded, the second authorization voided, the reservation reconciling then released with restock rows', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    const res = await execute(w);
    assert.equal(res.status, 202, res.text);
    await h.app.deps.saga.idle();

    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason], ['non_executable', 'CAPTURE_FAILED']);
    assert.equal(JSON.parse(row.reason_detail_json).supplierCode, 'B');
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['refunded', 'voided']);
    assert.ok(op(h, w.orders.A).cancel_requested_at, 'every operation carries the cancellation');
    assert.equal(op(h, w.orders.B).cancel_reason, 'CAPTURE_FAILED');
    assert.equal(fakeCalls(h, 'refund').length, 1);
    assert.equal(fakeCalls(h, 'void').length, 1);
    assert.equal(fakeCalls(h, 'refund')[0].request_id, `so:${w.orders.A}:refund:1`);
    assert.equal(fakeCalls(h, 'void')[0].request_id, `so:${w.orders.B}:void:1`);
    assert.equal(fakeCalls(h, 'capture').length, 2, 'the declined one is not sent again');
    const [declined] = calls(h, w.orders.B, 'capture');
    assert.deepEqual([declined.status, declined.error_code], ['failed', 'CAPTURE_DECLINED']);

    assert.equal(reservation(h, w.reservationId).status, 'released');
    const restock = h.db.prepare("SELECT * FROM inventory_ledger WHERE reason = 'restock' ORDER BY id").all();
    assert.equal(restock.length, 2);
    assert.ok(restock.every((r) => r.delta_on_hand > 0 && r.delta_reserved === 0));
    const consumed = h.db.prepare("SELECT SUM(delta_on_hand) AS n FROM inventory_ledger WHERE reason = 'consume'").get().n;
    assert.equal(consumed + restock.reduce((n, r) => n + r.delta_on_hand, 0), 0, 'the stock is back');
    assertLedgerInvariant(h);
    const handover = await signIn(h, 'supplier-a');
    const blocked = await handover.post(`/api/supplier/orders/${w.orders.A}/handover`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'HANDOVER_BLOCKED');
    const view = (await w.cafe1.get(`/api/requests/${w.requestId}`)).json;
    assert.notEqual(view.rescueStatus.status, 'purchase_confirmed');
  });

  test('RS-22: while a refund is not done the reservation stays reconciling; a refund_failed escalates it (failed_needs_attention) and never releases', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'refund_failed', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_failed');
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    await reconcilerOf(h).tick();
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    assert.equal(reservation(h, w.reservationId).escalation, 'REFUND_FAILED');
    const view = (await w.cafe1.get(`/api/requests/${w.requestId}`)).json;
    assert.equal(view.rescueStatus.status, 'failed_needs_attention');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'").get().n, 0);
    assert.equal(fakeCalls(h, 'refund').length, 1, 'a failed refund is not sent again by the reconciler');
  });

  test('RS-22: a capture that answers PENDING pauses the saga: the next capture does not start until the reconciler resolves it', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(fakeCalls(h, 'capture').length, 1, 'the second capture was not started');
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(plan(h, w.planId).lease_until, new Date(h.clock.now()).toISOString(), 'paused: lease_until = now');

    const rec = reconcilerOf(h);
    await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'no takeover while a capture is pending (F-TR-7)');
    assert.equal(fakeCalls(h, 'capture').length, 1);
    assert.equal(op(h, w.orders.A).status, 'capture_pending');

    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED' WHERE id = ?").run(op(h, w.orders.A).provider_capture_id);
    await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(plan(h, w.planId).lease_epoch, 2, 'the resumed saga holds a new epoch');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(fakeCalls(h, 'capture').length, 2);
  });

  test('step 2: an authorization that is no longer CREATED compensates with AUTHORIZATION_EXPIRED before any capture is sent', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare("UPDATE fake_paypal_authorizations SET status = 'VOIDED' WHERE id = ?").run(op(h, w.orders.B).provider_authorization_id);
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason], ['non_executable', 'AUTHORIZATION_EXPIRED']);
    assert.equal(fakeCalls(h, 'capture').length, 0, 'no capture was sent');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture' AND status = 'cancelled'").get().n, 2, 'queued captures are cancelled');
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['voided', 'voided'], 'the voided one is found VOIDED when its void is refused');
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.equal(reservation(h, w.reservationId).escalation, null);
    assertLedgerInvariant(h);
  });

  test('step 2: an authorization inside the expiry margin at the provider compensates the same way (voids only)', async () => {
    const h = await start();
    const w = await world(h);
    h.db.prepare('UPDATE fake_paypal_authorizations SET expiration_time = ? WHERE id = ?').run(new Date(h.clock.now() + 60_000).toISOString(), op(h, w.orders.A).provider_authorization_id);
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).non_executable_reason, 'AUTHORIZATION_EXPIRED');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(fakeCalls(h, 'void').length, 2);
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assertLedgerInvariant(h);
  });

  test('step 2: a read that fails leaves the plan executing and releases the lease; a later holder repeats step 2 before any capture', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'http_500:get_authorization', { remaining: 1 });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(plan(h, w.planId).lease_until, new Date(h.clock.now()).toISOString());
    assert.equal(fakeCalls(h, 'capture').length, 0);
    await reconcilerOf(h).tick();
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    assert.equal(fakeCalls(h, 'capture').length, 2);
  });
});

describe('step 3: the other answers to a capture', () => {
  test('a retryable answer (429) pauses the saga for the back-off: no takeover and no send until next_attempt_at, then the same key is sent', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'http_429:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const queued = calls(h, w.orders.A, 'capture')[0];
    assert.deepEqual([queued.status, queued.started_at, queued.send_token, queued.send_count], ['intent', null, null, 1], 'provably unsent again');
    assert.equal(queued.next_attempt_at, new Date(h.clock.now() + 5000).toISOString(), 'first back-off: 5 seconds');
    assert.equal(op(h, w.orders.A).status, 'authorized');
    assert.equal(plan(h, w.planId).status, 'executing');
    const rec = reconcilerOf(h);
    h.clock.advance(4000);
    await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'no takeover during the back-off');
    assert.equal(fakeCalls(h, 'capture').length, 1);
    h.clock.advance(1001);
    await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${w.orders.A}:capture:1`).length, 2, 'the 429 and the send');
    assert.equal(calls(h, w.orders.A, 'capture')[0].send_count, 2);
  });

  test('a definitive rejection (422) compensates like a decline: CAPTURE_FAILED, the first capture refunded', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'http_422:capture', { value: 'B' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.deepEqual([plan(h, w.planId).status, plan(h, w.planId).non_executable_reason], ['non_executable', 'CAPTURE_FAILED']);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['refunded', 'voided']);
    assert.deepEqual([calls(h, w.orders.B, 'capture')[0].status, calls(h, w.orders.B, 'capture')[0].error_code], ['failed', 'INJECTED_UNPROCESSABLE']);
    assert.equal(reservation(h, w.reservationId).status, 'released');
  });

  test('AUTHORIZATION_ALREADY_CAPTURED means a capture exists: the call turns unknown (never a blind failure), the read finds it, no second capture', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        if (args.requestId === `so:${w.orders.B}:capture:1`) await real.captureAuthorization({ ...args, requestId: 'external-capture-0001' }); // a capture we did not send under our key
        return real.captureAuthorization(args);
      },
    };
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.B).status, 'unknown');
    assert.equal(plan(h, w.planId).status, 'executing', 'not compensated on a guess');
    h.app.deps.payments = real;
    await reconcilerOf(h).tick();
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.B).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'one capture per authorization');
  });

  test('once executed, handover and ready are open to the suppliers (step 4 unlocks them)', async () => {
    const h = await start();
    const w = await world(h);
    const supplierA = await signIn(h, 'supplier-a');
    const before = await supplierA.post(`/api/supplier/orders/${w.orders.A}/ready`, {});
    assert.equal(before.status, 409, 'not before the plan is executed');
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const ready = await supplierA.post(`/api/supplier/orders/${w.orders.A}/ready`, {});
    assert.equal(ready.status, 200, ready.text);
    const handover = await supplierA.post(`/api/supplier/orders/${w.orders.A}/handover`, {});
    assert.equal(handover.status, 200, handover.text);
  });
});

describe('ARCH-23: the lease fences a stalled executor', () => {
  test('ARCH-23: a capture result that arrives after a takeover is discarded (provider.result_fenced); the taker reads, finishes, and no capture is repeated', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    let release;
    let applied;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const appliedSeen = new Promise((resolve) => {
      applied = resolve;
    });
    let held = false;
    // The first capture reaches the provider and is applied; its answer is held back (a stalled executor).
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        const outcome = await real.captureAuthorization(args);
        if (!held) {
          held = true;
          applied();
          await gate;
        }
        return outcome;
      },
    };
    assert.equal((await execute(w)).status, 202);
    await appliedSeen;
    assert.equal(calls(h, w.orders.A, 'capture')[0].status, 'intent', 'started, not recorded');

    // The executor stalls past its lease; another process (a second saga identity) reconciles and takes the plan over.
    h.clock.advance(h.config.sagaLeaseMs + 1000);
    const taker = createSaga(h.app.deps, { executorId: 'other-host:4242:cafebabe' });
    await reconcilerOf(h, taker).tick();
    await taker.idle();
    const row = plan(h, w.planId);
    assert.equal(row.status, 'executed');
    assert.equal(row.executor_id, 'other-host:4242:cafebabe');
    assert.equal(row.lease_epoch, 2);

    release();
    await h.app.deps.saga.idle();
    const lines = h.logEntries();
    assert.ok(lines.some((l) => l.msg === 'provider.result_fenced'), 'the stalled result was fenced');
    assert.ok(lines.some((l) => l.msg === 'saga.lease_lost'), 'and the stalled executor stopped');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2, 'the stalled executor changed nothing');
    const captures = fakeCalls(h, 'capture');
    assert.equal(captures.length, 2, 'one capture per order');
    assert.ok(captures.every((c) => c.replayed === 0));
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['captured', 'captured']);
  });

  test('ARCH-23: no capture is started without the lease: a start after the lease lapsed (nobody took over) is refused', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    h.clock.advance(h.config.sagaLeaseMs + 1);
    const result = await h.app.deps.saga.start(w.planId, 1);
    assert.equal(result, 'lost', 'G(now) needs lease_until > now');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(plan(h, w.planId).status, 'executing');
    // the reconciler takes the lapsed plan over and resumes it
    await reconcilerOf(h).tick();
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
  });

  test('ARCH-26: when the first capture cannot be sent (its call was cancelled) the saga compensates and never captures the second out of order', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    h.db.prepare("UPDATE provider_calls SET status = 'cancelled' WHERE operation_key = ?").run(`so:${w.orders.A}:capture:1`);
    assert.equal(await h.app.deps.saga.start(w.planId, 1), 'compensated');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(plan(h, w.planId).non_executable_reason, 'CAPTURE_FAILED');
  });
});

describe('configuration and shutdown', () => {
  test('ARCH-26: the lease must be at least 3 x the provider timeout (the configuration refuses a smaller one)', async () => {
    const { loadConfig } = await import('../../src/config.js');
    assert.throws(() => loadConfig({ RS_SAGA_LEASE_MS: '1499', RS_PAYPAL_TIMEOUT_MS: '500' }), /RS_SAGA_LEASE_MS/);
    assert.equal(loadConfig({ RS_SAGA_LEASE_MS: '1500', RS_PAYPAL_TIMEOUT_MS: '500' }).sagaLeaseMs, 1500);
  });

  test('closing the app pauses a run in flight: no step starts after stop(), and the plan can be taken over', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.stop();
    assert.equal(await h.app.deps.saga.start(w.planId, 1), 'stopped');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(plan(h, w.planId).status, 'executing');
  });
});
