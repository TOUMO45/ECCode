'use strict';
// Contract tests for the Host/Origin guard (spec C1 steps 1-2; brief AC17 in full).
// Real composition: buildApp with a key set and a counting fetch stub, listening on an ephemeral loopback port.
// A spawned `node src/server.js` repeats the key cases in the real process.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../../src/app.js');
const { createLogger } = require('../../src/log.js');
const { validateResponse } = require('../../src/triage/schema.js');
const { request } = require('../helpers/http-client.js');
const { spawnServer } = require('../helpers/spawn-server.js');
const { capture, messageOk } = require('../helpers/fake-fetch.js');
const net = require('node:net');

// node:http's client silently substitutes its default Host for an empty `host` header, so the empty-Host case is
// sent over a raw socket. Returns the status line's code.
function rawStatus(port, head) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(head));
    let d = '';
    s.setEncoding('latin1');
    s.on('data', (c) => { d += c; });
    s.on('error', reject);
    s.on('end', () => resolve(Number(d.split('\r\n')[0].split(' ')[1])));
  });
}

const FAKE_KEY = 'test-key-FAKE';
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const FOREIGN = 'attacker.example:3000';
const MESSAGES = {
  forbidden_host: 'Host header is not allowed.',
  forbidden_origin: 'Origin is not allowed.',
  method_not_allowed: 'Method not allowed.',
};
const VALID_MODEL_OUTPUT = {
  category: 'technical',
  urgency: 'medium',
  summary: 'The export button crashes the desktop app.',
  suggestedReply: 'Thank you for the report. Our team is investigating the export crash and will follow up soon.',
};

function assertNoCors(res, label) {
  const acl = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('access-control-'));
  assert.deepEqual(acl, [], `${label}: no Access-Control-* header`);
}

