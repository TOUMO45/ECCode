'use strict';
// Contract tests: triage modes end to end over HTTP (spec §Testing Strategy, C3, C6.4, C7; brief AC3, AC4, AC13).
// In-process tests always pass an explicit env object (never process.env, DES-1). The live path uses
// fake-fetch stubs, or the real globalThis.fetch against the loopback fake-anthropic server. No real key,
// no network beyond loopback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { buildApp } = require('../../src/app.js');
const { createLogger } = require('../../src/log.js');
const { validateResponse } = require('../../src/triage/schema.js');
const { request } = require('../helpers/http-client.js');
const { respond, messageOk, never, throws, capture } = require('../helpers/fake-fetch.js');
const { startFakeAnthropic } = require('../helpers/fake-anthropic.js');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_KEY = 'test-key-FAKE-modes-3b9d';
const MARKER = 'modes-marker-c71f0a';
const TICKET = `I was charged twice for my March invoice and need a refund. Ref ${MARKER}.`;
const RESPONSE_KEYS = ['category', 'urgency', 'summary', 'suggestedReply', 'source', 'fallbackReason', 'injectionSuspected', 'model'];
const VALID = Object.freeze({
  category: 'billing',
  urgency: 'high',
  summary: 'Customer was charged twice for the March invoice.',
  suggestedReply: 'Sorry about the double charge; we will look into it. Could you share the invoice number?',
});
const LIVE_ENV = Object.freeze({ ANTHROPIC_API_KEY: FAKE_KEY, PORT: '0', TRIAGE_TIMEOUT_MS: '300' });

async function startApp(env, fetchImpl) {
  const lines = [];
  const log = createLogger((l) => lines.push(l));
  const app = fetchImpl === undefined ? buildApp({ env, log }) : buildApp({ env, fetchImpl, log });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
  });
  const port = app.server.address().port;
  return {
    app,
    port,
    lines,
    post: (ticket) => request({ port, method: 'POST', path: '/api/triage', body: { ticket } }),
    close: () => new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); }),
  };
}

function assertNoLeakInLogs(lines) {
  for (const l of lines) {
    assert.ok(!l.includes(MARKER), 'ticket marker leaked into a log line');
    assert.ok(!l.includes(FAKE_KEY), 'API key leaked into a log line');
  }
}

function assertResponseShape(res) {
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json), RESPONSE_KEYS);
  const v = validateResponse(res.json);
  assert.ok(v.ok, `validateResponse failed: ${v.errors && v.errors.join(',')}`);
  assert.ok(!res.body.includes(FAKE_KEY), 'API key in response body');
  assert.ok(!JSON.stringify(res.headers).includes(FAKE_KEY), 'API key in response headers');
}

// ---------------------------------------------------------------- AC3: fallback mode (no key)

test('AC3: without ANTHROPIC_API_KEY the response is fallback/no_api_key, deterministic, and the transport is never called', async () => {
  const stub = capture(throws());
  const s = await startApp({ PORT: '0' }, stub);
  try {
    assert.equal(s.app.service.mode, 'fallback');
    const r1 = await s.post(TICKET);
    const r2 = await s.post(TICKET);
    assertResponseShape(r1);
    assert.equal(r1.json.source, 'fallback');
    assert.equal(r1.json.fallbackReason, 'no_api_key');
    assert.equal(r1.json.model, null);
    assert.deepEqual(r1.json, r2.json);
    assert.equal(stub.count, 0, 'fetch stub must never be called in fallback mode');
    assertNoLeakInLogs(s.lines);
  } finally {
    await s.close();
  }
});

