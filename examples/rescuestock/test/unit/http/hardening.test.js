import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { canonicalJson, JSON_MAX_DEPTH, jsonNestsDeeperThan } from '../../../src/http/body.js';
import { CONNECTIONS_CHECK_INTERVAL_MS, MAX_CONNECTIONS, closeServer, createHttpServer, listen } from '../../../src/http/server.js';
import { startTestApp } from './app-fixture.js';

function nested(levels) {
  // {"a":[[[...]]]} with `levels` containers in total (the object counts as one).
  return `{"a":${'['.repeat(levels - 1)}${']'.repeat(levels - 1)}}`;
}

function echoRoute(router) {
  router.add(
    'POST',
    '/api/test/fingerprint',
    async (ctx) => {
      const body = await ctx.body();
      return { status: 200, body: { fingerprint: canonicalJson(body).length } };
    },
    { policy: 'public' },
  );
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

test('SEC-B-3: a 40 kB body nested 20,000 deep is refused with 422 VALIDATION_FAILED, not a 500', async () => {
  const t = await startTestApp({ routes: [echoRoute] });
  try {
    const body = nested(20000);
    assert.ok(Buffer.byteLength(body) < 65536, 'the body is under the size cap, so only the depth limit can stop it');
    const res = await t.request({ method: 'POST', path: '/api/test/fingerprint', headers: JSON_HEADERS, body });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(res.json.error.details.fields, [{ field: 'body', rule: `depth:${JSON_MAX_DEPTH}` }]);
    assert.ok(res.json.error.requestId);
    // The process is unharmed.
    assert.equal((await t.request({ path: '/api/health' })).status, 200);
  } finally {
    await t.close();
  }
});

test('SEC-B-3: the limit is 32 levels: 32 are accepted and fingerprinted, 33 are refused', async () => {
  const t = await startTestApp({ routes: [echoRoute] });
  try {
    const ok = await t.request({ method: 'POST', path: '/api/test/fingerprint', headers: JSON_HEADERS, body: nested(32) });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.fingerprint > 0);
    const refused = await t.request({ method: 'POST', path: '/api/test/fingerprint', headers: JSON_HEADERS, body: nested(33) });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.error.code, 'VALIDATION_FAILED');
  } finally {
    await t.close();
  }
});

test('SEC-B-3: brackets inside strings and escaped quotes do not count as nesting', () => {
  assert.equal(jsonNestsDeeperThan(JSON.stringify({ text: '['.repeat(500) + '{'.repeat(500) })), false);
  assert.equal(jsonNestsDeeperThan(JSON.stringify({ text: 'a "quoted" \\ [[[[ string', more: ['x'] })), false);
  assert.equal(jsonNestsDeeperThan('{"a":"\\"[[[["}', 1), false);
  assert.equal(jsonNestsDeeperThan('[[[[1]]]]', 3), true);
  assert.equal(jsonNestsDeeperThan('[[[[1]]]]', 4), false);
  assert.equal(jsonNestsDeeperThan('{"a":{"b":{"c":1}},"d":[1,2,{"e":[3]}]}'), false);
});

test('SEC-B-3: canonicalJson itself refuses deep input with a TypeError instead of overflowing the stack', () => {
  let deep = {};
  for (let i = 0; i < 20000; i++) deep = { a: deep };
  assert.throws(() => canonicalJson(deep), (e) => e instanceof TypeError && /nested too deeply/.test(e.message));
  let ok = {};
  for (let i = 0; i < JSON_MAX_DEPTH - 1; i++) ok = { a: ok };
  assert.doesNotThrow(() => canonicalJson(ok));
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: 1 }), '{"a":1,"b":[1,{"c":2,"d":1}]}');
});

test('SEC-B-4: the app server checks timeouts every second and caps connections', async () => {
  const t = await startTestApp();
  try {
    assert.equal(CONNECTIONS_CHECK_INTERVAL_MS, 1000);
    assert.equal(t.app.server.connectionsCheckingInterval, 1000);
    assert.equal(t.app.server.maxConnections, MAX_CONNECTIONS);
    assert.equal(t.app.server.headersTimeout, 10000);
    assert.equal(t.app.server.requestTimeout, 30000);
  } finally {
    await t.close();
  }
});

function talk(port, text) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => (received += chunk));
    socket.on('close', () => resolve({ received, ms: Date.now() - started }));
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), 5000).unref();
  });
}

test('SEC-B-4: a slow-header connection is closed with 408 Request Timeout at the header timeout', async () => {
  const server = createHttpServer((req, res) => res.end('ok'), { headersTimeout: 300, requestTimeout: 600, checkInterval: 50 });
  const port = await listen(server, 0, '127.0.0.1');
  try {
    // The request line and one header, but never the blank line that ends the headers.
    const result = await talk(port, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    assert.match(result.received, /^HTTP\/1\.1 408 Request Timeout/);
    assert.ok(result.ms < 3000, `closed after ${result.ms} ms`);
  } finally {
    await closeServer(server);
  }
});

test('SEC-B-4: a slow body is closed with 408 at the request timeout, and a normal request still works', async () => {
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on('end', () => res.end('done'));
  }, { headersTimeout: 300, requestTimeout: 600, checkInterval: 50 });
  const port = await listen(server, 0, '127.0.0.1');
  try {
    const slow = await talk(port, 'POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n\r\nabc');
    assert.match(slow.received, /^HTTP\/1\.1 408 Request Timeout/);
    const fine = await talk(port, 'GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(fine.received, /^HTTP\/1\.1 200 OK/);
  } finally {
    await closeServer(server);
  }
});
