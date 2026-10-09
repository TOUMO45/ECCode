import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../../src/http/router.js';
import { AppError } from '../../../src/http/envelope.js';
import { APP_CSP } from '../../../src/http/headers.js';
import { REQUEST_ID_PATTERN } from '../../../src/http/request-id.js';
import { startTestApp } from './app-fixture.js';

// Test-only routes mounted next to the real ones.
function testRoutes(router) {
  router.add('POST', '/api/test/echo', async (ctx) => ({ status: 200, body: { received: await ctx.body() } }), { policy: 'public' });
  router.add('GET', '/api/test/boom', () => { throw new Error('secret internals: sk-live-should-not-leak SELECT * FROM users'); }, { policy: 'public' });
  router.add('GET', '/api/test/app-error', () => { throw new AppError(409, 'INVALID_STATE', { details: { from: 'a', to: 'b' } }); }, { policy: 'public' });
  router.add('GET', '/api/test/items/:id', (ctx) => ({ status: 200, body: { id: ctx.params.id } }), { policy: 'public' });
  router.add('GET', '/api/test/private', (ctx) => ({ status: 200, body: { user: ctx.user } }), { policy: 'customer' });
  router.add('GET', '/api/test/nocontent', () => ({ status: 204 }), { policy: 'public' });
  // Shaped like src/domain/errors.js: its own class, name 'AppError', (status, code, message, details).
  class DomainAppError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.name = 'AppError';
      this.status = status;
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }
  router.add('GET', '/api/test/domain-error', () => { throw new DomainAppError(409, 'INVALID_STATE', 'caller text with <b>markup</b>', { from: 'proposed', to: 'executed' }); }, { policy: 'public' });
  router.add('GET', '/api/test/domain-unknown', () => { throw new DomainAppError(409, 'NOT_IN_CATALOG', 'x'); }, { policy: 'public' });
  router.add('GET', '/api/test/domain-bad-status', () => { throw new DomainAppError(200, 'INVALID_STATE', 'x'); }, { policy: 'public' });
}

test('AppError accepts both (status, code, {details, headers}) and the domain-style (status, code, message, details)', () => {
  const a = new AppError(409, 'INVALID_STATE', { details: { from: 'x' }, headers: { 'Retry-After': '1' } });
  assert.deepEqual([a.status, a.code, a.details, a.headers], [409, 'INVALID_STATE', { from: 'x' }, { 'Retry-After': '1' }]);
  const b = new AppError(409, 'INVALID_STATE', 'ignored caller text', { from: 'y' });
  assert.deepEqual([b.message, b.details], ['This transition is not allowed in the current state.', { from: 'y' }]);
  assert.throws(() => new AppError(400, 'NOT_A_CODE'), TypeError);
  assert.equal(new AppError(undefined, 'NOT_FOUND').status, 404);
});

test('a domain AppError is recognised by duck typing and answered with the catalog message, not its own text', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/test/domain-error' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'INVALID_STATE');
    assert.deepEqual(res.json.error.details, { from: 'proposed', to: 'executed' });
    assert.equal(res.json.error.message, 'This transition is not allowed in the current state.');
    assert.doesNotMatch(res.text, /markup/);
    // A code outside the catalog or a non-error status is an unexpected failure, so it is 500 INTERNAL.
    for (const path of ['/api/test/domain-unknown', '/api/test/domain-bad-status']) {
      const bad = await t.request({ path });
      assert.equal(bad.status, 500, path);
      assert.equal(bad.json.error.code, 'INTERNAL');
    }
  });
});

async function withApp(options, fn) {
  const t = await startTestApp({ routes: [testRoutes], ...options });
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test('NFR6: every response carries X-Request-Id, and every JSON body carries the same requestId', async () => {
  await withApp({}, async (t) => {
    const ok = await t.request({ path: '/api/health' });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['x-request-id'], REQUEST_ID_PATTERN);
    assert.equal(ok.json.requestId, ok.headers['x-request-id']);

    const missing = await t.request({ path: '/api/nope' });
    assert.equal(missing.status, 404);
    assert.match(missing.headers['x-request-id'], REQUEST_ID_PATTERN);
    assert.equal(missing.json.error.requestId, missing.headers['x-request-id']);

    const config = await t.request({ path: '/api/config' });
    assert.equal(config.json.requestId, config.headers['x-request-id']);
  });
});

