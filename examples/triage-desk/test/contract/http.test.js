'use strict';
// Contract tests for the HTTP surface (spec C1-C5; brief AC1, AC2, AC11, AC14).
// The code under test is the real composition: buildApp (in-process, explicit env, injected fetch stub) and the
// real `node src/server.js` process via spawn-server. Nothing here re-implements the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { buildApp } = require('../../src/app.js');
const { createServer } = require('../../src/http-server.js');
const { loadConfig } = require('../../src/config.js');
const { createLogger } = require('../../src/log.js');
const { validateResponse } = require('../../src/triage/schema.js');
const { request } = require('../helpers/http-client.js');
const { spawnServer, PROJECT_ROOT } = require('../helpers/spawn-server.js');
const { capture, messageOk, throws } = require('../helpers/fake-fetch.js');

const FAKE_KEY = 'test-key-FAKE';
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const JSON_CT = 'application/json; charset=utf-8';

// C5, verbatim.
const C5 = {
  invalid_json: [400, 'Request body must be valid JSON.'],
  invalid_request: [400, 'Request body must be a JSON object with a string "ticket".'],
  ticket_empty: [400, 'Ticket text is empty.'],
  ticket_too_long: [400, 'Ticket text exceeds 8000 characters.'],
  forbidden_host: [403, 'Host header is not allowed.'],
  forbidden_origin: [403, 'Origin is not allowed.'],
  not_found: [404, 'Not found.'],
  method_not_allowed: [405, 'Method not allowed.'],
  payload_too_large: [413, 'Request body exceeds 16384 bytes.'],
  unsupported_media_type: [415, 'Content-Type must be application/json.'],
  internal_error: [500, 'Internal error.'],
};

const VALID_MODEL_OUTPUT = {
  category: 'billing',
  urgency: 'high',
  summary: 'Customer was charged twice for the March invoice.',
  suggestedReply: 'Thank you for contacting us. We are reviewing the duplicate charge and will update you shortly.',
};

const quietLog = () => createLogger(() => {});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server.address().port;
}
function close(server) {
  return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
}

/** AC11/C1 headers that every response must carry, and no Access-Control-* header. */
function assertCommonHeaders(res, label) {
  assert.equal(res.headers['content-security-policy'], CSP, `${label}: CSP`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', `${label}: referrer-policy`);
  assert.equal(res.headers['cache-control'], 'no-store', `${label}: cache-control`);
  const acl = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('access-control-'));
  assert.deepEqual(acl, [], `${label}: no Access-Control-* headers`);
}

/** JSON response: content-type, explicit content-length equal to the byte length. */
function assertJsonResponse(res, label) {
  assertCommonHeaders(res, label);
  assert.equal(res.headers['content-type'], JSON_CT, `${label}: content-type`);
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body, 'utf8')), `${label}: content-length`);
}

/** C1 error body shape + C5 exact status/message. */
function assertError(res, code, label = code) {
  const [status, message] = C5[code];
  assert.equal(res.status, status, `${label}: status (body ${res.body})`);
  assertJsonResponse(res, label);
  assert.deepEqual(res.json, { error: { code, message } }, `${label}: error body`);
}

/** AC2: every 200 triage response validates. */
function assertValidTriage(res, label) {
  assert.equal(res.status, 200, `${label}: status (body ${res.body})`);
  assertJsonResponse(res, label);
  const v = validateResponse(res.json);
  assert.ok(v.ok, `${label}: validateResponse errors ${JSON.stringify(v.errors)}`);
  assert.deepEqual(Object.keys(res.json),
    ['category', 'urgency', 'summary', 'suggestedReply', 'source', 'fallbackReason', 'injectionSuspected', 'model'],
    `${label}: exact keys in order`);
}

let fb; // fallback-mode in-process app
let live; // live-mode in-process app with a capturing stub
let fbStub;
let liveStub;

test.before(async () => {
  fbStub = capture(throws(new Error('fetch must not be called in fallback mode')));
  fb = buildApp({ env: { PORT: '0' }, fetchImpl: fbStub, log: quietLog() });
  fb.port = await listen(fb.server);

  liveStub = capture(messageOk(VALID_MODEL_OUTPUT));
  live = buildApp({ env: { ANTHROPIC_API_KEY: FAKE_KEY, PORT: '0', TRIAGE_TIMEOUT_MS: '300' }, fetchImpl: liveStub, log: quietLog() });
  live.port = await listen(live.server);
});

