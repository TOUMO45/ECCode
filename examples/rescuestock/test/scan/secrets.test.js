// Log part of the secrets scan (NFR6, RS-29, spec Observability and threat T21): every log line of the server runs in this
// suite carries a requestId and holds no Authorization header value, access token, client secret, password, payer e-mail
// or name, session or CSRF token, buyer text or provider body. The logger drops every key outside an allow-list, so the
// scan drives real flows (sign-up, sign-in, request, photo upload, extraction through the fake and through the real CLI and
// Anthropic adapters against stubs, degraded paths, refusals, malformed input, admin) with canary values placed in every
// channel a secret could leak through, then checks the lines that the server wrote.
// Phase G extends this file to built assets, recorded responses, screenshots and submission files (RS-29).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_KEYS, createLogger } from '../../src/log.js';
import { fixedClock } from '../../src/clock.js';
import { createAnthropicProvider } from '../../src/ai/anthropic.js';
import { createCliProvider } from '../../src/ai/cli.js';
import { ProviderError } from '../../src/ai/provider.js';
import { createAiRuntime } from '../../src/services/extraction.js';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { loadClearPhoto, setModelFault, uploadImage } from '../helpers/extraction.js';
import { createClient, uniqueUsername } from '../helpers/fixtures.js';
import { PROVIDER_BODY_MARKER, createCliStubRoot, okMessage, startAnthropicStub } from '../helpers/provider-stubs.js';
import { startServer } from '../helpers/server-proc.js';
import { ensureAdmin } from '../../src/services/users.js';

