// API tests for RS-25 (task e4-saga-reconciler; spec: Provider call protocol §5-6, Payment saga step 3, Reconciler step 1-2):
//   RS-25  after a simulated lost response on a capture the operation is `unknown`; the reconciler fetches the provider state and
//          only then marks `captured` (COMPLETED), marks `capture_pending` (PENDING, polled until resolved) or re-sends with the SAME
//          PayPal-Request-Id (no capture exists at the provider); no second capture occurs; a provider call left in `intent` at a
//          restart is treated as `unknown`
//   F-TR-7 a paused plan with a capture_pending or unknown operation is not taken over and sends nothing
//   a webhook can move an operation past the state of an open call; that call is resolved, not an error
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort, startCall } from '../../src/services/calls.js';
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

// Two suppliers, both confirmed and authorized: the plan is ready to execute.
async function world(h) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of ['A', 'B']) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
    const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
  }
  return { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
}

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const captureCall = (h, orderId) => h.db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(`so:${orderId}:capture:1`);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeKinds = (h, sinceId = 0) => h.db.prepare('SELECT id, kind, request_id, replayed FROM fake_paypal_calls WHERE id > ? ORDER BY id').all(sinceId);
const lastFakeId = (h) => h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM fake_paypal_calls').get().n;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const reconcilerOf = (h) => createReconciler(h.app.deps);
const settle = async (h, rec) => {
  const summary = await rec.tick();
  await h.app.deps.saga.idle();
  return summary;
};

