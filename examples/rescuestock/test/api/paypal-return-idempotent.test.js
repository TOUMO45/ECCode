// API tests for GET /api/paypal/return (task e2-payment-flow, spec: Return handler and authorization). Case names start with the
// criterion id:
//   RS-20  three repeated hits on the return URL for one supplier order produce exactly one authorize call
//   RS-27  the return URL with another customer's (or an unknown) PayPal token is 404 before any provider call
//   F-TR-3 a process that dies between the commit and the authorize send leaves a queued call that is sent later, exactly once
// plus the mapping of the authorize answers (CREATED, PENDING, retryable, unknown) and the redirects.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort, queueCall, recordCall, sendDueCalls, startCall } from '../../src/services/calls.js';
import { expireDueReservations } from '../../src/services/reservations.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
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

async function buyer(h, username = 'cafe1') {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function reservedPlan(h, client) {
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(client, DAY);
  const res = await reserve(client, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(res.status, 201, res.text);
  return { requestId, plan, orders: res.json.orders };
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

// create -> the buyer clicks "Approve (simulated)" on the fake page -> the path of the return URL the page redirects to
async function approvedReturnPath(h, client, orderId) {
  const created = await client.post(`/api/orders/${orderId}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(`${created.json.approvalUrl}/approve`);
  assert.equal(approved.status, 303);
  const target = new URL(approved.location);
  assert.equal(target.origin, `http://localhost:${h.port}`);
  assert.equal(target.pathname, '/api/paypal/return');
  assert.equal(target.searchParams.get('PayerID'), 'FAKEPAYER');
  return { path: target.pathname + target.search, token: target.searchParams.get('token'), approvalUrl: created.json.approvalUrl };
}

const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const calls = (h, orderId, kind) =>
  h.db.prepare('SELECT * FROM provider_calls WHERE payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?) AND kind = ? ORDER BY attempt').all(orderId, kind);
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const fakeTotal = (h) => h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);

describe('RS-20: the return URL authorizes exactly once', () => {
  test('RS-20: three hits (refresh, back-navigation) produce exactly one authorize call, and only the first reads the order', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    const expected = `/#/requests/${requestId}?paypal=returned&order=${orders[0].id}`;
    const base = fakeTotal(h);

    for (let hit = 1; hit <= 3; hit += 1) {
      const res = await cafe1.get(path);
      assert.equal(res.status, 303, res.text);
      assert.equal(res.headers.location, expected);
      assert.equal(res.text, '', 'a redirect has no body');
    }
    assert.equal(fakeCalls(h, 'authorize').length, 1, 'exactly one authorize call');
    assert.equal(fakeCalls(h, 'get_order').length, 1, 'refresh and back-navigation make no provider call at all');
    assert.equal(fakeTotal(h) - base, 2, 'one read and one authorize');
    const [authorize] = calls(h, orders[0].id, 'authorize');
    assert.deepEqual([authorize.operation_key, authorize.status, authorize.send_count], [`so:${orders[0].id}:authorize:1`, 'succeeded', 1]);
    assert.equal(fakeCalls(h, 'authorize')[0].request_id, `so:${orders[0].id}:authorize:1`);
    const row = op(h, orders[0].id);
    assert.equal(row.status, 'authorized');
    assert.match(row.provider_authorization_id, /^FAKEAUTH-/);
    assert.equal(row.authorization_expires_at, new Date(h.clock.now() + 29 * 24 * 3600 * 1000).toISOString());
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'capture'").get().n, 0, 'nothing is captured');

    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.deepEqual(view.orders.map((o) => o.payment.status), ['authorized', 'created']);
    assert.equal(view.orders[0].payment.approvalUrl, null);
    assert.notEqual(view.orders[0].payment.authorizationExpiresAt, null);
  });

  test('RS-20: three concurrent hits still produce exactly one authorize call (only the CAS winner queues it)', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    const results = await Promise.all([cafe1.get(path), cafe1.get(path), cafe1.get(path)]);
    assert.deepEqual(results.map((r) => r.status), [303, 303, 303]);
    assert.equal(fakeCalls(h, 'authorize').length, 1);
    assert.equal(calls(h, orders[0].id, 'authorize').length, 1);
    assert.equal(op(h, orders[0].id).status, 'authorized');
  });

  test('a PENDING authorization leaves the operation authorization_pending with pending_since (the reconciler polls it)', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'authorize_pending');
    assert.equal((await cafe1.get(path)).status, 303);
    const row = op(h, orders[0].id);
    assert.equal(row.status, 'authorization_pending');
    assert.equal(row.pending_since, new Date(h.clock.now()).toISOString());
    assert.match(row.provider_authorization_id, /^FAKEAUTH-/);
    assert.equal(calls(h, orders[0].id, 'authorize')[0].status, 'succeeded');
  });

  test('an order the buyer did not approve is a 303 with paypal=not_approved: no authorize call, the operation stays created', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { requestId, orders } = await reservedPlan(h, cafe1);
    const created = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    const token = created.json.approvalUrl.split('/').pop();
    const res = await cafe1.get(`/api/paypal/return?token=${token}&PayerID=FAKEPAYER`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `/#/requests/${requestId}?paypal=not_approved&order=${orders[0].id}`);
    assert.equal(fakeCalls(h, 'authorize').length, 0);
    assert.equal(op(h, orders[0].id).status, 'created');
    assert.equal(calls(h, orders[0].id, 'authorize').length, 0);
  });
});