test.after(async () => {
  await close(fb.server);
  await close(live.server);
});

const post = (port, body, headers = { 'content-type': 'application/json' }) =>
  request({ port, method: 'POST', path: '/api/triage', headers, body });

test('AC1: valid tickets (1 and 8000 chars, padded, extra keys, content-type params) return 200 and pass AC2', async () => {
  const cases = [
    ['1 char', { ticket: 'x' }],
    ['8000 chars', { ticket: 'a'.repeat(8000) }],
    ['8000 chars + surrounding whitespace (trim applies)', { ticket: `  \n${'b'.repeat(8000)}\t ` }],
    ['unknown extra keys ignored', { ticket: 'My invoice was charged twice this month.', extra: 1, nested: { a: [1] } }],
    ['realistic ticket', { ticket: 'I cannot log in to my account since the password reset yesterday.' }],
  ];
  for (const [label, body] of cases) {
    assertValidTriage(await post(fb.port, body), `fallback ${label}`);
  }
  for (const ct of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ;foo=bar']) {
    assertValidTriage(await post(fb.port, JSON.stringify({ ticket: 'Refund please.' }), { 'content-type': ct }), `content-type "${ct}"`);
  }
  const res = await post(fb.port, { ticket: 'Where is my refund?' });
  assert.equal(res.json.source, 'fallback');
  assert.equal(res.json.fallbackReason, 'no_api_key');
  assert.equal(res.json.model, null);
  assert.equal(fbStub.count, 0, 'fallback mode never calls fetch');
});

test('AC1/C3: every 400 case returns the exact C5 code and message (first failure wins)', async () => {
  const cases = [
    ['empty body', '', 'invalid_json'],
    ['malformed JSON', '{"ticket": "abc"', 'invalid_json'],
    ['not JSON at all', 'ticket=hello', 'invalid_json'],
    ['trailing garbage', '{"ticket":"a"} x', 'invalid_json'],
    ['array', '["ticket"]', 'invalid_request'],
    ['null', 'null', 'invalid_request'],
    ['number', '42', 'invalid_request'],
    ['string', '"a ticket"', 'invalid_request'],
    ['missing ticket', '{}', 'invalid_request'],
    ['wrong field name', '{"text":"hello"}', 'invalid_request'],
    ['ticket is number', '{"ticket":5}', 'invalid_request'],
    ['ticket is null', '{"ticket":null}', 'invalid_request'],
    ['ticket is array', '{"ticket":["a"]}', 'invalid_request'],
    ['ticket is object', '{"ticket":{"a":1}}', 'invalid_request'],
    ['empty ticket', '{"ticket":""}', 'ticket_empty'],
    ['whitespace-only ticket', JSON.stringify({ ticket: ' \n\t\r  ' }), 'ticket_empty'],
    ['8001 chars', JSON.stringify({ ticket: 'a'.repeat(8001) }), 'ticket_too_long'],
    ['8001 chars after trim', JSON.stringify({ ticket: ` ${'a'.repeat(8001)} ` }), 'ticket_too_long'],
  ];
  for (const [label, body, code] of cases) {
    const res = await post(fb.port, body);
    assertError(res, code, label);
    assert.ok(!res.body.includes('a'.repeat(50)), `${label}: error never echoes input`);
  }
  // Live mode has the same validation and never calls the model for invalid input.
  const before = liveStub.count;
  assertError(await post(live.port, '{"ticket":"   "}'), 'ticket_empty', 'live whitespace');
  assertError(await post(live.port, '{oops'), 'invalid_json', 'live malformed');
  assert.equal(liveStub.count, before, 'invalid requests never reach fetch');
});