test('NFR6: an inbound X-Request-Id matching ^[A-Za-z0-9-]{8,64}$ is kept; anything else is replaced', async () => {
  await withApp({}, async (t) => {
    const kept = await t.request({ path: '/api/health', headers: { 'X-Request-Id': 'client-req-0001' } });
    assert.equal(kept.headers['x-request-id'], 'client-req-0001');
    assert.equal(kept.json.requestId, 'client-req-0001');

    for (const bad of ['short', 'has space in it!', 'under_score_12345', 'x'.repeat(65), '<script>alert(1)</script>']) {
      const res = await t.request({ path: '/api/health', headers: { 'X-Request-Id': bad } });
      assert.notEqual(res.headers['x-request-id'], bad);
      assert.match(res.headers['x-request-id'], REQUEST_ID_PATTERN);
      assert.equal(res.json.requestId, res.headers['x-request-id']);
    }
    const a = await t.request({ path: '/api/health' });
    const b = await t.request({ path: '/api/health' });
    assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
  });
});

test('the error envelope has exactly code, message, requestId and optional details', async () => {
  await withApp({}, async (t) => {
    const notFound = await t.request({ path: '/api/nope' });
    assert.deepEqual(Object.keys(notFound.json), ['error']);
    assert.deepEqual(Object.keys(notFound.json.error).sort(), ['code', 'message', 'requestId']);
    assert.equal(notFound.json.error.code, 'NOT_FOUND');
    assert.match(notFound.headers['content-type'], /^application\/json; charset=utf-8$/);

    const state = await t.request({ path: '/api/test/app-error' });
    assert.equal(state.status, 409);
    assert.deepEqual(state.json.error.details, { from: 'a', to: 'b' });
    assert.equal(state.json.error.code, 'INVALID_STATE');
  });
});

test('405 carries an Allow header and the METHOD_NOT_ALLOWED envelope', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ method: 'POST', path: '/api/health', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 405);
    assert.equal(res.json.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(res.headers.allow, 'GET');
  });
});

test('an unexpected error becomes 500 INTERNAL without stack, message or SQL, and is logged without them', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/test/boom' });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'INTERNAL');
    assert.doesNotMatch(res.text, /secret internals|sk-live|SELECT|stack|at \S+ \(/);
    const logged = t.lines.join('');
    assert.doesNotMatch(logged, /secret internals|sk-live|SELECT \*/);
    const entry = t.logEntries().find((e) => e.msg === 'http.error');
    assert.ok(entry);
    assert.equal(entry.code, 'INTERNAL');
    assert.equal(entry.requestId, res.json.error.requestId);
  });
});

test('JSON body cap: 65,536 bytes is accepted and 65,537 bytes is refused with 413 PAYLOAD_TOO_LARGE', async () => {
  await withApp({}, async (t) => {
    const wrap = (n) => {
      const overhead = Buffer.byteLength('{"v":""}');
      return `{"v":"${'a'.repeat(n - overhead)}"}`;
    };
    const exact = wrap(65536);
    assert.equal(Buffer.byteLength(exact), 65536);
    const accepted = await t.request({ method: 'POST', path: '/api/test/echo', headers: { 'Content-Type': 'application/json' }, body: exact });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.received.v.length, 65536 - 8);

    const over = wrap(65537);
    assert.equal(Buffer.byteLength(over), 65537);
    const refused = await t.request({ method: 'POST', path: '/api/test/echo', headers: { 'Content-Type': 'application/json' }, body: over });
    assert.equal(refused.status, 413);
    assert.equal(refused.json.error.code, 'PAYLOAD_TOO_LARGE');
    assert.match(refused.json.error.requestId, REQUEST_ID_PATTERN);
  });
});

