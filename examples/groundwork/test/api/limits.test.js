import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from '../support/harness.js';
import { errorResponse, errorDetails } from '../../src/api/contract-schemas.js';
import { validate } from '../../src/lib/schema.js';

let h; let lead;
before(async () => { h = await startApp(); lead = await h.client('aLead'); });
after(async () => { await h.close(); });

const shaped = (r) => {
  assert.deepEqual(validate(errorResponse, r.json).errors, []);
  const id = typeof r.headers.get === 'function' ? r.headers.get('x-request-id') : r.headers['x-request-id'];
  assert.equal(r.json.error.requestId, id);
};

/** Raw request so headers/body framing are under test control. Resolves {status, body, headers} or {error}. */
function raw({ method = 'POST', path = '/api/users', headers = {}, chunks = [] }) {
  return new Promise((resolve) => {
    const u = new URL(h.url);
    const hdrs = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers: hdrs }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', (error) => resolve({ error }));
    (async () => {
      for (const c of chunks) {
        if (!req.write(c)) await new Promise((r) => req.once('drain', r));
        if (req.destroyed) return;
      }
      req.end();
    })();
  });
}

const authHeaders = () => ({
  cookie: lead.cookieHeader(), 'x-csrf-token': lead.csrfToken, 'content-type': 'application/json',
});

test('413: Content-Length above 1 MiB is refused with the envelope', async () => {
  const body = Buffer.alloc(1048576 + 1, 0x61);
  const r = await raw({ headers: { ...authHeaders(), 'content-length': String(body.length) }, chunks: [body] });
  if (r.error) assert.match(r.error.code, /ECONNRESET|EPIPE/); // server may close early; the check below covers the response path
  else { assert.equal(r.status, 413); shaped(r); assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE'); }
});

test('413: declared large Content-Length is rejected without reading the body', async () => {
  const r = await raw({ headers: { ...authHeaders(), 'content-length': String(50 * 1024 * 1024) }, chunks: [Buffer.from('{}')] });
  if (!r.error) { assert.equal(r.status, 413); shaped(r); }
});

test('413: chunked body streaming past 1 MiB is cut off', async () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const chunks = Array.from({ length: 24 }, () => chunk); // 1.5 MiB, no Content-Length
  const r = await raw({ headers: { ...authHeaders(), 'transfer-encoding': 'chunked' }, chunks });
  if (r.error) assert.match(r.error.code, /ECONNRESET|EPIPE/);
  else { assert.equal(r.status, 413); shaped(r); assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE'); }
});

test('413 via fetch with a large JSON body: small-enough overshoot returns the envelope', async () => {
  const big = JSON.stringify({ username: 'x', displayName: 'y'.repeat(1048576), password: 'a-long-password', role: 'viewer' });
  let r;
  try { r = await lead.request('POST', '/api/users', { rawBody: big, headers: { 'content-type': 'application/json' } }); } catch (e) { r = { error: e }; }
  assert.equal(r.error, undefined);
  assert.equal(r.status, 413);
  shaped(r);
  // the server is still healthy afterwards
  assert.equal((await h.anon().get('/api/health')).status, 200);
});

test('body exactly at the limit is read (and then fails validation, not 413)', async () => {
  const pad = '{"username":"x","pad":"' ;
  const body = pad + 'a'.repeat(1048576 - pad.length - 2) + '"}';
  assert.equal(Buffer.byteLength(body), 1048576);
  const r = await lead.request('POST', '/api/users', { rawBody: body, headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'VALIDATION_FAILED');
});

test('415: non-JSON content types are refused with the envelope', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json', 'application/jsonx']) {
    const r = await lead.request('POST', '/api/users', { rawBody: '{"a":1}', headers: { 'content-type': ct } });
    assert.equal(r.status, 415, ct);
    shaped(r);
    assert.equal(r.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  const none = await raw({ headers: { ...authHeaders(), 'content-type': undefined }, chunks: [Buffer.from('{}')] });
  assert.equal(none.status, 415);
  const ok = await lead.request('POST', '/api/users', { rawBody: '{}', headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(ok.status, 400); // passes the media check, fails validation
  const enc = await lead.request('POST', '/api/users', { rawBody: '{}', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  assert.equal(enc.status, 415);
});

test('400 INVALID_JSON for malformed or non-UTF-8 bodies, 400 for wrong top-level type', async () => {
  for (const b of ['{', '', 'null', '"str"', '[1]', '{"a":}', 'undefined']) {
    const r = await lead.request('POST', '/api/users', { rawBody: b, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400, JSON.stringify(b));
    shaped(r);
    assert.ok(['INVALID_JSON', 'VALIDATION_FAILED'].includes(r.json.error.code));
  }
  const r = await lead.request('POST', '/api/users', { rawBody: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_JSON');
});

test('404 and 405 are shaped; 405 carries Allow and details.allow', async () => {
  const nf = await h.anon().get('/api/nothing/here');
  assert.equal(nf.status, 404);
  shaped(nf);
  assert.equal(nf.json.error.code, 'NOT_FOUND');

  const mna = await h.anon().request('DELETE', '/api/health');
  assert.equal(mna.status, 405);
  shaped(mna);
  assert.equal(mna.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(validate(errorDetails.METHOD_NOT_ALLOWED, mna.json.error.details).errors, []);
  assert.deepEqual(mna.json.error.details.allow, ['GET', 'HEAD']);

  const opt = await h.anon().request('OPTIONS', '/api/health');
  assert.equal(opt.status, 405);
  const post = await lead.post('/api/me', {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('inbound X-Request-Id is reused only when well formed', async () => {
  const good = await h.anon().get('/api/health', { headers: { 'x-request-id': 'trace-12345678' } });
  assert.equal(good.headers.get('x-request-id'), 'trace-12345678');
  for (const bad of ['short', 'has space in it 123', 'x'.repeat(65), 'bad<script>id']) {
    const r = await h.anon().get('/api/nope', { headers: { 'x-request-id': bad } });
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f]{16}$/);
    assert.equal(r.json.error.requestId, r.headers.get('x-request-id'));
  }
});

test('query strings are whitelisted: unknown parameters are 400 on routes without query schema', async () => {
  const r = await lead.get('/api/users?admin=1');
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'VALIDATION_FAILED');
});

test('a body sent to a no-body POST route is rejected as unknown fields', async () => {
  const r = await lead.post('/api/auth/logout', { evil: true });
  assert.equal(r.status, 400);
  assert.equal((await h.anon().get('/api/health')).status, 200);
});

test('path parameters must be integers: non-numeric or huge ids do not match', async () => {
  h.app.ctx.router.get('/api/zz/:id', { action: 'me' }, async (rc) => ({ body: { id: rc.params.id } }));
  assert.equal((await lead.get('/api/zz/12')).json.id, 12);
  for (const p of ['abc', '1e3', '-1', '0', '99999999999', '2147483648', '1%20', '012345678901']) {
    assert.equal((await lead.get(`/api/zz/${p}`)).status, 404, p);
  }
});

test('unauthenticated 4xx ordering: no body is parsed before auth', async () => {
  const r = await raw({ headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('x')] });
  assert.equal(r.status, 401);
});

test('server survives slow/broken clients and malformed request lines', async () => {
  const net = await import('node:net');
  const u = new URL(h.url);
  await new Promise((resolve) => {
    const s = net.connect(Number(u.port), u.hostname, () => { s.write('GARBAGE\r\n\r\n'); });
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('error', resolve);
  });
  assert.equal((await h.anon().get('/api/health')).status, 200);
});
