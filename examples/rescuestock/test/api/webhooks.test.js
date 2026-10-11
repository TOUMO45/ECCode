// API tests for POST /api/webhooks/paypal/:merchantKey (task e3-webhooks). Case names start with the criterion id:
//   RS-23  a valid duplicate transmission id -> 200 {outcome: "duplicate"} with no effect; dedupe only among valid rows
//   RS-24  a failed verification -> `invalid` row, 400 WEBHOOK_SIGNATURE_INVALID, no transition; unreachable -> `unverified`, 503
//   SEC-6  60 requests per IP per minute -> 429 with no row; every cheap pre-check rejects before any provider call
//   SEC-16 an event maps only to an operation of the URL's merchant, of the active adapter and not archived
//   T13    forged events cannot pre-empt a genuine transmission id; the stored payload is a minimised summary (no payer data)
//   ARCH-22 the resolution hook queues the void of a cancelled operation turning authorized, exactly once
// Valid events are signed with test/helpers/webhook-signer.js (the HMAC scheme of the DB-backed fake). The provider calls are
// counted in fake_paypal_calls (kind verify_webhook). No PayPal host is contacted (the net guard would stop the process) and the
// certificate URL of an event is never fetched.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { startPaypalStub } from '../helpers/paypal-stub.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { blockedAttempts } from '../helpers/net-guard.js';
import { FAKE_WEBHOOK_SECRET, PAYER_MARKERS, buildEvent, signEvent, tamperBody } from '../helpers/webhook-signer.js';
import { ALLOWED_KEYS } from '../../src/log.js';
import { createNoopProvider, createVoidRule } from '../../src/services/void-rule.js';
import { createVoidPort } from '../../src/services/calls.js';
import { WEBHOOK_EVENTS, WEBHOOK_RATE_LIMIT, precheck, summarise, webhookAlgos } from '../../src/services/webhooks.js';
import { ok as okOutcome, rejected as rejectedOutcome } from '../../src/payments/provider.js';

const DAY = '2026-10-20';
const SECRET_ENV = { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_FAKE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET };
const harnesses = [];
const stubs = [];
after(async () => {
  for (const h of harnesses) await h.close();
  for (const s of stubs) await s.close();
});

const iso = (ms) => new Date(ms).toISOString();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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

// One harness with one reserved plan (supplier orders A and B, payment operations `created`) shared by most tests; each test
// starts from `fresh()`: empty webhook tables, the original provider and void rule, both operations back to `created`.
let sharedWorld = null;
async function world() {
  if (!sharedWorld) {
    sharedWorld = (async () => {
      const h = await startHarness({ seed: true, env: SECRET_ENV });
      harnesses.push(h);
      const { orders } = await reservedPlan(h, await buyer(h));
      const merchants = Object.fromEntries(orders.map((o) => [o.id, h.db.prepare('SELECT merchant_key FROM payment_operations WHERE supplier_order_id = ?').get(o.id).merchant_key]));
      return { h, orders, merchants, payments: h.app.deps.payments, voidRule: h.app.deps.voidRule };
    })();
  }
  return sharedWorld;
}

async function fresh() {
  const w = await world();
  const { h } = w;
  h.app.deps.payments = w.payments;
  h.app.deps.voidRule = w.voidRule;
  for (const sql of [
    'DELETE FROM webhook_events', "DELETE FROM rate_events WHERE kind = 'webhook'", 'DELETE FROM fake_paypal_calls',
    "DELETE FROM provider_calls WHERE kind = 'void'",
  ]) h.db.prepare(sql).run();
  // audit_events is append-only: a test sees only the rows written after its own start.
  auditFloor = h.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_events').get().id;
  for (const order of w.orders) {
    h.db.prepare(
      "UPDATE payment_operations SET status = 'created', prev_status = NULL, unknown_since = NULL, provider_order_id = NULL, provider_authorization_id = NULL, " +
        "provider_capture_id = NULL, provider_refund_id = NULL, cancel_requested_at = NULL, cancel_reason = NULL, archived_at = NULL, " +
        "authorization_expires_at = NULL, provider = 'fake', merchant_key = ?, voided_locally = 0, void_failed = 0, updated_at = '2026-10-20T06:00:00.000Z' WHERE supplier_order_id = ?",
    ).run(w.merchants[order.id], order.id);
  }
  return w;
}

const COLUMNS = new Set([
  'status', 'prev_status', 'unknown_since', 'provider_order_id', 'provider_authorization_id', 'provider_capture_id', 'provider_refund_id',
  'cancel_requested_at', 'cancel_reason', 'archived_at', 'provider', 'merchant_key', 'authorization_expires_at',
]);
// Test set-up only: puts an operation into a state with the ids a webhook will name.
function setOp(h, orderId, patch) {
  const names = Object.keys(patch);
  for (const n of names) assert.ok(COLUMNS.has(n), `set-up column ${n}`);
  h.db.prepare(`UPDATE payment_operations SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE supplier_order_id = ?`).run(...names.map((n) => patch[n]), orderId);
}
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const rows = (h) => h.db.prepare('SELECT * FROM webhook_events ORDER BY id').all();
const fakeCalls = (h) => h.db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
const verifyCalls = (h) => h.db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE kind = 'verify_webhook'").get().n;
const voidCalls = (h) => h.db.prepare("SELECT operation_key FROM provider_calls WHERE kind = 'void' ORDER BY id").all().map((r) => r.operation_key);
let auditFloor = 0;
const auditRows = (h, action = 'webhook.apply') => h.db.prepare('SELECT * FROM audit_events WHERE action = ? AND id > ? ORDER BY id').all(action, auditFloor);
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);

let counter = 0;
const uid = (prefix) => `${prefix}-${String((counter += 1)).padStart(6, '0')}`;

// Signs `event` (or raw bytes) with the transmission time of the harness clock.
function sign(h, input, overrides = {}) {
  const base = input.rawBody !== undefined ? { rawBody: input.rawBody } : { event: input };
  return signEvent({ ...base, transmissionTime: iso(h.clock.now()), ...overrides });
}

// POST to the webhook route. Unless `throttled`, the per-IP counter is emptied first so that tests do not count each other.
async function post(h, key, signed, { headers = {}, throttled = false } = {}) {
  if (!throttled) h.db.prepare("DELETE FROM rate_events WHERE kind = 'webhook'").run();
  const res = await h.request({
    method: 'POST', path: `/api/webhooks/paypal/${key}`, record: false, body: signed.rawBody,
    headers: { 'Content-Type': 'application/json', ...signed.headers, ...headers },
  });
  // Every JSON answer carries the request id (API conventions); the contract's {outcome} is what the tests compare, so on a
  // 200 the id is split off (the first test pins that it equals the X-Request-Id header).
  if (res.status === 200 && res.json && typeof res.json.requestId === 'string') {
    res.requestId = res.json.requestId;
    delete res.json.requestId;
  }
  return res;
}

const authorizationEvent = (type, resource, extra = {}) => buildEvent({ eventType: type, resource: { status: 'CREATED', ...resource }, ...extra });

function assertEnvelope(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.json.error.code, code);
  assert.deepEqual(Object.keys(res.json.error).sort(), ['code', 'message', 'requestId'], 'no details, no echo of input');
}

// ---- access ----------------------------------------------------------------------------------------------------------------