test('AC3: an empty ANTHROPIC_API_KEY is fallback mode as well', async () => {
  const stub = capture(throws());
  const s = await startApp({ PORT: '0', ANTHROPIC_API_KEY: '' }, stub);
  try {
    const r = await s.post(TICKET);
    assertResponseShape(r);
    assert.equal(r.json.fallbackReason, 'no_api_key');
    assert.equal(stub.count, 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- AC4 (a)-(n): stubbed transport over HTTP

const FALLBACK_CASES = [
  ['(a) transport throws', () => throws(), 'model_error'],
  ['(b) transport never resolves', () => never(), 'timeout'],
  ['(c) HTTP 404 with JSON error body (wrong model id)', () => respond(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } }), 'model_error'],
  ['(d) HTTP 429', () => respond(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), 'model_error'],
  ['(e) HTTP 529', () => respond(529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }), 'model_error'],
  ['(f) HTTP 500', () => respond(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }), 'model_error'],
  ['(g) stop_reason refusal', () => messageOk(VALID, { stop_reason: 'refusal' }), 'refusal'],
  ['(h) stop_reason max_tokens', () => messageOk(VALID, { stop_reason: 'max_tokens' }), 'truncated'],
  ['(i) non-JSON text block', () => messageOk('Sure! The category is billing.'), 'invalid_output'],
  ['(j) out-of-enum category', () => messageOk({ ...VALID, category: 'refunds' }), 'invalid_output'],
  ['(k) reply containing a URL', () => messageOk({ ...VALID, suggestedReply: 'Please pay again at https://evil.example/pay today.' }), 'invalid_output'],
  ['(l) two-sentence summary', () => messageOk({ ...VALID, summary: 'Customer was charged twice. They want a refund.' }), 'invalid_output'],
  ['3xx from a non-following transport', () => respond(307, '{}'), 'model_error'],
];

for (const [name, makeStub, reason] of FALLBACK_CASES) {
  test(`AC4 ${name} → 200 source fallback, fallbackReason ${reason}, at most one fetch call`, async () => {
    const stub = capture(makeStub());
    const s = await startApp(LIVE_ENV, stub);
    try {
      const r = await s.post(TICKET);
      assertResponseShape(r);
      assert.equal(r.json.source, 'fallback');
      assert.equal(r.json.fallbackReason, reason);
      assert.equal(r.json.model, null);
      assert.equal(stub.count, 1, 'exactly one outbound call, no retries');
      assertNoLeakInLogs(s.lines);
    } finally {
      await s.close();
    }
  });
}

test('AC4 (m) enum case is normalised: Billing/HIGH → source model, billing/high (V3)', async () => {
  const stub = capture(messageOk({ ...VALID, category: 'Billing', urgency: 'HIGH' }));
  const s = await startApp(LIVE_ENV, stub);
  try {
    const r = await s.post(TICKET);
    assertResponseShape(r);
    assert.equal(r.json.source, 'model');
    assert.equal(r.json.fallbackReason, null);
    assert.equal(r.json.category, 'billing');
    assert.equal(r.json.urgency, 'high');
    assert.equal(stub.count, 1);
  } finally {
    await s.close();
  }
});

