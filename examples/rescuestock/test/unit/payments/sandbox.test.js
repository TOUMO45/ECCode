// src/payments/sandbox.js: the PayPal Sandbox REST adapter, verified ONLY against the loopback double test/helpers/paypal-stub.js and
// against injected fetch functions (LIVE-DEPENDENT: no Sandbox host is contacted, no credential exists). The shared contract suite
// (provider-contract.test.js) covers the PaymentProvider behaviour; this file covers the adapter's own rules: construction guards,
// OAuth caching and the single deadline, outcome classification, the approval-link host (SEC-3, T17), the raw-bytes webhook
// splice, argument validation and secrets handling.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { PAYPAL_SANDBOX_API, Secret } from '../../../src/config.js';
import { fixedClock } from '../../../src/clock.js';
import { createLogger } from '../../../src/log.js';
import { APPROVAL_HOST, TOKEN_SAFETY_SECONDS, approvalHostAllowed, classifyResponse, createSandboxProvider } from '../../../src/payments/sandbox.js';
import { assertPaymentProvider } from '../../../src/payments/provider.js';
import { BODY_MARKER, STUB_START_MS, startPaypalStub } from '../../helpers/paypal-stub.js';
import { PAYER_MARKERS, buildEvent, signEvent } from '../../helpers/webhook-signer.js';

const RETURN_URL = 'http://localhost:3000/api/paypal/return';
const CANCEL_URL = 'http://localhost:3000/api/paypal/cancel';
const stubs = [];
after(async () => { for (const s of stubs) await s.close(); });

const secretsOf = (m) => ({ clientId: new Secret(m.clientId), clientSecret: new Secret(m.clientSecret), webhookId: new Secret(m.webhookId) });

async function setup({ merchants, stubOptions = {}, adapterClock = fixedClock(STUB_START_MS), timeoutMs = 2000, fetch } = {}) {
  const stub = await startPaypalStub({ appOrigin: 'http://localhost:3000', ...(merchants ? { merchants } : {}), ...stubOptions });
  stubs.push(stub);
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), clock: fixedClock(STUB_START_MS), requestId: 'sandbox-test' });
  const provider = createSandboxProvider({
    baseUrl: stub.baseUrl, merchants: Object.fromEntries(Object.entries(stub.merchants).map(([k, m]) => [k, secretsOf(m)])),
    timeoutMs, testOffline: true, log, clock: adapterClock, fetch,
  });
  return { stub, provider, lines, clock: adapterClock };
}
const create = (provider, requestId, merchantKey = 'DEFAULT', amountCents = 1250) => provider.createOrder({
  merchantKey, requestId, amountCents, currency: 'USD', referenceId: 'so-77', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
});
const tokenCalls = (stub) => stub.callsOf('token');

// A fetch double: answers by URL path suffix; records what the adapter asked for.
function scriptedFetch(routes) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url: String(url), init });
    const path = new URL(url).pathname;
    const route = routes[path] ?? routes['*'];
    if (!route) throw new Error(`unexpected request ${path}`);
    return route(url, init);
  };
  fn.seen = seen;
  return fn;
}
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const TOKEN_OK = () => json(200, { access_token: 'A21AA-scripted-token', token_type: 'Bearer', expires_in: 3600 });

describe('construction guards (SEC-3, T18)', () => {
  test('the adapter is a PaymentProvider that is not simulated and is a sandbox', () => {
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: {}, log: createLogger({ write: () => {} }) });
    assertPaymentProvider(provider);
    assert.deepEqual([provider.id, provider.simulated, provider.sandbox], ['paypal-sandbox', false, true]);
  });

  test('only the Sandbox API host is accepted; a loopback base only with testOffline; anything else throws before any request', () => {
    const make = (baseUrl, testOffline = false) => () => createSandboxProvider({ baseUrl, merchants: {}, testOffline });
    assert.doesNotThrow(make(PAYPAL_SANDBOX_API));
    assert.doesNotThrow(make(`${PAYPAL_SANDBOX_API}/`));
    assert.doesNotThrow(make('http://127.0.0.1:4010', true));
    assert.doesNotThrow(make('http://localhost:4010', true));
    for (const bad of [
      'https://api-m.paypal.com', 'https://api.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com.evil.example', 'https://evil.example',
      'http://api-m.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com:8443', 'http://127.0.0.1:4010', 'http://localhost:4010', 'http://10.0.0.5:80',
      'http://127.0.0.1:4010/path', '', null, 7,
    ]) {
      assert.throws(make(bad), RangeError, String(bad));
    }
    assert.throws(make('https://api-m.paypal.com', true), RangeError, 'the live host is refused even in test mode');
    assert.throws(() => createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: {}, timeoutMs: 0 }), RangeError);
    assert.throws(() => createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: {}, timeoutMs: 1.5 }), RangeError);
  });

  test('with the default base URL every request goes to api-m.sandbox.paypal.com over https (injected fetch, nothing is sent)', async () => {
    const f = scriptedFetch({
      '/v1/oauth2/token': TOKEN_OK,
      '*': () => json(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] }),
    });
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'cid', clientSecret: 'csec', webhookId: 'wid' }) }, fetch: f });
    const outcome = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'ORDER-1' });
    assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 404, 'INVALID_RESOURCE_ID']);
    assert.deepEqual(f.seen.map((s) => new URL(s.url).origin), [PAYPAL_SANDBOX_API, PAYPAL_SANDBOX_API]);
    assert.deepEqual(f.seen.map((s) => new URL(s.url).pathname), ['/v1/oauth2/token', '/v2/checkout/orders/ORDER-1']);
  });
});

