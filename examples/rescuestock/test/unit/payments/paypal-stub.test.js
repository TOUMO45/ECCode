// Self-tests of the PayPal Sandbox SIMULATION (test/helpers/paypal-stub.js) and of the fake webhook signer
// (test/helpers/webhook-signer.js), plus a proof that the shared provider contract suite is not vacuous: the suite runs
// against a small REFERENCE adapter defined here (a test fixture, NOT src/payments/sandbox.js) and a deliberately leaky
// variant must be caught by the suite's leak check.
// Everything is loopback (127.0.0.1); no PayPal host is contacted and no credential exists.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLogger } from '../../../src/log.js';
import { fixedClock } from '../../../src/clock.js';
import { approvalPageCsp } from '../../../src/http/headers.js';
import {
  AUTHORIZATION_TTL_MS, BODY_MARKER, DEFAULT_MERCHANT, KINDS, STUB_START_MS, parseFaultName, rawMemberSpan, startPaypalStub,
} from '../../helpers/paypal-stub.js';
import {
  FAKE_PAYER, FAKE_WEBHOOK_SECRET, PAYER_MARKERS, WEBHOOK_HEADER_NAMES, buildEvent, computeSignature, signEvent,
  signingString, tamperBody, verifySignature, webhookSecretFromEnv,
} from '../../helpers/webhook-signer.js';
import { CANCEL_URL, MERCHANT, RETURN_URL, findLeaks, runProviderContract } from './provider-contract.js';

const APP_ORIGIN = 'http://localhost:3000';
const basic = (c = DEFAULT_MERCHANT) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;