describe('route and access', () => {
  test('T13/ARCH-25: the route is registered with policy signature; an anonymous POST with no cookie, no CSRF token and a foreign Origin is judged by the signature alone', async () => {
    const { h, orders } = await fresh();
    const listed = h.app.router.list().filter((r) => r.template === '/api/webhooks/paypal/:merchantKey');
    assert.deepEqual(listed, [{ method: 'POST', template: '/api/webhooks/paypal/:merchantKey', policy: 'signature' }]);
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_order_id: uid('ORD'), provider_authorization_id: authId });
    const res = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId })), { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { outcome: 'applied' });
    assert.equal(res.requestId, res.headers['x-request-id'], 'the 200 body is {outcome} plus the request id of every JSON answer');
    assert.equal(res.headers['set-cookie'], undefined, 'no session is created or touched');
    assert.equal(op(h, orders[0].id).status, 'authorized');
  });

  test('T13: a merchantKey that is not configured is 404 before the body is read: no row, no provider call, no counter', async () => {
    const { h } = await fresh();
    for (const key of ['Z', 'F', 'a', 'AA', 'A%20', 'null']) {
      const res = await post(h, key, sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: uid('AUTH') })), { throttled: true });
      assert.equal(res.status, 404, `${key}: ${res.text}`);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    }
    assert.equal(rows(h).length, 0);
    assert.equal(fakeCalls(h), 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'webhook'").get().n, 0);
  });

  test('T13: only POST is routed (GET is 405 with Allow: POST)', async () => {
    const { h } = await fresh();
    const res = await h.request({ method: 'GET', path: '/api/webhooks/paypal/A', record: false });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
  });
});

// ---- body size -------------------------------------------------------------------------------------------------------------

describe('raw body limit', () => {
  test('SEC-6: a body of exactly 65,536 bytes is read, verified as bytes and accepted; 65,537 bytes is 413 with no row and no provider call', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const json = JSON.stringify(authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const exact = Buffer.from(json + ' '.repeat(65_536 - Buffer.byteLength(json)));
    assert.equal(exact.length, 65_536);
    const accepted = await post(h, 'A', sign(h, { rawBody: exact }));
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(accepted.json, { outcome: 'applied' });
    assert.equal(rows(h)[0].payload_sha256, sha256(exact));

    const before = [rows(h).length, fakeCalls(h)];
    const tooBig = await post(h, 'A', sign(h, { rawBody: Buffer.from(json + ' '.repeat(65_537 - Buffer.byteLength(json))) }));
    assertEnvelope(tooBig, 413, 'PAYLOAD_TOO_LARGE');
    assert.deepEqual([rows(h).length, fakeCalls(h)], before);
  });
});

// ---- pre-checks ------------------------------------------------------------------------------------------------------------

