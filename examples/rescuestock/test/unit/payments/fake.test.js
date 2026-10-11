// src/payments/fake.js: the DB-backed fake payment adapter, over a real SQLite file. The shared contract suite
// (provider-contract.test.js) covers the PaymentProvider behaviour; this file covers what is specific to the fake: its state in
// fake_paypal_*, the (merchant_key, request_id) replay model, call counting, the fault_flags vocabulary, the RS_TEST_HOOKS-only
// faults, labelling, the SEC-5 webhook key and the signature scheme. A SIMULATION; nothing here is PayPal.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret, loadConfig } from '../../../src/config.js';
import { fixedClock, isoFromMs } from '../../../src/clock.js';
import { openDb } from '../../../src/db/connection.js';
import { getMeta } from '../../../src/db/meta.js';
import { migrate } from '../../../src/db/migrate.js';
import { createLogger } from '../../../src/log.js';
import {
  AUTHORIZATION_TTL_MS, FAKE_HOOK_FAULTS, FAKE_SCENARIO_FAULTS, approveFakeOrder, createFakeProvider, fakeWebhookSignature,
  parseFakeFault, takeFakePaypalFault,
} from '../../../src/payments/fake.js';
import { assertPaymentProvider } from '../../../src/payments/provider.js';
import { STUB_START_MS } from '../../helpers/paypal-stub.js';
import { FAKE_WEBHOOK_SECRET, buildEvent, signEvent, tamperBody } from '../../helpers/webhook-signer.js';

const RETURN_URL = 'http://localhost:3000/api/paypal/return';
const CANCEL_URL = 'http://localhost:3000/api/paypal/cancel';
const DAY_MS = 24 * 60 * 60 * 1000;

let dir;
let seq = 5000;
const opened = [];