describe('OAuth: cached per merchant until expires_in - 60 s, one deadline for the whole call', () => {
  test('the token is fetched once and reused; it is refetched when expires_in - 60 s has passed', async () => {
    const clock = fixedClock(STUB_START_MS);
    const { stub, provider } = await setup({ adapterClock: clock, stubOptions: { tokenTtlSeconds: 180 } });
    const o = await create(provider, 'so:1:create_order:1');
    assert.equal(o.kind, 'ok');
    await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    assert.equal(tokenCalls(stub).length, 1);
    clock.advance((180 - TOKEN_SAFETY_SECONDS) * 1000 - 1);
    await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    assert.equal(tokenCalls(stub).length, 1, 'still cached one millisecond before expires_in - 60 s');
    clock.advance(1);
    await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    assert.equal(tokenCalls(stub).length, 2, 'refetched at expires_in - 60 s');
    assert.notEqual(stub.callsOf('get_order').at(-1).headers.authorization, stub.callsOf('get_order')[0].headers.authorization);
  });

  test('the cache is per merchant: two merchants fetch two tokens, each used for its own calls', async () => {
    const { stub, provider } = await setup({
      merchants: { A: { clientId: 'id-A', clientSecret: 'secret-A', webhookId: 'wh-A' }, B: { clientId: 'id-B', clientSecret: 'secret-B', webhookId: 'wh-B' } },
    });
    const a = await create(provider, 'so:1:create_order:1', 'A');
    const b = await create(provider, 'so:2:create_order:1', 'B');
    await create(provider, 'so:3:create_order:1', 'A');
    assert.equal(tokenCalls(stub).length, 2);
    assert.deepEqual(tokenCalls(stub).map((c) => c.merchantKey), ['A', 'B']);
    // B cannot read A's order (the double scopes resources to the merchant of the token).
    assert.equal((await provider.getOrder({ merchantKey: 'B', orderId: a.value.orderId })).kind, 'rejected');
    assert.equal((await provider.getOrder({ merchantKey: 'B', orderId: b.value.orderId })).kind, 'ok');
  });

  test('a token that lives 60 s or less is never cached', async () => {
    const { stub, provider } = await setup({ stubOptions: { tokenTtlSeconds: 60 } });
    await create(provider, 'so:1:create_order:1');
    await create(provider, 'so:2:create_order:1');
    assert.equal(tokenCalls(stub).length, 2);
  });

  test('a 401 is retryable and drops the cached token, so the next call fetches a new one and works', async () => {
    const { stub, provider } = await setup();
    const o = await create(provider, 'so:1:create_order:1');
    stub.expireTokens();
    const denied = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    assert.deepEqual([denied.kind, denied.httpStatus], ['retryable', 401]);
    const again = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    assert.equal(again.kind, 'ok');
    assert.equal(tokenCalls(stub).length, 2);
  });

  test('one AbortSignal.timeout covers the OAuth fetch AND the API call: two 250 ms steps do not fit in 400 ms', async () => {
    const sleepy = (ms, make) => (url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), ms);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    const f = scriptedFetch({
      '/v1/oauth2/token': sleepy(250, TOKEN_OK),
      '*': sleepy(250, () => json(200, { id: 'O-1', status: 'CREATED', links: [] })),
    });
    const provider = createSandboxProvider({
      baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, timeoutMs: 400, fetch: f,
    });
    const started = Date.now();
    const outcome = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' });
    assert.deepEqual(outcome, { kind: 'unknown', reason: 'timeout' });
    assert.ok(Date.now() - started < 1500, 'it gave up at the deadline, not after both steps');
    assert.equal(f.seen.length, 2, 'the API call was started (the token came back in time) and then cut off');
  });

  test('token endpoint failures become Outcomes: invalid client 401 retryable, no access_token unknown bad_body, 5xx unknown', async () => {
    const cases = [
      [() => json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }), { kind: 'retryable', httpStatus: 401, issue: 'HTTP_401' }],
      [() => json(200, { token_type: 'Bearer', expires_in: 3600 }), { kind: 'unknown', reason: 'bad_body' }],
      [() => json(200, { access_token: 'x', expires_in: 'soon' }), { kind: 'unknown', reason: 'bad_body' }],
      [() => json(503, { name: 'SERVICE_UNAVAILABLE' }), { kind: 'unknown', reason: 'http_5xx' }],
      [() => json(200, 'not json'), { kind: 'unknown', reason: 'bad_body' }],
    ];
    for (const [answer, expected] of cases) {
      const f = scriptedFetch({ '/v1/oauth2/token': answer });
      const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
      assert.deepEqual(await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' }), expected);
      assert.equal(f.seen.length, 1, 'no API call without a token');
    }
  });

  test('a merchant without credentials is rejected MERCHANT_NOT_CONFIGURED without any request', async () => {
    const f = scriptedFetch({});
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
    assert.deepEqual(await provider.getOrder({ merchantKey: 'C', orderId: 'O-1' }), { kind: 'rejected', httpStatus: 400, issue: 'MERCHANT_NOT_CONFIGURED' });
    assert.equal(f.seen.length, 0);
  });
});