function assertRejected(res, status, code, label) {
  assert.equal(res.status, status, `${label}: status (body ${res.body})`);
  assert.deepEqual(res.json, { error: { code, message: MESSAGES[code] } }, `${label}: body`);
  assert.equal(res.headers['content-security-policy'], CSP, `${label}: CSP`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', `${label}: referrer-policy`);
  assertNoCors(res, label);
  if (status === 403) assert.equal(String(res.headers.connection).toLowerCase(), 'close', `${label}: Connection: close`);
}

let app;
let port;
let stub;

test.before(async () => {
  stub = capture(messageOk(VALID_MODEL_OUTPUT));
  app = buildApp({ env: { ANTHROPIC_API_KEY: FAKE_KEY, PORT: '0', TRIAGE_TIMEOUT_MS: '300' }, fetchImpl: stub, log: createLogger(() => {}) });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  port = app.server.address().port;
});

test.after(async () => {
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
});

const JSON_HDR = { 'content-type': 'application/json' };
const TICKET = { ticket: 'The export button crashes the app every time.' };

// Order matters: every rejected request runs first, then the stub count is asserted to be 0, then the positives.
test('AC17: foreign Host is 403 forbidden_host on POST /api/triage, GET /api/health and GET /', async () => {
  const cases = [
    ['POST /api/triage', { method: 'POST', path: '/api/triage', headers: { host: FOREIGN, ...JSON_HDR }, body: TICKET }],
    ['GET /api/health', { method: 'GET', path: '/api/health', headers: { host: FOREIGN } }],
    ['HEAD /api/health', { method: 'HEAD', path: '/api/health', headers: { host: FOREIGN } }],
    ['GET /', { method: 'GET', path: '/', headers: { host: FOREIGN } }],
    ['GET /app.js', { method: 'GET', path: '/app.js', headers: { host: FOREIGN } }],
    ['GET unknown path', { method: 'GET', path: '/nope', headers: { host: FOREIGN } }],
    ['OPTIONS /api/triage', { method: 'OPTIONS', path: '/api/triage', headers: { host: FOREIGN } }],
    ['foreign name, right port', { method: 'POST', path: '/api/triage', headers: { host: `attacker.example:${port}`, ...JSON_HDR }, body: TICKET }],
    ['loopback name, wrong port', { method: 'POST', path: '/api/triage', headers: { host: `127.0.0.1:${port === 65535 ? 1 : port + 1}`, ...JSON_HDR }, body: TICKET }],
    ['loopback name, no port', { method: 'POST', path: '/api/triage', headers: { host: '127.0.0.1', ...JSON_HDR }, body: TICKET }],
    ['DNS-rebinding style suffix', { method: 'POST', path: '/api/triage', headers: { host: `localhost.attacker.example:${port}`, ...JSON_HDR }, body: TICKET }],
    ['userinfo trick', { method: 'GET', path: '/api/health', headers: { host: `127.0.0.1:${port}@attacker.example` } }],
  ];
  for (const [label, opts] of cases) {
    const res = await request({ port, ...opts });
    if (opts.method === 'HEAD') {
      assert.equal(res.status, 403, `${label}: status`);
      assert.equal(res.body, '');
      assertNoCors(res, label);
    } else {
      assertRejected(res, 403, 'forbidden_host', label);
    }
  }
});

test('AC17: an empty Host header is 403 (raw socket)', async () => {
  assert.equal(await rawStatus(port, 'GET /api/health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'), 403);
  assert.equal(await rawStatus(port, 'GET / HTTP/1.0\r\n\r\n'), 403, 'HTTP/1.0 without Host');
});

test('AC17: a request with no Host header is 403 forbidden_host (not Node\'s own 400)', async () => {
  for (const [label, opts] of [
    ['POST /api/triage', { method: 'POST', path: '/api/triage', headers: JSON_HDR, body: TICKET }],
    ['GET /api/health', { method: 'GET', path: '/api/health' }],
    ['GET /', { method: 'GET', path: '/' }],
  ]) {
    assertRejected(await request({ port, setHost: false, ...opts }), 403, 'forbidden_host', `no Host ${label}`);
  }
});

test('AC17: 20 KB body with a foreign (or missing) Host is 403, not 413, every time', async () => {
  const big = JSON.stringify({ ticket: 'x'.repeat(20 * 1024) });
  for (let i = 0; i < 25; i += 1) {
    assertRejected(await request({ port, method: 'POST', path: '/api/triage', headers: { host: FOREIGN, ...JSON_HDR }, body: big }), 403, 'forbidden_host', `20 KB foreign Host #${i}`);
  }
  assertRejected(await request({ port, method: 'POST', path: '/api/triage', setHost: false, headers: JSON_HDR, body: big }), 403, 'forbidden_host', '20 KB no Host');
  // Host is checked before content type as well: foreign Host + text/plain is 403, not 415.
  assertRejected(await request({ port, method: 'POST', path: '/api/triage', headers: { host: FOREIGN, 'content-type': 'text/plain' }, body: 'hi' }), 403, 'forbidden_host', 'foreign Host + text/plain');
  // Origin is checked before the body too: 20 KB + foreign Origin is 403 forbidden_origin, not 413.
  assertRejected(await request({ port, method: 'POST', path: '/api/triage', headers: { origin: 'http://attacker.example:3000', ...JSON_HDR }, body: big }), 403, 'forbidden_origin', '20 KB foreign Origin');
});

test('AC17: foreign and null Origin on POST with an allowlisted Host are 403 forbidden_origin', async () => {
  const origins = ['http://attacker.example:3000', 'null', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1 > 65535 ? 1 : port + 1}`,
    `http://attacker.example:${port}`, `http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}.attacker.example`, ''];
  for (const origin of origins) {
    assertRejected(await request({ port, method: 'POST', path: '/api/triage', headers: { origin, ...JSON_HDR }, body: TICKET }), 403, 'forbidden_origin', `Origin "${origin}"`);
  }
  // Origin is checked for every method except GET/HEAD: a foreign Origin on DELETE /api/health is 403, not 405.
  assertRejected(await request({ port, method: 'DELETE', path: '/api/health', headers: { origin: 'null' } }), 403, 'forbidden_origin', 'DELETE with Origin null');
});

test('AC17: OPTIONS /api/triage is 405 with no Access-Control-* header (no CORS preflight)', async () => {
  for (const headers of [{}, { origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }]) {
    const res = await request({ port, method: 'OPTIONS', path: '/api/triage', headers });
    assertRejected(res, 405, 'method_not_allowed', 'OPTIONS /api/triage');
    assert.equal(res.headers.allow, 'POST');
  }
  const h = await request({ port, method: 'OPTIONS', path: '/api/health' });
  assertRejected(h, 405, 'method_not_allowed', 'OPTIONS /api/health');
});

test('AC17: after all rejected requests the fetch stub call count is 0', () => {
  assert.equal(stub.count, 0);
});

test('AC17 positives: localhost Host + matching Origin, [::1] Host without Origin, 127.0.0.1 all return 200', async () => {
  const positives = [
    ['localhost + Origin', { host: `localhost:${port}`, origin: `http://localhost:${port}` }],
    ['[::1] without Origin', { host: `[::1]:${port}` }],
    ['127.0.0.1 + Origin', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }],
    ['upper-case Host', { host: `LOCALHOST:${port}` }],
    ['cross allowlisted Origin', { host: `127.0.0.1:${port}`, origin: `http://[::1]:${port}` }],
  ];
  for (const [label, headers] of positives) {
    const before = stub.count;
    const res = await request({ port, method: 'POST', path: '/api/triage', headers: { ...headers, ...JSON_HDR }, body: TICKET });
    assert.equal(res.status, 200, `${label}: status (body ${res.body})`);
    const v = validateResponse(res.json);
    assert.ok(v.ok, `${label}: ${JSON.stringify(v.errors)}`);
    assert.equal(res.json.source, 'model');
    assert.equal(stub.count, before + 1, `${label}: exactly one outbound call`);
    assertNoCors(res, label);
  }
  // GET is not Origin-checked: a foreign Origin on GET /api/health with an allowlisted Host is 200.
  const g = await request({ port, path: '/api/health', headers: { host: `[::1]:${port}`, origin: 'http://attacker.example:3000' } });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json, { status: 'ok', mode: 'live', model: 'claude-haiku-5-5' });
  assertNoCors(g, 'GET health with foreign Origin');
});