test('AC1/C3: body over 16384 bytes returns 413 (Content-Length fast path, boundary, chunked stream)', async () => {
  // Exactly 16384 bytes is not 413: it is read, parsed and rejected by validation instead.
  const at = JSON.stringify({ ticket: 'a'.repeat(16384 - 13) });
  assert.equal(Buffer.byteLength(at), 16384);
  assertError(await post(fb.port, at), 'ticket_too_long', '16384 bytes');

  const over = JSON.stringify({ ticket: 'a'.repeat(16385 - 13) });
  assert.equal(Buffer.byteLength(over), 16385);
  assertError(await post(fb.port, over), 'payload_too_large', '16385 bytes');
  assertError(await post(fb.port, JSON.stringify({ ticket: 'z'.repeat(20 * 1024) })), 'payload_too_large', '20 KB');

  // Multi-byte: 8000 three-byte characters exceed the byte cap (A1).
  assertError(await post(fb.port, JSON.stringify({ ticket: '€'.repeat(8000) })), 'payload_too_large', '8000 x 3-byte chars');

  // No Content-Length (chunked): the server counts streamed bytes and stops at the cap.
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: fb.port, method: 'POST', path: '/api/triage', agent: false,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: r.statusCode, headers: r.headers, body, json: JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.write('{"ticket":"');
    for (let i = 0; i < 20; i += 1) req.write('c'.repeat(1024));
    req.end('"}');
  });
  assertError(res, 'payload_too_large', 'chunked 20 KB');
});

test('AC1/C3: non-JSON content types return 415 before the body is read', async () => {
  const body = JSON.stringify({ ticket: 'hello' });
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x',
    'application/json-patch+json', 'application/jsonx', 'text/json']) {
    assertError(await post(fb.port, body, { 'content-type': ct }), 'unsupported_media_type', `content-type ${ct}`);
  }
  assertError(await post(fb.port, body, {}), 'unsupported_media_type', 'no content-type');
  // 415 is decided before the body: an oversized non-JSON body is 415, not 413.
  assertError(await post(fb.port, 'x'.repeat(20 * 1024), { 'content-type': 'text/plain' }), 'unsupported_media_type', '20 KB text/plain');
});

test('AC2: live-mode 200 from a valid model output validates and reports source model', async () => {
  const before = liveStub.count;
  const res = await post(live.port, { ticket: 'I was charged twice for my March invoice, please help.' });
  assertValidTriage(res, 'live model');
  assert.equal(res.json.source, 'model');
  assert.equal(res.json.fallbackReason, null);
  assert.equal(res.json.model, 'claude-haiku-5-5');
  assert.equal(res.json.category, 'billing');
  assert.equal(liveStub.count, before + 1, 'exactly one outbound call per request');
  assert.ok(!res.body.includes(FAKE_KEY));
  assert.ok(!JSON.stringify(res.headers).includes(FAKE_KEY));
});

test('AC14: GET/HEAD /api/health in fallback and live mode', async () => {
  const f = await request({ port: fb.port, path: '/api/health' });
  assert.equal(f.status, 200);
  assertJsonResponse(f, 'health fallback');
  assert.deepEqual(f.json, { status: 'ok', mode: 'fallback', model: null });
  assert.deepEqual(Object.keys(f.json), ['status', 'mode', 'model']);

  const l = await request({ port: live.port, path: '/api/health' });
  assert.equal(l.status, 200);
  assertJsonResponse(l, 'health live');
  assert.deepEqual(l.json, { status: 'ok', mode: 'live', model: 'claude-haiku-5-5' });
  assert.ok(!l.body.includes(FAKE_KEY), 'key value never included');

  const q = await request({ port: fb.port, path: '/api/health?verbose=1' });
  assert.equal(q.status, 200, 'query string is stripped before routing');

  const h = await request({ port: live.port, method: 'HEAD', path: '/api/health' });
  assert.equal(h.status, 200);
  assert.equal(h.body, '', 'HEAD has no body');
  assertCommonHeaders(h, 'health HEAD');
  assert.equal(h.headers['content-type'], JSON_CT);
  assert.equal(h.headers['content-length'], l.headers['content-length'], 'HEAD carries the GET headers');

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await request({ port: fb.port, method, path: '/api/health' });
    assertError(r, 'method_not_allowed', `${method} /api/health`);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
  assert.equal(fbStub.count, 0);
});