before(() => { dir = mkdtempSync(join(tmpdir(), 'rs-fake-unit-')); });
after(() => {
  for (const db of opened) { try { db.close(); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

function world({ testHooks = false, freeze, webhookSecret, busyTimeoutMs, file } = {}) {
  const path = file ?? join(dir, `fake-${(seq += 1)}.db`);
  const clock = fixedClock(STUB_START_MS);
  const db = openDb(path, busyTimeoutMs === undefined ? undefined : { busyTimeoutMs });
  opened.push(db);
  migrate(db, { clock });
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), clock, requestId: 'fake-test' });
  const provider = createFakeProvider({ db, clock, log, testHooks, freeze, webhookSecret, approvalOrigin: 'http://127.0.0.1:4555' });
  const rid = (kind) => `so:${(seq += 1)}:${kind}:1`;
  const flag = (fault, { value = '', remaining = 1 } = {}) => {
    db.prepare('INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, ?)')
      .run(`fake_paypal:${fault}`, value, remaining, isoFromMs(clock.now()));
  };
  const calls = () => db.prepare('SELECT * FROM fake_paypal_calls ORDER BY id').all();
  const okv = (outcome, what = 'call') => {
    assert.equal(outcome.kind, 'ok', `${what}: ${outcome.kind} ${outcome.issue ?? outcome.reason ?? ''}`);
    return outcome.value;
  };
  const M = 'A';
  const order = async (amountCents = 1250, requestId = rid('create_order'), merchantKey = M) => okv(await provider.createOrder({
    merchantKey, requestId, amountCents, currency: 'USD', referenceId: `so-${seq}`, returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
  }), 'createOrder');
  const authorized = async (amountCents = 1250, merchantKey = M) => {
    const o = await order(amountCents, rid('create_order'), merchantKey);
    approveFakeOrder(db, o.orderId);
    const a = okv(await provider.authorizeOrder({ merchantKey, requestId: rid('authorize'), orderId: o.orderId }), 'authorize');
    return { orderId: o.orderId, authorizationId: a.authorizationId, amountCents, merchantKey };
  };
  const capture = (w, requestId = rid('capture'), amountCents = w.amountCents) => provider.captureAuthorization({
    merchantKey: w.merchantKey ?? M, requestId, authorizationId: w.authorizationId, amountCents, currency: 'USD', invoiceId: 'rs-so-1-cap',
  });
  const refund = (w, requestId = rid('refund'), amountCents = w.amountCents) => provider.refundCapture({
    merchantKey: w.merchantKey ?? M, requestId, captureId: w.captureId, amountCents, currency: 'USD',
  });
  return { db, clock, provider, lines, rid, flag, calls, okv, order, authorized, capture, refund, path, M };
}

describe('the fake as a PaymentProvider', () => {
  test('it is the port: id fake, simulated, not sandbox; every ok payload is labelled simulated: true', async () => {
    const w = world();
    assertPaymentProvider(w.provider);
    assert.deepEqual([w.provider.id, w.provider.simulated, w.provider.sandbox], ['fake', true, false]);
    const a = await w.authorized();
    const cap = w.okv(await w.capture(a));
    const ref = w.okv(await w.refund({ ...a, captureId: cap.captureId }));
    const reads = [
      await w.provider.getOrder({ merchantKey: w.M, orderId: a.orderId }),
      await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId }),
      await w.provider.getCapture({ merchantKey: w.M, captureId: cap.captureId }),
      await w.provider.getRefund({ merchantKey: w.M, refundId: ref.refundId }),
    ];
    for (const value of [cap, ref, ...reads.map((r) => w.okv(r))]) {
      assert.equal(value.simulated, true);
      assert.equal(value.provider, 'fake');
    }
  });

  test('every fake_paypal_* row is stored with simulated = 1', async () => {
    const w = world();
    const a = await w.authorized();
    const cap = w.okv(await w.capture(a));
    w.okv(await w.refund({ ...a, captureId: cap.captureId }));
    for (const table of ['fake_paypal_orders', 'fake_paypal_authorizations', 'fake_paypal_captures', 'fake_paypal_refunds']) {
      const rows = w.db.prepare(`SELECT simulated FROM ${table}`).all();
      assert.ok(rows.length > 0, `${table} has a row`);
      assert.ok(rows.every((r) => r.simulated === 1), `${table} rows are labelled simulated`);
    }
  });

  test('the approval URL points at the listener origin and carries only the unguessable fake order id (FAKE- + 32 hex)', async () => {
    const w = world();
    const o = await w.order();
    assert.match(o.orderId, /^FAKE-[0-9a-f]{32}$/);
    assert.equal(o.approvalUrl, `http://127.0.0.1:4555/fake-paypal/checkout/${o.orderId}`);
    assert.doesNotMatch(o.approvalUrl, /return|cancel|localhost:3000/);
  });

  test('bad arguments are rejected 400 INVALID_ARGUMENT before anything is stored or counted', async () => {
    const w = world();
    const good = { merchantKey: w.M, requestId: w.rid('create_order'), amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL };
    const bad = [
      { ...good, merchantKey: 'Z' }, { ...good, requestId: '' }, { ...good, requestId: 'x'.repeat(109) }, { ...good, requestId: 'a b' },
      { ...good, amountCents: 0 }, { ...good, amountCents: 12.5 }, { ...good, amountCents: -1 }, { ...good, amountCents: 1e12 },
      { ...good, currency: 'EUR' }, { ...good, referenceId: 'so 1' }, { ...good, returnUrl: 'javascript:alert(1)' },
      { ...good, cancelUrl: 'http://user:pw@localhost/x' }, { ...good, returnUrl: `http://localhost/${'x'.repeat(2100)}` }, null,
    ];
    for (const args of bad) {
      const outcome = await w.provider.createOrder(args);
      assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 400, 'INVALID_ARGUMENT']);
    }
    assert.deepEqual((await w.provider.getOrder({ merchantKey: w.M, orderId: '../etc/passwd' })).issue, 'INVALID_ARGUMENT');
    assert.equal((await w.provider.verifyWebhook({ merchantKey: w.M, headers: {}, rawBody: 'x'.repeat(70000) })).issue, 'INVALID_ARGUMENT');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 0);
    assert.equal(w.calls().length, 0, 'a call that never reached the provider is not counted');
  });

  test('createOrder takes the attempt like the Sandbox adapter: the fake stores no invoice id, a re-create (attempt 2) is a new order, a bad attempt is rejected the same way', async () => {
    const w = world();
    const base = { merchantKey: w.M, amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL };
    const first = await w.provider.createOrder({ ...base, requestId: 'so:1:create_order:1', attempt: 1 });
    const second = await w.provider.createOrder({ ...base, requestId: 'so:1:create_order:2', attempt: 2 });
    assert.deepEqual([first.kind, second.kind], ['ok', 'ok']);
    assert.notEqual(first.value.orderId, second.value.orderId);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 2);
    assert.equal(JSON.stringify(second.value).includes('rs-so-1'), false, 'no invoice id appears in the answer');
    for (const attempt of [0, -1, 1.5, 1000, '2', NaN]) {
      const outcome = await w.provider.createOrder({ ...base, requestId: 'so:1:create_order:3', attempt });
      assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 400, 'INVALID_ARGUMENT'], String(attempt));
    }
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 2, 'a rejected attempt stored nothing');
  });

  test('a resource belongs to its merchant: another merchant key sees 404 for it and cannot change it', async () => {
    const w = world();
    const a = await w.authorized(1250, 'A');
    const other = (extra) => ({ merchantKey: 'B', ...extra });
    assert.equal((await w.provider.getOrder(other({ orderId: a.orderId }))).kind, 'rejected');
    assert.equal((await w.provider.getAuthorization(other({ authorizationId: a.authorizationId }))).httpStatus, 404);
    assert.equal((await w.provider.voidAuthorization(other({ requestId: w.rid('void'), authorizationId: a.authorizationId }))).httpStatus, 404);
    assert.equal((await w.provider.captureAuthorization(other({ requestId: w.rid('capture'), authorizationId: a.authorizationId, amountCents: 1250, currency: 'USD' }))).httpStatus, 404);
    assert.equal(w.db.prepare('SELECT status FROM fake_paypal_authorizations WHERE id = ?').get(a.authorizationId).status, 'CREATED');
  });
});

