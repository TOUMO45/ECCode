'use strict';
// Self-test for the shared test helpers (task t03, spec §Testing Strategy "Test helpers").
// Loopback only: every server here binds 127.0.0.1. src/server.js is NOT spawned (it is built later);
// spawn-server is exercised against test/helpers/fixtures/env-probe-server.js instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { request } = require('./http-client.js');
const fakeFetch = require('./fake-fetch.js');
const { startFakeAnthropic } = require('./fake-anthropic.js');
const { spawnServer, buildChildEnv } = require('./spawn-server.js');

const PROBE = path.join(__dirname, 'fixtures', 'env-probe-server.js');

/** Resolves to 'pending' if `p` has not settled after a few macrotask turns. */
async function settledState(p, turns = 5) {
  let state = 'pending';
  p.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
  return state;
}

/** In-process echo server (requireHostHeader:false so a Host-less request reaches the handler). */
async function startEcho(t) {
  const srv = http.createServer({ requireHostHeader: false }, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = JSON.stringify({
        method: req.method, url: req.url,
        hasHost: Object.prototype.hasOwnProperty.call(req.headers, 'host'),
        host: req.headers.host === undefined ? null : req.headers.host,
        origin: req.headers.origin === undefined ? null : req.headers.origin,
        contentType: req.headers['content-type'] === undefined ? null : req.headers['content-type'],
        contentLength: req.headers['content-length'] === undefined ? null : req.headers['content-length'],
        body,
      });
      if (req.url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(out) });
      res.end(req.method === 'HEAD' ? undefined : out);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  assert.equal(srv.address().address, '127.0.0.1');
  return srv.address().port;
}

// ---------------------------------------------------------------- http-client