describe('SEC-6: cheap pre-checks reject before any provider call', () => {
  const NOT_JSON = 'BODY_NOT_JSON_OBJECT';
  const NOT_MAPPED = 'EVENT_TYPE_NOT_MAPPED';
  const wrongBodyCases = [
    ['an empty body', Buffer.alloc(0), NOT_JSON],
    ['text that is not JSON', Buffer.from('definitely not json'), NOT_JSON],
    ['a JSON array', Buffer.from('[]'), NOT_JSON],
    ['a JSON string', Buffer.from('"PAYMENT.AUTHORIZATION.CREATED"'), NOT_JSON],
    ['an object without event_type', Buffer.from('{"resource":{"id":"X"}}'), NOT_MAPPED],
    ['an event_type that is not a string', Buffer.from('{"event_type":42}'), NOT_MAPPED],
    ['an event_type that is not mapped, even with a valid signature', Buffer.from('{"event_type":"CUSTOMER.DISPUTE.CREATED","resource":{"id":"X"}}'), NOT_MAPPED],
    ['an event_type with another case', Buffer.from('{"event_type":"payment.authorization.created"}'), NOT_MAPPED],
    ['an event_type that is an inherited property name', Buffer.from('{"event_type":"constructor"}'), NOT_MAPPED],
    ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), NOT_JSON],
    ['JSON nested 40 levels deep', Buffer.from(`{"event_type":"PAYMENT.AUTHORIZATION.CREATED","resource":${'['.repeat(40)}${']'.repeat(40)}}`), NOT_JSON],
  ];

  const headerCases = [
    ...['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'].map((name) => ({
      title: `header ${name} missing`, reason: 'HEADER_MISSING', mutate: (s) => { delete s.headers[name]; },
    })),
    { title: 'header paypal-transmission-sig empty', reason: 'HEADER_MISSING', mutate: (s) => { s.headers['paypal-transmission-sig'] = ''; } },
    { title: 'header paypal-transmission-sig longer than 1024', reason: 'HEADER_MISSING', mutate: (s) => { s.headers['paypal-transmission-sig'] = 'A'.repeat(1025); } },
    { title: 'transmission id of 65 characters', reason: 'TRANSMISSION_ID_INVALID', mutate: (s) => { s.headers['paypal-transmission-id'] = `TX-${'1'.repeat(62)}`; } },
    { title: 'transmission id with an underscore', reason: 'TRANSMISSION_ID_INVALID', mutate: (s) => { s.headers['paypal-transmission-id'] = 'TX_123456789012'; } },
    { title: 'transmission id with a space', reason: 'TRANSMISSION_ID_INVALID', mutate: (s) => { s.headers['paypal-transmission-id'] = 'TX 123456789012'; } },
    { title: 'auth algo not in the allow-list', reason: 'AUTH_ALGO_NOT_ALLOWED', mutate: (s) => { s.headers['paypal-auth-algo'] = 'MD5withRSA'; } },
    { title: 'auth algo in another case', reason: 'AUTH_ALGO_NOT_ALLOWED', mutate: (s) => { s.headers['paypal-auth-algo'] = 'sha256withrsa'; } },
    { title: 'transmission time that does not parse', reason: 'TRANSMISSION_TIME_INVALID', mutate: (s) => { s.headers['paypal-transmission-time'] = 'yesterday'; } },
    { title: 'transmission time without the T separator', reason: 'TRANSMISSION_TIME_INVALID', mutate: (s) => { s.headers['paypal-transmission-time'] = '2026-10-20 06:00:00'; } },
    { title: 'transmission time as an HTTP date', reason: 'TRANSMISSION_TIME_INVALID', mutate: (s) => { s.headers['paypal-transmission-time'] = 'Tue, 20 Oct 2026 06:00:00 GMT'; } },
    { title: 'transmission time 16 minutes old', reason: 'TRANSMISSION_TIME_OUT_OF_WINDOW', mutate: (s, h) => { s.headers['paypal-transmission-time'] = iso(h.clock.now() - 16 * 60_000); } },
    { title: 'transmission time 16 minutes ahead', reason: 'TRANSMISSION_TIME_OUT_OF_WINDOW', mutate: (s, h) => { s.headers['paypal-transmission-time'] = iso(h.clock.now() + 16 * 60_000); } },
    ...[
      ['http scheme', 'http://api.sandbox.paypal.com/v1/certs/x'],
      ['a host that is not paypal.com', 'https://evil.example/v1/certs/x'],
      ['paypal.com as a prefix of another host', 'https://paypal.com.evil.example/v1/certs/x'],
      ['paypal.com glued into another name', 'https://evilpaypal.com/v1/certs/x'],
      ['credentials in the URL', 'https://user:pw@api.paypal.com/v1/certs/x'],
      ['a non-default port', 'https://api.paypal.com:8443/v1/certs/x'],
      ['a loopback address', 'https://127.0.0.1:1/v1/certs/x'],
      ['no scheme', 'api.paypal.com/v1/certs/x'],
      ['an ftp URL', 'ftp://api.paypal.com/x'],
    ].map(([what, url]) => ({ title: `cert URL with ${what}`, reason: 'CERT_URL_INVALID', mutate: (s) => { s.headers['paypal-cert-url'] = url; } })),
    { title: 'cert URL longer than 1024 characters', reason: 'HEADER_MISSING', mutate: (s) => { s.headers['paypal-cert-url'] = `https://api.paypal.com/${'a'.repeat(1100)}`; } },
  ];

  async function assertRejected(h, signed, reason, { status = 400 } = {}) {
    const before = rows(h).length;
    const res = await post(h, 'A', signed);
    assertEnvelope(res, status, 'WEBHOOK_SIGNATURE_INVALID');
    const all = rows(h);
    assert.equal(all.length, before + 1, 'one row');
    const row = all.at(-1);
    assert.deepEqual(
      { signature_status: row.signature_status, outcome: row.outcome, flagged: row.flagged, flag_reason: row.flag_reason, payload_json: row.payload_json, merchant_key: row.merchant_key, provider: row.provider },
      { signature_status: 'invalid', outcome: 'rejected', flagged: 0, flag_reason: reason, payload_json: null, merchant_key: 'A', provider: 'fake' },
    );
    assert.equal(row.payload_sha256, sha256(signed.rawBody));
    assert.equal(fakeCalls(h), 0, 'no provider call, not even a read');
    return row;
  }

  for (const c of headerCases) {
    test(`SEC-6: ${c.title} -> invalid row ${c.reason}, 400, no provider call`, async () => {
      const { h, orders } = await fresh();
      const authId = uid('AUTH');
      setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
      const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
      c.mutate(signed, h);
      const row = await assertRejected(h, signed, c.reason);
      const given = signed.headers['paypal-transmission-id'];
      assert.equal(row.transmission_id, typeof given === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(given) ? given : '-', 'only a well-formed id is kept');
      assert.equal(op(h, orders[0].id).status, 'authorization_pending', 'no transition');
    });
  }

  for (const [title, body, reason] of wrongBodyCases) {
    test(`SEC-6: ${title} -> invalid row ${reason}, 400, no provider call (the signature is valid, the pre-check refuses first)`, async () => {
      const { h } = await fresh();
      await assertRejected(h, sign(h, { rawBody: body }), reason);
    });
  }

  test('SEC-6: precheck() is a pure function of headers, bytes, time and the allow-list', async () => {
    const { h } = await fresh();
    for (const [title, body, reason] of wrongBodyCases) {
      const checked = precheck({ headers: sign(h, { rawBody: body }).headers, rawBody: body, nowMs: h.clock.now() });
      assert.deepEqual([title, checked.ok, checked.reason], [title, false, reason]);
    }
    const good = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: 'X' }));
    const checked = precheck({ headers: good.headers, rawBody: good.rawBody, nowMs: h.clock.now() });
    assert.deepEqual([checked.ok, checked.transmissionId, checked.event.event_type], [true, good.transmissionId, 'PAYMENT.AUTHORIZATION.CREATED']);
  });

  test('SEC-6: the edges are accepted: a 64-character id, 14 minutes 59 seconds either way, a +03:00 offset, an api.sandbox.paypal.com and a paypal.com certificate host', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const variants = [
      { transmissionId: `TX-${'1'.repeat(61)}` },
      { transmissionTime: iso(h.clock.now() - 899_000) },
      { transmissionTime: iso(h.clock.now() + 899_000) },
      { transmissionTime: '2026-10-20T09:00:00+03:00' },
      { certUrl: 'https://paypal.com/v1/notifications/certs/x' },
      { certUrl: 'https://api.sandbox.paypal.com:443/v1/notifications/certs/x' },
    ];
    for (const overrides of variants) {
      const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
      const res = await post(h, 'A', sign(h, event, overrides));
      assert.equal(res.status, 200, `${JSON.stringify(overrides)}: ${res.text}`);
    }
    assert.equal(rows(h).every((r) => r.signature_status === 'valid'), true);
    assert.equal(verifyCalls(h), variants.length);
    assert.deepEqual(blockedAttempts(), [], 'the certificate URL is never fetched (the net guard saw no attempt)');
  });

  test('SEC-6: RS_PAYPAL_WEBHOOK_ALGOS widens the allow-list; a malformed list falls back to SHA256withRSA, never to "anything"', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    assert.deepEqual(webhookAlgos({}, {}), ['SHA256withRSA']);
    assert.deepEqual(webhookAlgos({}, { RS_PAYPAL_WEBHOOK_ALGOS: 'SHA256withRSA, SHA384withRSA' }), ['SHA256withRSA', 'SHA384withRSA']);
    assert.deepEqual(webhookAlgos({}, { RS_PAYPAL_WEBHOOK_ALGOS: 'ok, <script>' }), ['SHA256withRSA']);
    assert.deepEqual(webhookAlgos({}, { RS_PAYPAL_WEBHOOK_ALGOS: ',' }), ['SHA256withRSA']);
    assert.deepEqual(webhookAlgos({ paypalWebhookAlgos: ['SHA512withRSA'] }, { RS_PAYPAL_WEBHOOK_ALGOS: 'X' }), ['SHA512withRSA']);

    const saved = process.env.RS_PAYPAL_WEBHOOK_ALGOS;
    try {
      process.env.RS_PAYPAL_WEBHOOK_ALGOS = 'SHA256withRSA,SHA384withRSA';
      const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
      const res = await post(h, 'A', sign(h, event, { authAlgo: 'SHA384withRSA' }));
      assert.equal(res.status, 200, res.text);
      assert.equal(rows(h).at(-1).signature_status, 'valid');
      const refused = await post(h, 'A', sign(h, event, { authAlgo: 'SHA512withRSA' }));
      assertEnvelope(refused, 400, 'WEBHOOK_SIGNATURE_INVALID');
      assert.equal(rows(h).at(-1).flag_reason, 'AUTH_ALGO_NOT_ALLOWED');
    } finally {
      if (saved === undefined) delete process.env.RS_PAYPAL_WEBHOOK_ALGOS;
      else process.env.RS_PAYPAL_WEBHOOK_ALGOS = saved;
    }
  });

  test('SEC-6: invalid rows never count as "seen": the same forged id sent twice is two invalid rows and a genuine event with that id is still applied (T13)', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const id = 'TX-VICTIM-0001';
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const forged = sign(h, event, { transmissionId: id, secret: 'attacker-secret-attacker-secret-0123456789' });
    for (let i = 0; i < 2; i += 1) assertEnvelope(await post(h, 'A', forged), 400, 'WEBHOOK_SIGNATURE_INVALID');
    assert.deepEqual(rows(h).map((r) => [r.transmission_id, r.signature_status]), [[id, 'invalid'], [id, 'invalid']]);
    assert.equal(verifyCalls(h), 2, 'forged requests are verified, not deduplicated');
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');

    const genuine = await post(h, 'A', sign(h, event, { transmissionId: id }));
    assert.deepEqual([genuine.status, genuine.json], [200, { outcome: 'applied' }]);
    assert.equal(op(h, orders[0].id).status, 'authorized');
    assert.equal(rows(h).filter((r) => r.signature_status === 'valid').length, 1);
  });
});

// ---- verification (RS-24) --------------------------------------------------------------------------------------------------