describe('replay by (merchant_key, request_id)', () => {
  test('the same request id returns the stored answer with replayed = 1 and applies nothing twice', async () => {
    const w = world();
    const a = await w.authorized();
    const requestId = w.rid('capture');
    const first = w.okv(await w.capture(a, requestId));
    const second = w.okv(await w.capture(a, requestId));
    assert.equal(second.captureId, first.captureId);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1);
    const rows = w.calls().filter((c) => c.kind === 'capture');
    assert.deepEqual(rows.map((c) => c.replayed), [0, 1]);
    assert.deepEqual(rows.map((c) => c.request_id), [requestId, requestId]);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_requests WHERE request_id = ?').get(requestId).n, 1);
  });

  test('the key is per merchant: the same request id under another merchant is a different request', async () => {
    const w = world();
    const requestId = w.rid('create_order');
    const a = await w.order(1250, requestId, 'A');
    const b = await w.order(1250, requestId, 'B');
    assert.notEqual(a.orderId, b.orderId);
    assert.equal(w.calls().filter((c) => c.replayed === 1).length, 0);
  });

  test('a request id used for another kind is 422 REQUEST_ID_KIND_MISMATCH and nothing is applied', async () => {
    const w = world();
    const a = await w.authorized();
    const requestId = w.rid('capture');
    w.okv(await w.capture(a, requestId));
    const clash = await w.provider.voidAuthorization({ merchantKey: w.M, requestId, authorizationId: a.authorizationId });
    assert.deepEqual([clash.kind, clash.httpStatus, clash.issue], ['rejected', 422, 'REQUEST_ID_KIND_MISMATCH']);
    assert.equal(w.db.prepare('SELECT status FROM fake_paypal_authorizations WHERE id = ?').get(a.authorizationId).status, 'CAPTURED');
  });

  test('only ok answers are stored: a rejected call can be retried under the same request id', async () => {
    const w = world();
    const o = await w.order();
    const requestId = w.rid('authorize');
    const early = await w.provider.authorizeOrder({ merchantKey: w.M, requestId, orderId: o.orderId });
    assert.equal(early.issue, 'ORDER_NOT_APPROVED');
    approveFakeOrder(w.db, o.orderId);
    w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId, orderId: o.orderId }));
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_requests').get().n, 2, 'create_order and authorize, not the rejection');
  });

  test('state is shared through the database file: another provider (a second process) replays the same answer', async () => {
    const w = world();
    const second = world({ file: w.path });
    const a = await w.authorized();
    const requestId = w.rid('capture');
    const first = w.okv(await w.capture(a, requestId));
    const replay = w.okv(await second.capture(a, requestId));
    assert.equal(replay.captureId, first.captureId);
    const other = await second.capture(a); // another request id after the capture
    assert.equal(other.issue, 'AUTHORIZATION_ALREADY_CAPTURED');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1);
  });
});

describe('definitive answers of the spec', () => {
  test('a capture on an authorization already CAPTURED is 422 AUTHORIZATION_ALREADY_CAPTURED', async () => {
    const w = world();
    const a = await w.authorized();
    w.okv(await w.capture(a));
    const again = await w.capture(a);
    assert.deepEqual([again.kind, again.httpStatus, again.issue], ['rejected', 422, 'AUTHORIZATION_ALREADY_CAPTURED']);
  });

  test('a refund on a fully refunded capture is 422 CAPTURE_FULLY_REFUNDED; partial refunds add up to the capture', async () => {
    const w = world();
    const a = await w.authorized(1000);
    const c = { ...a, captureId: w.okv(await w.capture(a)).captureId };
    w.okv(await w.refund(c, w.rid('refund'), 400));
    assert.equal(w.okv(await w.provider.getCapture({ merchantKey: w.M, captureId: c.captureId })).status, 'COMPLETED', 'a partial refund leaves it COMPLETED');
    const over = await w.refund(c, w.rid('refund'), 601);
    assert.equal(over.issue, 'REFUND_AMOUNT_EXCEEDED');
    w.okv(await w.refund(c, w.rid('refund'), 600));
    assert.equal(w.okv(await w.provider.getCapture({ merchantKey: w.M, captureId: c.captureId })).status, 'REFUNDED');
    const full = await w.refund(c);
    assert.deepEqual([full.kind, full.httpStatus, full.issue], ['rejected', 422, 'CAPTURE_FULLY_REFUNDED']);
  });

  test('a capture cannot exceed the authorized amount, and a PENDING or DECLINED capture cannot be refunded', async () => {
    const w = world();
    const a = await w.authorized(1000);
    assert.equal((await w.capture(a, w.rid('capture'), 1001)).issue, 'AUTHORIZATION_AMOUNT_EXCEEDED');
    w.flag('capture_pending');
    const pending = { ...a, captureId: w.okv(await w.capture(a)).captureId };
    assert.equal((await w.refund(pending)).issue, 'CAPTURE_NOT_COMPLETED');
  });

  test('an order that is not approved cannot be authorized; a second authorize is ORDER_ALREADY_AUTHORIZED', async () => {
    const w = world();
    const o = await w.order();
    assert.equal((await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId })).issue, 'ORDER_NOT_APPROVED');
    approveFakeOrder(w.db, o.orderId);
    w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId }));
    assert.equal((await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId })).issue, 'ORDER_ALREADY_AUTHORIZED');
  });
});