test('C4/AC11: static files have the C4 content types, file bytes, security headers; HEAD has no body', async () => {
  const files = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ];
  for (const [p, file, ct] of files) {
    const expected = fs.readFileSync(path.join(PROJECT_ROOT, 'public', file), 'utf8');
    const res = await request({ port: fb.port, path: p });
    assert.equal(res.status, 200, `GET ${p}`);
    assert.equal(res.headers['content-type'], ct, `GET ${p} content-type`);
    assertCommonHeaders(res, `GET ${p}`);
    assert.equal(res.body, expected, `GET ${p} serves public/${file}`);

    const head = await request({ port: fb.port, method: 'HEAD', path: p });
    assert.equal(head.status, 200, `HEAD ${p}`);
    assert.equal(head.body, '', `HEAD ${p} has no body`);
    assert.equal(head.headers['content-type'], ct);
    assertCommonHeaders(head, `HEAD ${p}`);

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await request({ port: fb.port, method, path: p });
      assertError(r, 'method_not_allowed', `${method} ${p}`);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
  }
  const t = await request({ port: fb.port, method: 'GET', path: '/api/triage' });
  assertError(t, 'method_not_allowed', 'GET /api/triage');
  assert.equal(t.headers.allow, 'POST');
});

test('AC11: traversal and non-allowlisted paths return 404 JSON with every security header', async () => {
  const paths = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/package.json', '/src/app.js',
    '/public/index.html', '/favicon.ico', '/index.html/', '/api/triage/', '/API/HEALTH', '//index.html',
    '/app.js/../package.json', '/.env', '/index.htm', '/api'];
  for (const p of paths) {
    const res = await request({ port: fb.port, path: p });
    assertError(res, 'not_found', `GET ${p}`);
    assert.ok(!res.body.includes('"name"'), `${p}: never serves package.json`);
  }
  assertError(await request({ port: fb.port, method: 'POST', path: '/../api/triage', headers: { 'content-type': 'application/json' }, body: { ticket: 'x' } }), 'not_found', 'POST traversal');
});

test('C5: 500 internal_error when the injected service throws (real createServer, fixed message, no leak)', async () => {
  const config = loadConfig({ PORT: '0' });
  const service = {
    mode: 'fallback', model: null,
    analyse: async () => { throw new Error('SECRET-INTERNAL-DETAIL at /home/x/stack.js:1'); },
  };
  const server = createServer({ config, service, log: quietLog() });
  const port = await listen(server);
  try {
    const res = await post(port, { ticket: 'trigger a bug' });
    assertError(res, 'internal_error', '500');
    assert.ok(!res.body.includes('SECRET-INTERNAL-DETAIL'));
    assert.ok(!res.body.includes('stack'));
  } finally {
    await close(server);
  }
});

test('Real process (spawn-server): health in both modes, headers, static, 404, and AC2 over the wire', async (t) => {
  const fbProc = await spawnServer({ env: { ANTHROPIC_API_KEY: '' } });
  t.after(() => fbProc.stop());
  const h = await request({ port: fbProc.port, path: '/api/health' });
  assert.equal(h.status, 200);
  assertJsonResponse(h, 'spawned health fallback');
  assert.deepEqual(h.json, { status: 'ok', mode: 'fallback', model: null });

  assertValidTriage(await post(fbProc.port, { ticket: 'The export button crashes the app on Windows.' }), 'spawned triage');
  assertError(await post(fbProc.port, '{bad'), 'invalid_json', 'spawned invalid_json');
  assertError(await request({ port: fbProc.port, path: '/../package.json' }), 'not_found', 'spawned traversal');
  const idx = await request({ port: fbProc.port, path: '/' });
  assert.equal(idx.status, 200);
  assert.equal(idx.headers['content-type'], 'text/html; charset=utf-8');
  assertCommonHeaders(idx, 'spawned index');

  // Live mode: health needs no outbound call. The base URL points at a closed loopback port so nothing can leave.
  const liveProc = await spawnServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, TRIAGE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  t.after(() => liveProc.stop());
  const lh = await request({ port: liveProc.port, path: '/api/health' });
  assert.equal(lh.status, 200);
  assert.deepEqual(lh.json, { status: 'ok', mode: 'live', model: 'claude-haiku-5-5' });
  assert.ok(!lh.body.includes(FAKE_KEY));
  assert.ok(!JSON.stringify(lh.headers).includes(FAKE_KEY));
});
