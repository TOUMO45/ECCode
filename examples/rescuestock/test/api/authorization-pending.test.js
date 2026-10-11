// API tests for the PENDING authorization (task e4-saga-reconciler; spec: Customer routes > execute check order, Reconciler step 3):
//   RS-21  an authorization answering PENDING leaves the operation authorization_pending; execute returns 409 AUTHORIZATION_PENDING
//          with no capture until the reconciler observes CREATED; a DENIED observation ends it as authorization_failed with the void
//          rule; the poll runs every tick for 5 minutes and then every 5 minutes
//   F-TR-3 an operation left in `approved` (queued authorize) or `unknown` after a lost authorize answer also blocks execute
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

// Both orders confirmed; the orders in `authorize` are approved at the fake page and returned (`ret` = the return responses).
async function world(h, { authorize = ['A', 'B'] } = {}) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of ['A', 'B']) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
  }
  const w = { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
  for (const code of authorize) assert.equal((await approveOrder(h, w, code)).status, 303);
  return w;
}

async function approveOrder(h, w, code) {
  const created = await w.cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(`${created.json.approvalUrl}/approve`);
  const target = new URL(approved.location);
  return w.cafe1.get(target.pathname + target.search);
}

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const callsOf = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeTotal = (h) => h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const reconcilerOf = (h) => createReconciler(h.app.deps);
const settle = async (h, rec) => {
  await rec.tick();
  await h.app.deps.saga.idle();
};
const setProviderAuthorization = (h, orderId, status) =>
  h.db.prepare('UPDATE fake_paypal_authorizations SET status = ? WHERE id = ?').run(status, op(h, orderId).provider_authorization_id);