describe('RS-27: the return URL belongs to the buyer', () => {
  test('RS-27: another customer\'s token, an unknown token and a replaced token are 404 with no provider call and no state change', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const cafe2 = await buyer(h, 'cafe2');
    const { orders } = await reservedPlan(h, cafe1);
    const { path, token } = await approvedReturnPath(h, cafe1, orders[0].id);
    const before = { total: fakeTotal(h), op: { ...op(h, orders[0].id) }, calls: h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls').get().n };

    for (const url of [path, '/api/paypal/return?token=FAKE-00000000000000000000000000000000', `/api/paypal/return?token=${token.toLowerCase()}x`]) {
      const res = await cafe2.get(url);
      assert.equal(res.status, 404, `${url}: ${res.text}`);
      assert.equal(res.json.error.code, 'NOT_FOUND');
      assert.equal(res.json.error.details, undefined);
    }
    assert.equal(fakeTotal(h), before.total, 'the fake saw no call, not even a read');
    assert.deepEqual({ ...op(h, orders[0].id) }, before.op);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM provider_calls').get().n, before.calls);

    // The owner's own hit is unaffected.
    assert.equal((await cafe1.get(path)).status, 303);
    assert.equal(op(h, orders[0].id).status, 'authorized');
  });

  test('anonymous callers are redirected to sign-in with no state change; suppliers get 403; a missing or malformed token is 400', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    const base = fakeTotal(h);
    const anonymous = await createClient(h.request).get(path);
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.location, '/#/signin?notice=paypal-return');
    const supplier = await buyer(h, 'supplier-a');
    const forbidden = await supplier.get(path);
    assert.deepEqual([forbidden.status, forbidden.json.error.code], [403, 'FORBIDDEN']);
    for (const url of ['/api/paypal/return', '/api/paypal/return?token=', '/api/paypal/return?token=a%20b', `/api/paypal/return?token=${'x'.repeat(65)}`]) {
      const res = await cafe1.get(url);
      assert.deepEqual([res.status, res.json.error.code], [400, 'BAD_REQUEST'], url);
    }
    assert.equal(fakeTotal(h), base);
    assert.equal(op(h, orders[0].id).status, 'created');
  });
});