test('AC4 (n) a thinking block before the text block → parsed from the text block, source model', async () => {
  const stub = capture(messageOk(VALID, { thinkingFirst: true }));
  const s = await startApp(LIVE_ENV, stub);
  try {
    const r = await s.post(TICKET);
    assertResponseShape(r);
    assert.equal(r.json.source, 'model');
    assert.equal(r.json.summary, VALID.summary);
    assert.equal(r.json.suggestedReply, VALID.suggestedReply);
    assert.equal(stub.count, 1);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- response model = configured model (C3, t04 note)

test('C3: response model equals the configured model, not the model named in the upstream body', async () => {
  // Upstream body says claude-haiku-5-5; the configured model is different and must win.
  const stub = capture(messageOk(VALID, { model: 'claude-haiku-5-5' }));
  const s = await startApp({ ...LIVE_ENV, ANTHROPIC_MODEL: 'claude-opus-5-5' }, stub);
  try {
    const r = await s.post(TICKET);
    assertResponseShape(r);
    assert.equal(r.json.source, 'model');
    assert.equal(r.json.model, 'claude-opus-5-5');
    assert.equal(stub.calls[0].body.model, 'claude-opus-5-5', 'outbound body names the configured model');
    const h = await request({ port: s.port, path: '/api/health' });
    assert.equal(h.json.model, 'claude-opus-5-5');
  } finally {
    await s.close();
  }
});

test('C3: default configured model is claude-haiku-5-5 in the response and the outbound body', async () => {
  const stub = capture(messageOk(VALID, { model: 'some-other-model' }));
  const s = await startApp(LIVE_ENV, stub);
  try {
    const r = await s.post(TICKET);
    assert.equal(r.json.source, 'model');
    assert.equal(r.json.model, 'claude-haiku-5-5');
    assert.equal(stub.calls[0].body.model, 'claude-haiku-5-5');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- AC13 timeout bound

test('AC13: a transport that never settles returns fallback timeout within TRIAGE_TIMEOUT_MS + 500 ms', async () => {
  const stub = capture(never());
  const s = await startApp(LIVE_ENV, stub); // TRIAGE_TIMEOUT_MS = 300
  try {
    const t0 = process.hrtime.bigint();
    const r = await s.post(TICKET);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assertResponseShape(r);
    assert.equal(r.json.fallbackReason, 'timeout');
    assert.ok(ms <= 800, `response took ${ms.toFixed(1)} ms (> 300 + 500)`);
    assert.ok(stub.calls[0].init.signal instanceof AbortSignal);
    assert.equal(stub.calls[0].init.signal.aborted, true, 'the pending fetch is aborted');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- live mode with the real fetch against fake-anthropic

test('live mode: real globalThis.fetch against fake-anthropic → source model; C7 headers and URL', async () => {
  const fake = await startFakeAnthropic();
  const s = await startApp({ ...LIVE_ENV, TRIAGE_TIMEOUT_MS: '5000', TRIAGE_ANTHROPIC_BASE_URL: fake.url });
  try {
    fake.replyMessage(VALID);
    const r = await s.post(TICKET);
    assertResponseShape(r);
    assert.equal(r.json.source, 'model');
    assert.equal(r.json.model, 'claude-haiku-5-5');
    assert.equal(fake.count, 1);
    const req = fake.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/messages');
    assert.equal(req.headers['x-api-key'], FAKE_KEY);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.match(req.headers['content-type'], /^application\/json/);
    assert.equal(req.json.model, 'claude-haiku-5-5');
    assertNoLeakInLogs(s.lines);
  } finally {
    await s.close();
    await fake.close();
  }
});

// ---------------------------------------------------------------- AC4 (o) redirect is never followed (DES-1)

for (const status of [307, 308]) {
  test(`AC4 (o): configured endpoint answers ${status} → fallback model_error and the redirect target receives 0 requests`, async () => {
    const a = await startFakeAnthropic();
    const b = await startFakeAnthropic();
    // Real globalThis.fetch: buildApp is called without fetchImpl, so its default is used.
    const s = await startApp({ ...LIVE_ENV, TRIAGE_TIMEOUT_MS: '5000', TRIAGE_ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}` });
    try {
      a.redirect(status, `http://localhost:${b.port}/v1/messages`);
      b.replyMessage(VALID);
      const r = await s.post(TICKET);
      assertResponseShape(r);
      assert.equal(r.json.source, 'fallback');
      assert.equal(r.json.fallbackReason, 'model_error');
      assert.equal(r.json.model, null);
      assert.equal(a.count, 1, 'the configured endpoint received exactly one request');
      assert.equal(b.count, 0, 'the redirect target must receive no request (no key, no body)');
      assertNoLeakInLogs(s.lines);
    } finally {
      await s.close();
      await a.close();
      await b.close();
    }
  });
}

// ---------------------------------------------------------------- PL-3: tune-mode eval runs cleanly now that rules exist

test('PL-3: npm run eval:tune exits 0 or 1 (never 2) and ends with a TUNE_EVAL line', () => {
  const env = { PATH: process.env.PATH }; // explicit env: no inherited key or base URL
  const r = spawnSync('npm', ['run', '--silent', 'eval:tune'], { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.ok(r.status === 0 || r.status === 1, `eval:tune exited ${r.status}; stderr: ${r.stderr}`);
  assert.ok(!r.stdout.includes('ECCODE_EVAL'), 'tune mode must not print the full-mode ECCODE_EVAL line');
  const last = r.stdout.trim().split('\n').pop();
  assert.match(last, /^TUNE_EVAL \{/);
  assert.equal(JSON.parse(last.slice('TUNE_EVAL '.length)).mode, 'tune');
});
