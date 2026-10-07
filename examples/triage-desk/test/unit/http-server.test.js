'use strict';
// Unit tests for src/http-server.js (spec C1–C5, C6.5, D1.6, Security T2/T6/T7/T8/T9, AC1/AC11/AC14/AC17 at unit level).
// The triage service is a fake. Static files come from a temporary fixture directory (staticDir option), so this
// file never depends on public/ (built concurrently by t07).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../../src/http-server.js');
const { loadConfig } = require('../../src/config.js');
const { createLogger } = require('../../src/log.js');
const { request } = require('../helpers/http-client.js');

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const JSON_CT = 'application/json; charset=utf-8';
const MESSAGES = {
  invalid_json: 'Request body must be valid JSON.',
  invalid_request: 'Request body must be a JSON object with a string "ticket".',
  ticket_empty: 'Ticket text is empty.',
  ticket_too_long: 'Ticket text exceeds 8000 characters.',
  forbidden_host: 'Host header is not allowed.',
  forbidden_origin: 'Origin is not allowed.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'Request body exceeds 16384 bytes.',
  unsupported_media_type: 'Content-Type must be application/json.',
  internal_error: 'Internal error.',
};
const REQUEST_KEYS = ['t', 'event', 'rid', 'method', 'route', 'status', 'ms', 'errorCode', 'ticketLength', 'source',
  'fallbackReason', 'injectionSuspected', 'redactions', 'upstreamStatus', 'detail', 'usage'];

const STATIC = {
  'index.html': '<!doctype html><html lang="en"><title>fixture</title><p>index-fixture</p></html>\n',
  'app.js': "'use strict'; /* app-fixture */\n",
  'styles.css': '/* styles-fixture */ body { color: #1a1a1a; }\n',
};
let staticDir;

before(() => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-static-'));
  for (const [name, content] of Object.entries(STATIC)) fs.writeFileSync(path.join(staticDir, name), content);
});
after(() => { fs.rmSync(staticDir, { recursive: true, force: true }); });

const TRIAGE_RESPONSE = Object.freeze({
  category: 'billing', urgency: 'high', summary: 'Customer was charged twice.',
  suggestedReply: 'Thank you for contacting us. We are looking into the duplicate charge.',
  source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: false, model: null,
});
const TRIAGE_META = Object.freeze({
  latencyMs: 2, ticketLength: 0, redactions: null, upstreamStatus: null, usage: null, detail: null,
});

function fakeService(impl) {
  const svc = {
    mode: 'fallback',
    model: null,
    calls: [],
    async analyse(ticket) {
      svc.calls.push(ticket);
      if (impl) return impl(ticket);
      return { response: { ...TRIAGE_RESPONSE }, meta: { ...TRIAGE_META, ticketLength: ticket.length } };
    },
  };
  return svc;
}

/** Starts createServer on 127.0.0.1:0 and registers cleanup. */
async function start(t, { env = {}, service = fakeService(), config, dir = staticDir } = {}) {
  const cfg = config || loadConfig({ PORT: '0', ...env });
  const lines = [];
  const log = createLogger((l) => lines.push(l));
  const server = createServer({ config: cfg, service, log, staticDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  return {
    server, port, host, service, lines,
    records: () => lines.map((l) => JSON.parse(l)),
    req: (opts) => request({ port, ...opts }),
  };
}

/** Raw node:http request that can send headers only, or a body in timed chunks (chunked when no content-length). */
function raw({ port, method = 'POST', path: p = '/api/triage', headers = {}, chunks = [], end = true, gapMs = 0 }) {
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      responded = true;
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
        req.destroy();
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (!responded) reject(e); });
    req.setTimeout(5000, () => req.destroy(new Error('raw: timeout')));
    req.flushHeaders();
    (async () => {
      for (const c of chunks) {
        if (responded || req.destroyed) return;
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        if (responded || req.destroyed) return;
        req.write(c);
      }
      if (end && !responded && !req.destroyed) req.end();
    })().catch(() => {});
  });
}

function assertSecurityHeaders(res, label = '') {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[k], v, `${label} ${k}`);
  for (const k of Object.keys(res.headers)) assert.ok(!k.startsWith('access-control-'), `${label} has ${k}`);
}