describe('F-TR-3: the authorize call survives a dead process, a retryable answer and a lost response', () => {
  test('crash_after_return_commit: the handler dies after created -> approved; the queued authorize is sent once by sendDueCalls (reconciler step 6)', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const cafe1 = await buyer(h);
    const { requestId, orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'crash_after_return_commit');
    h.app.deps.killProcess = () => {
      throw new Error('process killed');
    };
    const died = await cafe1.get(path);
    assert.equal(died.status, 500);
    assert.equal(died.json.error.code, 'INTERNAL');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM fault_flags WHERE name = 'fake_paypal:crash_after_return_commit'").get().n, 0, 'the hook fired once');
    assert.equal(op(h, orders[0].id).status, 'approved');
    const [queued] = calls(h, orders[0].id, 'authorize');
    assert.deepEqual([queued.status, queued.started_at, queued.send_count], ['intent', null, 0]);
    assert.equal(fakeCalls(h, 'authorize').length, 0, 'nothing was sent');

    const sent = await sendDueCalls(h.app.deps);
    assert.deepEqual(sent.map((s) => s.state), ['recorded']);
    assert.equal(op(h, orders[0].id).status, 'authorized');
    assert.equal(fakeCalls(h, 'authorize').length, 1);
    assert.deepEqual(await sendDueCalls(h.app.deps), [], 'a second tick has nothing to send');
    assert.equal(fakeCalls(h, 'authorize').length, 1);

    // A new hit after the recovery is a plain refresh: a 303 and no provider call.
    h.app.deps.killProcess = () => process.kill(process.pid, 'SIGKILL');
    const base = fakeTotal(h);
    const hit = await cafe1.get(path);
    assert.equal(hit.status, 303);
    assert.equal(hit.headers.location, `/#/requests/${requestId}?paypal=returned&order=${orders[0].id}`);
    assert.equal(fakeTotal(h), base);
  });

  test('the hook is ignored without RS_TEST_HOOKS: the armed fault stays and the authorize is sent at once', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'crash_after_return_commit');
    h.app.deps.killProcess = () => {
      throw new Error('must not be called');
    };
    assert.equal((await cafe1.get(path)).status, 303);
    assert.equal(op(h, orders[0].id).status, 'authorized');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM fault_flags WHERE name = 'fake_paypal:crash_after_return_commit'").get().n, 1);
  });

  test('crash, then the reservation expires before the reconciler: the queued call ends cancelled, the operation voided locally, zero authorize calls', async () => {
    const h = await start({ RS_TEST_HOOKS: '1' });
    const cafe1 = await buyer(h);
    const { requestId, plan, orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'crash_after_return_commit');
    h.app.deps.killProcess = () => {
      throw new Error('process killed');
    };
    assert.equal((await cafe1.get(path)).status, 500);

    h.clock.advance(31 * 60 * 1000);
    assert.equal(expireDueReservations(h.app.deps).expired.length, 1);
    assert.deepEqual(await sendDueCalls(h.app.deps), [], 'a cancelled call is not sent');
    const [call] = calls(h, orders[0].id, 'authorize');
    assert.equal(call.status, 'cancelled');
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.voided_locally], ['voided', 1]);
    assert.equal(fakeCalls(h, 'authorize').length, 0);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'non_executable');
    const view = (await cafe1.get(`/api/requests/${requestId}`)).json;
    assert.notEqual(view.rescueStatus.status, 'cancelling');
  });

  test('a retryable authorize answer (429) puts the call back to queued with a 5 s back-off; sendDueCalls sends it when due, one effective authorization', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'http_429:authorize');
    assert.equal((await cafe1.get(path)).status, 303);
    assert.equal(op(h, orders[0].id).status, 'approved');
    const [queued] = calls(h, orders[0].id, 'authorize');
    assert.deepEqual([queued.status, queued.started_at, queued.send_token, queued.send_count], ['intent', null, null, 1]);
    assert.equal(queued.next_attempt_at, new Date(h.clock.now() + 5000).toISOString());

    assert.deepEqual(await sendDueCalls(h.app.deps), [], 'not due yet');
    h.clock.advance(5000);
    const sent = await sendDueCalls(h.app.deps);
    assert.deepEqual(sent.map((s) => s.state), ['recorded']);
    assert.equal(op(h, orders[0].id).status, 'authorized');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 1);
    assert.deepEqual(fakeCalls(h, 'authorize').map((c) => [c.request_id, c.replayed]), [[`so:${orders[0].id}:authorize:1`, 0], [`so:${orders[0].id}:authorize:1`, 0]]);
    assert.equal(calls(h, orders[0].id, 'authorize')[0].send_count, 2);
  });

  test('the back-off grows 5 s, 30 s, 2 min, 5 min and stays at 5 min', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'http_429:authorize', { remaining: 6 });
    assert.equal((await cafe1.get(path)).status, 303);
    const waits = [];
    for (let round = 0; round < 5; round += 1) {
      const [call] = calls(h, orders[0].id, 'authorize');
      waits.push(Date.parse(call.next_attempt_at) - h.clock.now());
      h.clock.advance(waits[round]);
      await sendDueCalls(h.app.deps);
    }
    assert.deepEqual(waits, [5000, 30_000, 120_000, 300_000, 300_000]);
  });

  test('a lost authorize response makes the call and the operation unknown (prev_status approved); the effect was applied and nothing is re-sent here', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const { path } = await approvedReturnPath(h, cafe1, orders[0].id);
    arm(h, 'lost_response:authorize');
    assert.equal((await cafe1.get(path)).status, 303);
    const row = op(h, orders[0].id);
    assert.deepEqual([row.status, row.prev_status], ['unknown', 'approved']);
    assert.notEqual(row.unknown_since, null);
    const [call] = calls(h, orders[0].id, 'authorize');
    assert.deepEqual([call.status, call.send_token], ['unknown', null]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_authorizations').get().n, 1);
    assert.deepEqual(await sendDueCalls(h.app.deps), [], 'an unknown call is resolved by reading first (reconciler), never re-sent blindly');
    assert.equal(fakeCalls(h, 'authorize').length, 1);
  });
});