describe('RS-25: a lost response on a capture', () => {
  test('RS-25: the capture was applied but the answer is lost: unknown -> the reconciler READS (captured) and sends nothing again; the plan completes', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();

    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(op(h, w.orders.A).prev_status, 'authorized');
    const lost = captureCall(h, w.orders.A);
    assert.deepEqual([lost.status, lost.send_token, lost.send_count], ['unknown', null, 1]);
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(captureCall(h, w.orders.B).started_at, null, 'F-TR-7: the second capture was not started');
    assert.equal(plan(h, w.planId).status, 'executing');
    assert.equal(fakeCalls(h, 'capture').length, 1);
    const mark = lastFakeId(h);

    await settle(h, reconcilerOf(h));

    const trail = fakeKinds(h, mark);
    assert.deepEqual(
      trail.map((c) => c.kind),
      ['get_authorization', 'get_order', 'capture'],
      'read the authorization, read the order for the capture id, and only then the next order is captured',
    );
    assert.equal(trail[2].request_id, `so:${w.orders.B}:capture:1`);
    assert.equal(fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${w.orders.A}:capture:1`).length, 1, 'order A was captured once, never re-sent');
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['captured', 'captured']);
    assert.match(op(h, w.orders.A).provider_capture_id, /^FAKECAP-/);
    assert.equal(captureCall(h, w.orders.A).status, 'succeeded');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'no second capture occurred');
  });

  test('RS-25: nothing was applied (a timeout): the reconciler reads CREATED, restores authorized and the lease holder re-sends with the SAME PayPal-Request-Id', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'timeout:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 0);
    const mark = lastFakeId(h);

    await settle(h, reconcilerOf(h));

    const trail = fakeKinds(h, mark);
    // Two reads, then the two captures. Spec, saga step 6 / ARCH-26 (2) and FU-41(a) (followups.md): before the lease holder re-sends an
    // `unknown` capture it reads the authorization ITSELF under the lease; the reconciler's step-2 read (the first get_authorization)
    // is not trusted for the send (f2 handoff ho-mv41a3s6-0138e24d). The holder's read (second get_authorization) shows CREATED, so the
    // capture goes again with the SAME key; order B was never in doubt and is sent without a read.
    assert.deepEqual(trail.map((c) => c.kind), ['get_authorization', 'get_authorization', 'capture', 'capture'], 'both reads come before the re-send');
    assert.equal(trail[2].request_id, `so:${w.orders.A}:capture:1`, 'the same key');
    assert.equal(trail[2].replayed, 0);
    assert.equal(trail[3].request_id, `so:${w.orders.B}:capture:1`);
    const all = fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${w.orders.A}:capture:1`);
    assert.equal(all.length, 2, 'the faulted send and the re-send');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 2, 'one capture per authorization');
    const call = captureCall(h, w.orders.A);
    assert.deepEqual([call.status, call.send_count], ['succeeded', 2]);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
  });

  test('RS-25: the lost answer was PENDING: the reconciler marks capture_pending, polls it, and the plan resumes only after it completes', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    const rec = reconcilerOf(h);

    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.match(op(h, w.orders.A).provider_capture_id, /^FAKECAP-/);
    assert.notEqual(op(h, w.orders.A).pending_since, null);
    assert.equal(captureCall(h, w.orders.A).status, 'succeeded');
    assert.equal(captureCall(h, w.orders.B).started_at, null);
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'no takeover while the capture is pending');

    h.clock.advance(1000);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'capture_pending', 'still pending at the provider');
    assert.equal(fakeCalls(h, 'capture').length, 1);

    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED' WHERE id = ?").run(op(h, w.orders.A).provider_capture_id);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(fakeCalls(h, 'capture').length, 2);
  });

  test('RS-25: the lost answer was a DECLINED capture: the same key is re-sent, the stored answer replays (no second capture), and the plan compensates', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'A' });
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');

    await settle(h, reconcilerOf(h));

    const sends = fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${w.orders.A}:capture:1`);
    assert.deepEqual(sends.map((c) => c.replayed), [0, 1], 'the second send replayed the first answer');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1, 'no second capture');
    assert.deepEqual([plan(h, w.planId).status, plan(h, w.planId).non_executable_reason], ['non_executable', 'CAPTURE_FAILED']);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['voided', 'voided']);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(w.reservationId).status, 'released');
    assert.equal(fakeCalls(h, 'capture').length, 2, 'B was never captured');
  });
});

describe('RS-25: a call left in intent at a restart is unknown', () => {
  test('RS-25: a started capture whose sender died (nothing applied) turns unknown after 2 x the timeout, is read, restored, and re-sent by the new lease holder', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    const first = captureCall(h, w.orders.A);
    assert.ok(startCall(h.db, h.clock, first.id, { guard: null }), 'the dead process started the call and died');
    const rec = reconcilerOf(h);

    await settle(h, rec);
    assert.equal(captureCall(h, w.orders.A).status, 'intent', 'younger than 2 x the timeout: still treated as in flight');
    h.clock.advance(2 * h.config.paypalTimeoutMs + 1);
    await settle(h, rec);
    assert.equal(captureCall(h, w.orders.A).status, 'unknown', 'older than 2 x the timeout: unknown, send token cleared');
    assert.equal(captureCall(h, w.orders.A).send_token, null);
    assert.equal(captureCall(h, w.orders.A).error_code, 'STALE_INTENT');
    assert.equal(op(h, w.orders.A).status, 'authorized', 'the read found no capture: restored');
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'the lease (60 s) has not lapsed: no takeover yet');
    assert.equal(fakeCalls(h, 'capture').length, 0);

    h.clock.advance(h.config.sagaLeaseMs);
    await settle(h, rec);
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(plan(h, w.planId).lease_epoch, 2);
    assert.equal(fakeCalls(h, 'capture').filter((c) => c.request_id === `so:${w.orders.A}:capture:1`).length, 1);
    assert.equal(captureCall(h, w.orders.A).send_count, 2, 'started twice, sent once');
  });

  test('RS-25: a started capture that the provider DID apply is found by the read: captured, never sent again', async () => {
    const h = await start();
    const w = await world(h);
    h.app.deps.saga.autoRun = false;
    assert.equal((await execute(w)).status, 202);
    const call = captureCall(h, w.orders.A);
    const started = startCall(h.db, h.clock, call.id, { guard: null });
    // the request reached the provider before the process died
    const sent = await h.app.deps.payments.captureAuthorization({
      merchantKey: started.op.merchant_key, requestId: call.operation_key, authorizationId: started.op.provider_authorization_id,
      amountCents: started.op.order_total_cents, currency: 'USD',
    });
    assert.equal(sent.kind, 'ok');
    h.clock.advance(2 * h.config.paypalTimeoutMs + h.config.sagaLeaseMs);
    await settle(h, reconcilerOf(h));
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.A).provider_capture_id, sent.value.captureId);
    assert.equal(fakeCalls(h, 'capture').filter((c) => c.request_id === call.operation_key).length, 1, 'no second capture for A');
    assert.equal(plan(h, w.planId).status, 'executed');
  });
});

describe('F-TR-7 and the unreadable provider', () => {
  test('F-TR-7: while an operation is unknown the plan is not taken over and nothing is sent; a read that fails leaves the call unknown until the next tick', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    arm(h, 'http_500:get_authorization', { remaining: null });
    const rec = reconcilerOf(h);
    const mark = lastFakeId(h);
    h.clock.advance(h.config.sagaLeaseMs * 3);
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'unknown');
    assert.equal(captureCall(h, w.orders.A).status, 'unknown');
    assert.equal(plan(h, w.planId).lease_epoch, 1, 'lease_epoch does not grow while an operation is unknown');
    assert.deepEqual(fakeKinds(h, mark).map((c) => c.kind), ['get_authorization'], 'one failed read, no send');

    // Row 2 of the derivation: an unknown older than RS_UNKNOWN_ESCALATE_MIN needs attention.
    h.clock.advance((h.config.unknownEscalateMin + 1) * 60_000);
    await settle(h, rec);
    assert.equal((await w.cafe1.get(`/api/requests/${w.requestId}`)).json.rescueStatus.status, 'failed_needs_attention');

    h.db.prepare("DELETE FROM fault_flags WHERE name = 'fake_paypal:http_500:get_authorization'").run();
    await settle(h, rec);
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(fakeCalls(h, 'capture').length, 2);
    assert.equal((await w.cafe1.get(`/api/requests/${w.requestId}`)).json.rescueStatus.status, 'purchase_confirmed');
  });

  test('a webhook that already moved the operation to captured: the open call is resolved (no error) and the plan completes', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const applied = h.db.prepare('SELECT id FROM fake_paypal_captures').get();
    // what the webhook route does: unknown -> captured with the capture id, unknown_since cleared, the call row left alone
    h.db.prepare("UPDATE payment_operations SET status = 'captured', provider_capture_id = ?, unknown_since = NULL WHERE supplier_order_id = ?").run(applied.id, w.orders.A);
    assert.equal(captureCall(h, w.orders.A).status, 'unknown');

    await settle(h, reconcilerOf(h));
    assert.equal(captureCall(h, w.orders.A).status, 'succeeded');
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(h.logEntries().filter((l) => l.level === 'error').length, 0, 'no error was logged');
  });

  test('the saga re-reads the operation after its capture call: a webhook that captured it meanwhile is accepted as done', async () => {
    const h = await start();
    const w = await world(h);
    const real = h.app.deps.payments;
    h.app.deps.payments = {
      ...real,
      async captureAuthorization(args) {
        const outcome = await real.captureAuthorization(args);
        if (args.requestId === `so:${w.orders.A}:capture:1`) {
          h.db.prepare("UPDATE payment_operations SET status = 'captured', provider_capture_id = ? WHERE supplier_order_id = ?").run(outcome.value.captureId, w.orders.A);
        }
        return outcome;
      },
    };
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(plan(h, w.planId).status, 'executed');
    assert.equal(captureCall(h, w.orders.A).status, 'succeeded');
    assert.equal(fakeCalls(h, 'capture').length, 2);
    assert.equal(h.logEntries().filter((l) => l.level === 'error').length, 0);
  });
});