test('http-client: default Host is 127.0.0.1:<port>, JSON parsed, status and headers returned', async (t) => {
  const port = await startEcho(t);
  const r = await request({ port, method: 'GET', path: '/api/health?x=1' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(typeof r.body, 'string');
  assert.deepEqual(r.json, JSON.parse(r.body));
  assert.equal(r.json.method, 'GET');
  assert.equal(r.json.url, '/api/health?x=1');
  assert.equal(r.json.host, '127.0.0.1:' + port);
});

test('http-client: foreign Host, missing Host (setHost=false) and Origin are sent as given', async (t) => {
  const port = await startEcho(t);
  const foreign = await request({ port, method: 'POST', path: '/api/triage', headers: { host: 'attacker.example:3000', origin: 'null' }, body: '{}' });
  assert.equal(foreign.json.host, 'attacker.example:3000');
  assert.equal(foreign.json.origin, 'null');

  const missing = await request({ port, method: 'GET', path: '/', setHost: false });
  assert.equal(missing.json.hasHost, false);
  assert.equal(missing.json.host, null);

  const v6 = await request({ port, method: 'GET', path: '/', headers: { Host: '[::1]:' + port, Origin: 'http://[::1]:' + port } });
  assert.equal(v6.json.host, '[::1]:' + port);
  assert.equal(v6.json.origin, 'http://[::1]:' + port);
});

test('http-client: body encoding (string raw, object as JSON) with explicit Content-Length', async (t) => {
  const port = await startEcho(t);
  const raw = await request({ port, method: 'POST', path: '/p', headers: { 'Content-Type': 'text/plain' }, body: 'not json {' });
  assert.equal(raw.json.body, 'not json {');
  assert.equal(raw.json.contentType, 'text/plain');
  assert.equal(raw.json.contentLength, String(Buffer.byteLength('not json {')));

  const obj = await request({ port, method: 'POST', path: '/p', body: { ticket: 'héllo' } });
  assert.equal(obj.json.body, JSON.stringify({ ticket: 'héllo' }));
  assert.equal(obj.json.contentType, 'application/json');
  assert.equal(obj.json.contentLength, String(Buffer.byteLength(JSON.stringify({ ticket: 'héllo' }))));

  const big = 'x'.repeat(20 * 1024);
  const r = await request({ port, method: 'POST', path: '/p', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(r.json.body.length, big.length);
});

test('http-client: HEAD gives an empty body and json null; non-JSON body gives json null', async (t) => {
  const port = await startEcho(t);
  const head = await request({ port, method: 'HEAD', path: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.json, null);
  const text = await request({ port, method: 'GET', path: '/text' });
  assert.equal(text.body, 'plain text');
  assert.equal(text.json, null);
});

test('http-client: rejects (does not hang) when nothing listens', async () => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  await assert.rejects(request({ port, method: 'GET', path: '/' }), { code: 'ECONNREFUSED' });
});

// ---------------------------------------------------------------- fake-fetch

test('fake-fetch: respond(status, json|text) exposes status and text()', async () => {
  const j = await fakeFetch.respond(429, { error: { type: 'rate_limit' } })('http://x/v1/messages', {});
  assert.equal(j.status, 429);
  assert.equal(await j.text(), '{"error":{"type":"rate_limit"}}');
  const s = await fakeFetch.respond(200, 'not json')('u', {});
  assert.equal(s.status, 200);
  assert.equal(await s.text(), 'not json');
});

test('fake-fetch: messageOk builds a Messages API body with a text block and usage', async () => {
  const triage = { category: 'billing', urgency: 'high', summary: 'S.', suggestedReply: 'R.' };
  const res = await fakeFetch.messageOk(triage)('u', {});
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, [{ type: 'text', text: JSON.stringify(triage) }]);
  assert.equal(typeof body.usage.input_tokens, 'number');
  assert.equal(typeof body.usage.output_tokens, 'number');

  const custom = JSON.parse(await (await fakeFetch.messageOk(triage, { stop_reason: 'max_tokens', usage: { input_tokens: 7, output_tokens: 9 } })('u', {})).text());
  assert.equal(custom.stop_reason, 'max_tokens');
  assert.deepEqual(custom.usage, { input_tokens: 7, output_tokens: 9 });

  const noUsage = JSON.parse(await (await fakeFetch.messageOk(triage, { usage: null })('u', {})).text());
  assert.equal(Object.prototype.hasOwnProperty.call(noUsage, 'usage'), false);

  const rawText = JSON.parse(await (await fakeFetch.messageOk('this is not json')('u', {})).text());
  assert.equal(rawText.content[0].text, 'this is not json');
});

test('fake-fetch: thinkingFirst puts a thinking block before the text block', async () => {
  const triage = { category: 'technical', urgency: 'low', summary: 'S.', suggestedReply: 'R.' };
  const body = JSON.parse(await (await fakeFetch.messageOk(triage, { thinkingFirst: true })('u', {})).text());
  assert.equal(body.content.length, 2);
  assert.equal(body.content[0].type, 'thinking');
  assert.equal(body.content[1].type, 'text');
  assert.equal(body.content[1].text, JSON.stringify(triage));
  assert.deepEqual(fakeFetch.messageBody(triage, { thinkingFirst: true }).content, body.content);
});

test('fake-fetch: never() stays pending, even after the signal aborts', async () => {
  const controller = new AbortController();
  const p = fakeFetch.never()('u', { signal: controller.signal });
  assert.equal(await settledState(p), 'pending');
  controller.abort();
  assert.equal(await settledState(p), 'pending');
});

test('fake-fetch: throws() rejects with a TypeError by default, or the given error', async () => {
  await assert.rejects(fakeFetch.throws()('u', {}), TypeError);
  const e = new Error('boom');
  await assert.rejects(fakeFetch.throws(e)('u', {}), (got) => got === e);
});

test('fake-fetch: capture(inner) records url, init and parsed body, counts calls, delegates to inner', async () => {
  const cap = fakeFetch.capture(fakeFetch.respond(200, { ok: true }));
  assert.equal(cap.count, 0);
  assert.deepEqual(cap.calls, []);
  const init = { method: 'POST', headers: { 'x-api-key': 'test-key-FAKE' }, body: JSON.stringify({ model: 'm', max_tokens: 5 }), redirect: 'error' };
  const res = await cap('http://127.0.0.1:9/v1/messages', init);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
  assert.equal(cap.count, 1);
  assert.equal(cap.calls[0].url, 'http://127.0.0.1:9/v1/messages');
  assert.equal(cap.calls[0].init, init);
  assert.equal(cap.calls[0].init.redirect, 'error');
  assert.deepEqual(cap.calls[0].body, { model: 'm', max_tokens: 5 });

  await cap('u2', { method: 'POST', body: 'not json' });
  assert.equal(cap.count, 2);
  assert.equal(cap.calls[1].body, null);
  assert.equal(cap.calls[1].rawBody, 'not json');

  // The call is recorded before inner runs, so a never() inner still counts.
  const capNever = fakeFetch.capture(fakeFetch.never());
  const p = capNever('u', { body: '{}' });
  assert.equal(capNever.count, 1);
  assert.equal(await settledState(p), 'pending');

  assert.throws(() => fakeFetch.capture(), TypeError);
});

// ---------------------------------------------------------------- fake-anthropic

async function startFA(t) {
  const fa = await startFakeAnthropic();
  t.after(() => fa.close());
  return fa;
}

test('fake-anthropic: binds 127.0.0.1, serves a programmed 200 and records the request', async (t) => {
  const fa = await startFA(t);
  assert.equal(fa.address, '127.0.0.1');
  assert.equal(fa.url, 'http://127.0.0.1:' + fa.port);
  assert.equal(fa.count, 0);

  const triage = { category: 'account', urgency: 'medium', summary: 'S.', suggestedReply: 'R.' };
  fa.replyMessage(triage, { usage: { input_tokens: 11, output_tokens: 22 } });
  const reqBody = JSON.stringify({ model: 'claude-haiku-5-5', messages: [] });
  const res = await fetch(fa.url + '/v1/messages', {
    method: 'POST', redirect: 'error', body: reqBody,
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key-FAKE', 'anthropic-version': '2023-06-01' },
  });
  assert.equal(res.status, 200);
  const got = await res.json();
  assert.deepEqual(got.content, [{ type: 'text', text: JSON.stringify(triage) }]);
  assert.deepEqual(got.usage, { input_tokens: 11, output_tokens: 22 });

  assert.equal(fa.count, 1);
  assert.equal(fa.requests.length, 1);
  const rec = fa.requests[0];
  assert.equal(rec.method, 'POST');
  assert.equal(rec.path, '/v1/messages');
  assert.equal(rec.headers['x-api-key'], 'test-key-FAKE');
  assert.equal(rec.headers['anthropic-version'], '2023-06-01');
  assert.equal(rec.body, reqBody);
  assert.deepEqual(rec.json, JSON.parse(reqBody));

  // Programmed responses persist until reprogrammed; one-shot responses are served first, in order.
  fa.reply(529, { type: 'error', error: { type: 'overloaded_error' } }, { once: true });
  const first = await fetch(fa.url + '/v1/messages', { method: 'POST', body: '{}' });
  assert.equal(first.status, 529);
  await first.text();
  const second = await fetch(fa.url + '/v1/messages', { method: 'POST', body: '{}' });
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(fa.count, 3);

  fa.reset();
  assert.equal(fa.count, 0);
  assert.deepEqual(fa.requests, []);
});

test('fake-anthropic: unprogrammed server answers 500, not a success', async (t) => {
  const fa = await startFA(t);
  const r = await request({ port: fa.port, method: 'POST', path: '/v1/messages', body: {} });
  assert.equal(r.status, 500);
  assert.equal(r.json.type, 'error');
  assert.equal(fa.count, 1);
});

for (const status of [307, 308]) {
  test(`fake-anthropic: redirect(${status}) — fetch with redirect:'error' throws and the target counts 0 requests`, async (t) => {
    const a = await startFA(t);
    const b = await startFA(t);
    b.replyMessage({ category: 'other', urgency: 'low', summary: 'S.', suggestedReply: 'R.' });
    const location = 'http://localhost:' + b.port + '/v1/messages';
    a.redirect(status, location);

    // The redirect is really served (status + Location), seen with a non-following client.
    const raw = await request({ port: a.port, method: 'POST', path: '/v1/messages', body: { x: 1 } });
    assert.equal(raw.status, status);
    assert.equal(raw.headers.location, location);

    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key-FAKE' }, body: '{"t":"redacted"}' };
    await assert.rejects(fetch(a.url + '/v1/messages', { ...init, redirect: 'error' }), TypeError);
    assert.equal(a.count, 2);
    assert.equal(b.count, 0);
    assert.deepEqual(b.requests, []);

    // Control: the counter on B is live. A following client does reach B (via localhost → 127.0.0.1),
    // so "B counted 0" above is a real observation, not a dead counter.
    const followed = await fetch(a.url + '/v1/messages', { ...init, redirect: 'follow' });
    assert.equal(followed.status, 200);
    await followed.text();
    assert.equal(b.count, 1);
    assert.equal(b.requests[0].headers['x-api-key'], 'test-key-FAKE');
  });
}

test('fake-anthropic: redirect() rejects a non-3xx status', async (t) => {
  const fa = await startFA(t);
  assert.throws(() => fa.redirect(200, 'http://127.0.0.1:1/'), RangeError);
});

// ---------------------------------------------------------------- spawn-server

test('spawn-server: buildChildEnv is exactly {PATH, ...testEnv, PORT:"0"} and copies nothing else from process.env', () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, b: process.env.TRIAGE_ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'parent-key-FAKE';
  process.env.TRIAGE_ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  try {
    assert.deepEqual(buildChildEnv({ ANTHROPIC_API_KEY: '', PORT: '1234', TRIAGE_TIMEOUT_MS: '300' }),
      { PATH: process.env.PATH, ANTHROPIC_API_KEY: '', TRIAGE_TIMEOUT_MS: '300', PORT: '0' });
    assert.deepEqual(buildChildEnv(), { PATH: process.env.PATH, PORT: '0' });
    assert.deepEqual(buildChildEnv({ PATH: '/custom/bin' }), { PATH: '/custom/bin', PORT: '0' });
    assert.throws(() => buildChildEnv({ PORT_X: 1 }), TypeError);
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.b === undefined) delete process.env.TRIAGE_ANTHROPIC_BASE_URL; else process.env.TRIAGE_ANTHROPIC_BASE_URL = saved.b;
  }
});

test('spawn-server: child sees only PATH, testEnv and PORT=0 (parent secrets do not leak); port read from listening line', async (t) => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, b: process.env.TRIAGE_ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'parent-key-FAKE';
  process.env.TRIAGE_ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  let srv;
  try {
    srv = await spawnServer({ entry: PROBE, env: { ANTHROPIC_API_KEY: '', MARKER: 'm-1' } });
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.b === undefined) delete process.env.TRIAGE_ANTHROPIC_BASE_URL; else process.env.TRIAGE_ANTHROPIC_BASE_URL = saved.b;
  }
  t.after(() => srv.stop());

  assert.equal(typeof srv.port, 'number');
  assert.ok(srv.port > 0);
  assert.equal(srv.listening.event, 'listening');
  assert.equal(srv.listening.port, srv.port);
  assert.deepEqual(srv.listening.envKeys, ['ANTHROPIC_API_KEY', 'MARKER', 'PATH', 'PORT']);
  assert.equal(srv.listening.portEnv, '0');
  assert.equal(srv.listening.apiKeyEmpty, true);

  const r = await request({ port: srv.port, method: 'GET', path: '/env' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.envKeys, ['ANTHROPIC_API_KEY', 'MARKER', 'PATH', 'PORT']);
  assert.equal(r.json.marker, 'm-1');

  // stdout lines are captured and parsed; stderr is captured.
  const line = await srv.waitForLog((rec) => rec.event === 'request');
  assert.equal(line.path, '/env');
  assert.ok(srv.logs().some((rec) => rec.event === 'listening'));
  assert.match(srv.stdout(), /"event":"listening"/);
  assert.match(srv.stderr(), /probe stderr line/);
  assert.equal(srv.stdout().includes('parent-key-FAKE'), false);
  assert.equal(srv.stderr().includes('parent-key-FAKE'), false);
});

test('spawn-server: stop() terminates the child and the port stops accepting', async () => {
  const srv = await spawnServer({ entry: PROBE });
  const port = srv.port;
  const exit = await srv.stop();
  assert.equal(srv.child.exitCode !== null || srv.child.signalCode !== null, true);
  assert.ok(exit.code === 0 || exit.signal !== null);
  assert.deepEqual(await srv.stop(), exit); // idempotent
  await assert.rejects(request({ port, method: 'GET', path: '/env' }), { code: 'ECONNREFUSED' });
});

test('spawn-server: a child that exits before listening rejects with its exit code and stderr', async () => {
  await assert.rejects(spawnServer({ entry: PROBE, env: { PROBE_MODE: 'config-error' } }), (err) => {
    assert.match(err.message, /exited before listening/);
    assert.equal(err.exitCode, 1);
    assert.match(err.stderr, /config error: PROBE_MODE/);
    return true;
  });
});

test('spawn-server: a child that never logs listening is killed after timeoutMs', async () => {
  await assert.rejects(spawnServer({ entry: PROBE, env: { PROBE_MODE: 'silent' }, timeoutMs: 500 }), /did not log a listening event within 500 ms/);
});