describe('the call protocol (src/services/calls.js): queue, start CAS, record fence', () => {
  async function queuedAuthorize() {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const row = op(h, orders[0].id);
    const queued = h.db.tx(() => queueCall(h.db, h.clock, { operationId: row.id, supplierOrderId: orders[0].id, kind: 'authorize', attempt: 1 }));
    return { h, row, orderId: orders[0].id, queued };
  }

  test('queue: INSERT OR IGNORE by operation_key so:<id>:<kind>:<attempt> is exactly-once, and a queued call has started_at NULL', async () => {
    const { h, row, orderId, queued } = await queuedAuthorize();
    assert.equal(queued.inserted, true);
    assert.deepEqual(
      [queued.call.operation_key, queued.call.status, queued.call.started_at, queued.call.send_token, queued.call.send_count, queued.call.attempt],
      [`so:${orderId}:authorize:1`, 'intent', null, null, 0, 1],
    );
    const again = h.db.tx(() => queueCall(h.db, h.clock, { operationId: row.id, supplierOrderId: orderId, kind: 'authorize', attempt: 1 }));
    assert.equal(again.inserted, false);
    assert.equal(again.call.id, queued.call.id);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'authorize'").get().n, 1);
    const next = h.db.tx(() => queueCall(h.db, h.clock, { operationId: row.id, supplierOrderId: orderId, kind: 'authorize', attempt: 2 }));
    assert.equal(next.inserted, true);
    assert.equal(next.call.operation_key, `so:${orderId}:authorize:2`);
  });

  test('start: the CAS on status = intent AND started_at IS NULL admits one sender, sets send_token, started_at and send_count', async () => {
    const { h, row, queued } = await queuedAuthorize();
    h.db.prepare("UPDATE payment_operations SET status = 'approved' WHERE id = ?").run(row.id);
    const first = startCall(h.db, h.clock, queued.call.id);
    const second = startCall(h.db, h.clock, queued.call.id);
    assert.ok(first && first.token.length === 32);
    assert.equal(second, null, 'the second sender stops');
    const stored = h.db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(queued.call.id);
    assert.deepEqual([stored.send_token, stored.send_count, stored.status], [first.token, 1, 'intent']);
    assert.equal(stored.started_at, new Date(h.clock.now()).toISOString());
  });

  test('start: a call whose operation can no longer use it is not started (guard runs inside the start transaction)', async () => {
    const { h, queued } = await queuedAuthorize();
    // the operation is still `created`, so an authorize is not sendable
    const { runCall } = await import('../../src/services/calls.js');
    assert.deepEqual((await runCall(h.app.deps, queued.call.id)).state, 'not_started');
    assert.equal(h.db.prepare('SELECT started_at FROM provider_calls WHERE id = ?').get(queued.call.id).started_at, null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n, 0);
  });

  test('record: the result is written WHERE send_token = ?; a call that was taken over discards the late result and logs provider.result_fenced', async () => {
    const { h, row, queued } = await queuedAuthorize();
    h.db.prepare("UPDATE payment_operations SET status = 'approved', provider_order_id = 'FAKE-x' WHERE id = ?").run(row.id);
    const mine = startCall(h.db, h.clock, queued.call.id);
    // a taker marks the call unknown (stale intent) and clears the token, as the reconciler does
    h.db.prepare("UPDATE provider_calls SET status = 'unknown', send_token = NULL, unknown_since = ? WHERE id = ?").run(new Date(h.clock.now()).toISOString(), queued.call.id);
    const late = recordCall(h.app.deps, {
      callId: queued.call.id, token: mine.token,
      outcome: { kind: 'ok', httpStatus: 201, value: { authorizationId: 'FAKEAUTH-late', status: 'CREATED', expirationTime: '2026-11-18T06:00:00.000Z' } },
      apply: () => assert.fail('a fenced result must not be applied'),
    });
    assert.deepEqual(late, { fenced: true });
    const stored = h.db.prepare('SELECT status, send_token, finished_at FROM provider_calls WHERE id = ?').get(queued.call.id);
    assert.deepEqual({ ...stored }, { status: 'unknown', send_token: null, finished_at: null });
    assert.equal(op(h, h.db.prepare('SELECT supplier_order_id FROM provider_calls pc JOIN payment_operations po ON po.id = pc.payment_operation_id WHERE pc.id = ?').get(queued.call.id).supplier_order_id).status, 'approved');
    assert.ok(h.logEntries().some((e) => e.msg === 'provider.result_fenced' && e.level === 'warn'));

    // and the right token is accepted exactly once
    const taker = startCall(h.db, h.clock, queued.call.id, { resendUnknown: true });
    assert.ok(taker);
    const done = recordCall(h.app.deps, { callId: queued.call.id, token: taker.token, outcome: { kind: 'rejected', httpStatus: 422, issue: 'ORDER_NOT_APPROVED' }, apply: () => null });
    assert.equal(done.fenced, false);
    assert.deepEqual(recordCall(h.app.deps, { callId: queued.call.id, token: taker.token, outcome: { kind: 'rejected', httpStatus: 422, issue: 'X' }, apply: () => null }), { fenced: true }, 'a second record with the same token is refused');
  });

  test('a send that throws is recorded as unknown (never an unhandled error), and the call is sent again only after it is resolved', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const { orders } = await reservedPlan(h, cafe1);
    const real = h.app.deps.payments;
    h.app.deps.payments = { ...real, async createOrder() { throw new Error('boom'); } };
    const res = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    assert.equal(res.status, 503, res.text);
    const [call] = calls(h, orders[0].id, 'create_order');
    assert.deepEqual([call.status, call.send_token, call.error_code], ['unknown', null, 'NETWORK']);
    assert.ok(h.logEntries().some((e) => e.msg === 'provider.send_threw'));
    assert.equal(JSON.stringify(h.logEntries()).includes('boom'), false, 'no error text reaches the log');
  });
});

