// API tests for ARCH-22 and the lost authorize answer (task e4-saga-reconciler; spec: Void rule, Provider call protocol §6-7,
// Rescue status derivation row 2 (r2 clauses (a) and (b))):
//   ARCH-22  an authorize whose answer was lost, then a supersession: exactly one void follows once the reconciler resolves the call
//            (the resolution hook queues so:<id>:void:1 in the same transaction as the move into `authorized`), also with two
//            reconcilers racing
//   row 2    a cancelled operation that stays non-terminal, and an approved operation whose authorize call stays outstanding, escalate
//            to failed_needs_attention after RS_PENDING_ESCALATE_MIN / RS_UNKNOWN_ESCALATE_MIN and leave it once resolved
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

// Reserved plan; only supplier A confirmed (a price change of B can still supersede it); both orders approved at the fake page.
async function world(h) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  const supplierA = await signIn(h, 'supplier-a');
  assert.equal((await supplierA.post(`/api/supplier/orders/${orders.A}/confirm`, confirmBody('A'))).status, 200);
  const w = { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
  for (const code of ['A', 'B']) {
    const res = await approveOrder(h, w, code);
    assert.ok([303, 500].includes(res.status), res.text);
  }
  return w;
}

async function approveOrder(h, w, code) {
  const created = await w.cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(`${created.json.approvalUrl}/approve`);
  const target = new URL(approved.location);
  return w.cafe1.get(target.pathname + target.search);
}

const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const callsOf = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const disarm = (h, fault) => h.db.prepare('DELETE FROM fault_flags WHERE name = ?').run(`fake_paypal:${fault}`);
const reconcilerOf = (h) => createReconciler(h.app.deps);
const statusOf = async (w) => (await w.cafe1.get(`/api/requests/${w.requestId}`)).json.rescueStatus;
const priceChangeOfB = async (h) => {
  const supplierB = await signIn(h, 'supplier-b');
  const product = h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = 'B' AND p.kind = 'bundle'").get().id;
  return supplierB.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: product, priceCents: 3700 }] } });
};

describe('ARCH-22: a lost authorize answer, then a supersession', () => {
  test('ARCH-22: exactly one void follows for the authorization the lost answer hid, even with two reconcilers racing; the re-plan queue is drained', async () => {
    const h = await start();
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['authorized', 'unknown']);
    assert.equal(op(h, w.orders.B).prev_status, 'approved');

    const changed = await priceChangeOfB(h);
    assert.equal(changed.status, 200, changed.text);
    assert.deepEqual([plan(h, w.planId).status, plan(h, w.planId).supersede_reason], ['superseded', 'PRICE_CHANGED']);
    assert.equal(op(h, w.orders.A).status, 'voided', 'the authorized one is voided right after the commit');
    assert.equal(op(h, w.orders.B).status, 'unknown', 'the unknown one resolves through the protocol');
    assert.notEqual(op(h, w.orders.B).cancel_requested_at, null);
    assert.equal(callsOf(h, w.orders.B, 'void').length, 0, 'no void exists yet: nobody knows the authorization exists');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM replan_queue').get().n, 1);

    const rec1 = reconcilerOf(h);
    const rec2 = reconcilerOf(h);
    await Promise.all([rec1.tick(), rec2.tick()]);
    await h.app.deps.saga.idle();

    assert.equal(op(h, w.orders.B).status, 'voided');
    const voids = callsOf(h, w.orders.B, 'void');
    assert.equal(voids.length, 1, 'one void call row (the UNIQUE key so:<id>:void:1)');
    assert.deepEqual([voids[0].operation_key, voids[0].status, voids[0].send_count], [`so:${w.orders.B}:void:1`, 'succeeded', 1]);
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.B}:void:1`).length, 1, 'the provider saw exactly one void for B');
    assert.equal(fakeCalls(h, 'void').length, 2, 'A and B, nothing else');
    assert.equal(fakeCalls(h, 'authorize').length, 2, 'the authorize was read, not sent again');
    assert.equal(callsOf(h, w.orders.B, 'authorize')[0].status, 'succeeded');
    assert.equal(fakeCalls(h, 'capture').length, 0);
    assert.equal(h.db.prepare("SELECT status FROM fake_paypal_authorizations WHERE id = ?").get(op(h, w.orders.B).provider_authorization_id).status, 'VOIDED');

    // step 8: the superseded request got its new plan from the queue
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM replan_queue').get().n, 0);
    const newest = h.db.prepare('SELECT status, version FROM plan_versions WHERE request_id = ? ORDER BY version DESC LIMIT 1').get(w.requestId);
    assert.deepEqual([newest.version, newest.status], [2, 'proposed']);

    await rec1.tick();
    await rec2.tick();
    assert.equal(fakeCalls(h, 'void').length, 2, 'more ticks add nothing');
    assert.equal(callsOf(h, w.orders.B, 'void').length, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'void_rule.resolution_hook'").get().n, 1);
  });

  test('ARCH-22: the lost authorize never reached the provider (a timeout): the same key is sent again, then the hook voids the authorization it created', async () => {
    const h = await start();
    arm(h, 'timeout:authorize', { value: 'B' });
    const w = await world(h);
    assert.equal(op(h, w.orders.B).status, 'unknown');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 1, 'only A was authorized');
    assert.equal((await priceChangeOfB(h)).status, 200);

    await reconcilerOf(h).tick();
    const sends = fakeCalls(h, 'authorize').filter((c) => c.request_id === `so:${w.orders.B}:authorize:1`);
    assert.equal(sends.length, 2, 'the faulted send and the re-send with the same key');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 2);
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.B}:void:1`).length, 1);
  });

  test('ARCH-22: the hidden authorization was DENIED: the operation ends authorization_failed and no void is queued', async () => {
    const h = await start();
    arm(h, 'authorize_denied', { value: 'B' });
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h);
    assert.equal((await priceChangeOfB(h)).status, 200);
    await reconcilerOf(h).tick();
    assert.equal(op(h, w.orders.B).status, 'authorization_failed');
    assert.equal(callsOf(h, w.orders.B, 'void').length, 0);
    assert.equal(fakeCalls(h, 'void').length, 1, 'only A was voided');
  });

  test('the cancelled order, abandoned by the buyer after a lost authorize answer, ends voided the same way (one void)', async () => {
    const h = await start();
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h);
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.B).status, 'unknown');
    await reconcilerOf(h).tick();
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(callsOf(h, w.orders.B, 'void').length, 1);
    assert.equal(fakeCalls(h, 'void').length, 2);
  });
});