describe('RS-21: a PENDING authorization blocks execute until the reconciler sees CREATED', () => {
  test('RS-21: execute is 409 AUTHORIZATION_PENDING (no capture, no provider call) while the provider says PENDING, and 202 once a tick observed CREATED', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    const w = await world(h);
    assert.equal(op(h, w.orders.A).status, 'authorized');
    assert.equal(op(h, w.orders.B).status, 'authorization_pending');
    assert.equal((await w.cafe1.get(`/api/requests/${w.requestId}`)).json.orders.find((o) => o.id === w.orders.B).payment.status, 'authorization_pending');

    const rec = reconcilerOf(h);
    for (let round = 1; round <= 3; round += 1) {
      const base = fakeTotal(h);
      const refused = await execute(w);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.error.code, 'AUTHORIZATION_PENDING');
      assert.equal(fakeTotal(h), base, 'the refusal makes no provider call');
      assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0, 'no capture row exists');
      h.clock.advance(1000);
      await settle(h, rec);
      assert.equal(fakeCalls(h, 'get_authorization').length, round, 'exactly one poll per tick');
      assert.equal(op(h, w.orders.B).status, 'authorization_pending', 'the provider still says PENDING');
    }
    assert.equal(plan(h, w.planId).status, 'approved');

    setProviderAuthorization(h, w.orders.B, 'CREATED');
    await settle(h, rec);
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(op(h, w.orders.B).last_error_code, null);
    assert.notEqual(op(h, w.orders.B).authorization_expires_at, null);

    const res = await execute(w);
    assert.equal(res.status, 202, res.text);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(fakeCalls(h, 'capture').length, 2);
  });

  test('RS-21: the poll runs every tick for the first 5 minutes of a pending state and then every 5 minutes', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    const w = await world(h);
    const rec = reconcilerOf(h);
    const polls = () => fakeCalls(h, 'get_authorization').length;
    const t0 = Date.parse(op(h, w.orders.B).pending_since);
    const minute = 60_000;
    const tickAt = async (minutes) => {
      h.clock.set(t0 + minutes * minute);
      await settle(h, rec);
      return polls();
    };

    assert.deepEqual([await tickAt(0), await tickAt(1), await tickAt(2), await tickAt(3), await tickAt(4)], [1, 2, 3, 4, 5], 'every tick while the state is younger than 5 minutes');
    assert.equal(await tickAt(6), 5, 'older than 5 minutes and polled 2 minutes ago: skipped');
    assert.equal(await tickAt(8), 5, 'still skipped');
    assert.equal(await tickAt(9), 6, 'polled 5 minutes after the last poll');
    assert.equal(await tickAt(10), 6, 'and then skipped again');
    assert.equal(op(h, w.orders.B).status, 'authorization_pending');
  });

  test('RS-21: a DENIED observation ends it: authorization_failed (naming the supplier), the plan non_executable, the other authorization voided, the reservation released', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    const w = await world(h);
    setProviderAuthorization(h, w.orders.B, 'DENIED');
    await settle(h, reconcilerOf(h));

    assert.equal(op(h, w.orders.B).status, 'authorization_failed');
    assert.equal(op(h, w.orders.B).last_error_code, 'AUTHORIZATION_DENIED');
    const row = plan(h, w.planId);
    assert.deepEqual([row.status, row.non_executable_reason], ['non_executable', 'AUTHORIZATION_FAILED']);
    assert.equal(JSON.parse(row.reason_detail_json).supplierCode, 'B');
    assert.equal(op(h, w.orders.A).status, 'voided');
    assert.equal(fakeCalls(h, 'void').length, 1);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    const refused = await execute(w);
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'PLAN_NOT_EXECUTABLE']);
  });

  test('ARCH-22: a cancellation requested while the authorization is pending: the poll sees CREATED and the resolution hook queues exactly one void', async () => {
    const h = await start();
    arm(h, 'authorize_pending', { value: 'B' });
    const w = await world(h);
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.A).status, 'voided', 'the authorized one was voided at once');
    assert.equal(op(h, w.orders.B).status, 'authorization_pending', 'the pending one resolves through the protocol');
    assert.notEqual(op(h, w.orders.B).cancel_requested_at, null);
    assert.equal(callsOf(h, w.orders.B, 'void').length, 0);

    setProviderAuthorization(h, w.orders.B, 'CREATED');
    const rec = reconcilerOf(h);
    await settle(h, rec);
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(callsOf(h, w.orders.B, 'void').length, 1);
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.B}:void:1`).length, 1);
    await settle(h, rec);
    assert.equal(fakeCalls(h, 'void').length, 2, 'one void per authorization, a second tick adds none');
    assert.equal(fakeCalls(h, 'capture').length, 0);
  });
});

describe('F-TR-3: an authorize that is still outstanding also blocks execute', () => {
  test('a return handler that died after its commit leaves the operation approved: execute is 409 AUTHORIZATION_PENDING until the reconciler sends the queued authorize', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const w = await world(h, { authorize: ['A'] });
    arm(h, 'crash_after_return_commit', { value: 'B' });
    h.app.deps.killProcess = () => {
      throw new Error('process killed');
    };
    assert.equal((await approveOrder(h, w, 'B')).status, 500);
    assert.equal(op(h, w.orders.B).status, 'approved');
    assert.equal(callsOf(h, w.orders.B, 'authorize')[0].started_at, null);
    const base = fakeTotal(h);
    const refused = await execute(w);
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'AUTHORIZATION_PENDING']);
    assert.equal(fakeTotal(h), base);

    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.B).status, 'authorized', 'reconciler step 6 sent the queued authorize');
    assert.equal(fakeCalls(h, 'authorize').length, 2);
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
  });

  test('a lost authorize answer leaves the operation unknown (prev approved): execute is 409 AUTHORIZATION_PENDING until the reconciler read it', async () => {
    const h = await start();
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h);
    assert.equal(op(h, w.orders.B).status, 'unknown');
    assert.equal(op(h, w.orders.B).prev_status, 'approved');
    const refused = await execute(w);
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'AUTHORIZATION_PENDING']);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0);

    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(fakeCalls(h, 'authorize').length, 2, 'the lost one and A: the authorization was read, not authorized again');
    assert.equal((await execute(w)).status, 202);
  });
});