function assertError(res, status, code, label = '') {
  assert.equal(res.status, status, `${label} status (body ${res.body})`);
  assert.equal(res.headers['content-type'], JSON_CT, label);
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)), label);
  assert.deepEqual(res.json, { error: { code, message: MESSAGES[code] } }, label);
  assertSecurityHeaders(res, label);
}

const post = (s, body, headers = {}) => s.req({ method: 'POST', path: '/api/triage', headers: { 'content-type': 'application/json', ...headers }, body });

// ---------------------------------------------------------------- C2 health

test('C2: GET /api/health in fallback mode', async (t) => {
  const s = await start(t);
  const res = await s.req({ path: '/api/health' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], JSON_CT);
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)));
  assert.deepEqual(res.json, { status: 'ok', mode: 'fallback', model: null });
  assert.deepEqual(Object.keys(res.json), ['status', 'mode', 'model']);
  assertSecurityHeaders(res);
});

test('C2/AC14: GET /api/health in live mode reports the model and never the key', async (t) => {
  const s = await start(t, { env: { ANTHROPIC_API_KEY: 'test-key-FAKE', ANTHROPIC_MODEL: 'claude-haiku-5-5' } });
  const res = await s.req({ path: '/api/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 'ok', mode: 'live', model: 'claude-haiku-5-5' });
  assert.ok(!res.body.includes('test-key-FAKE'));
  assert.ok(!JSON.stringify(res.headers).includes('test-key-FAKE'));
  assert.ok(!s.lines.join('\n').includes('test-key-FAKE'));
});

test('C2: HEAD /api/health has the same status and headers and no body', async (t) => {
  const s = await start(t);
  const g = await s.req({ path: '/api/health' });
  const h = await s.req({ method: 'HEAD', path: '/api/health' });
  assert.equal(h.status, 200);
  assert.equal(h.body, '');
  assert.equal(h.headers['content-type'], g.headers['content-type']);
  assert.equal(h.headers['content-length'], g.headers['content-length']);
  assertSecurityHeaders(h);
});

test('C2: other methods on /api/health → 405 with Allow: GET, HEAD', async (t) => {
  const s = await start(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await s.req({ method, path: '/api/health', headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
    assertError(res, 405, 'method_not_allowed', method);
    assert.equal(res.headers.allow, 'GET, HEAD', method);
    assert.equal(res.headers.connection, 'close', method);
  }
});

// ---------------------------------------------------------------- C1 step 1: Host allowlist

test('C1.1: allowlisted Host values (port 0 → actual port) are accepted, case-insensitively', async (t) => {
  const s = await start(t);
  for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `LOCALHOST:${s.port}`, `[::1]:${s.port}`.toUpperCase()]) {
    const res = await s.req({ path: '/api/health', headers: { host } });
    assert.equal(res.status, 200, host);
  }
});

test('C1.1/AC17: foreign, missing or wrong-port Host → 403 forbidden_host with Connection: close', async (t) => {
  const s = await start(t);
  const bad = ['attacker.example:3000', `attacker.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1', 'localhost',
    '[::1]', `127.0.0.1:${s.port}.attacker.example`, `127.0.0.2:${s.port}`, `::1:${s.port}`, `127.0.0.1:0${s.port}`,
    ` 127.0.0.1:${s.port}x`, `localhost.:${s.port}`];
  for (const host of bad) {
    for (const [method, p] of [['GET', '/api/health'], ['GET', '/'], ['POST', '/api/triage']]) {
      const res = await s.req({ method, path: p, headers: { host, 'content-type': 'application/json' }, body: method === 'POST' ? { ticket: 'hello' } : undefined });
      assertError(res, 403, 'forbidden_host', `${method} ${p} host=${JSON.stringify(host)}`);
      assert.equal(res.headers.connection, 'close');
    }
  }
  const noHost = await s.req({ path: '/api/health', setHost: false });
  assertError(noHost, 403, 'forbidden_host', 'missing Host');
  const noHostPost = await s.req({ method: 'POST', path: '/api/triage', setHost: false, body: { ticket: 'x' } });
  assertError(noHostPost, 403, 'forbidden_host', 'missing Host POST');
  assert.equal(s.service.calls.length, 0);
});

test('C1.1: Host is checked before routing and method (unknown path and OPTIONS also give 403)', async (t) => {
  const s = await start(t);
  const foreign = { host: 'attacker.example:3000' };
  assertError(await s.req({ path: '/nope', headers: foreign }), 403, 'forbidden_host');
  assertError(await s.req({ path: '/../package.json', headers: foreign }), 403, 'forbidden_host');
  assertError(await s.req({ method: 'OPTIONS', path: '/api/triage', headers: foreign }), 403, 'forbidden_host');
  assertError(await s.req({ method: 'DELETE', path: '/api/health', headers: foreign }), 403, 'forbidden_host');
});

test('C1.1/AC17: 20 KB body with a foreign Host → 403, not 413', async (t) => {
  const s = await start(t);
  for (let i = 0; i < 20; i++) {
    const res = await s.req({ method: 'POST', path: '/api/triage', headers: { host: 'attacker.example:3000', 'content-type': 'application/json' }, body: 'x'.repeat(20 * 1024) });
    assertError(res, 403, 'forbidden_host');
  }
  assert.equal(s.service.calls.length, 0);
});

test('C1.1: foreign Host is rejected before any body byte is sent (headers only, large Content-Length)', async (t) => {
  const s = await start(t);
  const res = await raw({ port: s.port, headers: { host: 'attacker.example:3000', 'content-type': 'application/json', 'content-length': '1000000' }, end: false });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'forbidden_host');
});

test('C1.1: non-loopback config.host adds <HOST>:P (opt-in)', async (t) => {
  const s = await start(t, { env: { HOST: '0.0.0.0', TRIAGE_ALLOW_REMOTE: '1' } });
  assert.equal((await s.req({ path: '/api/health', headers: { host: `0.0.0.0:${s.port}` } })).status, 200);
  assert.equal((await s.req({ path: '/api/health', headers: { host: `127.0.0.1:${s.port}` } })).status, 200);
  assertError(await s.req({ path: '/api/health', headers: { host: `10.0.0.5:${s.port}` } }), 403, 'forbidden_host');
});

test('C1.1: a named config.host is lower-cased into the allowlist', async (t) => {
  const s = await start(t, { env: { HOST: 'MyBox.Local', TRIAGE_ALLOW_REMOTE: '1' } });
  assert.equal((await s.req({ path: '/api/health', headers: { host: `mybox.local:${s.port}` } })).status, 200);
  assert.equal((await s.req({ path: '/api/health', headers: { host: `MYBOX.LOCAL:${s.port}` } })).status, 200);
});

test('C1.1: an IPv6 config.host is allowlisted as [addr]:P', async (t) => {
  const s = await start(t, { env: { HOST: 'fe80::1', TRIAGE_ALLOW_REMOTE: '1' } });
  assert.equal((await s.req({ path: '/api/health', headers: { host: `[fe80::1]:${s.port}` } })).status, 200);
  assertError(await s.req({ path: '/api/health', headers: { host: `fe80::1:${s.port}` } }), 403, 'forbidden_host');
  const s2 = await start(t, { env: { HOST: '::', TRIAGE_ALLOW_REMOTE: '1' } });
  assert.equal((await s2.req({ path: '/api/health', headers: { host: `[::]:${s2.port}` } })).status, 200);
});

test('C1.1: loopback config.host values add nothing beyond the three names', async (t) => {
  const s = await start(t, { env: { HOST: '::1' } });
  assert.equal((await s.req({ path: '/api/health', headers: { host: `[::1]:${s.port}` } })).status, 200);
  assertError(await s.req({ path: '/api/health', headers: { host: `::1:${s.port}` } }), 403, 'forbidden_host');
});

test('C1.1: port is read at request time; on port 80 the bare names are also allowed', async (t) => {
  const s = await start(t, { env: { HOST: 'mybox.local', TRIAGE_ALLOW_REMOTE: '1' } });
  const realAddress = s.server.address.bind(s.server);
  s.server.address = () => ({ ...realAddress(), port: 80 });
  for (const host of ['127.0.0.1', 'localhost', '[::1]', 'mybox.local', '127.0.0.1:80', 'localhost:80', '[::1]:80', 'mybox.local:80']) {
    assert.equal((await s.req({ path: '/api/health', headers: { host } })).status, 200, host);
  }
  for (const host of [`127.0.0.1:${s.port}`, 'attacker.example', 'attacker.example:80', '::1']) {
    assertError(await s.req({ path: '/api/health', headers: { host } }), 403, 'forbidden_host', host);
  }
  // Origin for port 80 uses the same allowlisted values.
  assert.equal((await post(s, { ticket: 'hi' }, { host: 'localhost', origin: 'http://localhost' })).status, 200);
  assert.equal((await post(s, { ticket: 'hi' }, { host: 'localhost', origin: 'http://localhost:80' })).status, 200);
  assertError(await post(s, { ticket: 'hi' }, { host: 'localhost', origin: 'http://attacker.example' }), 403, 'forbidden_origin');
});

test('C1.1: without port 80 the bare names are refused', async (t) => {
  const s = await start(t);
  const realAddress = s.server.address.bind(s.server);
  s.server.address = () => ({ ...realAddress(), port: 8080 });
  assertError(await s.req({ path: '/api/health', headers: { host: 'localhost' } }), 403, 'forbidden_host');
  assert.equal((await s.req({ path: '/api/health', headers: { host: 'localhost:8080' } })).status, 200);
});

// ---------------------------------------------------------------- C1 step 2: Origin

test('C1.2/AC17: foreign or null Origin on POST → 403 forbidden_origin; service never called', async (t) => {
  const s = await start(t);
  for (const origin of ['http://attacker.example:3000', 'null', `https://127.0.0.1:${s.port}`, `http://127.0.0.1:${s.port}/`,
    `http://127.0.0.1:${s.port + 1}`, `http://127.0.0.1`, `127.0.0.1:${s.port}`, '', `http://attacker.example`, 'file://']) {
    const res = await post(s, { ticket: 'hello' }, { origin });
    assertError(res, 403, 'forbidden_origin', `origin=${JSON.stringify(origin)}`);
    assert.equal(res.headers.connection, 'close');
  }
  assert.equal(s.service.calls.length, 0);
});

test('C1.2/AC17: allowlisted Origin, or no Origin, is allowed', async (t) => {
  const s = await start(t);
  assert.equal((await post(s, { ticket: 'a' }, { host: `localhost:${s.port}`, origin: `http://localhost:${s.port}` })).status, 200);
  assert.equal((await post(s, { ticket: 'a' }, { host: `[::1]:${s.port}` })).status, 200);
  assert.equal((await post(s, { ticket: 'a' }, { origin: `http://127.0.0.1:${s.port}` })).status, 200);
  // Origin may be any allowlisted value, not only the one in Host
  assert.equal((await post(s, { ticket: 'a' }, { origin: `http://[::1]:${s.port}` })).status, 200);
  assert.equal(s.service.calls.length, 4);
});

test('C1.2: Origin is not checked for GET and HEAD', async (t) => {
  const s = await start(t);
  assert.equal((await s.req({ path: '/api/health', headers: { origin: 'http://attacker.example' } })).status, 200);
  assert.equal((await s.req({ method: 'HEAD', path: '/', headers: { origin: 'null' } })).status, 200);
});

test('C1.2: Origin is checked before route, method and content type', async (t) => {
  const s = await start(t);
  const bad = { origin: 'http://attacker.example:3000' };
  assertError(await s.req({ method: 'POST', path: '/nope', headers: bad, body: '{}' }), 403, 'forbidden_origin');
  assertError(await s.req({ method: 'OPTIONS', path: '/api/triage', headers: bad }), 403, 'forbidden_origin');
  assertError(await s.req({ method: 'POST', path: '/api/triage', headers: { ...bad, 'content-type': 'text/plain' }, body: 'x' }), 403, 'forbidden_origin');
  assertError(await s.req({ method: 'POST', path: '/api/triage', headers: { ...bad, 'content-type': 'application/json' }, body: 'x'.repeat(20000) }), 403, 'forbidden_origin');
});

// ---------------------------------------------------------------- C1 steps 3–4: route and method

test('C1.3/AC11: exact path match after stripping the query; no decoding or normalisation', async (t) => {
  const s = await start(t);
  assert.equal((await s.req({ path: '/api/health?x=1&y=/../' })).status, 200);
  assert.equal((await s.req({ path: '/?q' })).status, 200);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/api/health/', '/API/HEALTH', '/api//health', '/favicon.ico',
    '/index.htm', '/public/app.js', '/app.js/', '//', '/%61pp.js', '/src/server.js', '/package.json', '/api', '/api/triage/x']) {
    const res = await s.req({ path: p });
    assertError(res, 404, 'not_found', p);
    assert.equal(res.headers.connection, 'close', p);
  }
});