describe('SEC-E-2: the public return and cancel URLs are limited per signed-in user before any provider call', () => {
  const LIMIT = 30; // per window; one hit on an unapproved order is one provider getOrder

  test('SEC-E-2: hit LIMIT + 1 of one buyer is 429 RATE_LIMITED with Retry-After and makes no provider call; another buyer, an anonymous caller and the next window are unaffected', async () => {
    const h = await start();
    const cafe1 = await buyer(h);
    const cafe2 = await buyer(h, 'cafe2');
    const { orders } = await reservedPlan(h, cafe1);
    const created = await cafe1.post(`/api/orders/${orders[0].id}/paypal/create`, {});
    const token = created.json.approvalUrl.split('/').pop();
    const url = `/api/paypal/return?token=${token}&PayerID=FAKEPAYER`; // never approved at the provider: each hit reads the order
    const reads = () => fakeCalls(h, 'get_order').length;

    for (let hit = 1; hit <= LIMIT; hit += 1) {
      const res = await cafe1.get(url);
      assert.equal(res.status, 303, `hit ${hit}`);
    }
    assert.equal(reads(), LIMIT);
    const refused = await cafe1.get(url);
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(refused.json.error.details, { limit: 'general' });
    assert.equal(refused.headers['retry-after'], '60');
    assert.equal(reads(), LIMIT, 'the refused hit made no provider call');
    assert.equal((await cafe1.get(`/api/paypal/cancel?token=${token}`)).status, 429, 'cancel shares the count');
    assert.equal(op(h, orders[0].id).buyer_cancelled_at, null, 'and changed nothing');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE user_key = ?').get(`pp:u:${cafe1.user.id}`).n, LIMIT, 'a refused hit is not recorded');

    // another buyer: own count (a foreign token is 404, not 429); anonymous hits stay on the redirect path
    assert.equal((await cafe2.get(url)).status, 404);
    const anonymous = await createClient(h.request).get(url);
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.location, '/#/signin?notice=paypal-return');
    assert.equal(reads(), LIMIT);

    h.clock.advance(61_000);
    assert.equal((await cafe1.get(url)).status, 303, 'the next window starts clean');
    assert.equal(reads(), LIMIT + 1);
  });
});