describe('derivation row 2: a cancellation that does not finish needs attention', () => {
  test('row 2 (b): a cancelled operation still non-terminal after RS_PENDING_ESCALATE_MIN is failed_needs_attention, and leaves it once the reconciler resolves it', async () => {
    const h = await start({ RS_PENDING_ESCALATE_MIN: '5', RS_UNKNOWN_ESCALATE_MIN: '100000' });
    arm(h, 'lost_response:authorize', { value: 'B' });
    const w = await world(h);
    assert.equal((await priceChangeOfB(h)).status, 200);
    arm(h, 'http_500:get_order', { remaining: null });
    const rec = reconcilerOf(h);

    h.clock.advance(4 * 60_000);
    await rec.tick();
    assert.equal(op(h, w.orders.B).status, 'unknown', 'the read keeps failing');
    assert.notEqual((await statusOf(w)).status, 'failed_needs_attention', 'younger than the limit');

    h.clock.advance(2 * 60_000);
    await rec.tick();
    const escalated = await statusOf(w);
    assert.equal(escalated.status, 'failed_needs_attention');
    assert.equal(fakeCalls(h, 'void').filter((c) => c.request_id === `so:${w.orders.B}:void:1`).length, 0, 'still no void: nothing was read');

    disarm(h, 'http_500:get_order');
    await rec.tick();
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.notEqual((await statusOf(w)).status, 'failed_needs_attention');
  });

  test('row 2 (a): an approved operation whose queued authorize cannot be sent (429) is failed_needs_attention after RS_UNKNOWN_ESCALATE_MIN, and leaves it once sent', async () => {
    const h = await start({ RS_TEST_HOOKS: '1', RS_UNKNOWN_ESCALATE_MIN: '3', RS_PENDING_ESCALATE_MIN: '100000' });
    const cafe1 = await signIn(h, 'cafe1');
    h.clock.advance(61_000);
    const { requestId, plan: p } = await approvedPlan(cafe1, DAY);
    const reserved = await reserve(cafe1, p.id, idempotencyKey(`${requestId}-${p.id}`));
    const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
    const w = { cafe1, requestId, planId: p.id, orders };
    arm(h, 'crash_after_return_commit', { value: 'A' });
    h.app.deps.killProcess = () => {
      throw new Error('process killed');
    };
    assert.equal((await approveOrder(h, w, 'A')).status, 500);
    assert.equal(op(h, orders.A).status, 'approved');
    arm(h, 'http_429:authorize', { remaining: null });
    const rec = reconcilerOf(h);

    await rec.tick();
    assert.equal(op(h, orders.A).status, 'approved', 'a retryable answer: still queued, nothing applied');
    assert.equal(callsOf(h, orders.A, 'authorize')[0].started_at, null);
    assert.notEqual((await statusOf(w)).status, 'failed_needs_attention');

    h.clock.advance(4 * 60_000);
    await rec.tick();
    assert.equal((await statusOf(w)).status, 'failed_needs_attention', 'backstop: the authorize call has been outstanding for more than 3 minutes');

    disarm(h, 'http_429:authorize');
    h.clock.advance(6 * 60_000); // past the longest back-off
    await rec.tick();
    assert.equal(op(h, orders.A).status, 'authorized');
    assert.notEqual((await statusOf(w)).status, 'failed_needs_attention');
  });
});