test('C1.4/AC17: OPTIONS /api/triage → 405 Allow: POST and no Access-Control-* header', async (t) => {
  const s = await start(t);
  const res = await s.req({ method: 'OPTIONS', path: '/api/triage', headers: { origin: `http://127.0.0.1:${s.port}`, 'access-control-request-method': 'POST' } });
  assertError(res, 405, 'method_not_allowed');
  assert.equal(res.headers.allow, 'POST');
  assert.equal(res.headers.connection, 'close');
});

test('C1.4: wrong methods get 405 with the route Allow header', async (t) => {
  const s = await start(t);
  for (const [method, p, allow] of [['GET', '/api/triage', 'POST'], ['HEAD', '/api/triage', 'POST'], ['PUT', '/api/triage', 'POST'],
    ['POST', '/', 'GET, HEAD'], ['DELETE', '/app.js', 'GET, HEAD'], ['OPTIONS', '/', 'GET, HEAD'], ['PATCH', '/styles.css', 'GET, HEAD'],
    ['OPTIONS', '/index.html', 'GET, HEAD']]) {
    const res = await s.req({ method, path: p });
    assert.equal(res.status, 405, `${method} ${p}`);
    assert.equal(res.headers.allow, allow, `${method} ${p}`);
    if (method !== 'HEAD') assert.deepEqual(res.json, { error: { code: 'method_not_allowed', message: MESSAGES.method_not_allowed } });
    else assert.equal(res.body, '');
    assertSecurityHeaders(res);
  }
});