// A raw node:http request so the tests see the header lines exactly as sent (fetch folds duplicates).
function raw(stub, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: stub.port, method, path, agent: false,
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function tokenFor(stub, creds = DEFAULT_MERCHANT) {
  const res = await raw(stub, 'POST', '/v1/oauth2/token', {
    headers: { authorization: basic(creds), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  assert.equal(res.status, 200);
  return res.json.access_token;
}

const orderBody = (value = '12.50') => ({
  intent: 'AUTHORIZE',
  purchase_units: [{
    reference_id: 'so-1', custom_id: 'so-1', invoice_id: 'rs-so-1-a1', description: 'RescueStock demo order (Sandbox)',
    amount: { currency_code: 'USD', value },
  }],
  payment_source: { paypal: { experience_context: {
    return_url: RETURN_URL, cancel_url: CANCEL_URL, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'RescueStock Sandbox Demo',
  } } },
});

// A client bound to one stub and one token.
function client(stub, token) {
  const h = (extra) => ({ authorization: `Bearer ${token}`, ...extra });
  return {
    get: (path, headers) => raw(stub, 'GET', path, { headers: h(headers) }),
    post: (path, body, requestId, headers) =>
      raw(stub, 'POST', path, { body: body ?? {}, headers: h({ ...(requestId ? { 'paypal-request-id': requestId } : {}), ...headers }) }),
  };
}

async function approvedOrder(stub, api, requestId = 'so:1:create_order:1', value = '12.50') {
  const created = await api.post('/v2/checkout/orders', orderBody(value), requestId);
  assert.equal(created.status, 201);
  stub.approve(created.json.id);
  return created.json.id;
}

async function authorizedOrder(stub, api, n = 1, value = '12.50') {
  const orderId = await approvedOrder(stub, api, `so:${n}:create_order:1`, value);
  const auth = await api.post(`/v2/checkout/orders/${orderId}/authorize`, {}, `so:${n}:authorize:1`);
  assert.equal(auth.status, 201);
  return { orderId, authorizationId: auth.json.purchase_units[0].payments.authorizations[0].id };
}

// ---- webhook signer -----------------------------------------------------------------------------------------------------

describe('webhook-signer', () => {
  test('the signature is HMAC-SHA256 over id|time|sha256(body), deterministic, and verifies', () => {
    const parts = { transmissionId: 'TX-1', transmissionTime: '2026-10-20T06:00:00.000Z', rawBody: '{"a":1}' };
    assert.match(signingString(parts), /^TX-1\|2026-10-20T06:00:00\.000Z\|[0-9a-f]{64}$/);
    const sig = computeSignature(FAKE_WEBHOOK_SECRET, parts);
    assert.equal(sig, computeSignature(FAKE_WEBHOOK_SECRET, { ...parts, rawBody: Buffer.from('{"a":1}') }));
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, parts, sig), true);
  });

  test('a wrong secret, a changed byte, another id or time, and garbage input do not verify', () => {
    const parts = { transmissionId: 'TX-1', transmissionTime: 'T', rawBody: '{"a":1}' };
    const sig = computeSignature(FAKE_WEBHOOK_SECRET, parts);
    assert.equal(verifySignature('some-other-secret-of-at-least-32-bytes-xxxx', parts, sig), false);
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, { ...parts, rawBody: '{"a":2}' }, sig), false);
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, { ...parts, transmissionId: 'TX-2' }, sig), false);
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, { ...parts, transmissionTime: 'U' }, sig), false);
    for (const bad of [undefined, null, '', 'x', 42]) assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, parts, bad), false);
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, { rawBody: '{}' }, sig), false);
  });

  test('signEvent returns the five paypal-* headers the route pre-checks require', () => {
    const signed = signEvent({ event: buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C1' } }) });
    assert.deepEqual(Object.keys(signed.headers).sort(), [...WEBHOOK_HEADER_NAMES].sort());
    assert.match(signed.headers['paypal-transmission-id'], /^[A-Za-z0-9-]{1,64}$/);
    assert.equal(signed.headers['paypal-auth-algo'], 'SHA256withRSA');
    const cert = new URL(signed.headers['paypal-cert-url']);
    assert.equal(cert.protocol, 'https:');
    assert.ok(cert.hostname.endsWith('paypal.com'));
    assert.ok(Buffer.isBuffer(signed.rawBody));
    assert.equal(verifySignature(FAKE_WEBHOOK_SECRET, {
      transmissionId: signed.headers['paypal-transmission-id'], transmissionTime: signed.headers['paypal-transmission-time'], rawBody: signed.rawBody,
    }, signed.headers['paypal-transmission-sig']), true);
  });

  test('transmission ids are unique; rawBody is signed as given; an override signature is used verbatim', () => {
    const a = signEvent({ rawBody: '{ "x" : 1 }' });
    const b = signEvent({ rawBody: '{ "x" : 1 }' });
    assert.notEqual(a.headers['paypal-transmission-id'], b.headers['paypal-transmission-id']);
    assert.equal(a.rawBody.toString(), '{ "x" : 1 }');
    assert.equal(signEvent({ rawBody: '{}', signature: 'forged' }).headers['paypal-transmission-sig'], 'forged');
    assert.throws(() => signEvent({}), TypeError);
    assert.throws(() => signEvent({ event: {}, rawBody: '{}' }), TypeError);
  });

  test('buildEvent adds fake payer data only on request; tamperBody changes exactly one byte', () => {
    const plain = JSON.stringify(buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C1' } }));
    assert.deepEqual(findLeaks([plain], PAYER_MARKERS), []);
    const withPayer = JSON.stringify(buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C1' }, withPayer: true }));
    assert.equal(findLeaks([withPayer], PAYER_MARKERS).length, PAYER_MARKERS.length);
    const body = Buffer.from(withPayer);
    const tampered = tamperBody(body);
    assert.equal(tampered.length, body.length);
    assert.equal([...body].filter((byte, i) => byte !== tampered[i]).length, 1);
    assert.throws(() => tamperBody(Buffer.alloc(0)), RangeError);
  });

  test('webhookSecretFromEnv prefers a valid RS_FAKE_WEBHOOK_SECRET and refuses short or placeholder values', () => {
    const long = 'x'.repeat(40);
    assert.equal(webhookSecretFromEnv({ RS_FAKE_WEBHOOK_SECRET: long }), long);
    assert.equal(webhookSecretFromEnv({ RS_FAKE_WEBHOOK_SECRET: 'short' }), FAKE_WEBHOOK_SECRET);
    assert.equal(webhookSecretFromEnv({ RS_FAKE_WEBHOOK_SECRET: `<${long}>` }), FAKE_WEBHOOK_SECRET);
    assert.equal(webhookSecretFromEnv({}), FAKE_WEBHOOK_SECRET);
    assert.ok(Buffer.byteLength(FAKE_WEBHOOK_SECRET) >= 32);
  });
});

// ---- pure helpers of the stub -------------------------------------------------------------------------------------------

describe('rawMemberSpan and parseFaultName', () => {
  test('rawMemberSpan returns the member exactly as written, for every JSON value type', () => {
    const text = '{"a" : 1, "webhook_event" :  { "k":[1, 2, {"q":"}"}] , "s":"a\\"b}" } ,"z":true}';
    assert.equal(rawMemberSpan(text, 'webhook_event'), '{ "k":[1, 2, {"q":"}"}] , "s":"a\\"b}" }');
    assert.equal(rawMemberSpan('{"x":"str\\\\","y":[ ]}', 'x'), '"str\\\\"');
    assert.equal(rawMemberSpan('{"x":"s","y":[ 1 ,2 ]}', 'y'), '[ 1 ,2 ]');
    assert.equal(rawMemberSpan('{"x": 12.50 ,"y":null}', 'x'), '12.50');
    assert.equal(rawMemberSpan('{"a":{"webhook_event":1}}', 'webhook_event'), null, 'only top-level members');
  });

  test('rawMemberSpan returns null for non-objects, unterminated text and missing keys', () => {
    for (const text of ['', '[]', 'null', '{', '{"a":', '{"a":1', '{"a":"x', '{a:1}', '{"a":1}']) {
      assert.equal(rawMemberSpan(text, 'missing'), null, `text ${JSON.stringify(text)}`);
    }
  });

  test('parseFaultName accepts the whole vocabulary and rejects anything else', () => {
    for (const name of ['authorize_denied', 'authorize_pending', 'capture_declined', 'capture_pending', 'refund_pending', 'refund_failed', 'void_fail', 'auth_expire', 'order_not_approvable']) {
      assert.equal(parseFaultName(name).name, name);
    }
    for (const kind of KINDS) {
      assert.equal(parseFaultName(`lost_response:${kind}`).type, 'lost');
      assert.equal(parseFaultName(`timeout:${kind}`).type, 'timeout');
      assert.equal(parseFaultName(`bad_body:${kind}`).type, 'bad_body');
      assert.equal(parseFaultName(`http_503:${kind}`).status, 503);
    }
    for (const bad of ['', 'http_200:capture', 'http_700:capture', 'lost_response:nothing', 'timeout', 'capture', 'HTTP_500:capture']) {
      assert.throws(() => parseFaultName(bad), RangeError, bad);
    }
  });
});

// ---- the stub over HTTP -------------------------------------------------------------------------------------------------

describe('paypal-stub', () => {
  let stub;
  let api;

  before(async () => {
    stub = await startPaypalStub({ appOrigin: APP_ORIGIN });
    api = client(stub, await tokenFor(stub));
  });
  after(() => stub.close());

  describe('server and OAuth', () => {
    test('listens on 127.0.0.1 only, with a loopback base URL', () => {
      assert.equal(stub.host, '127.0.0.1');
      assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(stub.port > 0);
    });

    test('OAuth: basic auth with the right credentials returns a bearer token with expires_in', async () => {
      const res = await raw(stub, 'POST', '/v1/oauth2/token', {
        headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.token_type, 'Bearer');
      assert.equal(res.json.expires_in, 32400);
      assert.match(res.json.access_token, /^A21AASTUB/);
      assert.ok(stub.issuedTokens().includes(res.json.access_token));
    });

    test('OAuth: wrong credentials -> 401, missing or wrong grant_type -> 400', async () => {
      const bad = await raw(stub, 'POST', '/v1/oauth2/token', {
        headers: { authorization: basic({ ...DEFAULT_MERCHANT, clientSecret: 'wrong' }), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
      });
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error, 'invalid_client');
      const none = await raw(stub, 'POST', '/v1/oauth2/token', { body: 'grant_type=client_credentials', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(none.status, 401);
      const grant = await raw(stub, 'POST', '/v1/oauth2/token', {
        headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=password',
      });
      assert.equal(grant.status, 400);
    });

    test('API calls need a valid, unexpired bearer token (401 AUTHENTICATION_FAILURE otherwise)', async () => {
      const none = await raw(stub, 'GET', '/v2/checkout/orders/STUBORD000001');
      assert.equal(none.status, 401);
      assert.equal(none.json.name, 'AUTHENTICATION_FAILURE');
      const wrong = await client(stub, 'not-a-token').get('/v2/checkout/orders/STUBORD000001');
      assert.equal(wrong.status, 401);
      const other = await startPaypalStub({ clock: fixedClock(STUB_START_MS), tokenTtlSeconds: 60 });
      try {
        const token = await tokenFor(other);
        assert.equal((await client(other, token).get('/v2/checkout/orders/X')).status, 404);
        other.clock.advance(61_000);
        assert.equal((await client(other, token).get('/v2/checkout/orders/X')).status, 401, 'the token expired with the stub clock');
        assert.equal((await client(other, await tokenFor(other)).get('/v2/checkout/orders/X')).status, 404);
        other.expireTokens();
        assert.equal((await client(other, token).get('/v2/checkout/orders/X')).status, 401);
      } finally {
        await other.close();
      }
    });

    test('unknown paths and malformed JSON are answered, not crashed on', async () => {
      assert.equal((await api.get('/v2/nothing/here')).status, 404);
      const bad = await raw(stub, 'POST', '/v2/checkout/orders', { body: '{not json', headers: { authorization: `Bearer ${stub.issuedTokens()[0]}`, 'paypal-request-id': 'so:9:create_order:1' } });
      assert.equal(bad.status, 400);
      assert.equal(stub.lastCall('unknown').path, '/v2/nothing/here');
    });
  });

  describe('recording', () => {
    test('every request is recorded with method, path, headers, raw and parsed body and the PayPal-Request-Id', async () => {
      stub.clearCalls();
      const body = orderBody('7.05');
      const res = await api.post('/v2/checkout/orders', body, 'so:21:create_order:1', { prefer: 'return=minimal' });
      assert.equal(res.status, 201);
      const call = stub.lastCall('create_order');
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/v2/checkout/orders');
      assert.equal(call.requestId, 'so:21:create_order:1');
      assert.equal(call.headers['paypal-request-id'], 'so:21:create_order:1');
      assert.equal(call.headers.prefer, 'return=minimal');
      assert.match(call.headers.authorization, /^Bearer /);
      assert.deepEqual(call.body, body);
      assert.equal(call.rawBody, JSON.stringify(body));
      assert.equal(call.status, 201);
      assert.equal(call.replayed, false);
      assert.equal(call.resourceId, res.json.id);
      assert.equal(call.merchantKey, 'DEFAULT');
      assert.deepEqual(stub.counts(), { create_order: 1 });
      assert.equal(stub.callsOf('create_order').length, 1);
    });

    test('reads are recorded too, without a request id', async () => {
      stub.clearCalls();
      const orderId = await approvedOrder(stub, api, 'so:22:create_order:1');
      await api.get(`/v2/checkout/orders/${orderId}`);
      assert.equal(stub.lastCall('get_order').requestId, null);
      assert.equal(stub.counts().get_order, 1);
    });
  });

  describe('orders, authorizations, captures, refunds', () => {
    test('createOrder validates intent, currency, the two-decimal value and the urls', async () => {
      const check = async (mutate, issue, status = 422) => {
        const body = orderBody();
        mutate(body);
        const res = await api.post('/v2/checkout/orders', body, `so:${Math.random()}:create_order:1`);
        assert.equal(res.status, status, issue);
        assert.equal(res.json.details[0].issue, issue);
      };
      await check((b) => { b.intent = 'CAPTURE'; }, 'INVALID_PARAMETER_VALUE');
      await check((b) => { b.purchase_units[0].amount.currency_code = 'EUR'; }, 'CURRENCY_NOT_SUPPORTED');
      await check((b) => { b.purchase_units[0].amount.value = '12.5'; }, 'DECIMAL_PRECISION');
      await check((b) => { b.purchase_units[0].amount.value = 12.5; }, 'DECIMAL_PRECISION');
      await check((b) => { b.purchase_units[0].amount.value = '0.00'; }, 'INVALID_PARAMETER_VALUE');
      await check((b) => { delete b.payment_source; }, 'MISSING_REQUIRED_PARAMETER');
      await check((b) => { b.purchase_units = []; }, 'MISSING_REQUIRED_PARAMETER');
    });

    test('createOrder: 201 with id, status CREATED and a payer-action link to the stub approval page', async () => {
      const res = await api.post('/v2/checkout/orders', orderBody(), 'so:31:create_order:1');
      assert.equal(res.status, 201);
      assert.equal(res.json.status, 'CREATED');
      const link = res.json.links.find((l) => l.rel === 'payer-action');
      assert.equal(link.href, `${stub.baseUrl}/checkoutnow?token=${res.json.id}`);
      assert.equal(stub.approvalUrl(res.json.id), link.href);
    });

    test('authorize needs an APPROVED order; the answer carries the authorization and the fake payer data', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:32:create_order:1');
      const early = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:32:authorize:1');
      assert.equal(early.status, 422);
      assert.equal(early.json.details[0].issue, 'ORDER_NOT_APPROVED');
      stub.approve(created.json.id);
      const res = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:32:authorize:2');
      assert.equal(res.status, 201);
      assert.equal(res.json.status, 'COMPLETED');
      const auth = res.json.purchase_units[0].payments.authorizations[0];
      assert.equal(auth.status, 'CREATED');
      assert.equal(Date.parse(auth.expiration_time), stub.clock.now() + AUTHORIZATION_TTL_MS);
      assert.equal(res.json.payer.email_address, FAKE_PAYER.email);
      assert.equal(findLeaks([res.text], PAYER_MARKERS).length >= 3, true, 'the answer carries fake payer data');
      const again = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:32:authorize:3');
      assert.equal(again.status, 422);
      assert.equal(again.json.details[0].issue, 'ORDER_ALREADY_AUTHORIZED');
    });

    test('getOrder shows payer data once approved and lists payments.authorizations/captures/refunds with up-links', async () => {
      const w = await authorizedOrder(stub, api, 33);
      const cap = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, { amount: { currency_code: 'USD', value: '12.50' }, final_capture: true, invoice_id: 'rs-so-33-cap' }, 'so:33:capture:1');
      const ref = await api.post(`/v2/payments/captures/${cap.json.id}/refund`, { amount: { currency_code: 'USD', value: '12.50' }, note_to_payer: 'x' }, 'so:33:refund:1');
      const order = await api.get(`/v2/checkout/orders/${w.orderId}`);
      assert.equal(order.status, 200);
      assert.equal(order.json.payer.payer_id, FAKE_PAYER.payerId);
      const payments = order.json.purchase_units[0].payments;
      assert.equal(payments.authorizations[0].id, w.authorizationId);
      assert.equal(payments.captures[0].id, cap.json.id);
      assert.ok(payments.captures[0].links.find((l) => l.rel === 'up').href.endsWith(`/authorizations/${w.authorizationId}`));
      assert.equal(payments.refunds[0].id, ref.json.id);
      assert.ok(payments.refunds[0].links.find((l) => l.rel === 'up').href.endsWith(`/captures/${cap.json.id}`));
      const fresh = await api.post('/v2/checkout/orders', orderBody(), 'so:34:create_order:1');
      const unpaid = await api.get(`/v2/checkout/orders/${fresh.json.id}`);
      assert.equal(unpaid.json.payer, undefined);
      assert.equal(unpaid.json.purchase_units[0].payments, undefined);
    });

    test('capture: 201 COMPLETED once; a second capture is 422 AUTHORIZATION_ALREADY_CAPTURED; getAuthorization reads CAPTURED', async () => {
      const w = await authorizedOrder(stub, api, 35);
      const first = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, { amount: { currency_code: 'USD', value: '12.50' }, final_capture: true }, 'so:35:capture:1');
      assert.equal(first.status, 201);
      assert.equal(first.json.status, 'COMPLETED');
      assert.equal(first.json.amount.value, '12.50');
      const second = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, { amount: { currency_code: 'USD', value: '12.50' }, final_capture: true }, 'so:35:capture:2');
      assert.equal(second.status, 422);
      assert.equal(second.json.details[0].issue, 'AUTHORIZATION_ALREADY_CAPTURED');
      assert.equal((await api.get(`/v2/payments/authorizations/${w.authorizationId}`)).json.status, 'CAPTURED');
      assert.equal((await api.get(`/v2/payments/captures/${first.json.id}`)).json.status, 'COMPLETED');
    });

    test('capture amount above the authorization is rejected; unknown ids are 404 INVALID_RESOURCE_ID', async () => {
      const w = await authorizedOrder(stub, api, 36);
      const over = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, { amount: { currency_code: 'USD', value: '12.51' } }, 'so:36:capture:1');
      assert.equal(over.status, 422);
      assert.equal(over.json.details[0].issue, 'AUTHORIZATION_AMOUNT_EXCEEDED');
      for (const path of ['/v2/payments/authorizations/NOPE', '/v2/payments/captures/NOPE', '/v2/payments/refunds/NOPE', '/v2/checkout/orders/NOPE']) {
        const res = await api.get(path);
        assert.equal(res.status, 404, path);
        assert.equal(res.json.details[0].issue, 'INVALID_RESOURCE_ID');
      }
    });

    test('void: 204 once, then 422 AUTHORIZATION_VOIDED; a captured authorization cannot be voided', async () => {
      const w = await authorizedOrder(stub, api, 37);
      const res = await api.post(`/v2/payments/authorizations/${w.authorizationId}/void`, undefined, 'so:37:void:1');
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.equal((await api.get(`/v2/payments/authorizations/${w.authorizationId}`)).json.status, 'VOIDED');
      const again = await api.post(`/v2/payments/authorizations/${w.authorizationId}/void`, undefined, 'so:37:void:2');
      assert.equal(again.json.details[0].issue, 'AUTHORIZATION_VOIDED');
      const c = await authorizedOrder(stub, api, 38);
      await api.post(`/v2/payments/authorizations/${c.authorizationId}/capture`, {}, 'so:38:capture:1');
      const captured = await api.post(`/v2/payments/authorizations/${c.authorizationId}/void`, undefined, 'so:38:void:1');
      assert.equal(captured.json.details[0].issue, 'AUTHORIZATION_ALREADY_CAPTURED');
    });

    test('refund: partial then rest, REFUNDED capture, 422 CAPTURE_FULLY_REFUNDED, amount above the rest rejected', async () => {
      const w = await authorizedOrder(stub, api, 39, '10.00');
      const cap = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, {}, 'so:39:capture:1');
      const part = await api.post(`/v2/payments/captures/${cap.json.id}/refund`, { amount: { currency_code: 'USD', value: '4.00' } }, 'so:39:refund:1');
      assert.equal(part.json.status, 'COMPLETED');
      assert.equal((await api.get(`/v2/payments/captures/${cap.json.id}`)).json.status, 'PARTIALLY_REFUNDED');
      const over = await api.post(`/v2/payments/captures/${cap.json.id}/refund`, { amount: { currency_code: 'USD', value: '6.01' } }, 'so:39:refund:2');
      assert.equal(over.json.details[0].issue, 'REFUND_AMOUNT_EXCEEDED');
      const rest = await api.post(`/v2/payments/captures/${cap.json.id}/refund`, { amount: { currency_code: 'USD', value: '6.00' } }, 'so:39:refund:3');
      assert.equal(rest.status, 201);
      assert.equal((await api.get(`/v2/payments/captures/${cap.json.id}`)).json.status, 'REFUNDED');
      const full = await api.post(`/v2/payments/captures/${cap.json.id}/refund`, {}, 'so:39:refund:4');
      assert.equal(full.status, 422);
      assert.equal(full.json.details[0].issue, 'CAPTURE_FULLY_REFUNDED');
      assert.equal((await api.get(`/v2/payments/refunds/${part.json.id}`)).json.status, 'COMPLETED');
    });

    test('authorizations expire with the stub clock (29 days) and an expired one cannot be captured or voided', async () => {
      const own = await startPaypalStub({ clock: fixedClock(STUB_START_MS) });
      try {
        let a = client(own, await tokenFor(own));
        const w = await authorizedOrder(own, a, 40);
        assert.equal((await a.get(`/v2/payments/authorizations/${w.authorizationId}`)).json.status, 'CREATED');
        own.clock.advance(AUTHORIZATION_TTL_MS);
        assert.equal((await a.get(`/v2/payments/authorizations/${w.authorizationId}`)).status, 401, 'the 9 hour token expired too');
        a = client(own, await tokenFor(own));
        assert.equal((await a.get(`/v2/payments/authorizations/${w.authorizationId}`)).json.status, 'EXPIRED');
        assert.equal((await a.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, {}, 'so:40:capture:1')).json.details[0].issue, 'AUTHORIZATION_EXPIRED');
        assert.equal((await a.post(`/v2/payments/authorizations/${w.authorizationId}/void`, undefined, 'so:40:void:1')).json.details[0].issue, 'AUTHORIZATION_EXPIRED');
      } finally {
        await own.close();
      }
    });

    test('merchants are isolated: another merchant\'s token sees 404 for these resources', async () => {
      const two = await startPaypalStub({ merchants: { A: { clientId: 'cid-A', clientSecret: 'sec-A', webhookId: 'WH-A' }, B: { clientId: 'cid-B', clientSecret: 'sec-B', webhookId: 'WH-B' } } });
      try {
        const a = client(two, await tokenFor(two, { clientId: 'cid-A', clientSecret: 'sec-A' }));
        const b = client(two, await tokenFor(two, { clientId: 'cid-B', clientSecret: 'sec-B' }));
        const created = await a.post('/v2/checkout/orders', orderBody(), 'so:1:create_order:1');
        assert.equal((await a.get(`/v2/checkout/orders/${created.json.id}`)).status, 200);
        assert.equal((await b.get(`/v2/checkout/orders/${created.json.id}`)).status, 404);
        assert.equal(two.lastCall('get_order').merchantKey, 'B');
        // The same PayPal-Request-Id under another merchant is not a replay.
        const other = await b.post('/v2/checkout/orders', orderBody(), 'so:1:create_order:1');
        assert.equal(other.status, 201);
        assert.notEqual(other.json.id, created.json.id);
        assert.equal(two.calls.at(-1).replayed, false);
      } finally {
        await two.close();
      }
    });
  });

  describe('replay by PayPal-Request-Id', () => {
    test('create_order: the same id returns the stored answer, creates no second order and is recorded as replayed', async () => {
      const before = stub.counters().order;
      const first = await api.post('/v2/checkout/orders', orderBody(), 'so:51:create_order:1');
      const second = await api.post('/v2/checkout/orders', orderBody(), 'so:51:create_order:1');
      assert.equal(second.status, 201);
      assert.equal(second.text, first.text);
      assert.equal(stub.counters().order, before + 1);
      const calls = stub.callsOf('create_order').filter((c) => c.requestId === 'so:51:create_order:1');
      assert.deepEqual(calls.map((c) => c.replayed), [false, true]);
      assert.equal(stub.callsOf('create_order', { replayed: true }).length >= 1, true);
    });

    test('authorize, capture, void and refund replay too, and a replayed capture is not AUTHORIZATION_ALREADY_CAPTURED', async () => {
      const w = await authorizedOrder(stub, api, 52);
      const authAgain = await api.post(`/v2/checkout/orders/${w.orderId}/authorize`, {}, 'so:52:authorize:1');
      assert.equal(authAgain.status, 201);
      assert.equal(authAgain.json.purchase_units[0].payments.authorizations[0].id, w.authorizationId);
      const capPath = `/v2/payments/authorizations/${w.authorizationId}/capture`;
      const c1 = await api.post(capPath, {}, 'so:52:capture:1');
      const captured = stub.counters().capture;
      const c2 = await api.post(capPath, {}, 'so:52:capture:1');
      assert.equal(c2.status, 201);
      assert.equal(c2.json.id, c1.json.id);
      assert.equal(stub.counters().capture, captured, 'the replay created no second capture');
      const r1 = await api.post(`/v2/payments/captures/${c1.json.id}/refund`, {}, 'so:52:refund:1');
      const r2 = await api.post(`/v2/payments/captures/${c1.json.id}/refund`, {}, 'so:52:refund:1');
      assert.equal(r2.json.id, r1.json.id);
      const v = await authorizedOrder(stub, api, 53);
      assert.equal((await api.post(`/v2/payments/authorizations/${v.authorizationId}/void`, undefined, 'so:53:void:1')).status, 204);
      assert.equal((await api.post(`/v2/payments/authorizations/${v.authorizationId}/void`, undefined, 'so:53:void:1')).status, 204);
    });

    test('a rejected answer is not stored: the same id may succeed once the cause is gone', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:54:create_order:1');
      const early = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:54:authorize:1');
      assert.equal(early.status, 422);
      stub.approve(created.json.id);
      const late = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:54:authorize:1');
      assert.equal(late.status, 201);
    });

    test('a mutating call without PayPal-Request-Id is 400 MISSING_REQUEST_ID; the same id on another kind is 422', async () => {
      const missing = await api.post('/v2/checkout/orders', orderBody());
      assert.equal(missing.status, 400);
      assert.equal(missing.json.details[0].issue, 'MISSING_REQUEST_ID');
      await api.post('/v2/checkout/orders', orderBody(), 'so:55:create_order:1');
      const clash = await api.post('/v2/payments/authorizations/ANY/capture', {}, 'so:55:create_order:1');
      assert.equal(clash.status, 422);
      assert.equal(clash.json.details[0].issue, 'REQUEST_ID_KIND_MISMATCH');
      const lenient = await startPaypalStub({ requireRequestId: false });
      try {
        const res = await client(lenient, await tokenFor(lenient)).post('/v2/checkout/orders', orderBody());
        assert.equal(res.status, 201);
      } finally {
        await lenient.close();
      }
    });
  });

  describe('approval page and the F-TR-14 CSP', () => {
    const cspLines = (rawHeaders) => rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'content-security-policy');

    test('GET page: 200 HTML, banner, amount, two forms, no script, exactly one CSP header equal to approvalPageCsp(appOrigin)', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody('19.99'), 'so:61:create_order:1');
      const res = await raw(stub, 'GET', `/checkoutnow?token=${created.json.id}`);
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.equal(cspLines(res.rawHeaders).length, 1, 'exactly one Content-Security-Policy header');
      assert.equal(res.headers['content-security-policy'], approvalPageCsp(APP_ORIGIN));
      assert.equal(res.headers['content-security-policy'], `default-src 'none'; style-src 'self'; form-action 'self' ${APP_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`);
      assert.match(res.text, /Simulated PayPal approval/);
      assert.match(res.text, /not PayPal/);
      assert.match(res.text, /19\.99 USD/);
      assert.match(res.text, /Approve \(simulated\)/);
      assert.equal((res.text.match(/<form /g) ?? []).length, 2);
      assert.doesNotMatch(res.text, /<script|javascript:|style=/i);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    });

    test('approve: 303 to the stored return url with token and PayerID, the order becomes APPROVED, one CSP on the redirect too', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:62:create_order:1');
      const res = await raw(stub, 'POST', `/checkoutnow/${created.json.id}/approve`);
      assert.equal(res.status, 303);
      const location = new URL(res.headers.location);
      assert.equal(`${location.origin}${location.pathname}`, RETURN_URL);
      assert.equal(location.searchParams.get('token'), created.json.id);
      assert.equal(location.searchParams.get('PayerID'), FAKE_PAYER.payerId);
      assert.equal(cspLines(res.rawHeaders).length, 1);
      assert.equal(res.headers['content-security-policy'], approvalPageCsp(APP_ORIGIN));
      assert.equal(stub.order(created.json.id).status, 'APPROVED');
      const again = await raw(stub, 'POST', `/checkoutnow/${created.json.id}/approve`);
      assert.equal(again.status, 303, 'approving twice gives the same redirect');
      const auth = await api.post(`/v2/checkout/orders/${created.json.id}/authorize`, {}, 'so:62:authorize:1');
      assert.equal(auth.status, 201, 'a buyer-approved order can be authorized');
    });

    test('cancel: 303 to the stored cancel url with the token, no state change, one CSP', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:63:create_order:1');
      const res = await raw(stub, 'POST', `/checkoutnow/${created.json.id}/cancel`);
      assert.equal(res.status, 303);
      const location = new URL(res.headers.location);
      assert.equal(`${location.origin}${location.pathname}`, CANCEL_URL);
      assert.equal(location.searchParams.get('token'), created.json.id);
      assert.equal(location.searchParams.has('PayerID'), false);
      assert.equal(cspLines(res.rawHeaders).length, 1);
      assert.equal(stub.order(created.json.id).status, 'CREATED');
    });

    test('unknown order: 404 pages carry the same single CSP; nothing is reflected into the page', async () => {
      for (const [method, path] of [['GET', '/checkoutnow?token=<script>alert(1)</script>'], ['POST', '/checkoutnow/NOPE/approve'], ['POST', '/checkoutnow/NOPE/cancel']]) {
        const res = await raw(stub, method, path.replace('<script>alert(1)</script>', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'));
        assert.equal(res.status, 404, path);
        assert.equal(cspLines(res.rawHeaders).length, 1);
        assert.equal(res.headers['content-security-policy'], approvalPageCsp(APP_ORIGIN));
        assert.doesNotMatch(res.text, /alert\(1\)/);
      }
    });

    test('the CSP follows stub.appOrigin, and an invalid origin is refused at response time (no header injection)', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:64:create_order:1');
      const url = `/checkoutnow?token=${created.json.id}`;
      stub.appOrigin = 'http://localhost:41233';
      try {
        const res = await raw(stub, 'GET', url);
        assert.equal(res.headers['content-security-policy'], approvalPageCsp('http://localhost:41233'));
        assert.match(res.headers['content-security-policy'], /form-action 'self' http:\/\/localhost:41233;/);
        stub.appOrigin = 'http://localhost:3000; script-src *';
        const bad = await raw(stub, 'GET', url);
        assert.equal(bad.status, 500);
        assert.equal(bad.headers['content-security-policy'], undefined);
      } finally {
        stub.appOrigin = APP_ORIGIN;
      }
    });

    test('order_not_approvable: the page refuses with 409 (one CSP) and the order stays CREATED', async () => {
      const created = await api.post('/v2/checkout/orders', orderBody(), 'so:65:create_order:1');
      stub.fault('order_not_approvable');
      const res = await raw(stub, 'POST', `/checkoutnow/${created.json.id}/approve`);
      assert.equal(res.status, 409);
      assert.equal(cspLines(res.rawHeaders).length, 1);
      assert.equal(stub.order(created.json.id).status, 'CREATED');
      assert.equal((await raw(stub, 'POST', `/checkoutnow/${created.json.id}/approve`)).status, 303, 'the fault was single-use');
    });

    test('API responses do not carry the approval CSP; the approval link base and rel can be changed', async () => {
      const res = await api.get('/v2/checkout/orders/NOPE');
      assert.equal(res.headers['content-security-policy'], undefined);
      const own = await startPaypalStub({ approvalLink: { rel: 'approve', base: 'https://evil.example' } });
      try {
        const created = await client(own, await tokenFor(own)).post('/v2/checkout/orders', orderBody(), 'so:66:create_order:1');
        const link = created.json.links.find((l) => l.rel === 'approve');
        assert.equal(link.href, `https://evil.example/checkoutnow?token=${created.json.id}`);
      } finally {
        await own.close();
      }
    });
  });

  describe('fault injection', () => {
    test('http_<NNN>:<kind> answers that status with a PayPal-shaped error, applies nothing, then is spent', async () => {
      stub.fault('http_500:create_order');
      const before = stub.counters().order;
      const res = await api.post('/v2/checkout/orders', orderBody(), 'so:71:create_order:1');
      assert.equal(res.status, 500);
      assert.equal(res.json.name, 'INTERNAL_SERVER_ERROR');
      assert.ok(res.json.message.includes(BODY_MARKER));
      assert.equal(stub.counters().order, before);
      assert.equal(stub.lastCall('create_order').fault, 'http_500:create_order');
      const next = await api.post('/v2/checkout/orders', orderBody(), 'so:71:create_order:1');
      assert.equal(next.status, 201, 'the fault is spent and the failed request id was not stored');
      assert.deepEqual(stub.faultsFired().at(-1), { name: 'http_500:create_order', fired: 1, remaining: 0 });
    });

    test('count applies a fault to that many calls; Infinity until cleared; clearFaults removes it', async () => {
      stub.fault('http_429:get_order', { count: 2 });
      for (let i = 0; i < 2; i += 1) assert.equal((await api.get('/v2/checkout/orders/NOPE')).status, 429);
      assert.equal((await api.get('/v2/checkout/orders/NOPE')).status, 404);
      stub.fault('http_503:get_order', { count: Infinity });
      for (let i = 0; i < 3; i += 1) assert.equal((await api.get('/v2/checkout/orders/NOPE')).status, 503);
      stub.clearFaults();
      assert.equal((await api.get('/v2/checkout/orders/NOPE')).status, 404);
      assert.throws(() => stub.fault('http_503:get_order', { count: 0 }), RangeError);
      assert.throws(() => stub.fault('not-a-fault'), RangeError);
    });

    test('a fault is scoped to its kind and, when given, to its merchant', async () => {
      stub.fault('http_503:get_capture', { merchantKey: 'SOMEONE-ELSE' });
      assert.equal((await api.get('/v2/payments/captures/NOPE')).status, 404, 'another merchant\'s fault does not apply');
      stub.clearFaults();
      stub.fault('http_503:get_capture');
      assert.equal((await api.get('/v2/payments/refunds/NOPE')).status, 404, 'another kind is unaffected');
      assert.equal((await api.get('/v2/payments/captures/NOPE')).status, 503);
      stub.clearFaults();
    });

    test('lost_response: the effect is applied and stored, the connection is dropped, a retry replays the same answer', async () => {
      const w = await authorizedOrder(stub, api, 72);
      stub.fault('lost_response:capture');
      await assert.rejects(api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, {}, 'so:72:capture:1'));
      assert.equal(stub.lastCall('capture').status, null);
      assert.equal(stub.authorization(w.authorizationId).status, 'CAPTURED', 'the capture was applied');
      const captured = stub.counters().capture;
      const retry = await api.post(`/v2/payments/authorizations/${w.authorizationId}/capture`, {}, 'so:72:capture:1');
      assert.equal(retry.status, 201);
      assert.equal(stub.lastCall('capture').replayed, true);
      assert.equal(stub.counters().capture, captured, 'the retry created no second capture');
    });

    test('timeout: nothing is applied and the call never answers (the client\'s own bound ends it); a retry then applies once', async () => {
      stub.fault('timeout:create_order');
      const before = stub.counters().order;
      await assert.rejects(
        fetch(`${stub.baseUrl}/v2/checkout/orders`, {
          method: 'POST', body: JSON.stringify(orderBody()), signal: AbortSignal.timeout(250),
          headers: { authorization: `Bearer ${stub.issuedTokens()[0]}`, 'content-type': 'application/json', 'paypal-request-id': 'so:73:create_order:1' },
        }),
        (err) => err.name === 'TimeoutError' || err.name === 'AbortError',
      );
      assert.equal(stub.counters().order, before, 'nothing was applied');
      assert.equal(stub.lastCall('create_order').fault, 'timeout:create_order');
      assert.equal((await api.post('/v2/checkout/orders', orderBody(), 'so:73:create_order:1')).status, 201);
      assert.equal(stub.counters().order, before + 1);
    });

    test('bad_body: the effect is applied and the answer is 200 text that is not JSON', async () => {
      const orderId = await approvedOrder(stub, api, 'so:74:create_order:1');
      stub.fault('bad_body:authorize');
      const res = await api.post(`/v2/checkout/orders/${orderId}/authorize`, {}, 'so:74:authorize:1');
      assert.equal(res.status, 200);
      assert.equal(res.json, null);
      assert.equal(stub.order(orderId).status, 'COMPLETED', 'authorization was applied');
      assert.equal((await api.post(`/v2/checkout/orders/${orderId}/authorize`, {}, 'so:74:authorize:1')).status, 201, 'the retry replays');
    });

    test('token faults: http_429:token and http_503:token answer on the OAuth endpoint, timeout:token holds it', async () => {
      stub.fault('http_429:token');
      const res = await raw(stub, 'POST', '/v1/oauth2/token', { headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
      assert.equal(res.status, 429);
      stub.fault('timeout:token');
      await assert.rejects(fetch(`${stub.baseUrl}/v1/oauth2/token`, {
        method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(200),
        headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' },
      }));
      stub.clearFaults();
      assert.equal((await tokenFor(stub)).startsWith('A21AA'), true);
    });

    test('status faults: authorize_denied/pending, capture_declined/pending, refund_pending/failed, void_fail, auth_expire', async () => {
      const own = await startPaypalStub();
      try {
        const a = client(own, await tokenFor(own));
        const authStatus = async (n, fault) => {
          const orderId = await approvedOrder(own, a, `so:${n}:create_order:1`);
          if (fault) own.fault(fault);
          const res = await a.post(`/v2/checkout/orders/${orderId}/authorize`, {}, `so:${n}:authorize:1`);
          return { orderId, auth: res.json.purchase_units[0].payments.authorizations[0] };
        };
        assert.equal((await authStatus(1, 'authorize_denied')).auth.status, 'DENIED');
        assert.equal((await authStatus(2, 'authorize_pending')).auth.status, 'PENDING');
        const pendingAuth = await authStatus(3, 'authorize_pending');
        const pendingCap = await a.post(`/v2/payments/authorizations/${pendingAuth.auth.id}/capture`, {}, 'so:3:capture:1');
        assert.equal(pendingCap.json.details[0].issue, 'AUTHORIZATION_PENDING');

        const good = await authStatus(4);
        own.fault('capture_declined');
        const declined = await a.post(`/v2/payments/authorizations/${good.auth.id}/capture`, {}, 'so:4:capture:1');
        assert.equal(declined.json.status, 'DECLINED');
        assert.equal((await a.get(`/v2/payments/authorizations/${good.auth.id}`)).json.status, 'CREATED', 'a declined capture leaves the authorization');
        own.fault('capture_pending');
        const pending = await a.post(`/v2/payments/authorizations/${good.auth.id}/capture`, {}, 'so:4:capture:2');
        assert.equal(pending.json.status, 'PENDING');
        assert.equal((await a.get(`/v2/payments/authorizations/${good.auth.id}`)).json.status, 'CAPTURED');
        own.fault('refund_pending');
        assert.equal((await a.post(`/v2/payments/captures/${declined.json.id}/refund`, {}, 'so:4:refund:0')).json.details[0].issue, 'CAPTURE_NOT_COMPLETED');
        const refundOnPending = await a.post(`/v2/payments/captures/${pending.json.id}/refund`, {}, 'so:4:refund:1');
        assert.equal(refundOnPending.json.details[0].issue, 'CAPTURE_NOT_COMPLETED', 'a PENDING capture cannot be refunded yet');
        own.clearFaults();

        const done = await authorizedOrder(own, a, 5);
        const cap = await a.post(`/v2/payments/authorizations/${done.authorizationId}/capture`, {}, 'so:5:capture:1');
        own.fault('refund_failed');
        const failed = await a.post(`/v2/payments/captures/${cap.json.id}/refund`, {}, 'so:5:refund:1');
        assert.equal(failed.json.status, 'FAILED');
        assert.equal((await a.get(`/v2/payments/captures/${cap.json.id}`)).json.status, 'COMPLETED', 'a failed refund refunds nothing');
        own.fault('refund_pending');
        assert.equal((await a.post(`/v2/payments/captures/${cap.json.id}/refund`, {}, 'so:5:refund:2')).json.status, 'PENDING');

        const voidable = await authorizedOrder(own, a, 6);
        own.fault('void_fail');
        const voidFail = await a.post(`/v2/payments/authorizations/${voidable.authorizationId}/void`, undefined, 'so:6:void:1');
        assert.equal(voidFail.status, 422);
        assert.equal(voidFail.json.details[0].issue, 'AUTHORIZATION_CANNOT_BE_VOIDED');
        assert.equal(own.authorization(voidable.authorizationId).status, 'CREATED');

        const expiring = await approvedOrder(own, a, 'so:7:create_order:1');
        own.fault('auth_expire');
        const exp = await a.post(`/v2/checkout/orders/${expiring}/authorize`, {}, 'so:7:authorize:1');
        const expId = exp.json.purchase_units[0].payments.authorizations[0].id;
        assert.equal((await a.get(`/v2/payments/authorizations/${expId}`)).json.status, 'EXPIRED');
      } finally {
        await own.close();
      }
    });
  });

  describe('verify-webhook-signature', () => {
    const verifyBody = (signed, overrides = {}) => {
      const h = signed.headers;
      const fields = {
        auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: DEFAULT_MERCHANT.webhookId,
        ...overrides,
      };
      const head = Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
      return `{${head},"webhook_event":${signed.rawBody.toString('utf8')}}`; // the raw bytes spliced in, as the adapter must
    };
    const post = (body) => raw(stub, 'POST', '/v1/notifications/verify-webhook-signature', { body, headers: { authorization: `Bearer ${stub.issuedTokens()[0]}` } });
    const event = () => buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' }, withPayer: true });

    test('a correctly signed event: SUCCESS, and the raw event bytes are recorded as spliced', async () => {
      const signed = signEvent({ event: event() });
      const res = await post(verifyBody(signed));
      assert.equal(res.status, 200);
      assert.equal(res.json.verification_status, 'SUCCESS');
      assert.equal(stub.lastCall('verify_webhook').webhookEventRaw, signed.rawBody.toString('utf8'));
    });

    test('non-canonical bytes verify when spliced unchanged, and FAIL when the event was re-serialised', async () => {
      const rawText = '{ "id":"WH-1" ,\n "event_type":"PAYMENT.CAPTURE.COMPLETED", "resource":{"id":"CAP-1","note":"caf\\u00e9"} }';
      const signed = signEvent({ rawBody: rawText });
      assert.equal((await post(verifyBody(signed))).json.verification_status, 'SUCCESS');
      const reserialised = { ...signed, rawBody: Buffer.from(JSON.stringify(JSON.parse(rawText))) };
      assert.equal((await post(verifyBody(reserialised))).json.verification_status, 'FAILURE');
    });

    test('FAILURE for a tampered body, a wrong secret, another webhook id, a disallowed algo and a missing member', async () => {
      const signed = signEvent({ event: event() });
      assert.equal((await post(verifyBody({ ...signed, rawBody: tamperBody(signed.rawBody) }))).json.verification_status, 'FAILURE');
      const forged = signEvent({ event: event(), secret: 'another-secret-that-is-at-least-32-bytes-0002' });
      assert.equal((await post(verifyBody(forged))).json.verification_status, 'FAILURE');
      assert.equal((await post(verifyBody(signed, { webhook_id: 'WH-OTHER' }))).json.verification_status, 'FAILURE');
      assert.equal((await post(verifyBody(signed, { auth_algo: 'MD5' }))).json.verification_status, 'FAILURE');
      const missing = await post(JSON.stringify({ auth_algo: 'SHA256withRSA', webhook_event: {} }));
      assert.equal(missing.status, 400);
    });
  });

  describe('safety', () => {
    test('there is no real host anywhere in the stub\'s own answers', async () => {
      const w = await authorizedOrder(stub, api, 81);
      const order = await api.get(`/v2/checkout/orders/${w.orderId}`);
      const hosts = [...order.text.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1]);
      assert.ok(hosts.length > 0);
      for (const host of hosts) assert.match(host, /^127\.0\.0\.1:\d+$/, 'only loopback links');
      assert.doesNotMatch(order.text, /paypal\.com/);
    });
  });
});