test('AC17 in the real process (spawn-server): foreign Host, missing Host, 20 KB + foreign Host, OPTIONS', async (t) => {
  // Base URL is a closed loopback port, so even a guard failure could not send anything off the machine.
  const proc = await spawnServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, TRIAGE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  t.after(() => proc.stop());
  const p = proc.port;
  assertRejected(await request({ port: p, method: 'POST', path: '/api/triage', headers: { host: FOREIGN, ...JSON_HDR }, body: TICKET }), 403, 'forbidden_host', 'spawned foreign Host');
  assertRejected(await request({ port: p, path: '/', headers: { host: FOREIGN } }), 403, 'forbidden_host', 'spawned foreign Host GET /');
  assertRejected(await request({ port: p, path: '/api/health', setHost: false }), 403, 'forbidden_host', 'spawned no Host');
  const big = JSON.stringify({ ticket: 'x'.repeat(20 * 1024) });
  assertRejected(await request({ port: p, method: 'POST', path: '/api/triage', headers: { host: FOREIGN, ...JSON_HDR }, body: big }), 403, 'forbidden_host', 'spawned 20 KB foreign Host');
  assertRejected(await request({ port: p, method: 'POST', path: '/api/triage', headers: { origin: 'null', ...JSON_HDR }, body: TICKET }), 403, 'forbidden_origin', 'spawned Origin null');
  assertRejected(await request({ port: p, method: 'OPTIONS', path: '/api/triage' }), 405, 'method_not_allowed', 'spawned OPTIONS');
  const ok = await request({ port: p, path: '/api/health', headers: { host: `localhost:${p}` } });
  assert.equal(ok.status, 200);
});