// ---------------------------------------------------------------- C4 static

test('C4: static files are served from staticDir with fixed content types', async (t) => {
  const s = await start(t);
  for (const [p, file, ct] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/styles.css', 'styles.css', 'text/css; charset=utf-8']]) {
    const res = await s.req({ path: p });
    assert.equal(res.status, 200, p);
    assert.equal(res.body, STATIC[file], p);
    assert.equal(res.headers['content-type'], ct, p);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(STATIC[file])), p);
    assertSecurityHeaders(res, p);
    const head = await s.req({ method: 'HEAD', path: p });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], ct);
    assert.equal(head.headers['content-length'], res.headers['content-length']);
    assertSecurityHeaders(head, 'HEAD ' + p);
  }
});

test('C4: files are read once when createServer is called', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-static-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(STATIC)) fs.writeFileSync(path.join(dir, name), content);
  const s = await start(t, { dir });
  fs.writeFileSync(path.join(dir, 'app.js'), 'changed');
  fs.rmSync(path.join(dir, 'styles.css'));
  assert.equal((await s.req({ path: '/app.js' })).body, STATIC['app.js']);
  assert.equal((await s.req({ path: '/styles.css' })).body, STATIC['styles.css']);
});

test('C4: a missing static file makes createServer throw (fail fast at startup)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-static-missing-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), 'x');
    assert.throws(() => createServer({ config: loadConfig({ PORT: '0' }), service: fakeService(), log: createLogger(() => {}), staticDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C3 POST /api/triage

test('C3: 200 passes the trimmed ticket to the service and returns its response', async (t) => {
  const s = await start(t);
  const res = await post(s, { ticket: '  I was charged twice.  ', extra: 'ignored' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], JSON_CT);
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)));
  assert.deepEqual(res.json, TRIAGE_RESPONSE);
  assert.deepEqual(Object.keys(res.json), Object.keys(TRIAGE_RESPONSE));
  assert.deepEqual(s.service.calls, ['I was charged twice.']);
  assertSecurityHeaders(res);
});

test('C1: accepted requests keep the connection open (Connection: close only on rejections)', async (t) => {
  const s = await start(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const get = (p, extra = {}) => new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port: s.port, path: p, agent, ...extra }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    r.on('error', reject);
    r.end();
  });
  assert.equal((await get('/api/health')).headers.connection, 'keep-alive');
  assert.equal((await get('/')).headers.connection, 'keep-alive');
  assert.equal((await get('/nope')).headers.connection, 'close');
});