describe('authorization expiry', () => {
  test('expiration_time is created + 29 days; the clock passing it makes the authorization EXPIRED and uncapturable', async () => {
    const w = world();
    const o = await w.order();
    approveFakeOrder(w.db, o.orderId);
    const a = w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId }));
    assert.equal(a.status, 'CREATED');
    assert.equal(Date.parse(a.expirationTime), STUB_START_MS + 29 * DAY_MS);
    assert.equal(AUTHORIZATION_TTL_MS, 29 * DAY_MS);
    w.clock.advance(29 * DAY_MS - 1);
    assert.equal(w.okv(await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId })).status, 'CREATED');
    w.clock.advance(1);
    assert.equal(w.okv(await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId })).status, 'EXPIRED');
    assert.equal(w.db.prepare('SELECT status FROM fake_paypal_authorizations WHERE id = ?').get(a.authorizationId).status, 'EXPIRED');
    const late = await w.capture({ authorizationId: a.authorizationId, amountCents: 1250 });
    assert.equal(late.issue, 'AUTHORIZATION_EXPIRED');
    const v = await w.provider.voidAuthorization({ merchantKey: w.M, requestId: w.rid('void'), authorizationId: a.authorizationId });
    assert.equal(v.issue, 'AUTHORIZATION_EXPIRED');
  });

  test('auth_expire: the authorization is created already expired (status CREATED in the answer, EXPIRED on every read)', async () => {
    const w = world();
    const o = await w.order();
    approveFakeOrder(w.db, o.orderId);
    w.flag('auth_expire');
    const a = w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId }));
    assert.equal(a.status, 'CREATED');
    assert.equal(Date.parse(a.expirationTime), STUB_START_MS);
    assert.equal(w.okv(await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId })).status, 'EXPIRED');
    assert.equal(w.okv(await w.provider.getOrder({ merchantKey: w.M, orderId: o.orderId })).authorizations[0].status, 'EXPIRED');
  });
});

describe('every call is counted in fake_paypal_calls', () => {
  test('reads, rejections and faulted calls are counted, with kind, merchant, request id, resource and pid', async () => {
    const w = world();
    const a = await w.authorized(); // create_order + authorize
    await w.provider.getOrder({ merchantKey: w.M, orderId: a.orderId });
    await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId });
    const c = w.okv(await w.capture(a));
    await w.provider.getCapture({ merchantKey: w.M, captureId: c.captureId });
    await w.capture(a); // rejected
    w.flag('timeout:get_refund');
    await w.provider.getRefund({ merchantKey: w.M, refundId: 'FAKEREF-none' }); // faulted
    const r = w.okv(await w.refund({ ...a, captureId: c.captureId }));
    await w.provider.getRefund({ merchantKey: w.M, refundId: r.refundId });
    const signed = signEvent({ event: buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED' }), secret: FAKE_WEBHOOK_SECRET });
    await w.provider.verifyWebhook({ merchantKey: w.M, headers: signed.headers, rawBody: signed.rawBody });
    const kinds = w.calls().map((row) => row.kind);
    assert.deepEqual(kinds, [
      'create_order', 'authorize', 'get_order', 'get_authorization', 'capture', 'get_capture', 'capture', 'get_refund', 'refund', 'get_refund', 'verify_webhook',
    ]);
    const rows = w.calls();
    assert.ok(rows.every((row) => row.merchant_key === 'A' && row.pid === process.pid && row.replayed === 0));
    assert.equal(rows[4].request_id.endsWith(':capture:1'), true);
    assert.equal(rows[4].resource_id, c.captureId, 'a call that creates a resource records its id');
    assert.equal(rows[6].resource_id, a.authorizationId, 'a rejected capture records the authorization it addressed');
    assert.equal(rows[2].request_id, null, 'a read has no request id');
    assert.equal(rows[2].resource_id, a.orderId);
    assert.match(rows[0].at, /^2026-10-20T06:00:00\.000Z$/);
  });

  test('RS-20 shape: N captures of N orders give exactly N get_authorization and N capture rows when nothing else is called', async () => {
    const w = world();
    const worlds = [await w.authorized(500, 'A'), await w.authorized(700, 'B')];
    w.db.prepare('DELETE FROM fake_paypal_calls').run();
    for (const a of worlds) {
      await w.provider.getAuthorization({ merchantKey: a.merchantKey, authorizationId: a.authorizationId });
      w.okv(await w.capture(a));
    }
    const counts = Object.fromEntries(w.db.prepare('SELECT kind, COUNT(*) AS n FROM fake_paypal_calls GROUP BY kind').all().map((r) => [r.kind, r.n]));
    assert.deepEqual(counts, { get_authorization: 2, capture: 2 });
  });

  test('the provider logs only allow-listed fields: no ids of resources, no URLs, no secrets', async () => {
    const w = world();
    const a = await w.authorized();
    await w.capture(a);
    await w.capture(a);
    const text = w.lines.join('');
    assert.ok(w.lines.length >= 3);
    for (const marker of [a.orderId, a.authorizationId, RETURN_URL, 'localhost:3000']) assert.equal(text.includes(marker), false, `${marker} is not logged`);
    for (const line of w.lines) assert.equal(JSON.parse(line).provider, 'fake');
  });
});