describe('outcome classification', () => {
  test('2xx with a parseable object body is ok (an empty body too); anything else 2xx is unknown bad_body', () => {
    assert.deepEqual(classifyResponse(200, '{"a":1}'), { kind: 'ok', value: { a: 1 }, httpStatus: 200 });
    assert.deepEqual(classifyResponse(204, ''), { kind: 'ok', value: {}, httpStatus: 204 });
    for (const text of ['<html>', '[1]', 'null', '"x"', '12', '{']) assert.deepEqual(classifyResponse(200, text), { kind: 'unknown', reason: 'bad_body' }, text);
  });

  test('400/404/409/422 are rejected with the PayPal issue; 401/403/429 retryable; 5xx unknown; a redirect is unknown', () => {
    const body = JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'free text', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED', description: 'free' }] });
    for (const status of [400, 404, 409, 422]) assert.deepEqual(classifyResponse(status, body), { kind: 'rejected', httpStatus: status, issue: 'AUTHORIZATION_ALREADY_CAPTURED' });
    for (const status of [401, 403, 429]) assert.deepEqual(classifyResponse(status, body), { kind: 'retryable', httpStatus: status, issue: 'AUTHORIZATION_ALREADY_CAPTURED' });
    for (const status of [500, 502, 503, 504, 599]) assert.deepEqual(classifyResponse(status, body), { kind: 'unknown', reason: 'http_5xx' });
    for (const status of [301, 302, 307]) assert.deepEqual(classifyResponse(status, ''), { kind: 'unknown', reason: 'bad_body' });
    assert.equal(classifyResponse(405, '').kind, 'rejected', 'another 4xx is definitive');
  });

  test('the issue is an upper-case token from details[0].issue or name; free text is never copied', () => {
    const issue = (parsed, status = 422) => classifyResponse(status, JSON.stringify(parsed)).issue;
    assert.equal(issue({ name: 'INVALID_REQUEST', details: [{ issue: 'ORDER_NOT_APPROVED' }] }), 'ORDER_NOT_APPROVED');
    assert.equal(issue({ name: 'INVALID_REQUEST' }), 'INVALID_REQUEST');
    assert.equal(issue({ name: 'bad name with spaces', details: [{ issue: 'secret token A21AAxyz' }] }), 'HTTP_422');
    assert.equal(issue({ message: `echo ${BODY_MARKER}`, details: [{ issue: 'lower_case' }] }), 'HTTP_422');
    assert.equal(classifyResponse(422, 'not json').issue, 'HTTP_422');
    assert.equal(classifyResponse(429, '').issue, 'HTTP_429');
    assert.equal(issue({ details: [{ issue: 'A'.repeat(80) }] }), 'HTTP_422');
  });

  test('through the double: a provider error body never reaches an Outcome or a log line', async () => {
    const { stub, provider, lines } = await setup();
    const outcome = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'NO-SUCH-ORDER' });
    assert.equal(outcome.kind, 'rejected');
    assert.equal(stub.callsOf('get_order')[0].responseBody.includes(BODY_MARKER), true, 'the double did send the marker');
    assert.equal(JSON.stringify(outcome).includes(BODY_MARKER), false);
    assert.equal(lines.join('').includes(BODY_MARKER), false);
  });

  test('redirects are not followed (a Bearer token must not leave the host) and an oversized body is bad_body', async () => {
    const f = scriptedFetch({
      '/v1/oauth2/token': TOKEN_OK,
      '/v2/checkout/orders/REDIRECT': (url, init) => {
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      },
      '/v2/checkout/orders/HUGE': () => new Response('{"pad":"' + 'x'.repeat(1024 * 1024 + 10) + '"}', { status: 200 }),
    });
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
    assert.deepEqual(await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'REDIRECT' }), { kind: 'unknown', reason: 'bad_body' });
    assert.deepEqual(await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'HUGE' }), { kind: 'unknown', reason: 'bad_body' });
    assert.ok(f.seen.every((s) => new URL(s.url).origin === PAYPAL_SANDBOX_API));
  });

  test('a network error or an abort is unknown network or timeout; the error text (which could hold a credential) is not kept', async () => {
    const creds = { clientId: 'client-id-LEAK', clientSecret: 'client-secret-LEAK', webhookId: 'webhook-id-LEAK' };
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l), clock: fixedClock(STUB_START_MS) });
    const leaky = async () => { throw new TypeError(`fetch failed for Basic ${Buffer.from('client-id-LEAK:client-secret-LEAK').toString('base64')} client-secret-LEAK`); };
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf(creds) }, log, fetch: leaky });
    const outcome = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' });
    assert.deepEqual(outcome, { kind: 'unknown', reason: 'network' });
    const aborted = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf(creds) }, log, fetch: async () => { throw new DOMException('aborted', 'AbortError'); } });
    assert.deepEqual(await aborted.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' }), { kind: 'unknown', reason: 'timeout' });
    const text = lines.join('') + JSON.stringify(outcome);
    for (const secret of Object.values(creds)) assert.equal(text.includes(secret), false);
    assert.equal(text.includes(Buffer.from('client-id-LEAK:client-secret-LEAK').toString('base64')), false);
  });
});