// ---- a reference adapter, to run the shared contract suite against the stub ------------------------------------------------

function toPayPalValue(cents) {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// A compact PaymentProvider over fetch, written from the spec's wire mapping. It exists ONLY to prove that the contract
// suite and the stub agree and that the suite detects faults; e1's src/payments/sandbox.js is the real adapter.
// `leaky` makes it log a response body, to prove that the suite's leak check fires.
function createReferenceProvider({ baseUrl, merchants, timeoutMs, log, leaky = false }) {
  const tokens = new Map();

  function classify(status, text) {
    if (status >= 200 && status < 300) {
      if (status === 204 || text === '') return { kind: 'ok', httpStatus: status, value: {} };
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== 'object') throw new Error('not an object');
        return { kind: 'ok', httpStatus: status, value };
      } catch {
        return { kind: 'unknown', reason: 'bad_body' };
      }
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    const issue = parsed?.details?.[0]?.issue ?? parsed?.name ?? parsed?.error ?? 'UNKNOWN';
    if (status === 401 || status === 403 || status === 429) return { kind: 'retryable', httpStatus: status, issue };
    if (status >= 500) return { kind: 'unknown', reason: 'http_5xx' };
    return { kind: 'rejected', httpStatus: status, issue };
  }

  function failure(err) {
    return { kind: 'unknown', reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  async function token(merchantKey, signal) {
    const cached = tokens.get(merchantKey);
    if (cached && Date.now() < cached.expiresAt) return { token: cached.token };
    const m = merchants[merchantKey];
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST', signal,
      headers: { authorization: `Basic ${Buffer.from(`${m.clientId}:${m.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    const outcome = classify(res.status, text);
    if (outcome.kind !== 'ok') return { outcome };
    tokens.set(merchantKey, { token: outcome.value.access_token, expiresAt: Date.now() + (outcome.value.expires_in - 60) * 1000 });
    return { token: outcome.value.access_token };
  }

  async function call(merchantKey, kind, method, path, { body, requestId, prefer } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const t = await token(merchantKey, signal);
      if (t.outcome) return t.outcome;
      const res = await fetch(`${baseUrl}${path}`, {
        method, signal, body,
        headers: {
          authorization: `Bearer ${t.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(requestId ? { 'paypal-request-id': requestId } : {}), ...(prefer ? { prefer } : {}),
        },
      });
      const text = await res.text();
      if (leaky) { // the defect the suite must catch: provider data (payer data, or the error body) in a log line
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        log.info(parsed?.payer ? JSON.stringify(parsed.payer) : text);
      }
      const outcome = classify(res.status, text);
      log.info('provider.call', { kind, httpStatus: res.status, operationKey: requestId, provider: 'paypal-sandbox' });
      return outcome;
    } catch (err) {
      log.warn('provider.call.failed', { kind, provider: 'paypal-sandbox' });
      return failure(err);
    }
  }

  const map = (outcome, fn) => (outcome.kind === 'ok' ? { ...outcome, value: fn(outcome.value) } : outcome);
  const tail = (href) => String(href ?? '').split('/').pop();
  const upId = (links) => tail(links?.find((l) => l.rel === 'up')?.href);
  const money = (cents, currency) => ({ currency_code: currency, value: toPayPalValue(cents) });

  return {
    id: 'paypal-sandbox', simulated: false, sandbox: true,
    async createOrder({ merchantKey, requestId, amountCents, currency, referenceId, returnUrl, cancelUrl }) {
      const body = JSON.stringify({
        intent: 'AUTHORIZE',
        purchase_units: [{ reference_id: referenceId, custom_id: referenceId, invoice_id: `rs-${referenceId}-a1`, description: 'RescueStock demo order (Sandbox)', amount: money(amountCents, currency) }],
        payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'RescueStock Sandbox Demo' } } },
      });
      const out = await call(merchantKey, 'create_order', 'POST', '/v2/checkout/orders', { body, requestId, prefer: 'return=minimal' });
      return map(out, (v) => ({ orderId: v.id, status: v.status, approvalUrl: v.links?.find((l) => ['payer-action', 'approve'].includes(l.rel))?.href }));
    },
    async getOrder({ merchantKey, orderId }) {
      const out = await call(merchantKey, 'get_order', 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      return map(out, (v) => {
        const pay = v.purchase_units?.[0]?.payments ?? {};
        return {
          status: v.status,
          authorizations: (pay.authorizations ?? []).map((a) => ({ id: a.id, status: a.status, expirationTime: a.expiration_time })),
          captures: (pay.captures ?? []).map((c) => ({ id: c.id, status: c.status, authorizationId: upId(c.links) })),
          refunds: (pay.refunds ?? []).map((r) => ({ id: r.id, status: r.status, captureId: upId(r.links) })),
        };
      });
    },
    async authorizeOrder({ merchantKey, requestId, orderId }) {
      const out = await call(merchantKey, 'authorize', 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { body: '{}', requestId });
      return map(out, (v) => {
        const a = v.purchase_units?.[0]?.payments?.authorizations?.[0];
        return { authorizationId: a?.id, status: a?.status, expirationTime: a?.expiration_time };
      });
    },
    async getAuthorization({ merchantKey, authorizationId }) {
      return map(await call(merchantKey, 'get_authorization', 'GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`),
        (v) => ({ status: v.status, expirationTime: v.expiration_time }));
    },
    async captureAuthorization({ merchantKey, requestId, authorizationId, amountCents, currency, invoiceId }) {
      const body = JSON.stringify({ amount: money(amountCents, currency), final_capture: true, invoice_id: invoiceId });
      return map(await call(merchantKey, 'capture', 'POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, { body, requestId }),
        (v) => ({ captureId: v.id, status: v.status }));
    },
    async getCapture({ merchantKey, captureId }) {
      return map(await call(merchantKey, 'get_capture', 'GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`), (v) => ({ status: v.status }));
    },
    async voidAuthorization({ merchantKey, requestId, authorizationId }) {
      return map(await call(merchantKey, 'void', 'POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, { requestId }), () => ({ status: 'VOIDED' }));
    },
    async refundCapture({ merchantKey, requestId, captureId, amountCents, currency }) {
      const body = JSON.stringify({ amount: money(amountCents, currency), note_to_payer: 'RescueStock demo compensation' });
      return map(await call(merchantKey, 'refund', 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { body, requestId }),
        (v) => ({ refundId: v.id, status: v.status }));
    },
    async getRefund({ merchantKey, refundId }) {
      return map(await call(merchantKey, 'get_refund', 'GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`), (v) => ({ status: v.status }));
    },
    async verifyWebhook({ merchantKey, headers, rawBody }) {
      const need = WEBHOOK_HEADER_NAMES;
      if (!headers || need.some((n) => typeof headers[n] !== 'string' || headers[n] === '')) {
        return { kind: 'ok', httpStatus: 200, value: { verified: false } };
      }
      const m = merchants[merchantKey];
      const fields = {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: m.webhookId,
      };
      const head = Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
      const body = `{${head},"webhook_event":${Buffer.from(rawBody).toString('utf8')}}`; // raw bytes spliced, not re-serialised
      return map(await call(merchantKey, 'verify_webhook', 'POST', '/v1/notifications/verify-webhook-signature', { body }),
        (v) => ({ verified: v.verification_status === 'SUCCESS' }));
    },
  };
}

async function createReferenceHarness({ timeoutMs, log, clock }, { leaky = false } = {}) {
  const stub = await startPaypalStub({ clock, appOrigin: APP_ORIGIN });
  const provider = createReferenceProvider({ baseUrl: stub.baseUrl, merchants: stub.merchants, timeoutMs, log, leaky });
  const m = stub.merchants[MERCHANT];
  return {
    provider,
    expectations: { id: 'paypal-sandbox', simulated: false, sandbox: true },
    approve: async (orderId) => stub.approve(orderId),
    supports: (fault) => { try { parseFaultName(fault); return true; } catch { return false; } },
    inject: (fault, { count = 1 } = {}) => stub.fault(fault, { count }),
    clear: () => stub.clearFaults(),
    webhookSecret: stub.webhookSecret,
    sensitive: () => [...stub.issuedTokens(), m.clientId, m.clientSecret, m.webhookId],
    wire: { calls: (kind) => stub.callsOf(kind), clear: () => stub.clearCalls() },
    close: () => stub.close(),
  };
}

// The shared suite, against the reference adapter over the stub.
runProviderContract({ name: 'reference adapter over paypal-stub', createAdapter: createReferenceHarness });

describe('the contract suite is not vacuous', () => {
  test('findLeaks reports every marker present in the texts and ignores empty markers', () => {
    const texts = ['{"msg":"ok"}', `got ${FAKE_PAYER.email} back`, `body ${BODY_MARKER}`];
    const found = findLeaks(texts, [FAKE_PAYER.email, BODY_MARKER, 'absent-marker', '', undefined]);
    assert.deepEqual(found.map((f) => f.marker).sort(), [BODY_MARKER, FAKE_PAYER.email].sort());
    assert.deepEqual(findLeaks(['clean'], PAYER_MARKERS), []);
  });

  test('an adapter that logs a provider response body is caught: its log lines contain payer data and a token marker', async () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l), clock: fixedClock(STUB_START_MS), requestId: 'leak-check' });
    const harness = await createReferenceHarness({ timeoutMs: 2000, log, clock: fixedClock(STUB_START_MS) }, { leaky: true });
    try {
      const created = await harness.provider.createOrder({
        merchantKey: MERCHANT, requestId: 'so:900:create_order:1', amountCents: 1250, currency: 'USD', referenceId: 'so-900', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
      });
      await harness.approve(created.value.orderId);
      await harness.provider.getOrder({ merchantKey: MERCHANT, orderId: created.value.orderId });
      await harness.provider.getOrder({ merchantKey: MERCHANT, orderId: 'NO-SUCH-ORDER' });
      const leaks = findLeaks(lines, [...PAYER_MARKERS, BODY_MARKER]);
      assert.ok(leaks.some((l) => l.marker === FAKE_PAYER.email), 'the payer e-mail in a logged body is found');
      assert.ok(leaks.some((l) => l.marker === BODY_MARKER), 'the provider error body marker is found');
    } finally {
      await harness.close();
    }
  });

  test('the well-behaved reference adapter leaves no leak in the same scenario', async () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l), clock: fixedClock(STUB_START_MS), requestId: 'clean-check' });
    const harness = await createReferenceHarness({ timeoutMs: 2000, log, clock: fixedClock(STUB_START_MS) });
    try {
      const created = await harness.provider.createOrder({
        merchantKey: MERCHANT, requestId: 'so:901:create_order:1', amountCents: 1250, currency: 'USD', referenceId: 'so-901', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
      });
      await harness.approve(created.value.orderId);
      await harness.provider.getOrder({ merchantKey: MERCHANT, orderId: created.value.orderId });
      await harness.provider.getOrder({ merchantKey: MERCHANT, orderId: 'NO-SUCH-ORDER' });
      assert.ok(lines.length >= 3, 'the adapter logged its calls');
      assert.deepEqual(findLeaks(lines, [...harness.sensitive(), ...PAYER_MARKERS, BODY_MARKER, RETURN_URL]), []);
    } finally {
      await harness.close();
    }
  });
});