describe('faults (fault_flags rows named fake_paypal:<fault>)', () => {
  test('the vocabulary: every fault of the spec parses, the test-only ones are hooks, unknown names do not', () => {
    for (const name of ['authorize_denied', 'authorize_pending', 'capture_declined', 'capture_pending', 'refund_pending', 'refund_failed', 'void_fail', 'auth_expire', 'order_not_approvable']) {
      assert.equal(parseFakeFault(name)?.family, 'scenario', name);
      assert.ok(FAKE_SCENARIO_FAULTS.includes(name));
    }
    for (const kind of ['create_order', 'authorize', 'capture', 'void', 'refund']) {
      for (const prefix of ['lost_response', 'timeout', 'http_500']) assert.equal(parseFakeFault(`${prefix}:${kind}`)?.family, 'transport', `${prefix}:${kind}`);
    }
    for (const name of ['freeze_after_capture_apply', 'freeze_before_capture_apply', 'capture_lands_after_void_intent', 'crash_after_return_commit']) {
      assert.equal(parseFakeFault(name)?.family, 'hook', name);
      assert.ok(FAKE_HOOK_FAULTS.includes(name));
    }
    for (const name of ['', 'nonsense', 'timeout:token', 'lost_response:capture ', 'http_200:capture', 'http_500:nothing', 'authorize_denied:capture', 7, null]) {
      assert.equal(parseFakeFault(name), null, String(name));
    }
  });

  test('scenario faults: denied, pending, declined, capture pending, refund pending and failed, void_fail', async () => {
    const w = world();
    const mk = async () => {
      const o = await w.order();
      approveFakeOrder(w.db, o.orderId);
      return o;
    };
    w.flag('authorize_denied');
    const o1 = await mk();
    assert.equal(w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o1.orderId })).status, 'DENIED');
    w.flag('authorize_pending');
    const o2 = await mk();
    const pendingAuth = w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o2.orderId }));
    assert.equal(pendingAuth.status, 'PENDING');
    assert.equal((await w.capture({ authorizationId: pendingAuth.authorizationId, amountCents: 1250 })).issue, 'AUTHORIZATION_PENDING');
    const a = await w.authorized();
    w.flag('capture_declined');
    assert.equal(w.okv(await w.capture(a)).status, 'DECLINED');
    assert.equal(w.db.prepare('SELECT status FROM fake_paypal_authorizations WHERE id = ?').get(a.authorizationId).status, 'CREATED');
    w.flag('void_fail');
    assert.equal((await w.provider.voidAuthorization({ merchantKey: w.M, requestId: w.rid('void'), authorizationId: a.authorizationId })).issue, 'AUTHORIZATION_CANNOT_BE_VOIDED');
    const c = { ...a, captureId: w.okv(await w.capture(a)).captureId };
    w.flag('refund_pending');
    assert.equal(w.okv(await w.refund(c)).status, 'PENDING');
    assert.equal((await w.refund(c)).issue, 'CAPTURE_FULLY_REFUNDED', 'a pending refund already holds the amount');
    const b = await w.authorized(500);
    const d = { ...b, captureId: w.okv(await w.capture(b)).captureId };
    w.flag('refund_failed');
    assert.equal(w.okv(await w.refund(d)).status, 'FAILED');
    assert.equal(w.okv(await w.refund(d)).status, 'COMPLETED', 'a failed refund does not hold the amount');
  });

  test('order_not_approvable: createOrder stores approvable = 0 and the approval step refuses', async () => {
    const w = world();
    w.flag('order_not_approvable');
    const o = await w.order();
    assert.equal(w.db.prepare('SELECT approvable FROM fake_paypal_orders WHERE id = ?').get(o.orderId).approvable, 0);
    assert.equal(approveFakeOrder(w.db, o.orderId).result, 'not_approvable');
    assert.equal(w.db.prepare('SELECT status FROM fake_paypal_orders WHERE id = ?').get(o.orderId).status, 'CREATED');
    const next = await w.order();
    assert.equal(approveFakeOrder(w.db, next.orderId).result, 'approved', 'the fault was used up by one order');
  });

  for (const kind of ['create_order', 'authorize', 'capture', 'void', 'refund']) {
    test(`timeout:${kind} and http_500:${kind} apply nothing; lost_response:${kind} applies the effect and a retry with the same request id replays it`, async () => {
      const w = world();
      const call = async (state, requestId) => {
        switch (kind) {
          case 'create_order': return w.provider.createOrder({ merchantKey: w.M, requestId, amountCents: 900, currency: 'USD', referenceId: 'so-9', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
          case 'authorize': return w.provider.authorizeOrder({ merchantKey: w.M, requestId, orderId: state.orderId });
          case 'capture': return w.capture(state, requestId);
          case 'void': return w.provider.voidAuthorization({ merchantKey: w.M, requestId, authorizationId: state.authorizationId });
          default: return w.refund(state, requestId);
        }
      };
      const prepare = async () => {
        if (kind === 'create_order') return {};
        if (kind === 'authorize') { const o = await w.order(900); approveFakeOrder(w.db, o.orderId); return { orderId: o.orderId }; }
        const a = await w.authorized(900);
        if (kind === 'refund') return { ...a, captureId: w.okv(await w.capture(a)).captureId };
        return a;
      };
      const effects = (state) => {
        const sql = {
          create_order: 'SELECT COUNT(*) AS n FROM fake_paypal_orders',
          authorize: `SELECT COUNT(*) AS n FROM fake_paypal_authorizations WHERE order_id = '${state.orderId}'`,
          capture: 'SELECT COUNT(*) AS n FROM fake_paypal_captures',
          void: `SELECT COUNT(*) AS n FROM fake_paypal_authorizations WHERE status = 'VOIDED'`,
          refund: 'SELECT COUNT(*) AS n FROM fake_paypal_refunds',
        }[kind];
        return w.db.prepare(sql).get().n;
      };
      const state = await prepare();
      const baseline = effects(state);
      w.flag(`timeout:${kind}`);
      const t = await call(state, w.rid(kind));
      assert.deepEqual([t.kind, t.reason], ['unknown', 'timeout']);
      assert.equal(effects(state), baseline, 'timeout applied nothing');
      w.flag(`http_500:${kind}`);
      const h = await call(state, w.rid(kind));
      assert.deepEqual([h.kind, h.reason], ['unknown', 'http_5xx']);
      assert.equal(effects(state), baseline, 'http_500 applied nothing');
      const requestId = w.rid(kind);
      w.flag(`lost_response:${kind}`);
      const lost = await call(state, requestId);
      assert.deepEqual([lost.kind, lost.reason], ['unknown', 'network']);
      assert.equal(effects(state), baseline + 1, 'lost_response applied the effect');
      const retry = await call(state, requestId);
      assert.equal(retry.kind, 'ok');
      assert.equal(effects(state), baseline + 1, 'the retry replayed, it did not apply twice');
      assert.equal(w.calls().filter((c) => c.kind === kind && c.replayed === 1).length, 1);
    });
  }

  test('a fault with remaining N affects the next N matching calls and is then deleted; NULL stays until cleared', async () => {
    const w = world();
    w.flag('http_500:get_order', { remaining: 2 });
    const o = await w.order();
    const read = () => w.provider.getOrder({ merchantKey: w.M, orderId: o.orderId });
    assert.equal((await read()).reason, 'http_5xx');
    assert.equal(w.db.prepare("SELECT remaining FROM fault_flags WHERE name = 'fake_paypal:http_500:get_order'").get().remaining, 1);
    assert.equal((await read()).reason, 'http_5xx');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fault_flags').get().n, 0);
    assert.equal((await read()).kind, 'ok');
    w.flag('http_500:get_order', { remaining: null });
    for (let i = 0; i < 4; i += 1) assert.equal((await read()).reason, 'http_5xx');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fault_flags').get().n, 1, 'a NULL count stays');
    w.db.prepare('DELETE FROM fault_flags').run();
    assert.equal((await read()).kind, 'ok');
  });

  test('a fault is scoped by its value: supplier code A affects merchant A only', async () => {
    const w = world();
    w.flag('http_500:create_order', { value: 'A', remaining: 1 });
    const args = (merchantKey) => ({ merchantKey, requestId: w.rid('create_order'), amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
    assert.equal((await w.provider.createOrder(args('B'))).kind, 'ok', 'merchant B is unaffected and does not consume it');
    assert.equal((await w.provider.createOrder(args('A'))).reason, 'http_5xx');
    assert.equal((await w.provider.createOrder(args('A'))).kind, 'ok');
  });

  test('other transport faults of the grammar: http_429 retryable, http_422 rejected, bad_body applies the effect', async () => {
    const w = world();
    const o = await w.order();
    w.flag('http_429:get_order');
    assert.deepEqual(await w.provider.getOrder({ merchantKey: w.M, orderId: o.orderId }), { kind: 'retryable', httpStatus: 429, issue: 'RATE_LIMIT_REACHED' });
    w.flag('http_422:get_order');
    assert.equal((await w.provider.getOrder({ merchantKey: w.M, orderId: o.orderId })).httpStatus, 422);
    const requestId = w.rid('create_order');
    w.flag('bad_body:create_order');
    assert.deepEqual(await w.provider.createOrder({ merchantKey: w.M, requestId, amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL }), { kind: 'unknown', reason: 'bad_body' });
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 2, 'the order exists');
  });

  test('a busy database is a retryable Outcome that applied nothing, not an exception', async () => {
    const w = world({ busyTimeoutMs: 0 });
    const holder = openDb(w.path, { busyTimeoutMs: 0 });
    opened.push(holder);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const outcome = await w.provider.createOrder({ merchantKey: w.M, requestId: w.rid('create_order'), amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
      assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['retryable', 429, 'FAKE_DB_BUSY']);
    } finally {
      holder.exec('ROLLBACK');
    }
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 0);
    assert.equal((await w.provider.createOrder({ merchantKey: w.M, requestId: w.rid('create_order'), amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL })).kind, 'ok');
  });
});