describe('RS-24: verification', () => {
  test('RS-24: a tampered body, a wrong secret and a garbage signature are invalid rows, 400, and no transition', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const before = op(h, orders[0].id);
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const good = sign(h, event);
    const forgeries = [
      { ...good, rawBody: tamperBody(good.rawBody) },
      sign(h, event, { secret: 'a-different-secret-a-different-secret-0123456789' }),
      sign(h, event, { signature: 'bm90IGEgc2lnbmF0dXJl' }),
      { ...good, headers: { ...good.headers, 'paypal-transmission-id': 'TX-OTHER-999999' } },
      { ...good, headers: { ...good.headers, 'paypal-transmission-time': iso(h.clock.now() - 1000) } },
    ];
    for (const forged of forgeries) {
      const res = await post(h, 'A', forged);
      assertEnvelope(res, 400, 'WEBHOOK_SIGNATURE_INVALID');
    }
    const all = rows(h);
    assert.equal(all.length, forgeries.length);
    for (const row of all) {
      assert.deepEqual([row.signature_status, row.outcome, row.flag_reason, row.payload_json, row.applied_at], ['invalid', 'rejected', 'SIGNATURE_VERIFICATION_FAILED', null, null]);
    }
    assert.equal(verifyCalls(h), forgeries.length, 'each one was verified exactly once');
    assert.deepEqual(op(h, orders[0].id), before, 'the operation row is untouched');
    assert.equal(auditRows(h).length, 0);
  });

  test('RS-24: a body that differs from the signed bytes only in whitespace does not verify (the bytes are what is signed)', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const signed = sign(h, event);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(signed.rawBody.toString('utf8')), null, 2));
    assert.notEqual(reserialised.compare(signed.rawBody), 0);
    assertEnvelope(await post(h, 'A', { ...signed, rawBody: reserialised }), 400, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
  });

  test('RS-24: verification unreachable (HTTP 500, 429, 422 at the provider) -> `unverified` row, 503 PROVIDER_UNAVAILABLE, no transition; PayPal\'s retry of the same id is then applied', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const before = op(h, orders[0].id);
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const signed = sign(h, event);
    const reasons = [];
    for (const fault of ['http_500:verify_webhook', 'http_429:verify_webhook', 'http_422:verify_webhook']) {
      arm(h, fault);
      const res = await post(h, 'A', signed);
      assertEnvelope(res, 503, 'PROVIDER_UNAVAILABLE');
      const row = rows(h).at(-1);
      assert.deepEqual([row.signature_status, row.outcome, row.flagged, row.payload_json, row.event_type], ['unverified', 'rejected', 0, null, 'PAYMENT.AUTHORIZATION.CREATED']);
      reasons.push(row.flag_reason);
    }
    assert.deepEqual(reasons, ['VERIFY_UNREACHABLE', 'VERIFY_RETRYABLE', 'INJECTED_UNPROCESSABLE'], 'a rejected answer keeps the provider\'s issue code as the reason');
    assert.deepEqual(op(h, orders[0].id), before);
    assert.equal(rows(h).length, 3);

    const retry = await post(h, 'A', signed);
    assert.deepEqual([retry.status, retry.json], [200, { outcome: 'applied' }], 'an unverified row does not block the retry');
    assert.equal(op(h, orders[0].id).status, 'authorized');
    assert.deepEqual(rows(h).map((r) => r.signature_status), ['unverified', 'unverified', 'unverified', 'valid']);
  });

  test('RS-24: a missing webhook id (rejected WEBHOOK_ID_MISSING), an adapter that throws and a missing adapter are `unverified` 503; a rejected INVALID_ARGUMENT is invalid 400; ok verified:true is the only way to valid', async () => {
    const { h, orders, payments } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const withVerify = (verifyWebhook) => { h.app.deps.payments = { ...payments, verifyWebhook }; };

    withVerify(async () => rejectedOutcome(400, 'WEBHOOK_ID_MISSING'));
    assertEnvelope(await post(h, 'A', signed), 503, 'PROVIDER_UNAVAILABLE');
    withVerify(async () => { throw new Error('adapter exploded with a secret-looking detail sk-live-123'); });
    assertEnvelope(await post(h, 'A', signed), 503, 'PROVIDER_UNAVAILABLE');
    h.app.deps.payments = null;
    assertEnvelope(await post(h, 'A', signed), 503, 'PROVIDER_UNAVAILABLE');
    withVerify(async () => rejectedOutcome(400, 'INVALID_ARGUMENT'));
    assertEnvelope(await post(h, 'A', signed), 400, 'WEBHOOK_SIGNATURE_INVALID');
    withVerify(async () => okOutcome({ verified: 'yes' }));
    assertEnvelope(await post(h, 'A', signed), 400, 'WEBHOOK_SIGNATURE_INVALID');
    assert.deepEqual(rows(h).map((r) => [r.signature_status, r.flag_reason]), [
      ['unverified', 'WEBHOOK_ID_MISSING'], ['unverified', 'VERIFY_THREW'], ['unverified', 'PROVIDER_MISSING'], ['invalid', 'VERIFY_ARGUMENT_INVALID'],
      ['invalid', 'SIGNATURE_VERIFICATION_FAILED'],
    ]);
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    assert.equal(h.lines.join('').includes('sk-live-123'), false, 'the adapter\'s error text is not logged');

    withVerify(async () => okOutcome({ verified: true }));
    assert.deepEqual((await post(h, 'A', signed)).json, { outcome: 'applied' });
  });
});

// ---- RS-23 -------------------------------------------------------------------------------------------------------------------

describe('RS-23: duplicates', () => {
  test('RS-23: a valid transmission id seen twice is applied once; the replay is 200 duplicate with no row, no provider call, no audit and no change', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const first = await post(h, 'A', signed);
    assert.deepEqual([first.status, first.json], [200, { outcome: 'applied' }]);
    const afterFirst = { op: op(h, orders[0].id), rows: rows(h), verify: verifyCalls(h), audit: auditRows(h) };
    assert.equal(afterFirst.op.status, 'authorized');
    assert.deepEqual([afterFirst.rows.length, afterFirst.verify, afterFirst.audit.length], [1, 1, 1]);

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(1000);
      const again = await post(h, 'A', signed);
      assert.deepEqual([again.status, again.json], [200, { outcome: 'duplicate' }]);
    }
    assert.deepEqual(op(h, orders[0].id), afterFirst.op);
    assert.deepEqual(rows(h), afterFirst.rows);
    assert.equal(verifyCalls(h), 1, 'the replay is answered before any provider call');
    assert.deepEqual(auditRows(h), afterFirst.audit);
  });

  test('RS-23: a different payload under an already-valid transmission id is also a duplicate (it cannot change anything)', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const id = 'TX-DEDUPE-0001';
    assert.deepEqual((await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }), { transmissionId: id }))).json, { outcome: 'applied' });
    const other = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.VOIDED', { id: authId, status: 'VOIDED' }), { transmissionId: id }));
    assert.deepEqual([other.status, other.json], [200, { outcome: 'duplicate' }]);
    assert.equal(op(h, orders[0].id).status, 'authorized');
  });

  test('RS-23: five concurrent copies of one valid event give one `applied`, four `duplicate`, one valid row and one hook call', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId, cancel_requested_at: iso(h.clock.now()), cancel_reason: 'PAYMENT_CANCELLED' });
    const rule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
    h.app.deps.voidRule = rule;
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const results = await Promise.all(Array.from({ length: 5 }, () => post(h, 'A', signed, { throttled: true })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(results.map((r) => r.json.outcome).sort(), ['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    assert.equal(rows(h).filter((r) => r.signature_status === 'valid').length, 1);
    assert.deepEqual(voidCalls(h), [`so:${orders[0].id}:void:1`]);
    assert.equal(auditRows(h).length, 1);
  });
});

// ---- mapping -----------------------------------------------------------------------------------------------------------------