describe('the approval link host (SEC-3, T17)', () => {
  test('approvalHostAllowed: https on www.sandbox.paypal.com only; a loopback http host only with the test flag', () => {
    assert.equal(APPROVAL_HOST, 'www.sandbox.paypal.com');
    for (const href of ['https://www.sandbox.paypal.com/checkoutnow?token=ORDER1', 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1&x=y']) {
      assert.equal(approvalHostAllowed(href, false), true, href);
      assert.equal(approvalHostAllowed(href, true), true, href);
    }
    for (const href of [
      'http://www.sandbox.paypal.com/checkoutnow?token=O', 'https://www.paypal.com/checkoutnow?token=O', 'https://paypal.com/x', 'https://sandbox.paypal.com/x',
      'https://www.sandbox.paypal.com.evil.example/x', 'https://evil.example/www.sandbox.paypal.com', 'https://www.sandbox.paypal.com@evil.example/x',
      'https://user:pw@www.sandbox.paypal.com/x', 'https://www.sandbox.paypal.com:8443/x', 'https://WWW.SANDBOX.PAYPAL.COM.evil.example/x',
      'javascript:alert(1)', 'ftp://www.sandbox.paypal.com/x', '//www.sandbox.paypal.com/x', '/checkoutnow', '', 'not a url', 'https://api-m.sandbox.paypal.com/x',
    ]) {
      assert.equal(approvalHostAllowed(href, false), false, `${href} (live mode)`);
      assert.equal(approvalHostAllowed(href, true), false, `${href} (test mode)`);
    }
    for (const href of ['http://127.0.0.1:4010/checkoutnow?token=O', 'http://localhost:4010/checkoutnow?token=O']) {
      assert.equal(approvalHostAllowed(href, true), true, href);
      assert.equal(approvalHostAllowed(href, false), false, `${href} needs RS_TEST_OFFLINE=1`);
    }
    assert.equal(approvalHostAllowed('http://10.0.0.5/x', true), false, 'only loopback, even in test mode');
    assert.equal(approvalHostAllowed('http://127.0.0.1.evil.example/x', true), false);
  });

  test('createOrder: a link to a foreign host is rejected APPROVAL_HOST_INVALID and the URL is not echoed', async () => {
    for (const base of ['https://evil.example', 'https://www.paypal.com', 'http://10.1.2.3:9']) {
      const { provider, lines } = await setup({ stubOptions: { approvalLink: { base } } });
      const outcome = await create(provider, 'so:1:create_order:1');
      assert.deepEqual([outcome.kind, outcome.issue], ['rejected', 'APPROVAL_HOST_INVALID'], base);
      assert.equal(JSON.stringify(outcome).includes('evil'), false);
      assert.equal(lines.join('').includes('evil'), false);
    }
  });

  test('createOrder: the real Sandbox page host is accepted, with rel payer-action or approve', async () => {
    for (const rel of ['payer-action', 'approve']) {
      const { provider } = await setup({ stubOptions: { approvalLink: { base: 'https://www.sandbox.paypal.com', rel } } });
      const outcome = await create(provider, `so:1:create_order:${rel.length}`);
      assert.equal(outcome.kind, 'ok', rel);
      assert.match(outcome.value.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=STUBORD\d+$/);
    }
  });

  test('createOrder: the loopback stub link needs testOffline; without it the same answer is rejected (live-mode strictness)', async () => {
    const answer = () => json(201, { id: 'ORD-1', status: 'CREATED', links: [{ rel: 'payer-action', href: 'http://127.0.0.1:4010/checkoutnow?token=ORD-1' }] });
    const run = async (testOffline) => {
      const f = scriptedFetch({ '/v1/oauth2/token': TOKEN_OK, '/v2/checkout/orders': answer });
      const provider = createSandboxProvider({
        baseUrl: testOffline ? 'http://127.0.0.1:4011' : PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, testOffline, fetch: f,
      });
      return create(provider, 'so:1:create_order:1');
    };
    assert.equal((await run(true)).kind, 'ok');
    assert.deepEqual((await run(false)).issue, 'APPROVAL_HOST_INVALID');
  });

  test('createOrder: an answer without an approval link is rejected APPROVAL_LINK_MISSING; one without id or status is bad_body', async () => {
    const run = async (body) => {
      const f = scriptedFetch({ '/v1/oauth2/token': TOKEN_OK, '/v2/checkout/orders': () => json(201, body) });
      const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
      return create(provider, 'so:1:create_order:1');
    };
    assert.equal((await run({ id: 'O-1', status: 'CREATED', links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/O-1' }] })).issue, 'APPROVAL_LINK_MISSING');
    assert.deepEqual(await run({ status: 'CREATED', links: [] }), { kind: 'unknown', reason: 'bad_body' });
    assert.deepEqual(await run({ id: 'O-1', links: [] }), { kind: 'unknown', reason: 'bad_body' });
  });
});

describe('the wire mapping', () => {
  test('createOrder sends the full spec body: AUTHORIZE, invoice and custom ids, the description, PAY_NOW, NO_SHIPPING, Prefer and the request id', async () => {
    const { stub, provider } = await setup();
    const outcome = await create(provider, 'so:77:create_order:1', 'DEFAULT', 100005);
    assert.equal(outcome.kind, 'ok');
    const call = stub.lastCall('create_order');
    assert.equal(call.requestId, 'so:77:create_order:1');
    assert.match(call.headers.prefer, /return=minimal/);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: 'so-77', custom_id: 'so-77', invoice_id: 'rs-so-77-a1', description: 'RescueStock demo order (Sandbox)',
        amount: { currency_code: 'USD', value: '1000.05' },
      }],
      payment_source: { paypal: { experience_context: {
        return_url: RETURN_URL, cancel_url: CANCEL_URL, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'RescueStock Sandbox Demo',
      } } },
    });
  });

  test('createOrder: invoice_id carries the attempt (rs-<referenceId>-a<attempt>), so an A13 re-create never repeats an invoice id; attempt 1 and no attempt are unchanged', async () => {
    const { stub, provider } = await setup();
    const withAttempt = (requestId, attempt) => provider.createOrder({
      merchantKey: 'DEFAULT', requestId, amountCents: 1250, currency: 'USD', referenceId: 'so-77', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
      ...(attempt === undefined ? {} : { attempt }),
    });
    const invoiceOf = () => stub.lastCall('create_order').body.purchase_units[0];
    assert.equal((await withAttempt('so:77:create_order:1', 1)).kind, 'ok');
    assert.equal(invoiceOf().invoice_id, 'rs-so-77-a1');
    assert.equal((await withAttempt('so:77:create_order:2', 2)).kind, 'ok');
    assert.equal(invoiceOf().invoice_id, 'rs-so-77-a2');
    assert.equal(invoiceOf().reference_id, 'so-77', 'reference and custom ids stay attempt-free');
    assert.equal(invoiceOf().custom_id, 'so-77');
    assert.equal((await withAttempt('so:77:create_order:12', 12)).kind, 'ok');
    assert.equal(invoiceOf().invoice_id, 'rs-so-77-a12');
    assert.equal((await withAttempt('so:78:create_order:1')).kind, 'ok');
    assert.equal(invoiceOf().invoice_id, 'rs-so-77-a1', 'no attempt means attempt 1');
    const ids = stub.callsOf('create_order').map((c) => c.body.purchase_units[0].invoice_id);
    assert.deepEqual(ids, ['rs-so-77-a1', 'rs-so-77-a2', 'rs-so-77-a12', 'rs-so-77-a1']);
  });

  test('createOrder: an attempt that is not a positive integer up to 999 is rejected 400 INVALID_ARGUMENT before anything is sent', async () => {
    const { stub, provider } = await setup();
    for (const attempt of [0, -1, 1.5, 1000, '2', NaN, Infinity, {}, [], true]) {
      const outcome = await provider.createOrder({
        merchantKey: 'DEFAULT', requestId: 'so:77:create_order:1', amountCents: 100, currency: 'USD', referenceId: 'so-77', attempt, returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
      });
      assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 400, 'INVALID_ARGUMENT'], String(attempt));
    }
    assert.equal(stub.calls.length, 0, 'the double saw nothing');
  });

  test('the ok payloads carry provider paypal-sandbox and sandbox: true, and never the buyer\'s payer data', async () => {
    const { stub, provider } = await setup();
    const o = await create(provider, 'so:1:create_order:1');
    stub.approve(o.value.orderId);
    const a = await provider.authorizeOrder({ merchantKey: 'DEFAULT', requestId: 'so:1:authorize:1', orderId: o.value.orderId });
    const order = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: o.value.orderId });
    for (const outcome of [o, a, order]) {
      assert.equal(outcome.kind, 'ok');
      assert.equal(outcome.value.provider, 'paypal-sandbox');
      assert.equal(outcome.value.sandbox, true);
    }
    assert.equal(stub.lastCall('get_order').responseBody.includes(PAYER_MARKERS[1]), true, 'the double did answer with payer data');
    assert.equal(JSON.stringify([o, a, order]).includes(PAYER_MARKERS[1]), false);
  });

  test('an authorization that is already EXPIRED when authorize answers is reported CREATED with its past expirationTime; a later read says EXPIRED', async () => {
    const { stub, provider } = await setup();
    const o = await create(provider, 'so:1:create_order:1');
    stub.approve(o.value.orderId);
    stub.fault('auth_expire');
    const a = await provider.authorizeOrder({ merchantKey: 'DEFAULT', requestId: 'so:1:authorize:1', orderId: o.value.orderId });
    assert.equal(a.kind, 'ok');
    assert.equal(a.value.status, 'CREATED');
    assert.equal(Date.parse(a.value.expirationTime), STUB_START_MS);
    const read = await provider.getAuthorization({ merchantKey: 'DEFAULT', authorizationId: a.value.authorizationId });
    assert.equal(read.value.status, 'EXPIRED');
  });

  test('2xx answers that lack what the port promises are unknown bad_body, not half-filled values', async () => {
    const answers = {
      authorize: json(201, { id: 'O-1', status: 'COMPLETED', purchase_units: [{ payments: {} }] }),
      authorizeStatus: json(201, { purchase_units: [{ payments: { authorizations: [{ id: 'A-1', status: 'MYSTERY', expiration_time: '2026-11-18T06:00:00Z' }] } }] }),
      capture: json(201, { id: 'C-1', status: 'MYSTERY' }),
      captureId: json(201, { status: 'COMPLETED' }),
      refund: json(201, { id: 'R-1' }),
      getAuth: json(200, {}),
      getOrder: json(200, { id: 'O-1', purchase_units: [] }),
      getOrderBroken: json(200, { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED' }] } }] }),
    };
    const f = scriptedFetch({
      '/v1/oauth2/token': TOKEN_OK,
      '/v2/checkout/orders/O-1/authorize': () => answers.authorize.clone(),
      '/v2/checkout/orders/O-2/authorize': () => answers.authorizeStatus.clone(),
      '/v2/payments/authorizations/A-1/capture': () => answers.capture.clone(),
      '/v2/payments/authorizations/A-2/capture': () => answers.captureId.clone(),
      '/v2/payments/captures/C-1/refund': () => answers.refund.clone(),
      '/v2/payments/authorizations/A-1': () => answers.getAuth.clone(),
      '/v2/checkout/orders/O-1': () => answers.getOrder.clone(),
      '/v2/checkout/orders/O-3': () => answers.getOrderBroken.clone(),
    });
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
    const bad = { kind: 'unknown', reason: 'bad_body' };
    const m = { merchantKey: 'DEFAULT' };
    assert.deepEqual(await provider.authorizeOrder({ ...m, requestId: 'so:1:authorize:1', orderId: 'O-1' }), bad);
    assert.deepEqual(await provider.authorizeOrder({ ...m, requestId: 'so:2:authorize:1', orderId: 'O-2' }), bad);
    assert.deepEqual(await provider.captureAuthorization({ ...m, requestId: 'so:1:capture:1', authorizationId: 'A-1', amountCents: 100, currency: 'USD' }), bad);
    assert.deepEqual(await provider.captureAuthorization({ ...m, requestId: 'so:2:capture:1', authorizationId: 'A-2', amountCents: 100, currency: 'USD' }), bad);
    assert.deepEqual(await provider.refundCapture({ ...m, requestId: 'so:1:refund:1', captureId: 'C-1', amountCents: 100, currency: 'USD' }), bad);
    assert.deepEqual(await provider.getAuthorization({ ...m, authorizationId: 'A-1' }), bad);
    assert.deepEqual(await provider.getOrder({ ...m, orderId: 'O-1' }), bad);
    assert.deepEqual(await provider.getOrder({ ...m, orderId: 'O-3' }), bad);
  });

  test('getOrder defaults absent payments.* lists to [] and maps authorizationId / captureId from the links with rel up', async () => {
    const f = scriptedFetch({
      '/v1/oauth2/token': TOKEN_OK,
      '/v2/checkout/orders/O-1': () => json(200, {
        id: 'O-1', status: 'COMPLETED',
        purchase_units: [{ payments: {
          authorizations: [{ id: 'A-1', status: 'CAPTURED', expiration_time: '2026-11-18T06:00:00Z' }],
          captures: [{ id: 'C-1', status: 'COMPLETED', links: [{ rel: 'self', href: 'https://x/v2/payments/captures/C-1' }, { rel: 'up', href: 'https://x/v2/payments/authorizations/A-1' }] }],
          refunds: [{ id: 'R-1', status: 'COMPLETED', links: [{ rel: 'up', href: 'https://x/v2/payments/captures/C-1?x=1' }] }],
        } }],
      }),
      '/v2/checkout/orders/O-2': () => json(200, { id: 'O-2', status: 'CREATED', purchase_units: [{ reference_id: 'so-1' }] }),
    });
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
    const full = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' });
    assert.deepEqual(
      { ...full.value, provider: undefined, sandbox: undefined },
      {
        status: 'COMPLETED', provider: undefined, sandbox: undefined,
        authorizations: [{ id: 'A-1', status: 'CAPTURED', expirationTime: '2026-11-18T06:00:00Z' }],
        captures: [{ id: 'C-1', status: 'COMPLETED', authorizationId: 'A-1' }],
        refunds: [{ id: 'R-1', status: 'COMPLETED', captureId: 'C-1' }],
      },
    );
    const bare = await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-2' });
    assert.deepEqual([bare.value.authorizations, bare.value.captures, bare.value.refunds], [[], [], []]);
  });

  test('capture without an invoice id sends none; ids are URL-encoded into the path; void sends no body', async () => {
    const f = scriptedFetch({
      '/v1/oauth2/token': TOKEN_OK,
      '*': () => json(201, { id: 'C-9', status: 'COMPLETED' }),
    });
    const provider = createSandboxProvider({ baseUrl: PAYPAL_SANDBOX_API, merchants: { DEFAULT: secretsOf({ clientId: 'c', clientSecret: 's', webhookId: 'w' }) }, fetch: f });
    await provider.captureAuthorization({ merchantKey: 'DEFAULT', requestId: 'so:1:capture:1', authorizationId: 'A.1-x_y', amountCents: 5, currency: 'USD' });
    const sent = f.seen.at(-1);
    assert.equal(new URL(sent.url).pathname, '/v2/payments/authorizations/A.1-x_y/capture');
    assert.deepEqual(JSON.parse(sent.init.body), { amount: { currency_code: 'USD', value: '0.05' }, final_capture: true });
    await provider.voidAuthorization({ merchantKey: 'DEFAULT', requestId: 'so:1:void:1', authorizationId: 'A-1' });
    const voided = f.seen.at(-1);
    assert.equal(voided.init.body, undefined);
    assert.equal(voided.init.headers['paypal-request-id'], 'so:1:void:1');
    assert.equal(voided.init.headers['content-type'], undefined);
  });

  test('bad arguments are rejected 400 INVALID_ARGUMENT before any request (path-injection ids, floats, other currencies)', async () => {
    const { stub, provider } = await setup();
    const m = { merchantKey: 'DEFAULT' };
    const outcomes = [
      await provider.getOrder({ ...m, orderId: '../../v1/oauth2/token' }),
      await provider.getOrder({ ...m, orderId: 'a/b' }),
      await provider.getOrder({ ...m, orderId: '' }),
      await provider.getOrder({ merchantKey: 'EVIL', orderId: 'O-1' }),
      await provider.authorizeOrder({ ...m, orderId: 'O-1' }),
      await provider.captureAuthorization({ ...m, requestId: 'so:1:capture:1', authorizationId: 'A-1', amountCents: 10.5, currency: 'USD' }),
      await provider.captureAuthorization({ ...m, requestId: 'so:1:capture:1', authorizationId: 'A-1', amountCents: 10, currency: 'EUR' }),
      await provider.refundCapture({ ...m, requestId: 'so:1:refund:1', captureId: 'C-1', amountCents: 0, currency: 'USD' }),
      await provider.voidAuthorization({ ...m, requestId: 'x y', authorizationId: 'A-1' }),
      await provider.createOrder({ ...m, requestId: 'so:1:create_order:1', amountCents: 100, currency: 'USD', referenceId: 'so-1', returnUrl: 'file:///etc/passwd', cancelUrl: CANCEL_URL }),
      await provider.getRefund(undefined),
    ];
    for (const outcome of outcomes) assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 400, 'INVALID_ARGUMENT']);
    assert.equal(stub.calls.length, 0, 'the double saw nothing');
  });
});