describe('RS_TEST_HOOKS-only faults', () => {
  test('without testHooks the hook faults are ignored and left in place', async () => {
    const frozen = [];
    const w = world({ testHooks: false, freeze: () => frozen.push('freeze') });
    for (const name of ['freeze_after_capture_apply', 'freeze_before_capture_apply', 'capture_lands_after_void_intent']) w.flag(name);
    const a = await w.authorized();
    w.okv(await w.provider.voidAuthorization({ merchantKey: w.M, requestId: w.rid('void'), authorizationId: a.authorizationId }));
    const b = await w.authorized();
    w.okv(await w.capture(b));
    assert.deepEqual(frozen, []);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fault_flags').get().n, 3, 'nothing was consumed');
  });

  test('freeze_after_capture_apply: the capture is applied and committed, THEN the process freezes; the result is still returned', async () => {
    const seen = [];
    const w = world({ testHooks: true });
    const frozenAt = () => ({
      captures: w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n,
      captureCalls: w.calls().filter((c) => c.kind === 'capture').length,
      inTx: w.db.inTx,
    });
    const hooked = world({ testHooks: true, file: w.path, freeze: () => seen.push(frozenAt()) });
    const a = await w.authorized();
    w.flag('freeze_after_capture_apply');
    const requestId = w.rid('capture');
    const outcome = await hooked.capture(a, requestId);
    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(seen, [{ captures: 1, captureCalls: 1, inTx: false }]);
    // The same request id again (the frozen sender resuming) replays and does not freeze again.
    await hooked.capture(a, requestId);
    assert.equal(seen.length, 1);
  });

  test('freeze_before_capture_apply: the freeze happens before the call is applied or counted; the call then applies as a replay if another sender won', async () => {
    const seen = [];
    const w = world({ testHooks: true });
    const a = await w.authorized();
    const requestId = w.rid('capture');
    let winner = null;
    const hooked = world({
      testHooks: true, file: w.path,
      freeze: () => {
        seen.push({ captures: w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, captureCalls: w.calls().filter((c) => c.kind === 'capture').length });
        winner = w.provider.captureAuthorization({ merchantKey: w.M, requestId, authorizationId: a.authorizationId, amountCents: 1250, currency: 'USD' }); // process 2
      },
    });
    w.flag('freeze_before_capture_apply');
    const resumed = await hooked.capture(a, requestId);
    const first = await winner;
    assert.deepEqual(seen, [{ captures: 0, captureCalls: 0 }]);
    assert.equal(first.kind, 'ok');
    assert.equal(resumed.value.captureId, first.value.captureId);
    const rows = w.calls().filter((c) => c.kind === 'capture');
    assert.deepEqual(rows.map((c) => c.replayed), [0, 1], 'exactly one non-replayed capture');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_captures').get().n, 1);
  });

  test('capture_lands_after_void_intent: the void finds the authorization CAPTURED and answers 422 AUTHORIZATION_ALREADY_CAPTURED (F-TR-6)', async () => {
    const w = world({ testHooks: true });
    const a = await w.authorized();
    w.flag('capture_lands_after_void_intent');
    const v = await w.provider.voidAuthorization({ merchantKey: w.M, requestId: w.rid('void'), authorizationId: a.authorizationId });
    assert.deepEqual([v.kind, v.httpStatus, v.issue], ['rejected', 422, 'AUTHORIZATION_ALREADY_CAPTURED']);
    assert.equal(w.okv(await w.provider.getAuthorization({ merchantKey: w.M, authorizationId: a.authorizationId })).status, 'CAPTURED');
    const order = w.okv(await w.provider.getOrder({ merchantKey: w.M, orderId: a.orderId }));
    assert.equal(order.captures.length, 1);
    assert.equal(order.captures[0].status, 'COMPLETED');
    const captureId = order.captures[0].id;
    // The compensation path: refund it.
    const refund = w.okv(await w.refund({ ...a, captureId }));
    assert.equal(refund.status, 'COMPLETED');
    assert.equal(w.okv(await w.provider.getCapture({ merchantKey: w.M, captureId })).status, 'REFUNDED');
    const voidCalls = w.calls().filter((c) => c.kind === 'void');
    assert.equal(voidCalls.length, 1);
  });

  test('capture_lands_after_void_intent is only consumed when the void would otherwise apply (an already captured authorization keeps it armed)', async () => {
    const w = world({ testHooks: true });
    const a = await w.authorized();
    w.okv(await w.capture(a));
    w.flag('capture_lands_after_void_intent');
    const v = await w.provider.voidAuthorization({ merchantKey: w.M, requestId: w.rid('void'), authorizationId: a.authorizationId });
    assert.equal(v.issue, 'AUTHORIZATION_ALREADY_CAPTURED');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fault_flags').get().n, 1);
  });

  test('takeFakePaypalFault (the return handler\'s crash hook) consumes crash_after_return_commit once, only with testHooks, and by supplier scope', () => {
    const w = world();
    w.flag('crash_after_return_commit', { value: 'C', remaining: 2 });
    assert.equal(takeFakePaypalFault(w.db, 'crash_after_return_commit', { merchantKey: 'C', testHooks: false }), false);
    assert.equal(takeFakePaypalFault(w.db, 'crash_after_return_commit', { merchantKey: 'B', testHooks: true }), false);
    assert.equal(takeFakePaypalFault(w.db, 'crash_after_return_commit', { merchantKey: 'C', testHooks: true }), true);
    assert.equal(takeFakePaypalFault(w.db, 'crash_after_return_commit', { merchantKey: 'C', testHooks: true }), true);
    assert.equal(takeFakePaypalFault(w.db, 'crash_after_return_commit', { merchantKey: 'C', testHooks: true }), false);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fault_flags').get().n, 0);
  });
});