test('JSON body cap: a chunked body without Content-Length is cut off at the cap', async () => {
  await withApp({}, async (t) => {
    const big = `{"v":"${'b'.repeat(200000)}"}`;
    const res = await t.request({
      method: 'POST',
      path: '/api/test/echo',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: big,
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('invalid JSON is 400 INVALID_JSON, a wrong content type is 415, a non-object body is 422', async () => {
  await withApp({}, async (t) => {
    const json = { 'Content-Type': 'application/json' };
    const bad = await t.request({ method: 'POST', path: '/api/test/echo', headers: json, body: '{"a":' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_JSON');
    assert.doesNotMatch(bad.text, /Unexpected|position/);

    const truncatedUtf8 = await t.request({ method: 'POST', path: '/api/test/echo', headers: json, body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) });
    assert.equal(truncatedUtf8.json.error.code, 'INVALID_JSON');

    const text = await t.request({ method: 'POST', path: '/api/test/echo', headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' });
    assert.equal(text.status, 415);
    assert.equal(text.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const form = await t.request({ method: 'POST', path: '/api/test/echo', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    assert.equal(form.status, 415);

    const array = await t.request({ method: 'POST', path: '/api/test/echo', headers: json, body: '[1,2]' });
    assert.equal(array.status, 422);
    assert.equal(array.json.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(array.json.error.details.fields, [{ field: 'body', rule: 'object' }]);

    const withCharset = await t.request({ method: 'POST', path: '/api/test/echo', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"a":1}' });
    assert.equal(withCharset.status, 200);
    const empty = await t.request({ method: 'POST', path: '/api/test/echo', headers: json, body: '' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.received, {});
  });
});

test('SEC-13: a Host header outside the allow-list is refused with 421 MISDIRECTED_REQUEST', async () => {
  await withApp({}, async (t) => {
    for (const host of ['evil.example', 'evil.example:3000', `127.0.0.1.evil.example:${t.port}`, `localhost.evil.example:${t.port}`, '127.0.0.1', 'localhost', `0.0.0.0:${t.port}`]) {
      const res = await t.request({ path: '/api/health', host });
      assert.equal(res.status, 421, host);
      assert.equal(res.json.error.code, 'MISDIRECTED_REQUEST');
      assert.match(res.json.error.requestId, REQUEST_ID_PATTERN);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', 'a 421 still carries the security headers');
    }
    // The static path and unknown paths are checked too.
    assert.equal((await t.request({ path: '/index.html', host: 'evil.example' })).status, 421);
    assert.equal((await t.request({ path: '/api/nope', host: 'evil.example' })).status, 421);
  });
});

test('SEC-13: localhost:<port>, 127.0.0.1:<port>, the RS_PUBLIC_URL host and RS_ALLOWED_HOSTS entries are allowed', async () => {
  await withApp({ env: { RS_PUBLIC_URL: 'https://rescue.example.com', RS_ALLOWED_HOSTS: 'Extra.Example:8443' } }, async (t) => {
    for (const host of [`localhost:${t.port}`, `127.0.0.1:${t.port}`, `LOCALHOST:${t.port}`, 'rescue.example.com', 'RESCUE.example.com', 'extra.example:8443']) {
      const res = await t.request({ path: '/api/health', host });
      assert.equal(res.status, 200, host);
    }
    assert.equal((await t.request({ path: '/api/health', host: 'rescue.example.com:444' })).status, 421);
  });
});

test('SEC-20: no response carries an Access-Control-* header, including with an Origin and on OPTIONS', async () => {
  await withApp({}, async (t) => {
    const probes = [
      { path: '/api/health', headers: { Origin: 'https://evil.example' } },
      { path: '/api/config', headers: { Origin: 'https://evil.example' } },
      { path: '/api/nope', headers: { Origin: 'https://evil.example' } },
      { method: 'OPTIONS', path: '/api/health', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } },
      { path: '/api/health', host: 'evil.example', headers: { Origin: 'https://evil.example' } },
    ];
    for (const probe of probes) {
      const res = await t.request(probe);
      const names = Object.keys(res.headers).filter((n) => n.startsWith('access-control-'));
      assert.deepEqual(names, [], `${probe.method || 'GET'} ${probe.path}`);
    }
  });
});

test('T22: API responses carry the app security headers and Cache-Control: no-store', async () => {
  await withApp({}, async (t) => {
    for (const path of ['/api/health', '/api/config', '/api/nope']) {
      const res = await t.request({ path });
      assert.equal(res.headers['content-security-policy'], APP_CSP, path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(res.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });
});

test('GET /api/health answers 200 {status: "ok", requestId}', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/health' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['requestId', 'status']);
    assert.equal(res.json.status, 'ok');
  });
});

test('GET /api/health answers 503 DB_BUSY when the database cannot be read', async () => {
  await withApp({}, async (t) => {
    t.db.close();
    const res = await t.request({ path: '/api/health' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'DB_BUSY');
    assert.equal(res.headers['retry-after'], '1');
    // Reopen so the fixture can close cleanly.
  });
});

test('NFR4: GET /api/config returns labels and provider names and no secret, client id or merchant id', async () => {
  const secrets = {
    RS_ADMIN_PASSWORD: 'admin-secret-value-0001',
    RS_DEMO_PASSWORD: 'demo-secret-value-0002',
    RS_FAKE_WEBHOOK_SECRET: 'w'.repeat(40),
    ANTHROPIC_API_KEY: 'anthropic-secret-value-0003',
    RS_PAYPAL_A_CLIENT_ID: 'paypal-client-id-0004',
    RS_PAYPAL_A_CLIENT_SECRET: 'paypal-client-secret-0005',
    RS_PAYPAL_A_WEBHOOK_ID: 'paypal-webhook-id-0006',
  };
  await withApp({ env: secrets }, async (t) => {
    const res = await t.request({ path: '/api/config' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['extractionProvider', 'labels', 'paymentProvider', 'requestId', 'reservationTtlMin', 'signupEnabled']);
    assert.equal(res.json.paymentProvider, 'fake');
    assert.equal(res.json.extractionProvider, 'fake');
    assert.equal(res.json.signupEnabled, true);
    assert.equal(res.json.reservationTtlMin, 30);
    assert.equal(res.json.labels.testMode, true);
    assert.equal(res.json.labels.priceNotice, 'Test prices, not market prices');
    assert.equal(res.json.labels.simulatedPayments, true);
    for (const value of Object.values(secrets)) assert.ok(!res.text.includes(value), 'a secret value leaked');
    assert.doesNotMatch(res.text, /client|merchant_key|merchantKey|paypal-/i);
  });
});

test('ARCH-25: default deny: a route with a non-public policy answers 401 UNAUTHENTICATED when no authorize hook exists', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/test/private' });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHENTICATED');
  });
});

test('an authorize hook decides non-public routes and its user reaches the handler and the request log', async () => {
  const authorize = (ctx, route) => {
    if (ctx.req.headers['x-test-user'] !== 'yes') throw new AppError(401, 'UNAUTHENTICATED');
    assert.equal(route.policy, 'customer');
    ctx.user = { id: 7, role: 'customer' };
  };
  await withApp({ authorize }, async (t) => {
    assert.equal((await t.request({ path: '/api/test/private' })).status, 401);
    const ok = await t.request({ path: '/api/test/private', headers: { 'X-Test-User': 'yes' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.user, { id: 7, role: 'customer' });
    await new Promise((resolve) => setImmediate(resolve));
    const entry = t.logEntries().filter((e) => e.msg === 'http.request').find((e) => e.requestId === ok.headers['x-request-id']);
    assert.equal(entry.userId, 7);
    assert.equal(entry.role, 'customer');
  });
});

test('path parameters are decoded and bad escapes are 400 BAD_REQUEST', async () => {
  await withApp({}, async (t) => {
    const ok = await t.request({ path: '/api/test/items/42' });
    assert.equal(ok.json.id, '42');
    const encoded = await t.request({ path: '/api/test/items/a%20b' });
    assert.equal(encoded.json.id, 'a b');
    const bad = await t.request({ path: '/api/test/items/%zz' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'BAD_REQUEST');
    const slash = await t.request({ path: '/api/test/items/a%2Fb' });
    assert.equal(slash.status, 400);
  });
});

test('a handler may answer with a bare status such as 204', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/test/nocontent' });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
  });
});

test('NFR6: each request writes one http.request log line with the route template, status and requestId, and no query or body', async () => {
  await withApp({}, async (t) => {
    const res = await t.request({ path: '/api/test/items/99?token=SECRETQUERY&x=1' });
    await new Promise((resolve) => setImmediate(resolve));
    const lines = t.logEntries().filter((e) => e.msg === 'http.request' && e.requestId === res.headers['x-request-id']);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].route, '/api/test/items/:id');
    assert.equal(lines[0].method, 'GET');
    assert.equal(lines[0].status, 200);
    assert.equal(typeof lines[0].durationMs, 'number');
    assert.doesNotMatch(t.lines.join(''), /SECRETQUERY/);
  });
});

test('T19: the server timeouts are headers 10 s, request 30 s, keep-alive 5 s', async () => {
  await withApp({}, async (t) => {
    assert.equal(t.app.server.headersTimeout, 10000);
    assert.equal(t.app.server.requestTimeout, 30000);
    assert.equal(t.app.server.keepAliveTimeout, 5000);
  });
});

test('the router refuses a route without a valid policy at registration', () => {
  const router = createRouter();
  assert.throws(() => router.add('GET', '/api/x', () => {}), /no valid policy/);
  assert.throws(() => router.add('GET', '/api/x', () => {}, { policy: 'everyone' }), /no valid policy/);
  assert.throws(() => router.add('GET', '/api/x', () => {}, {}), /no valid policy/);
  router.add('GET', '/api/x', () => {}, { policy: 'public' });
  assert.throws(() => router.add('GET', '/api/x', () => {}, { policy: 'public' }), /Duplicate/);
  router.assertPolicies();
  assert.deepEqual(router.list(), [{ method: 'GET', template: '/api/x', policy: 'public' }]);
});

test('a second server on the same app instance cannot be confused: the app reports the port it bound', async () => {
  await withApp({}, async (t) => {
    assert.ok(Number.isInteger(t.port) && t.port > 0);
    assert.equal(t.app.deps.publicUrl(), `http://localhost:${t.port}`);
  });
  await withApp({ env: { RS_PUBLIC_URL: 'https://rescue.example.com' } }, async (t) => {
    assert.equal(t.app.deps.publicUrl(), 'https://rescue.example.com');
  });
});