describe('event mapping and transitions', () => {
  // [event type, resource fields, from-state set-up, expected status, expected outcome, expected flag_reason, column checks]
  const cases = [
    ['PAYMENT.AUTHORIZATION.CREATED', 'authorization_pending -> authorized', { status: 'authorization_pending' }, 'authorized', 'applied', null],
    ['PAYMENT.AUTHORIZATION.CREATED', 'approved -> authorized (the return handler has not recorded it yet)', { status: 'approved' }, 'authorized', 'applied', null],
    ['PAYMENT.AUTHORIZATION.CREATED', 'unknown (lost authorize, prev approved) -> authorized', { status: 'unknown', prev_status: 'approved', unknown_since: '2026-10-20T05:59:00.000Z' }, 'authorized', 'applied', null],
    ['PAYMENT.AUTHORIZATION.CREATED', 'authorized stays authorized', { status: 'authorized' }, 'authorized', 'ignored', 'ALREADY_IN_STATE'],
    ['PAYMENT.AUTHORIZATION.CREATED', 'voided is terminal: flagged', { status: 'voided' }, 'voided', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.AUTHORIZATION.CREATED', 'created has no authorization yet: flagged', { status: 'created' }, 'created', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.AUTHORIZATION.CREATED', 'unknown with prev refund_pending cannot resolve to authorized: flagged', { status: 'unknown', prev_status: 'refund_pending', unknown_since: '2026-10-20T05:59:00.000Z' }, 'unknown', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.AUTHORIZATION.VOIDED', 'authorized -> voided', { status: 'authorized' }, 'voided', 'applied', null],
    ['PAYMENT.AUTHORIZATION.VOIDED', 'captured is not voidable: flagged', { status: 'captured' }, 'captured', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.CAPTURE.COMPLETED', 'authorized -> captured', { status: 'authorized' }, 'captured', 'applied', null],
    ['PAYMENT.CAPTURE.COMPLETED', 'capture_pending -> captured', { status: 'capture_pending' }, 'captured', 'applied', null],
    ['PAYMENT.CAPTURE.COMPLETED', 'refunded is terminal: flagged', { status: 'refunded' }, 'refunded', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.CAPTURE.PENDING', 'authorized -> capture_pending', { status: 'authorized' }, 'capture_pending', 'applied', null],
    ['PAYMENT.CAPTURE.PENDING', 'captured cannot go back to capture_pending: flagged', { status: 'captured' }, 'captured', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.CAPTURE.DENIED', 'capture_pending -> authorized', { status: 'capture_pending' }, 'authorized', 'applied', null],
    ['PAYMENT.CAPTURE.DENIED', 'a denial while merely authorized changes nothing', { status: 'authorized' }, 'authorized', 'ignored', 'ALREADY_IN_STATE'],
    ['PAYMENT.CAPTURE.DENIED', 'a denial for a captured operation is flagged', { status: 'captured' }, 'captured', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['PAYMENT.CAPTURE.REFUNDED', 'refund_pending -> refunded', { status: 'refund_pending' }, 'refunded', 'applied', null],
    ['PAYMENT.CAPTURE.REFUNDED', 'a refund nobody asked for (captured) is flagged, not applied', { status: 'captured' }, 'captured', 'flagged', 'TRANSITION_NOT_ALLOWED'],
    ['CHECKOUT.ORDER.APPROVED', 'is informational: an approved-at-provider order never authorizes (created)', { status: 'created' }, 'created', 'ignored', 'INFORMATIONAL_EVENT'],
    ['CHECKOUT.ORDER.APPROVED', 'is informational (approved)', { status: 'approved' }, 'approved', 'ignored', 'INFORMATIONAL_EVENT'],
  ];

  function eventFor(type, ids) {
    switch (type) {
      case 'PAYMENT.AUTHORIZATION.CREATED':
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        return authorizationEvent(type, {
          id: ids.auth, status: type.endsWith('VOIDED') ? 'VOIDED' : 'CREATED', expiration_time: '2026-11-18T06:00:00Z', supplementary_data: { related_ids: { order_id: ids.order } },
        });
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.PENDING':
      case 'PAYMENT.CAPTURE.DENIED':
        return buildEvent({ eventType: type, resource: { id: ids.capture, status: type.split('.')[2], supplementary_data: { related_ids: { authorization_id: ids.auth, order_id: ids.order } } } });
      case 'PAYMENT.CAPTURE.REFUNDED':
        return buildEvent({ eventType: type, resource: { id: ids.refund, status: 'COMPLETED', links: [{ rel: 'self', href: `https://api.sandbox.paypal.com/v2/payments/refunds/${ids.refund}` }, { rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${ids.capture}` }] } });
      default:
        return buildEvent({ eventType: type, resource: { id: ids.order, status: 'APPROVED' } });
    }
  }

  for (const [type, title, setup, status, outcome, flagReason] of cases) {
    test(`${type}: ${title}`, async () => {
      const { h, orders } = await fresh();
      const ids = { order: uid('ORD'), auth: uid('AUTH'), capture: uid('CAP'), refund: uid('REF') };
      // The operation already carries the ids its state implies; the event names them.
      const stored = { provider_order_id: ids.order };
      if (!['created', 'approved'].includes(setup.status)) stored.provider_authorization_id = ids.auth;
      if (['captured', 'refund_pending', 'refunded'].includes(setup.status)) stored.provider_capture_id = ids.capture;
      if (['refund_pending', 'refunded'].includes(setup.status)) stored.provider_refund_id = ids.refund;
      if (setup.status === 'capture_pending') stored.provider_capture_id = ids.capture;
      setOp(h, orders[0].id, { ...stored, ...setup });
      const before = op(h, orders[0].id);
      const res = await post(h, 'A', sign(h, eventFor(type, ids)));
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { outcome });
      const after = op(h, orders[0].id);
      assert.equal(after.status, status);
      const [row] = rows(h);
      assert.deepEqual(
        [row.signature_status, row.outcome, row.flagged, row.flag_reason, row.event_type, row.merchant_key],
        ['valid', outcome, outcome === 'flagged' ? 1 : 0, flagReason, type, 'A'],
      );
      assert.equal(row.applied_at !== null, outcome === 'applied');
      if (outcome !== 'applied') {
        assert.deepEqual({ ...after, updated_at: null }, { ...before, updated_at: null }, 'no column changed');
        assert.equal(after.updated_at, before.updated_at);
        assert.equal(auditRows(h).length, 0);
      } else {
        const [audit] = auditRows(h);
        assert.deepEqual(JSON.parse(audit.detail_json), { eventType: type, from: before.status, to: status });
        assert.equal(audit.entity_id, before.id);
      }
      if (outcome === 'applied' && type === 'PAYMENT.CAPTURE.COMPLETED') assert.equal(after.provider_capture_id, ids.capture);
      if (outcome === 'applied' && type === 'PAYMENT.AUTHORIZATION.CREATED') assert.equal(after.authorization_expires_at, '2026-11-18T06:00:00.000Z');
      if (setup.status === 'unknown' && outcome === 'applied') assert.equal(after.unknown_since, null);
    });
  }

  test('the event table is exactly the spec\'s seven events', () => {
    assert.deepEqual(Object.keys(WEBHOOK_EVENTS).sort(), [
      'CHECKOUT.ORDER.APPROVED', 'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED',
      'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.REFUNDED',
    ]);
  });

  test('a first-time authorization is recorded from the event: provider_authorization_id comes from the event when the operation was found by its order id', async () => {
    const { h, orders } = await fresh();
    const orderId = uid('ORD');
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'approved', provider_order_id: orderId });
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId, supplementary_data: { related_ids: { order_id: orderId } } });
    const res = await post(h, 'A', sign(h, event));
    assert.deepEqual(res.json, { outcome: 'applied' });
    const after = op(h, orders[0].id);
    assert.deepEqual([after.status, after.provider_authorization_id], ['authorized', authId]);
  });

  test('ids that contradict the stored ones are flagged, not applied (authorization, capture, refund)', async () => {
    const { h, orders } = await fresh();
    const orderId = uid('ORD');
    const stored = { auth: uid('AUTH'), capture: uid('CAP'), refund: uid('REF') };
    // authorization found through the order id, but the operation already holds another authorization
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_order_id: orderId, provider_authorization_id: stored.auth });
    let res = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: uid('AUTH'), supplementary_data: { related_ids: { order_id: orderId } } })));
    assert.deepEqual(res.json, { outcome: 'flagged' });
    // capture found through the authorization id, but the operation already holds another capture
    setOp(h, orders[0].id, { status: 'authorized', provider_capture_id: stored.capture });
    res = await post(h, 'A', sign(h, buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: uid('CAP'), supplementary_data: { related_ids: { authorization_id: stored.auth } } } })));
    assert.deepEqual(res.json, { outcome: 'flagged' });
    // refund found through the capture id, but the operation already holds another refund
    setOp(h, orders[0].id, { status: 'refund_pending', provider_refund_id: stored.refund });
    res = await post(h, 'A', sign(h, buildEvent({ eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: uid('REF'), links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${stored.capture}` }] } })));
    assert.deepEqual(res.json, { outcome: 'flagged' });
    assert.deepEqual(rows(h).map((r) => r.flag_reason), ['AUTHORIZATION_ID_MISMATCH', 'CAPTURE_ID_MISMATCH', 'REFUND_ID_MISMATCH']);
    assert.equal(op(h, orders[0].id).status, 'refund_pending');
  });

  test('a refund event is matched through the "up" link of the capture when its own id is not stored yet', async () => {
    const { h, orders } = await fresh();
    const capture = uid('CAP');
    const refund = uid('REF');
    setOp(h, orders[0].id, { status: 'refund_pending', provider_authorization_id: uid('AUTH'), provider_capture_id: capture });
    const res = await post(h, 'A', sign(h, buildEvent({ eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: refund, status: 'COMPLETED', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${capture}` }] } })));
    assert.deepEqual(res.json, { outcome: 'applied' });
    assert.deepEqual([op(h, orders[0].id).status, op(h, orders[0].id).provider_refund_id], ['refunded', refund]);
  });

  test('a resource that no operation owns is `ignored` (NO_MATCHING_OPERATION): the valid row is kept, nothing else changes', async () => {
    const { h, orders } = await fresh();
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: uid('AUTH') });
    const before = op(h, orders[0].id);
    const res = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: uid('AUTH') })));
    assert.deepEqual([res.status, res.json], [200, { outcome: 'ignored' }]);
    assert.deepEqual([rows(h)[0].signature_status, rows(h)[0].flag_reason], ['valid', 'NO_MATCHING_OPERATION']);
    assert.deepEqual(op(h, orders[0].id), before);
  });

  test('SEC-16: the operation must belong to the merchant of the URL, to the active adapter and must not be archived', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    const arrange = (patch = {}) => setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId, merchant_key: 'A', provider: 'fake', archived_at: null, ...patch });
    const send = (key = 'A') => post(h, key, sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId })));

    // the same resource id under another merchant's URL: ignored, even though it is a genuinely signed event
    arrange();
    let res = await send('B');
    assert.deepEqual(res.json, { outcome: 'ignored' });
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    // an operation recorded for the other adapter
    arrange({ provider: 'paypal-sandbox' });
    res = await send('A');
    assert.deepEqual(res.json, { outcome: 'ignored' });
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    // an archived operation (demo reset)
    arrange({ archived_at: '2026-10-19T06:00:00.000Z' });
    res = await send('A');
    assert.deepEqual(res.json, { outcome: 'ignored' });
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    // the operation owned by merchant B is invisible to A and visible to B
    arrange({ merchant_key: 'B' });
    assert.deepEqual((await send('A')).json, { outcome: 'ignored' });
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    assert.deepEqual((await send('B')).json, { outcome: 'applied' });
    assert.equal(op(h, orders[0].id).status, 'authorized');
    // control: everything matching applies
    arrange();
    assert.deepEqual((await send('A')).json, { outcome: 'applied' });
    assert.deepEqual(rows(h).map((r) => r.flag_reason), ['NO_MATCHING_OPERATION', 'NO_MATCHING_OPERATION', 'NO_MATCHING_OPERATION', 'NO_MATCHING_OPERATION', null, null]);
    assert.deepEqual(rows(h).map((r) => r.merchant_key), ['B', 'A', 'A', 'A', 'B', 'A']);
  });
});

// ---- resolution hook -----------------------------------------------------------------------------------------------------------

describe('ARCH-22: the resolution hook', () => {
  test('ARCH-22: a cancelled operation turning authorized by a webhook queues so:<id>:void:1 exactly once (real void port); a replay and a second event add none', async () => {
    const { h, orders } = await fresh();
    h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId, cancel_requested_at: iso(h.clock.now()), cancel_reason: 'PAYMENT_CANCELLED' });
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    assert.deepEqual((await post(h, 'A', signed)).json, { outcome: 'applied' });
    assert.deepEqual(voidCalls(h), [`so:${orders[0].id}:void:1`]);
    assert.equal(op(h, orders[0].id).status === 'authorized' || op(h, orders[0].id).status === 'voided', true);

    assert.deepEqual((await post(h, 'A', signed)).json, { outcome: 'duplicate' });
    const second = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId })));
    assert.equal(second.status, 200);
    assert.equal(second.json.outcome, 'ignored', 'the operation is already past that state');
    assert.deepEqual(voidCalls(h), [`so:${orders[0].id}:void:1`]);
    assert.equal(auditRows(h, 'void_rule.resolution_hook').length, 1, 'the hook audited its one queued void');
  });

  test('ARCH-22: the recorder port sees exactly one intent; an operation without cancel_requested_at queues none', async () => {
    const { h, orders } = await fresh();
    const port = createNoopProvider();
    h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: port });
    const plainAuth = uid('AUTH');
    const cancelledAuth = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: plainAuth });
    setOp(h, orders[1].id, { status: 'authorization_pending', provider_authorization_id: cancelledAuth, cancel_requested_at: iso(h.clock.now()), cancel_reason: 'SUPPLIER_REFUSED' });
    assert.deepEqual((await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: plainAuth })))).json, { outcome: 'applied' });
    assert.equal(port.queued.length, 0);
    assert.deepEqual((await post(h, 'B', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: cancelledAuth })))).json, { outcome: 'applied' });
    assert.equal(port.queued.length, 1);
    assert.deepEqual(
      [port.queued[0].operationKey, port.queued[0].operationId, port.queued[0].reason],
      [`so:${orders[1].id}:void:1`, op(h, orders[1].id).id, 'SUPPLIER_REFUSED'],
    );
  });

  test('ARCH-22: unknown with a lost authorize and a denied capture also pass through the hook', async () => {
    const { h, orders } = await fresh();
    const port = createNoopProvider();
    h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: port });
    const cancel = { cancel_requested_at: iso(h.clock.now()), cancel_reason: 'PAYMENT_CANCELLED' };
    const lost = uid('AUTH');
    setOp(h, orders[0].id, { status: 'unknown', prev_status: 'approved', unknown_since: iso(h.clock.now() - 60_000), provider_authorization_id: lost, ...cancel });
    assert.deepEqual((await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: lost })))).json, { outcome: 'applied' });
    const pendingAuth = uid('AUTH');
    const capture = uid('CAP');
    setOp(h, orders[1].id, { status: 'capture_pending', provider_authorization_id: pendingAuth, provider_capture_id: capture, ...cancel });
    assert.deepEqual(
      (await post(h, 'B', sign(h, buildEvent({ eventType: 'PAYMENT.CAPTURE.DENIED', resource: { id: capture, status: 'DENIED' } })))).json,
      { outcome: 'applied' },
    );
    assert.deepEqual(port.queued.map((i) => i.operationKey), [`so:${orders[0].id}:void:1`, `so:${orders[1].id}:void:1`]);
  });

  test('ARCH-22: the move, the row, the audit and the hook are one transaction: a failing hook rolls everything back and PayPal\'s retry then succeeds', async () => {
    const { h, orders, voidRule } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const before = op(h, orders[0].id);
    h.app.deps.voidRule = { onAuthorized() { throw new Error('hook failed'); }, provider: createNoopProvider() };
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const failed = await post(h, 'A', signed);
    assertEnvelope(failed, 500, 'INTERNAL');
    assert.deepEqual(op(h, orders[0].id), before, 'the operation did not move');
    assert.deepEqual(rows(h), [], 'no valid row was committed, so the retry is not a duplicate');
    assert.equal(auditRows(h).length, 0);

    h.app.deps.voidRule = voidRule;
    const retry = await post(h, 'A', signed);
    assert.deepEqual([retry.status, retry.json], [200, { outcome: 'applied' }]);
    assert.equal(op(h, orders[0].id).status, 'authorized');
  });
});

// ---- raw body, byte-exact -----------------------------------------------------------------------------------------------------

describe('raw body is kept byte-exact', () => {
  async function exactCase(label, makeBytes) {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const bytes = makeBytes(JSON.stringify(event), event);
    const seen = [];
    const real = (await world()).payments;
    h.app.deps.payments = { ...real, verifyWebhook: (args) => { seen.push(args); return real.verifyWebhook(args); } };
    const signed = sign(h, { rawBody: bytes });
    const res = await post(h, 'A', signed);
    assert.equal(res.status, 200, `${label}: ${res.text}`);
    assert.deepEqual(res.json, { outcome: 'applied' }, label);
    assert.equal(seen.length, 1, label);
    assert.equal(Buffer.isBuffer(seen[0].rawBody), true, label);
    assert.equal(Buffer.compare(seen[0].rawBody, bytes), 0, `${label}: the provider received exactly the bytes that were sent`);
    assert.deepEqual(Object.keys(seen[0].headers).sort(), Object.keys(signed.headers).sort(), label);
    assert.deepEqual(seen[0].headers, signed.headers, label);
    assert.equal(seen[0].merchantKey, 'A');
    assert.equal(rows(h)[0].payload_sha256, sha256(bytes), label);
    assert.equal(op(h, orders[0].id).status, 'authorized', label);
  }

  test('a UTF-8 byte order mark in front of the object is handed to verification unchanged (parsed without it, never stripped from what is verified)', () =>
    exactCase('bom', (json) => Buffer.concat([BOM, Buffer.from(json)])));

  test('whitespace, CRLF and tabs outside the object are handed over unchanged', () =>
    exactCase('whitespace', (json) => Buffer.from(`\r\n\t  ${json}  \r\n\r\n`)));

  test('a BOM together with whitespace, raw non-ASCII text and a JSON escape are handed over unchanged', () =>
    exactCase('bom+unicode', (json) => Buffer.concat([BOM, Buffer.from(` \n${json.replace(/}$/, ',"note":"Café 日本 \\u00e9\\ud83d\\ude00"}')}\n`)])));

  test('an unusual layout (key order, spacing, duplicate keys, number forms) is handed over unchanged and still parsed by its last event_type', () =>
    exactCase('layout', (json, event) => Buffer.from(`{ "links" : [ ] ,\t"resource" :${JSON.stringify(event.resource, null, 4)},\n "event_type" : "PAYMENT.AUTHORIZATION.CREATED" , "create_time":"2026-10-20T06:00:00.000Z", "x":1E2, "x":1e+2 }`)));

  test('the headers reach the adapter as a plain lower-case object holding only the five paypal-* headers', async () => {
    const { h, orders, payments } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const seen = [];
    h.app.deps.payments = { ...payments, verifyWebhook: (args) => { seen.push(args); return payments.verifyWebhook(args); } };
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    await post(h, 'A', signed, { headers: { Cookie: 'rs_sid=whatever', 'X-Custom': 'secret' } });
    assert.deepEqual(Object.keys(seen[0].headers).sort(), ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']);
  });
});

// ---- SEC-6 rate limit ----------------------------------------------------------------------------------------------------------

describe('SEC-6: 60 requests per IP per minute', () => {
  test('SEC-6: the 61st request in a minute is 429 RATE_LIMITED {limit: webhook_ip} with Retry-After, writes no row and makes no provider call; it is admitted again after the window', async () => {
    const { h, orders } = await fresh();
    assert.equal(WEBHOOK_RATE_LIMIT, 60);
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const junk = { rawBody: Buffer.from('x'), headers: {} };
    for (let i = 1; i <= 60; i += 1) {
      const res = await post(h, 'A', junk, { throttled: true });
      assert.equal(res.status, 400, `request ${i}: ${res.text}`);
    }
    assert.equal(rows(h).length, 60);
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    const limited = await post(h, 'A', signed, { throttled: true });
    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.json.error.code, 'RATE_LIMITED');
    assert.deepEqual(limited.json.error.details, { limit: 'webhook_ip' });
    assert.match(limited.headers['retry-after'], /^\d+$/);
    assert.equal(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60, true);
    assert.equal(rows(h).length, 60, 'no row for the refused request');
    assert.equal(fakeCalls(h), 0, 'no provider call');
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'webhook'").get().n, 60, 'a refused request is not counted');

    // an unknown merchant key is 404 whatever the counter says
    assert.equal((await post(h, 'Z', signed, { throttled: true })).status, 404);

    h.clock.advance(61_000);
    const later = await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId })), { throttled: true });
    assert.deepEqual([later.status, later.json], [200, { outcome: 'applied' }]);
  });

  test('SEC-6: the budget is per client: with RS_TRUST_PROXY=1 two addresses have two budgets, and every address of one IPv6 /64 shares one', async () => {
    const h = await startHarness({ seed: false, env: { ...SECRET_ENV, RS_TRUST_PROXY: '1' } });
    harnesses.push(h);
    const junk = { rawBody: Buffer.from('x'), headers: {} };
    const as = (ip) => post(h, 'A', junk, { throttled: true, headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 60; i += 1) assert.equal((await as('203.0.113.1')).status, 400);
    assert.equal((await as('203.0.113.1')).status, 429);
    assert.equal((await as('203.0.113.2')).status, 400, 'another address has its own budget');
    for (let i = 0; i < 30; i += 1) assert.equal((await as('2001:db8:1:1::a')).status, 400);
    for (let i = 0; i < 30; i += 1) assert.equal((await as('2001:db8:1:1:ffff::b')).status, 400);
    const limited = await as('2001:db8:1:1::c');
    assert.equal(limited.status, 429, 'the /64 prefix is one client');
    assert.equal((await as('2001:db8:1:2::a')).status, 400, 'the next /64 is another client');
  });
});

// ---- privacy ---------------------------------------------------------------------------------------------------------------------

describe('T13: the stored payload is a minimised summary; no payer data in rows, audit, logs or answers', () => {
  const forms = (value) => [...new Set([value, value.toLowerCase(), JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64').replace(/=+$/, '')])];
  const findLeaks = (texts, markers) => markers.flatMap((m) => forms(m).flatMap((f) => texts.filter((t) => t.includes(f)).map(() => m)));

  test('T13: payer data, addresses, amounts and notes in a signed event never reach webhook_events, audit_events, a log line or an answer', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    const orderId = uid('ORD');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_order_id: orderId, provider_authorization_id: authId });
    const extra = 'Zoltan-NOTE-canary-7731';
    const event = buildEvent({
      eventType: 'PAYMENT.AUTHORIZATION.CREATED', withPayer: true, id: 'WH-EVT-PRIVACY-1', resourceType: 'authorization',
      resource: {
        id: authId, status: 'CREATED', amount: { currency_code: 'USD', value: '40.00' }, note_to_payer: extra,
        shipping: { name: { full_name: extra }, address: { address_line_1: extra } }, custom_id: extra,
        supplementary_data: { related_ids: { order_id: orderId } }, expiration_time: '2026-11-18T06:00:00Z',
      },
    });
    const signed = sign(h, event);
    assert.equal(findLeaks([signed.rawBody.toString('utf8')], PAYER_MARKERS).length >= PAYER_MARKERS.length, true, 'the request does carry payer data');
    const res = await post(h, 'A', signed);
    assert.deepEqual(res.json, { outcome: 'applied' });

    const [row] = rows(h);
    assert.deepEqual(JSON.parse(row.payload_json), {
      event_type: 'PAYMENT.AUTHORIZATION.CREATED', event_id: 'WH-EVT-PRIVACY-1', resource_type: 'authorization', resource_id: authId, resource_status: 'CREATED', order_id: orderId,
    });
    assert.equal(row.payload_sha256, sha256(signed.rawBody));
    const everything = [
      JSON.stringify(rows(h)), JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all()), JSON.stringify(h.db.prepare('SELECT * FROM payment_operations').all()),
      h.lines.join('\n'), res.text, JSON.stringify(res.headers),
    ];
    assert.deepEqual(findLeaks(everything, [...PAYER_MARKERS, extra]), []);
  });

  test('T13: refused, unverified and failed requests leak nothing either: the signature, the shared secret and payer data stay out of rows, logs and answers', async () => {
    const { h, orders, payments } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId, payer: { email_address: PAYER_MARKERS[1] } });
    const texts = [];
    const good = sign(h, buildEvent({ eventType: 'PAYMENT.AUTHORIZATION.CREATED', withPayer: true, resource: { id: authId } }));
    const requests = [
      sign(h, buildEvent({ eventType: 'PAYMENT.AUTHORIZATION.CREATED', withPayer: true, resource: { id: authId } }), { secret: 'wrong-secret-wrong-secret-wrong-secret-01' }),
      { ...good, headers: { ...good.headers, 'paypal-auth-algo': 'MD5withRSA' } },
      sign(h, event, { signature: 'c2lnbmF0dXJlLWNhbmFyeS0wMDQy' }),
    ];
    for (const signed of requests) texts.push((await post(h, 'A', signed)).text);
    arm(h, 'http_500:verify_webhook');
    texts.push((await post(h, 'A', good)).text);
    h.app.deps.voidRule = { onAuthorized() { throw new Error(`hook failed ${PAYER_MARKERS[1]}`); }, provider: createNoopProvider() };
    texts.push((await post(h, 'A', good)).text);
    h.app.deps.payments = payments;

    const sensitive = [FAKE_WEBHOOK_SECRET, 'wrong-secret-wrong-secret-wrong-secret-01', ...PAYER_MARKERS, ...requests.map((r) => r.headers['paypal-transmission-sig']), good.headers['paypal-transmission-sig']];
    const everything = [...texts, h.lines.join('\n'), JSON.stringify(rows(h)), JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all())];
    assert.deepEqual(findLeaks(everything, sensitive), []);
    assert.equal(rows(h).length >= 4, true);
  });

  test('T13: every webhook log line carries a requestId, uses only allow-listed keys and names the outcome by code', async () => {
    const { h, orders } = await fresh();
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    const start = h.lines.length;
    const signed = sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId }));
    await post(h, 'A', signed);
    await post(h, 'A', signed);
    await post(h, 'A', { ...signed, headers: { ...signed.headers, 'paypal-cert-url': 'https://evil.example/x' } });
    const lines = h.lines.slice(start).map((l) => JSON.parse(l));
    const received = lines.filter((l) => l.msg === 'webhook.received');
    assert.deepEqual(received.map((l) => [l.code, l.httpStatus]), [['APPLIED', 200], ['DUPLICATE', 200], ['INVALID_CERT_URL_INVALID', 400]]);
    const allowed = new Set(['ts', 'level', 'msg', 'requestId', ...ALLOWED_KEYS]);
    for (const line of lines) {
      assert.match(line.requestId, /^[A-Za-z0-9_-]{1,64}$/);
      assert.deepEqual(Object.keys(line).filter((k) => !allowed.has(k)), []);
    }
  });

  test('T13: summarise keeps only allow-listed, pattern-checked fields', () => {
    const summary = summarise({
      id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture',
      resource: { id: 'CAP-1', status: 'COMPLETED', payer: { email_address: 'x@y.z' }, amount: { value: '1.00' }, supplementary_data: { related_ids: { authorization_id: 'AUTH-1', order_id: '<script>' } } },
    });
    assert.deepEqual(summary, { event_type: 'PAYMENT.CAPTURE.COMPLETED', event_id: 'WH-1', resource_type: 'capture', resource_id: 'CAP-1', resource_status: 'COMPLETED', authorization_id: 'AUTH-1' });
    assert.deepEqual(summarise({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: 'not an object' }), { event_type: 'PAYMENT.CAPTURE.COMPLETED' });
  });
});

// ---- the Sandbox adapter against the loopback stub ----------------------------------------------------------------------------------

describe('with the Sandbox adapter against the loopback stub', () => {
  test('RS-24/SEC-16: the event is verified at the stub with the merchant\'s webhook id and the operation of the DEFAULT merchant is moved; a forged one is invalid; a body with a BOM is never sent to the stub', async () => {
    const stub = await startPaypalStub();
    stubs.push(stub);
    const h = await startHarness({
      seed: true,
      env: {
        ...SECRET_ENV, RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_BASE_URL: stub.baseUrl,
        RS_PAYPAL_DEFAULT_CLIENT_ID: stub.merchants.DEFAULT.clientId, RS_PAYPAL_DEFAULT_CLIENT_SECRET: stub.merchants.DEFAULT.clientSecret,
        RS_PAYPAL_DEFAULT_WEBHOOK_ID: stub.merchants.DEFAULT.webhookId,
      },
    });
    harnesses.push(h);
    stub.appOrigin = `http://localhost:${h.port}`;
    const { orders } = await reservedPlan(h, await buyer(h));
    const authId = uid('AUTH');
    setOp(h, orders[0].id, { status: 'authorization_pending', provider_authorization_id: authId });
    assert.deepEqual([op(h, orders[0].id).provider, op(h, orders[0].id).merchant_key], ['paypal-sandbox', 'DEFAULT']);
    assert.equal((await post(h, 'A', sign(h, authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId })))).status, 404, 'A is not a configured key in single-credential mode');

    const event = authorizationEvent('PAYMENT.AUTHORIZATION.CREATED', { id: authId });
    const signed = sign(h, event);
    const forged = await post(h, 'DEFAULT', sign(h, event, { secret: 'a-different-secret-a-different-secret-0123456789' }));
    assertEnvelope(forged, 400, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal(op(h, orders[0].id).status, 'authorization_pending');

    const res = await post(h, 'DEFAULT', signed);
    assert.deepEqual([res.status, res.json], [200, { outcome: 'applied' }]);
    assert.equal(op(h, orders[0].id).status, 'authorized');
    const sent = stub.callsOf('verify_webhook');
    assert.equal(sent.length, 2);
    const body = sent[1].body;
    assert.deepEqual([body.webhook_id, body.transmission_id, body.auth_algo], [stub.merchants.DEFAULT.webhookId, signed.transmissionId, 'SHA256withRSA']);
    assert.equal(rows(h).at(-1).provider, 'paypal-sandbox');

    const bom = sign(h, { rawBody: Buffer.concat([BOM, signed.rawBody]) });
    assertEnvelope(await post(h, 'DEFAULT', bom), 400, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal(stub.callsOf('verify_webhook').length, 2, 'the adapter proved the body is not one JSON object and sent nothing');
    assert.deepEqual(blockedAttempts(), []);
  });
});