// Canary values. None is a real credential; each is long and unusual enough that a match is a leak.
const CANARY = Object.freeze({
  authorization: 'Bearer canary-authorization-5d1f8a2c9e7b4036',
  accessToken: 'A21AAcanaryAccessToken0042xyz',
  clientId: 'AaCanaryClientId0042abcdefg',
  clientSecret: 'EeCanaryClientSecret0042abcdefg',
  adminPassword: 'canary-admin-password-0042-aa',
  webhookSecret: 'canary-webhook-secret-0042-0123456789abcdef',
  customerPassword: 'canary-customer-password-0042',
  apiKey: 'canary-anthropic-api-key-0042',
  payerEmail: 'zoltan.canarypayer@canary-mail.example',
  payerName: 'Zoltan Canarypayer',
  providerBody: PROVIDER_BODY_MARKER,
  buyerText: 'canary-buyer-sentence-0042',
});
const CANARY_VALUES = Object.freeze(Object.values(CANARY));
const SECRET_ENV = Object.freeze({
  RS_ADMIN_PASSWORD: CANARY.adminPassword,
  RS_FAKE_WEBHOOK_SECRET: CANARY.webhookSecret,
  RS_PAYMENT_PROVIDER: 'paypal-sandbox',
  RS_PAYPAL_DEFAULT_CLIENT_ID: CANARY.clientId,
  RS_PAYPAL_DEFAULT_CLIENT_SECRET: CANARY.clientSecret,
  RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'WH-CANARY-0042',
  RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
  RS_REGISTER_PER_IP_PER_HOUR: '1000',
});
const LINE_KEYS = new Set(['ts', 'level', 'msg', 'requestId', ...ALLOWED_KEYS]);
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Forms a value could take once logged: as is, JSON-escaped, URL-encoded, lower-cased, base64.
function forms(value) {
  const out = new Set([value, value.toLowerCase(), JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64').replace(/=+$/, '')]);
  return [...out];
}

// scanLogLines(lines, canaries) -> problems[]: a line that is not JSON, has no valid requestId, uses a key outside the
// allow-list, or contains any form of a canary.
export function scanLogLines(lines, canaries = CANARY_VALUES) {
  const problems = [];
  lines.forEach((raw, index) => {
    const where = `line ${index + 1}`;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push(`${where}: not a JSON line`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push(`${where}: not a JSON object`);
      return;
    }
    if (typeof parsed.requestId !== 'string' || !REQUEST_ID_RE.test(parsed.requestId)) problems.push(`${where}: no valid requestId`);
    for (const key of Object.keys(parsed)) if (!LINE_KEYS.has(key)) problems.push(`${where}: key "${key}" is not in the allow-list`);
    for (const canary of canaries) {
      for (const form of forms(canary)) if (raw.includes(form)) problems.push(`${where}: contains a canary value (${canary.slice(0, 12)}...)`);
    }
  });
  return problems;
}

const nonEmptyLines = (text) => text.split('\n').filter((l) => l.trim() !== '');

// ---- in-process server: many flows, every response correlated with its log line --------------------------------------------

describe('NFR6, RS-29: log lines of an in-process server run hold requestId and no secret', () => {
  let h;
  let anthropic;
  let cliRoot;
  const seen = [];
  const WINDOW_MS = 11 * 60 * 1000;

  // Every call also carries an Authorization header, an access-token header and the payer's data in the body.
  const tracked = (extraHeaders = {}) => async (options) => {
    const headers = { Authorization: CANARY.authorization, 'X-Access-Token': CANARY.accessToken, ...extraHeaders, ...(options.headers ?? {}) };
    const res = await h.request({ ...options, headers });
    seen.push({ method: options.method ?? 'GET', path: options.path, status: res.status, requestId: res.headers['x-request-id'] });
    return res;
  };

  before(async () => {
    h = await startHarness({ seed: true, env: SECRET_ENV });
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
    anthropic = await startAnthropicStub();
    cliRoot = createCliStubRoot();
  });
  after(async () => {
    await anthropic.close();
    cliRoot.cleanup();
    await h.close();
  });

  const swapProvider = (provider) => {
    h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, provider });
  };

  test('NFR6: sign-up, sign-in, requests, a photo, extraction (fake, CLI and Anthropic adapters, every failure), refusals and admin calls leave only allow-listed, secret-free lines', async () => {
    const client = createClient(tracked());
    await client.register({ username: uniqueUsername('scan'), password: CANARY.customerPassword, displayName: CANARY.payerName });
    // Wrong credentials, a malformed body, an oversized body and an unknown route that names a canary in its path.
    const stranger = createClient(tracked());
    await stranger.send({ path: '/api/auth/csrf' });
    assert.equal((await stranger.post('/api/auth/signin', { username: 'cafe1', password: CANARY.customerPassword })).status, 401);
    const malformed = await stranger.send({ method: 'POST', path: '/api/auth/signin', headers: { 'Content-Type': 'application/json' }, body: `{"username":"${CANARY.payerEmail}","password":"${CANARY.customerPassword}"` });
    assert.equal(malformed.status, 400);
    const oversized = await stranger.send({ method: 'POST', path: '/api/requests', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${CANARY.buyerText} ${'x'.repeat(200_000)}` }) });
    assert.ok(oversized.status >= 400 && oversized.status < 500, `oversized body: ${oversized.status}`);
    assert.equal((await stranger.get(`/api/${encodeURIComponent(CANARY.payerEmail)}/${CANARY.accessToken}`)).status, 404);

    const text = `I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups. Contact ${CANARY.payerName} at ${CANARY.payerEmail}. ${CANARY.buyerText}`;
    const newRequest = async () => {
      const res = await client.post('/api/requests', { text });
      assert.equal(res.status, 201, res.text);
      return res.json.request.id;
    };
    const extract = (id) => client.post(`/api/requests/${id}/extract`, {});

    // (1) the fake: success with a photo, then each fake fault.
    const id = await newRequest();
    assert.equal((await uploadImage(client, id, loadClearPhoto())).status, 201);
    assert.equal((await extract(id)).status, 200);
    assert.equal((await client.get(`/api/requests/${id}/image`)).status, 200);
    for (const fault of ['timeout', 'invalid_json', 'schema_invalid', 'error']) {
      h.clock.advance(WINDOW_MS);
      setModelFault(h.db, h.clock, fault, 1);
      const res = await extract(id);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.extraction.degraded, true, fault);
    }

    // (2) the real Anthropic adapter against the loopback stub: provider bodies that carry the marker.
    h.clock.advance(WINDOW_MS);
    swapProvider(createAnthropicProvider({ apiKey: CANARY.apiKey, baseUrl: anthropic.baseUrl, allowLoopback: true, timeoutMs: 5000 }));
    for (const reply of [
      { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: `${CANARY.providerBody} ${CANARY.apiKey}` } } },
      { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: CANARY.providerBody } } },
      { status: 200, json: okMessage(`not json ${CANARY.providerBody}`) },
      { status: 200, json: okMessage(JSON.stringify({ language: 'en', note: CANARY.providerBody })) },
    ]) {
      h.clock.advance(WINDOW_MS);
      anthropic.reset();
      anthropic.queue(reply);
      const res = await extract(id);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.extraction.degraded, true);
      assert.equal(res.text.includes(CANARY.providerBody), false, 'the API response does not carry the provider body either');
    }

    // (3) the real CLI adapter against the stub binary: stderr and prose answers.
    for (const mode of ['exit1', 'prose']) {
      h.clock.advance(WINDOW_MS);
      const sb = cliRoot.sandbox(mode);
      swapProvider(createCliProvider({ env: sb.env, tmpRoot: sb.tmp, callCapMicroUsd: 50_000, timeoutMs: 20_000 }));
      const res = await extract(id);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.extraction.degraded, true);
    }

    // (4) adapters that fail with the provider body in the error's cause, or with an unexpected error.
    for (const make of [
      () => new ProviderError('PROVIDER_BAD_OUTPUT', { cause: new Error(`${CANARY.providerBody} ${CANARY.accessToken}`) }),
      () => new Error(`${CANARY.providerBody} ${CANARY.authorization}`),
    ]) {
      h.clock.advance(WINDOW_MS);
      swapProvider({ id: 'anthropic', simulated: false, model: 'probe', extract: async () => { throw make(); } });
      const res = await extract(id);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.extraction.degraded, true);
    }
    // A provider that returns a body the validator refuses.
    h.clock.advance(WINDOW_MS);
    swapProvider({ id: 'anthropic', simulated: false, model: 'probe', extract: async () => ({ output: { raw: CANARY.providerBody }, usage: { model: 'probe', costUsd: 0, costMicroUsd: 0, inputTokens: 1, outputTokens: 1, latencyMs: 1 } }) });
    assert.equal((await extract(id)).json.extraction.degraded, true);

    // (5) refusals: the per-customer rate limit, then deletion, then an admin session with the canary password.
    h.clock.advance(WINDOW_MS);
    swapProvider({ id: 'fake', simulated: true, model: 'fake', extract: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE'); } });
    let limited = null;
    for (let i = 0; i < 12 && limited === null; i += 1) {
      const res = await extract(id);
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'the rate limit was reached');
    assert.equal((await client.send({ method: 'DELETE', path: `/api/requests/${id}` })).status, 200);
    const admin = createClient(tracked());
    await admin.signIn('admin', CANARY.adminPassword);
    assert.equal((await admin.get('/api/admin/metrics')).status, 200);
    assert.equal((await admin.get('/api/config')).status, 200);
    assert.equal((await client.get('/api/admin/metrics')).status, 403);

    // The scan.
    assert.ok(h.lines.length >= seen.length, `at least one line per response (${h.lines.length} lines, ${seen.length} responses)`);
    assert.deepEqual(scanLogLines(nonEmptyLines(h.lines.join(''))), []);
  });

  test('NFR6: every response header X-Request-Id appears on exactly one http.request line with the same status and a route template, never the raw path', () => {
    assert.ok(seen.length > 30, `the previous test drove the server (${seen.length} responses)`);
    const entries = h.lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'http.request');
    for (const call of seen) {
      const matches = entries.filter((e) => e.requestId === call.requestId);
      assert.equal(matches.length, 1, `${call.method} ${call.path}: ${matches.length} http.request lines for ${call.requestId}`);
      assert.equal(matches[0].status, call.status, `${call.method} ${call.path}: status on the line`);
      assert.equal(matches[0].method, call.method);
      assert.equal(String(matches[0].route).includes(CANARY.payerEmail), false);
      assert.ok(matches[0].route === 'unmatched' || matches[0].route.startsWith('/'), `route "${matches[0].route}"`);
      if (matches[0].route !== 'unmatched') assert.doesNotMatch(matches[0].route, /\/\d+(\/|$)/, 'a route template, not a path with a record id');
    }
  });

  test('NFR6: no log line carries the buyer text, the photo, the display name or a field of the extraction', () => {
    const all = h.lines.join('');
    assert.equal(all.includes('cups and 200 lids'), false);
    assert.equal(all.includes('rawText'), false);
    assert.equal(all.includes('originalWording'), false);
    assert.equal(all.includes('Zoltan'), false);
    assert.equal(all.includes('canarypayer'), false);
  });
});

// ---- a real server process: stdout lines and stderr ---------------------------------------------------------------------------

describe('NFR6, RS-29: the log of a separate server process (stdout) holds requestId and no secret', () => {
  let server;
  before(async () => {
    server = await startServer({ seed: true, env: { ...SECRET_ENV, RS_TEST_HOOKS: undefined } });
  });
  after(() => server.cleanup());

  test('NFR6: startup lines, requests with canary headers and bodies, a failed sign-in and a 404 leave only scanned lines, and stderr holds no canary', async () => {
    const client = createClient((options) => server.request({ ...options, headers: { Authorization: CANARY.authorization, 'X-Access-Token': CANARY.accessToken, ...(options.headers ?? {}) } }));
    await client.register({ username: uniqueUsername('proc'), password: CANARY.customerPassword, displayName: CANARY.payerName });
    const created = await client.post('/api/requests', { text: `I need 200 cups and 200 lids. ${CANARY.payerEmail} ${CANARY.buyerText}` });
    assert.equal(created.status, 201, created.text);
    const extracted = await client.post(`/api/requests/${created.json.request.id}/extract`, {});
    assert.equal(extracted.status, 200, extracted.text);
    assert.equal((await server.request({ method: 'GET', path: `/api/${CANARY.accessToken}` })).status, 404);
    const failed = createClient(server.request);
    await failed.send({ path: '/api/auth/csrf' });
    assert.equal((await failed.post('/api/auth/signin', { username: 'cafe1', password: CANARY.customerPassword })).status, 401);
    await client.signOut();
    // Give the process nothing to wait for: stop it so its stdout is complete.
    await server.stop('SIGTERM');
    const lines = nonEmptyLines(server.stdout());
    assert.ok(lines.length >= 8, `lines written: ${lines.length}`);
    assert.ok(lines.some((l) => JSON.parse(l).msg === 'listening'), 'the listening line is present');
    assert.deepEqual(scanLogLines(lines), []);
    for (const canary of CANARY_VALUES) for (const form of forms(canary)) assert.equal(server.stderr().includes(form), false, `stderr contains ${canary.slice(0, 12)}...`);
  });
});

// ---- the logger itself and the scan's own controls ----------------------------------------------------------------------------

describe('NFR6: the logger allow-list and the scan itself', () => {
  test('NFR6: the logger drops every key outside its allow-list and truncates long values, so a secret passed to it never reaches the sink', () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l), clock: fixedClock(Date.UTC(2026, 9, 20)) });
    log.child('req-12345678').info('probe', {
      authorization: CANARY.authorization, accessToken: CANARY.accessToken, clientSecret: CANARY.clientSecret, payerEmail: CANARY.payerEmail,
      body: { text: CANARY.providerBody }, headers: { Authorization: CANARY.authorization }, text: CANARY.buyerText, route: '/api/requests/:id', status: 200,
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(scanLogLines(nonEmptyLines(lines.join(''))), []);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.requestId, 'req-12345678');
    assert.deepEqual(Object.keys(entry).sort(), ['level', 'msg', 'requestId', 'route', 'status', 'ts']);
  });

  test('NFR6: a line without requestId, with a foreign key, or holding any form of a canary is reported (the scan is not vacuous)', () => {
    const ok = JSON.stringify({ ts: 't', level: 'info', msg: 'm', requestId: 'req-12345678', status: 200 });
    assert.deepEqual(scanLogLines([ok]), []);
    assert.notDeepEqual(scanLogLines([JSON.stringify({ ts: 't', level: 'info', msg: 'm' })]), [], 'no requestId');
    assert.notDeepEqual(scanLogLines([JSON.stringify({ ts: 't', level: 'info', msg: 'm', requestId: 'bad id!' })]), [], 'invalid requestId');
    assert.notDeepEqual(scanLogLines([JSON.stringify({ ts: 't', level: 'info', msg: 'm', requestId: 'req-12345678', authorization: 'x' })]), [], 'foreign key');
    assert.notDeepEqual(scanLogLines(['not json']), []);
    for (const canary of CANARY_VALUES) {
      for (const form of forms(canary)) {
        const line = JSON.stringify({ ts: 't', level: 'info', msg: form, requestId: 'req-12345678' });
        assert.notDeepEqual(scanLogLines([line]), [], `a line holding ${form.slice(0, 20)} is reported`);
      }
    }
  });
});