test('C1.1: an empty Host header (raw socket) → 403 forbidden_host', async (t) => {
  const s = await start(t);
  const net = require('node:net');
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(s.port, '127.0.0.1', () => {
      sock.write('GET /api/health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 403 /);
  assert.ok(reply.includes('"forbidden_host"'));
});

test('C3: Content-Type media type must be application/json (parameters and case ignored) → else 415', async (t) => {
  const s = await start(t);
  for (const ct of ['application/json', 'application/json; charset=utf-8', ' Application/JSON ;x=y', 'APPLICATION/JSON']) {
    assert.equal((await s.req({ method: 'POST', path: '/api/triage', headers: { 'content-type': ct }, body: '{"ticket":"a"}' })).status, 200, ct);
  }
  for (const ct of ['text/plain', 'application/jsonx', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x',
    'application/json-patch+json', 'json', '', 'text/json']) {
    const res = await s.req({ method: 'POST', path: '/api/triage', headers: { 'content-type': ct }, body: '{"ticket":"a"}' });
    assertError(res, 415, 'unsupported_media_type', ct);
    assert.equal(res.headers.connection, 'close');
  }
  const none = await s.req({ method: 'POST', path: '/api/triage', body: Buffer.from('{"ticket":"a"}') });
  assertError(none, 415, 'unsupported_media_type', 'no content-type');
  assert.equal(s.service.calls.length, 4);
});

test('C3: 415 is decided before the body is read', async (t) => {
  const s = await start(t);
  const res = await raw({ port: s.port, headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'text/plain', 'content-length': '1000000' }, end: false });
  assert.equal(res.status, 415);
});

test('C3: Content-Length > 16384 → 413 at once, before any body byte is sent', async (t) => {
  const s = await start(t);
  const res = await raw({ port: s.port, headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json', 'content-length': '16385' }, end: false });
  assertError(res, 413, 'payload_too_large');
  assert.equal(res.headers.connection, 'close');
  const big = await post(s, 'x'.repeat(20 * 1024));
  assertError(big, 413, 'payload_too_large');
  assert.equal(s.service.calls.length, 0);
});

test('C3: exactly 16384 bytes is read (then validated), 16385 is 413', async (t) => {
  const s = await start(t);
  const prefix = '{"ticket":"';
  const suffix = '"}';
  const at = prefix + 'a'.repeat(16384 - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(at), 16384);
  assertError(await post(s, at), 400, 'ticket_too_long');
  const over = prefix + 'a'.repeat(16385 - prefix.length - suffix.length) + suffix;
  assertError(await post(s, over), 413, 'payload_too_large');
});

test('C3: streamed (chunked) body is counted and cut off at 16384 bytes → 413', async (t) => {
  const s = await start(t);
  const res = await raw({
    port: s.port,
    headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json' },
    chunks: [ '{"ticket":"' + 'a'.repeat(5000), 'a'.repeat(5000), 'a'.repeat(5000), 'a'.repeat(5000), 'a'.repeat(5000), '"}'],
    gapMs: 10,
  });
  assertError(res, 413, 'payload_too_large');
  assert.equal(res.headers.connection, 'close');
  assert.equal(s.service.calls.length, 0);
  // the server is still healthy afterwards
  assert.equal((await s.req({ path: '/api/health' })).status, 200);
});

test('C3: chunked body under the cap is accepted and UTF-8 split across chunks decodes correctly', async (t) => {
  const s = await start(t);
  const body = Buffer.from(JSON.stringify({ ticket: 'Préférence — 😀 ticket' }), 'utf8');
  const cut = body.indexOf(Buffer.from('😀')) + 2; // split inside the 4-byte emoji
  const res = await raw({
    port: s.port,
    headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json' },
    chunks: [body.subarray(0, cut), body.subarray(cut)],
    gapMs: 10,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(s.service.calls, ['Préférence — 😀 ticket']);
});

test('C3/C5: validation table over HTTP with exact messages', async (t) => {
  const s = await start(t);
  const cases = [
    ['', 'invalid_json'], ['{', 'invalid_json'], ['nul', 'invalid_json'], ["{'ticket':'x'}", 'invalid_json'], ['﻿{"ticket":"x"}', 'invalid_json'],
    ['[]', 'invalid_request'], ['null', 'invalid_request'], ['"ticket"', 'invalid_request'], ['42', 'invalid_request'],
    ['{}', 'invalid_request'], ['{"ticket":5}', 'invalid_request'], ['{"ticket":null}', 'invalid_request'],
    ['{"ticket":"   "}', 'ticket_empty'], ['{"ticket":""}', 'ticket_empty'],
    [JSON.stringify({ ticket: 'a'.repeat(8001) }), 'ticket_too_long'],
  ];
  for (const [body, code] of cases) {
    const res = await post(s, body);
    assertError(res, 400, code, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await post(s, JSON.stringify({ ticket: 'a'.repeat(8000) }))).status, 200);
  assert.equal(s.service.calls.length, 1);
});

test('C5/T9: invalid JSON response never echoes the input or a parser message', async (t) => {
  const s = await start(t);
  const res = await post(s, '{"ticket": SECRET-INPUT-x9');
  assertError(res, 400, 'invalid_json');
  assert.ok(!res.body.includes('SECRET'));
  assert.ok(!res.body.includes('position'));
  assert.ok(!s.lines.join('\n').includes('SECRET'));
});

test('C3: a service that throws gives 500 internal_error, an error event without message, and the server keeps running', async (t) => {
  let fail = true;
  const svc = fakeService(() => {
    if (fail) { const e = new TypeError('boom with SECRET-TICKET-TEXT'); throw e; }
    return { response: { ...TRIAGE_RESPONSE }, meta: { ...TRIAGE_META } };
  });
  const s = await start(t, { service: svc });
  const res = await post(s, { ticket: 'SECRET-TICKET-TEXT here' });
  assertError(res, 500, 'internal_error');
  assert.ok(!res.body.includes('boom'));
  const errs = s.records().filter((r) => r.event === 'error');
  assert.equal(errs.length, 1);
  assert.deepEqual(Object.keys(errs[0]), ['t', 'event', 'rid', 'errorCode', 'errorName']);
  assert.equal(errs[0].errorCode, 'internal_error');
  assert.equal(errs[0].errorName, 'TypeError');
  const reqLine = s.records().find((r) => r.event === 'request' && r.status === 500);
  assert.equal(reqLine.rid, errs[0].rid);
  assert.equal(reqLine.errorCode, 'internal_error');
  assert.ok(!s.lines.join('\n').includes('SECRET'));
  assert.ok(!s.lines.join('\n').includes('boom'));
  fail = false;
  assert.equal((await post(s, { ticket: 'again' })).status, 200);
});

test('C3: a service that rejects with a non-Error still gives 500', async (t) => {
  const svc = fakeService(() => Promise.reject('plain string SECRET'));
  const s = await start(t, { service: svc });
  assertError(await post(s, { ticket: 'x' }), 500, 'internal_error');
  assert.ok(!s.lines.join('\n').includes('SECRET'));
});

// ---------------------------------------------------------------- request log (D1.6)

test('D1.6: one metadata-only request line per request; triage fields from response and meta', async (t) => {
  const svc = fakeService((ticket) => ({
    response: { ...TRIAGE_RESPONSE, source: 'model', fallbackReason: null, model: 'claude-haiku-5-5', injectionSuspected: true },
    meta: { latencyMs: 5, ticketLength: ticket.length, redactions: { email: 1, card: 0, phone: 2 }, upstreamStatus: 200,
      usage: { inputTokens: 100, outputTokens: 20 }, detail: null },
  }));
  const s = await start(t, { service: svc });
  const marker = 'LOGMARK-ticket-7c1 alice@example.com';
  await post(s, { ticket: '  ' + marker + '  ' });
  await s.req({ path: '/api/health?secret-query=LOGMARK-q' });
  await s.req({ path: '/nope/LOGMARK-path', headers: { host: 'LOGMARK-host.example' } });
  await s.req({ path: '/nope/LOGMARK-path' });
  await s.req({ method: 'PROPFIND', path: '/' });
  const all = s.lines.join('\n');
  assert.ok(!all.includes('LOGMARK'), 'no ticket text, URL, query or Host value in the log');
  assert.ok(!all.includes('alice@example.com'));
  const rs = s.records();
  assert.equal(rs.length, 5);
  for (const r of rs) {
    assert.deepEqual(Object.keys(r), REQUEST_KEYS);
    assert.equal(r.event, 'request');
    assert.match(r.rid, /^[0-9a-f]{8}$/);
    assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
  }
  assert.deepEqual({ ...rs[0], t: 'T', rid: 'R', ms: 0 }, {
    t: 'T', event: 'request', rid: 'R', method: 'POST', route: '/api/triage', status: 200, ms: 0, errorCode: null,
    ticketLength: marker.length, source: 'model', fallbackReason: null, injectionSuspected: true,
    redactions: { email: 1, card: 0, phone: 2 }, upstreamStatus: 200, detail: null, usage: { inputTokens: 100, outputTokens: 20 },
  });
  assert.deepEqual([rs[1].method, rs[1].route, rs[1].status, rs[1].errorCode, rs[1].source, rs[1].ticketLength], ['GET', '/api/health', 200, null, null, null]);
  assert.deepEqual([rs[2].route, rs[2].status, rs[2].errorCode], ['other', 403, 'forbidden_host']);
  assert.deepEqual([rs[3].route, rs[3].status, rs[3].errorCode], ['other', 404, 'not_found']);
  assert.deepEqual([rs[4].method, rs[4].route, rs[4].status, rs[4].errorCode], ['OTHER', '/', 405, 'method_not_allowed']);
  assert.notEqual(rs[0].rid, rs[1].rid);
});

test('D1.6: rejected triage requests log errorCode and null triage fields', async (t) => {
  const s = await start(t);
  await post(s, '{"ticket":"   "}');
  await post(s, 'x'.repeat(17000));
  await post(s, { ticket: 'x' }, { origin: 'null' });
  const rs = s.records();
  assert.deepEqual(rs.map((r) => [r.status, r.errorCode]), [[400, 'ticket_empty'], [413, 'payload_too_large'], [403, 'forbidden_origin']]);
  for (const r of rs) for (const k of ['ticketLength', 'source', 'fallbackReason', 'injectionSuspected', 'redactions', 'upstreamStatus', 'detail', 'usage']) assert.equal(r[k], null, k);
});

test('C1 order with a fake service: nothing after the first failing step runs', async (t) => {
  const s = await start(t);
  // Host beats Origin beats route beats method beats 415 beats 413 beats body validation
  const big = { 'content-type': 'text/plain', 'content-length': '999999' };
  const steps = [
    [{ host: 'evil.example:1', origin: 'null', ...big }, '/nope', 'OPTIONS', 403, 'forbidden_host'],
    [{ origin: 'null', ...big }, '/nope', 'OPTIONS', 403, 'forbidden_origin'],
    [{ ...big }, '/nope', 'OPTIONS', 404, 'not_found'],
    [{ ...big }, '/api/triage', 'PUT', 405, 'method_not_allowed'],
    [{ ...big }, '/api/triage', 'POST', 415, 'unsupported_media_type'],
    [{ 'content-type': 'application/json', 'content-length': '999999' }, '/api/triage', 'POST', 413, 'payload_too_large'],
  ];
  for (const [headers, p, method, status, code] of steps) {
    const res = await raw({ port: s.port, method, path: p, headers: { host: `127.0.0.1:${s.port}`, ...headers }, end: false });
    assert.equal(res.status, status, code);
    assert.equal(res.json.error.code, code);
  }
  assert.equal(s.service.calls.length, 0);
});

test('createServer uses requireHostHeader:false (a Host-less request reaches the handler and gets 403, not Node\'s 400)', async (t) => {
  const s = await start(t);
  const res = await s.req({ path: '/', setHost: false });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'forbidden_host');
});