describe('verifyWebhook sends the received bytes', () => {
  const signedRaw = (raw, stub) => signEvent({ rawBody: raw, secret: stub.webhookSecret, transmissionTime: new Date(STUB_START_MS).toISOString() });

  test('the webhook_event member is the received body, byte for byte (odd whitespace, escapes, key order, non-ASCII, trailing newline)', async () => {
    const { stub, provider } = await setup();
    // (Whitespace OUTSIDE the object is not covered: the double verifies the span of the webhook_event member, which excludes it.)
    for (const raw of [
      '{ "id":"WH-1",\n  "event_type" : "PAYMENT.CAPTURE.COMPLETED", "resource":{"note":"caf\\u00e9 \\/ über 日本","id":"X","n":1.50} , "links":[ ]}',
      '{"b":2,\t"a":1.0e0,\r\n"c":[ 1 ,2 ]}',
      '{"x":"\\"quoted\\" } , \\"webhook_id\\":\\"nope\\""}',
    ]) {
      const signed = signedRaw(raw, stub);
      const outcome = await provider.verifyWebhook({ merchantKey: 'DEFAULT', headers: signed.headers, rawBody: signed.rawBody });
      assert.equal(outcome.kind, 'ok');
      assert.equal(outcome.value.verified, true, raw);
      assert.equal(stub.lastCall('verify_webhook').webhookEventRaw, raw, 'the double extracts exactly the received bytes');
      assert.equal(stub.lastCall('verify_webhook').rawBody.includes(raw), true, 'the bytes are inside the request unchanged');
    }
  });

  test('a body that could add fields to the request is never sent: it is not one JSON object, so nothing verifies', async () => {
    const { stub, provider } = await setup();
    const attempts = [
      '1, "webhook_id": "attacker-webhook"', '{"a":1}, "webhook_id":"attacker"', '{"a":1}}, {"webhook_id":"x"', '[1,2]', '"text"', 'null', '123', '{', '',
      '﻿{"a":1}',
    ];
    for (const raw of attempts) {
      if (raw === '') continue; // an empty body is an invalid argument, covered below
      const signed = signedRaw(raw, stub);
      const outcome = await provider.verifyWebhook({ merchantKey: 'DEFAULT', headers: signed.headers, rawBody: Buffer.from(raw, 'utf8') });
      assert.deepEqual([outcome.kind, outcome.value?.verified], ['ok', false], JSON.stringify(raw));
    }
    assert.equal(stub.callsOf('verify_webhook').length, 0, 'none of them was sent');
    const invalidUtf8 = await provider.verifyWebhook({ merchantKey: 'DEFAULT', headers: signedRaw('{"a":1}', stub).headers, rawBody: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) });
    assert.equal(invalidUtf8.value.verified, false);
    assert.equal(stub.callsOf('verify_webhook').length, 0);
  });

  test('missing or malformed signature headers verify nothing and send nothing; a bad body or merchant is rejected', async () => {
    const { stub, provider } = await setup();
    const signed = signedRaw('{"a":1}', stub);
    const call = (headers, rawBody = signed.rawBody, merchantKey = 'DEFAULT') => provider.verifyWebhook({ merchantKey, headers, rawBody });
    for (const headers of [undefined, null, {}, { ...signed.headers, 'paypal-transmission-sig': '' }, { ...signed.headers, 'paypal-cert-url': 7 }, { ...signed.headers, 'paypal-auth-algo': 'x'.repeat(2000) }]) {
      const outcome = await call(headers);
      assert.deepEqual([outcome.kind, outcome.value?.verified], ['ok', false]);
    }
    assert.equal(stub.callsOf('verify_webhook').length, 0);
    for (const bad of [await call(signed.headers, ''), await call(signed.headers, 'x'.repeat(70000)), await call(signed.headers, 42), await call(signed.headers, signed.rawBody, 'NOPE')]) {
      assert.deepEqual([bad.kind, bad.httpStatus, bad.issue], ['rejected', 400, 'INVALID_ARGUMENT']);
    }
  });

  test('a tampered body or the wrong webhook id is FAILURE (verified false, still ok); the merchant\'s webhook id is the one sent', async () => {
    const { stub, provider } = await setup();
    const signed = signedRaw(JSON.stringify(buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C-1' } })), stub);
    const tampered = Buffer.from(signed.rawBody.toString('utf8').replace('C-1', 'C-2'));
    const bad = await provider.verifyWebhook({ merchantKey: 'DEFAULT', headers: signed.headers, rawBody: tampered });
    assert.deepEqual([bad.kind, bad.value.verified], ['ok', false]);
    assert.equal(stub.lastCall('verify_webhook').body.webhook_id, stub.merchants.DEFAULT.webhookId);
    const wrongId = createSandboxProvider({
      baseUrl: stub.baseUrl, testOffline: true, merchants: { DEFAULT: secretsOf({ ...stub.merchants.DEFAULT, webhookId: 'WH-OTHER' }) },
    });
    const outcome = await wrongId.verifyWebhook({ merchantKey: 'DEFAULT', headers: signed.headers, rawBody: signed.rawBody });
    assert.deepEqual([outcome.kind, outcome.value.verified], ['ok', false]);
  });

  test('a merchant with no webhook id configured cannot verify: rejected WEBHOOK_ID_MISSING, nothing sent', async () => {
    const { stub } = await setup();
    const provider = createSandboxProvider({
      baseUrl: stub.baseUrl, testOffline: true, merchants: { DEFAULT: { clientId: new Secret('a'), clientSecret: new Secret('b'), webhookId: null } },
    });
    const signed = signedRaw('{"a":1}', stub);
    const outcome = await provider.verifyWebhook({ merchantKey: 'DEFAULT', headers: signed.headers, rawBody: signed.rawBody });
    assert.deepEqual([outcome.kind, outcome.httpStatus, outcome.issue], ['rejected', 400, 'WEBHOOK_ID_MISSING']);
    assert.equal(stub.calls.length, 0);
  });
});

describe('credentials are Secret values and never logged', () => {
  test('a full flow leaves no client id, client secret, webhook id, access token or Basic header in logs, Outcomes or inspect output', async () => {
    const { stub, provider, lines } = await setup();
    const o = await create(provider, 'so:1:create_order:1');
    stub.approve(o.value.orderId);
    const a = await provider.authorizeOrder({ merchantKey: 'DEFAULT', requestId: 'so:1:authorize:1', orderId: o.value.orderId });
    const c = await provider.captureAuthorization({ merchantKey: 'DEFAULT', requestId: 'so:1:capture:1', authorizationId: a.value.authorizationId, amountCents: 1250, currency: 'USD' });
    await provider.refundCapture({ merchantKey: 'DEFAULT', requestId: 'so:1:refund:1', captureId: c.value.captureId, amountCents: 1250, currency: 'USD' });
    await provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'NOPE' });
    const m = stub.merchants.DEFAULT;
    const basic = Buffer.from(`${m.clientId}:${m.clientSecret}`).toString('base64');
    const everything = [lines.join(''), inspect(provider, { depth: 5 }), JSON.stringify([o, a, c])].join('\n');
    for (const secret of [m.clientId, m.clientSecret, m.webhookId, basic, ...stub.issuedTokens()]) assert.equal(everything.includes(secret), false, secret);
    assert.ok(lines.length >= 5);
  });

  test('the Secret wrapper of config.js is what the adapter takes: it reveals only through reveal()', () => {
    const s = new Secret('client-secret-value');
    assert.equal(String(s), '[redacted]');
    assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
    assert.equal(inspect(s), '[redacted]');
    assert.equal(s.reveal(), 'client-secret-value');
  });
});