describe('the approval step', () => {
  test('CREATED -> APPROVED once (CAS); approving again is already_approved; a completed order is invalid_state; an unknown id is not_found', async () => {
    const w = world();
    const o = await w.order();
    assert.equal(approveFakeOrder(w.db, o.orderId).result, 'approved');
    assert.equal(approveFakeOrder(w.db, o.orderId).result, 'already_approved');
    w.okv(await w.provider.authorizeOrder({ merchantKey: w.M, requestId: w.rid('authorize'), orderId: o.orderId }));
    assert.equal(approveFakeOrder(w.db, o.orderId).result, 'invalid_state');
    assert.equal(approveFakeOrder(w.db, 'FAKE-00000000000000000000000000000000').result, 'not_found');
    assert.equal(approveFakeOrder(w.db, "x'; DROP TABLE fake_paypal_orders; --").result, 'not_found');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_orders').get().n, 1);
  });
});

describe('the webhook key (SEC-5) and the signature scheme', () => {
  test('with no configured secret the key is generated ONCE into meta and shared by every provider on the database', async () => {
    const w = world();
    assert.equal(getMeta(w.db, 'fake_webhook_secret'), null, 'nothing is generated before it is needed');
    const signed = signEvent({ event: buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED' }), secret: 'not-the-generated-secret-0123456789abcdef' });
    assert.equal(w.okv(await w.provider.verifyWebhook({ merchantKey: w.M, headers: signed.headers, rawBody: signed.rawBody })).verified, false);
    const key = getMeta(w.db, 'fake_webhook_secret');
    assert.match(key, /^[0-9a-f]{64}$/, '32 random bytes');
    const second = world({ file: w.path });
    const good = signEvent({ event: buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED' }), secret: key });
    assert.equal(w.okv(await second.provider.verifyWebhook({ merchantKey: w.M, headers: good.headers, rawBody: good.rawBody })).verified, true);
    assert.equal(getMeta(w.db, 'fake_webhook_secret'), key, 'unchanged');
  });

  test('a configured secret (RS_FAKE_WEBHOOK_SECRET, as a Secret or a string) is used and nothing is written to meta', async () => {
    for (const secret of [new Secret(FAKE_WEBHOOK_SECRET), FAKE_WEBHOOK_SECRET, () => FAKE_WEBHOOK_SECRET]) {
      const w = world({ webhookSecret: secret });
      const signed = signEvent({ event: buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED' }), secret: FAKE_WEBHOOK_SECRET });
      assert.equal(w.okv(await w.provider.verifyWebhook({ merchantKey: w.M, headers: signed.headers, rawBody: signed.rawBody })).verified, true);
      assert.equal(getMeta(w.db, 'fake_webhook_secret'), null);
    }
  });

  test('the scheme is the test signer\'s: base64(HMAC-SHA256(secret, id|time|sha256hex(body))), over the exact bytes', async () => {
    const w = world({ webhookSecret: FAKE_WEBHOOK_SECRET });
    const signed = signEvent({ rawBody: '{ "id":"WH-1",  "event_type":"X" }', secret: FAKE_WEBHOOK_SECRET });
    assert.equal(signed.headers['paypal-transmission-sig'], fakeWebhookSignature(FAKE_WEBHOOK_SECRET, {
      transmissionId: signed.transmissionId, transmissionTime: signed.headers['paypal-transmission-time'], rawBody: signed.rawBody,
    }));
    const verify = (headers, rawBody) => w.provider.verifyWebhook({ merchantKey: w.M, headers, rawBody });
    assert.equal(w.okv(await verify(signed.headers, signed.rawBody)).verified, true);
    assert.equal(w.okv(await verify(signed.headers, signed.rawBody.toString('utf8'))).verified, true, 'a string body is its UTF-8 bytes');
    assert.equal(w.okv(await verify(signed.headers, tamperBody(signed.rawBody))).verified, false);
    assert.equal(w.okv(await verify(signed.headers, Buffer.from(JSON.stringify(JSON.parse(signed.rawBody.toString()))))).verified, false, 're-serialised bytes differ');
    assert.equal(w.okv(await verify({ ...signed.headers, 'paypal-transmission-id': 'TX-000000009999' }, signed.rawBody)).verified, false);
    assert.equal(w.okv(await verify({ ...signed.headers, 'paypal-transmission-time': '2026-10-20T06:00:01.000Z' }, signed.rawBody)).verified, false);
    assert.equal(w.okv(await verify({ ...signed.headers, 'paypal-transmission-sig': 'AAAA' }, signed.rawBody)).verified, false);
    const { 'paypal-cert-url': _drop, ...missing } = signed.headers;
    assert.equal(w.okv(await verify(missing, signed.rawBody)).verified, false);
    assert.equal(w.okv(await verify(null, signed.rawBody)).verified, false);
  });
});
