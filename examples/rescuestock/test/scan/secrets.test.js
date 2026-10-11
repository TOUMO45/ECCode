// Log part of the secrets scan (NFR6, RS-29, spec Observability and threat T21): every log line of the server runs in this
// suite carries a requestId and holds no Authorization header value, access token, client secret, password, payer e-mail
// or name, session or CSRF token, buyer text or provider body. The logger drops every key outside an allow-list, so the
// scan drives real flows (sign-up, sign-in, request, photo upload, extraction through the fake and through the real CLI and
// Anthropic adapters against stubs, degraded paths, refusals, malformed input, admin) with canary values placed in every
// channel a secret could leak through, then checks the lines that the server wrote.
// Phase G (g3) extends this file to built assets, recorded responses, screenshots and submission files (RS-29): see the describe blocks from "RS-29: built assets" down.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { ConfigError, loadConfig } from '../../src/config.js';
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

// ======================================================================================================================
// RS-29 (phase G): the same canaries, searched for in everything else the project ships or records.
//   built assets (public/), recorded API responses (the contract examples and live answers of a server holding the canaries),
//   screenshots (file names and the text chunks of each PNG), the submission files and the README, and the redaction of
//   configuration errors. A secret-SHAPED value (not only a canary) fails too: bearer tokens, API keys, PayPal-style access
//   tokens, credentials assigned to a name, long token-like strings, e-mail addresses and URLs with credentials.
// ======================================================================================================================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Shapes of secrets. TOKEN_SHAPED needs 32+ characters of one token with a lower case letter and a digit or upper case letter.
const SECRET_SHAPES = Object.freeze([
  ['bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{8,}/],
  ['basic-auth value', /Basic\s+[A-Za-z0-9+/]{12,}={0,2}/],
  ['Anthropic-style API key', /\bsk-[A-Za-z0-9_-]{10,}/],
  ['PayPal-style access token', /\bA21AA[A-Za-z0-9_-]{16,}/],
  ['credential assigned a value', /\b(client_secret|api[_-]?key|webhook[_-]?id)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i],
  ['URL with credentials', /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
]);
const TOKEN_SHAPED = /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{32,}\b/;

/** scanText(name, text) -> problems[]: a canary in any form, or a secret shape. */
export function scanText(name, text, { shapes = SECRET_SHAPES, tokenShaped = true } = {}) {
  const problems = [];
  for (const canary of CANARY_VALUES) {
    for (const form of forms(canary)) if (text.includes(form)) problems.push(`${name}: holds the canary ${canary.slice(0, 18)}…`);
  }
  for (const [label, pattern] of shapes) {
    const m = pattern.exec(text);
    if (m) problems.push(`${name}: ${label} (${m[0].slice(0, 24)}…)`);
  }
  if (tokenShaped) {
    const m = TOKEN_SHAPED.exec(text);
    if (m) problems.push(`${name}: long token-shaped value (${m[0].slice(0, 24)}…)`);
  }
  return [...new Set(problems)];
}

function filesUnder(dir, keep = () => true) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}
const rel = (path) => relative(ROOT, path).split('\\').join('/');

describe('RS-29: the scan itself is not vacuous', () => {
  test('RS-29: every canary form and every secret shape is reported; ordinary text is not', () => {
    for (const canary of CANARY_VALUES) for (const form of forms(canary)) assert.notDeepEqual(scanText('x', `before ${form} after`), [], form.slice(0, 20));
    const planted = {
      'bearer token': 'Authorization: Bearer abcdefghijklmnop',
      'Anthropic-style API key': 'key sk-ant-abcdefghijklmno',
      'PayPal-style access token': 'token A21AAabcdefghijklmnopqrstu',
      'credential assigned a value': 'client_secret = "abcdefghijkl1234"',
      'URL with credentials': 'https://user:pass1234@example.test/x',
      'e-mail address': 'write to someone@example.test',
      'private key': '-----BEGIN RSA PRIVATE KEY-----',
    };
    for (const [label, text] of Object.entries(planted)) assert.ok(scanText('x', text, { tokenShaped: false }).some((p) => p.includes(label)), label);
    assert.ok(scanText('x', 'abcdef0123456789abcdef0123456789ab').some((p) => p.includes('token-shaped')));
    assert.deepEqual(scanText('x', 'Supplier A refused the order: Out of lids. No money was taken. Set RS_PAYPAL_DEFAULT_CLIENT_SECRET in your shell.'), []);
  });
});

describe('RS-29: built assets (public/)', () => {
  test('RS-29: no file under public/ holds a canary, a client id, a secret or a secret-shaped value, and no asset reads a credential from the environment', () => {
    const files = filesUnder(join(ROOT, 'public'));
    assert.ok(files.length >= 20, `the scan saw ${files.length} files under public/`);
    const problems = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      problems.push(...scanText(rel(file), text));
      assert.doesNotMatch(text, /RS_PAYPAL_[A-Z_]*(CLIENT_SECRET|CLIENT_ID|WEBHOOK_ID)|ANTHROPIC_API_KEY|RS_ADMIN_PASSWORD|process\.env/, `${rel(file)} names a credential variable or reads the environment`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('RS-29: recorded API responses', () => {
  test('RS-29: the recorded example responses (test/fixtures, including the subdirectories) hold no canary and no secret shape', () => {
    const files = filesUnder(join(ROOT, 'test', 'fixtures'), (p) => p.endsWith('.json'));
    assert.ok(files.length >= 60, `the scan saw ${files.length} recorded responses`);
    const problems = [];
    for (const file of files) problems.push(...scanText(rel(file), readFileSync(file, 'utf8'), { tokenShaped: false }));
    assert.deepEqual(problems, []);
  });

  test('RS-29: the answers of a server that holds the canaries (config, session, requests, admin views, errors) never echo a configured secret or a canary sent in a header, a body or a path', async () => {
    const h = await startHarness({ seed: true, env: SECRET_ENV });
    try {
      await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
      const recorded = [];
      const call = async (client, options) => {
        const res = await client.send({ ...options, headers: { Authorization: CANARY.authorization, 'X-Access-Token': CANARY.accessToken, ...(options.headers ?? {}) } });
        recorded.push({ name: `${options.method ?? 'GET'} ${options.path} -> ${res.status}`, text: `${JSON.stringify(res.headers)}\n${res.text}` });
        return res;
      };
      const anonymous = createClient(h.request);
      await call(anonymous, { path: '/api/health' });
      await call(anonymous, { path: '/api/config' });
      await call(anonymous, { path: '/api/auth/csrf' });
      await call(anonymous, { path: '/api/auth/session' });
      await call(anonymous, { path: `/api/requests/${CANARY.buyerText}` });
      await call(anonymous, { method: 'POST', path: '/api/auth/signin', jsonBody: { username: CANARY.payerEmail, password: CANARY.customerPassword } });
      await call(anonymous, { method: 'POST', path: '/api/webhooks/paypal/A', jsonBody: { note: CANARY.providerBody, secret: CANARY.clientSecret } });
      const customer = createClient(h.request);
      await customer.register({ username: uniqueUsername('rec'), password: CANARY.customerPassword, displayName: CANARY.payerName });
      const created = await call(customer, { method: 'POST', path: '/api/requests', jsonBody: { text: `I need cups. ${CANARY.buyerText}` } });
      await call(customer, { path: '/api/requests' });
      await call(customer, { path: `/api/requests/${created.json.request.id}` });
      await call(customer, { path: '/api/admin/metrics' }); // 403 for a customer
      const admin = createClient(h.request);
      await admin.signIn('admin', CANARY.adminPassword);
      for (const path of ['/api/admin/metrics', '/api/admin/timeline', '/api/config']) await call(admin, { path });
      await call(admin, { method: 'POST', path: '/api/admin/faults', jsonBody: { kind: 'fake_paypal', fault: CANARY.apiKey } });
      assert.ok(recorded.length >= 15, `${recorded.length} responses recorded`);
      const problems = [];
      for (const r of recorded) {
        // The configured secrets and the credentials the test sent must never come back, in any form.
        for (const secret of [CANARY.adminPassword, CANARY.webhookSecret, CANARY.clientId, CANARY.clientSecret, CANARY.accessToken, CANARY.authorization, CANARY.apiKey, CANARY.customerPassword]) {
          for (const form of forms(secret)) if (r.text.includes(form)) problems.push(`${r.name}: echoes ${secret.slice(0, 14)}…`);
        }
        // And no secret shape appears (the session cookie header is a random id, not a secret shape under test).
        problems.push(...scanText(r.name, r.text.replace(/"set-cookie":\[[^\]]*\]/g, ''), { tokenShaped: false, shapes: SECRET_SHAPES.filter(([label]) => label !== 'e-mail address') }).filter((p) => !p.includes('canary-buyer') && !p.includes('canary-payer')));
      }
      assert.deepEqual(problems, []);
    } finally {
      await h.close();
    }
  });
});

// A PNG is a signature plus chunks: length (4), type (4), data, CRC (4). Text lives in tEXt (keyword NUL text), zTXt (keyword NUL method
// compressed) and iTXt (keyword NUL flags method language NUL translated NUL text, possibly compressed).
export function pngTextChunks(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG signature');
  const out = [];
  let i = 8;
  while (i + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.subarray(i + 4, i + 8).toString('latin1');
    const data = buffer.subarray(i + 8, i + 8 + length);
    if (type === 'tEXt') out.push(data.toString('latin1'));
    else if (type === 'zTXt') {
      const nul = data.indexOf(0);
      out.push(`${data.subarray(0, nul).toString('latin1')}\0${inflateSync(data.subarray(nul + 2)).toString('latin1')}`);
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      const compressed = data[nul + 1] === 1;
      let p = nul + 3;
      p = data.indexOf(0, p) + 1; // language
      p = data.indexOf(0, p) + 1; // translated keyword
      const body = data.subarray(p);
      out.push(`${data.subarray(0, nul).toString('utf8')}\0${(compressed ? inflateSync(body) : body).toString('utf8')}`);
    }
    i += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

const SCREENSHOT_DIR = join(ROOT, 'test', 'browser', 'out');

describe('RS-29: screenshots (file names and the text of each PNG)', () => {
  test('RS-29: the PNG reader finds text chunks (tEXt, zTXt, iTXt) and the scan reports a canary in each', async () => {
    const { deflateSync } = await import('node:zlib');
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('tEXt', Buffer.from(`Comment\0${CANARY.clientSecret}`, 'latin1')),
      chunk('zTXt', Buffer.concat([Buffer.from('Note\0\0', 'latin1'), deflateSync(Buffer.from(CANARY.accessToken))])),
      chunk('iTXt', Buffer.concat([Buffer.from('Title\0\0\0\0\0', 'latin1'), Buffer.from(CANARY.apiKey)])),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const text = pngTextChunks(png);
    assert.equal(text.length, 3);
    for (const entry of text) assert.notDeepEqual(scanText('planted.png', entry, { tokenShaped: false }), [], entry.slice(0, 20));
    assert.deepEqual(pngTextChunks(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IEND', Buffer.alloc(0))])), []);
  });

  test('RS-29: every screenshot under test/browser/out is a PNG with a plain file name and no text chunk that holds a canary or a secret shape (skipped when no browser run has produced any)', (t) => {
    const files = filesUnder(SCREENSHOT_DIR, (p) => p.endsWith('.png'));
    if (files.length === 0) {
      t.skip('test/browser/out holds no screenshot yet: they are written by `npm run test:browser`; the run after it scans them');
      return;
    }
    const problems = [];
    for (const file of files) {
      const name = file.slice(file.lastIndexOf('/') + 1);
      if (!/^[a-z0-9][a-z0-9-]*-(360|1280)\.png$/.test(name)) problems.push(`${name}: not a <test>-<width>.png name`);
      problems.push(...scanText(`file name ${name}`, name, { tokenShaped: false }));
      problems.push(...scanText(name, pngTextChunks(readFileSync(file)).join('\n'), { tokenShaped: false }));
    }
    assert.deepEqual(problems, []);
  });
});

describe('RS-29: README, runbooks and submission files', () => {
  test('RS-29: README.md, docs/ and .env.example hold no canary, client id, secret or secret shape', () => {
    const files = [join(ROOT, 'README.md'), join(ROOT, '.env.example'), ...filesUnder(join(ROOT, 'docs'), (p) => p.endsWith('.md'))].filter((p) => existsSync(p));
    assert.ok(files.length >= 8, `the scan saw ${files.length} files`);
    assert.ok(files.some((f) => rel(f).startsWith('docs/submission/')), 'the submission files are among them');
    const problems = [];
    for (const file of files) problems.push(...scanText(rel(file), readFileSync(file, 'utf8')));
    assert.deepEqual(problems, []);
  });
});

// ======================================================================================================================
// RS-29, whole project (rework-8, SEC-G-1): EVERY file the repository ships or records is read, not only public/, the recorded
// responses, the markdown documents and the screenshots. That is every git-tracked or untracked-unignored file (git ls-files -co
// --exclude-standard; without git, as in a clean checkout, a walk of the directory without node_modules, .git, data/, reports/,
// test/.out and .env files) PLUS the screenshots of test/browser/out. It includes the project record `.eccode/` (artifacts, drafts,
// handoffs, reviews and the run logs in `.eccode/evidence`, where the output of a live run would be recorded), src/, scripts/,
// package.json and the lockfile, every document of any type, and every PNG: all chunks except pixel data (text, EXIF, ICC, private
// chunks, compressed or not) and any bytes after IEND.
//
// What is looked for, in every file:
//   - each canary of this suite, in any form (exempt: the file that DEFINES them);
//   - the high-confidence shapes of a credential: bearer token, basic-auth value, API key (sk-), PayPal access token, a credential
//     assigned to a name, a URL with a password, a private key, a JWT, and a long mixed-case token (60+ characters, at most three
//     hyphens: a credential, not a slug or a hash). The e-mail and 32-character token-shape rules of the narrower scans stay with
//     them: over a whole record they match hashes, slugs and addresses of reviewers, which are not secrets.
// Exceptions are listed below by PATH AND VALUE: a test source or a record that holds a fake credential on purpose, with the exact
// fragment and the reason. A file listed for one fragment is still checked for every other one, and an entry that no longer matches
// anything fails as stale. Evidence logs need no entry: they hold canary NAMES (test titles), never canary values.
// ======================================================================================================================

// Files that DEFINE a canary value (the one place the value may appear), by path.
const CANARY_HOLDERS = Object.freeze({
  'test/scan/secrets.test.js': 'defines the canary values of this scan',
  'test/helpers/provider-stubs.js': 'defines PROVIDER_BODY_MARKER, the canary for a provider body',
});
// Files that hold one sample of every secret shape on purpose, to prove the scan sees each one (the shape check skips them).
const SHAPE_SAMPLE_FILES = Object.freeze({
  'test/scan/secrets.test.js': 'plants one sample of each shape, with the fake values of the config-redaction cases',
});

const SHAPE_EXCUSES = Object.freeze([
  { path: 'test/api/extract-degraded.test.js', has: 'sk-live-should-not-leak', reason: 'a fake key the test sends to prove it is never echoed' },
  { path: 'test/unit/http/app.test.js', has: 'sk-live-should-not-leak', reason: 'a fake key the test sends to prove it is never echoed' },
  { path: 'test/api/health-config.test.js', has: 'sk-ant-test-SENTINEL', reason: 'a fake API key sentinel: /api/health must not show it' },
  { path: 'test/unit/config/secrets.test.js', has: 'sk-ant-test-key-value', reason: 'a fake API key: the configuration must not repeat it' },
  { path: 'test/api/webhooks.test.js', has: 'user:pw@', reason: 'a fake URL password the webhook host check must refuse' },
  { path: 'test/unit/config/hosts.test.js', has: 'user:pw@', reason: 'a fake URL password the host check must refuse' },
  { path: 'test/unit/config/hosts.test.js', has: 'u:p@', reason: 'a fake URL password the host check must refuse' },
  { path: 'test/unit/payments/fake.test.js', has: 'user:pw@', reason: 'a fake URL password the adapter must refuse' },
  { path: 'test/unit/payments/sandbox.test.js', has: 'user:pw@', reason: 'a fake URL password the adapter must refuse' },
  { path: 'test/unit/payments/sandbox.test.js', has: 'webhook-id-LEAK', reason: 'a fake webhook id the adapter must not leak' },
  { path: 'test/unit/payments/sandbox.test.js', has: 'attacker-webhook', reason: 'a fake attacker webhook id in a forged event' },
  { path: 'test/unit/payments/paypal-stub.test.js', has: 'DEFAULT_MERCHANT', reason: 'the name of a stub merchant, not a credential' },
  { path: 'test/helpers/paypal-stub.js', has: 'WH-STUB-DEFAULT', reason: 'the stub default webhook id (loopback stub)' },
  { path: '.eccode/drafts/sec-phb-config-db.mjs', has: 'LOGSECRET', reason: 'a phase B security probe: fake values it plants to see whether they leak' },
  { path: '.eccode/drafts/sec-phb-config-db.mjs', has: 'sk-live-REALSECRET', reason: 'a phase B security probe: fake values it plants to see whether they leak' },
  { path: '.eccode/drafts/sec-phb-config-db.mjs', has: 'user:pw@', reason: 'a phase B security probe: fake values it plants to see whether they leak' },
  { path: '.eccode/reviews/drafts/phase-g-security-1.md', has: 'sk-live-REALSECRET', reason: 'the review names that probe value as fake' },
  { path: '.eccode/events.jsonl', has: 'WH-STUB-DEFAULT', reason: 'the record quotes the stub default webhook id' },
  { path: '.eccode/events.jsonl', has: 'sk-tests-evidence', reason: 'the record quotes a scan result about a slug that begins sk-' },
  { path: '.eccode/events.jsonl', has: 'sk-overview-owner', reason: 'the record quotes a scan result about a slug that begins sk-' },
  { path: '.eccode/events.jsonl', has: 'sk-live-should-not-leak', reason: 'the record quotes a scan result naming a test placeholder' },
  { path: '.eccode/events.jsonl', has: 'DEFAULT_MERCHANT', reason: 'the record quotes a scan result naming a stub merchant' },
  { path: '.eccode/events.jsonl', has: 'webhook-id-LEAK', reason: 'the record quotes a scan result naming a test placeholder' },
  { path: '.eccode/state.json', has: 'DEFAULT_MERCHANT', reason: 'the record quotes a scan result naming a stub merchant' },
  { path: '.eccode/state.json', has: 'webhook-id-LEAK', reason: 'the record quotes a scan result naming a test placeholder' },
  { path: '.eccode/state.json', has: 'WH-STUB-DEFAULT', reason: 'the record quotes the stub default webhook id' },
  { path: '.eccode/state.json', has: 'sk-tests-evidence', reason: 'the record quotes a scan result about a slug that begins sk-' },
  { path: '.eccode/state.json', has: 'sk-overview-owner', reason: 'the record quotes a scan result about a slug that begins sk-' },
  { path: '.eccode/state.json', has: 'sk-live-should-not-leak', reason: 'the record quotes a scan result naming a test placeholder' },
]);

const PROJECT_SHAPES = Object.freeze([
  ...SECRET_SHAPES.filter(([label]) => label !== 'e-mail address'),
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
]);
const LONG_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{60,}(?![A-Za-z0-9_-])/g;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'reports', 'coverage']);

/** A long, mixed-case token with a digit and at most three hyphens (not a slug, not a hash, not a base64 integrity value). */
export function longCredential(text) {
  for (const m of text.replace(/"integrity":\s*"[^"]*"/g, '').matchAll(LONG_RUN)) {
    const s = m[0];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && (s.match(/-/g) ?? []).length <= 3) return s;
  }
  return null;
}

/** Every chunk of a PNG except the pixel data, raw and (where it is compressed) inflated, plus any bytes after IEND. */
export function pngAllChunkText(buffer) {
  const out = [];
  let i = 8;
  while (i + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.subarray(i + 4, i + 8).toString('latin1');
    const data = buffer.subarray(i + 8, Math.min(buffer.length, i + 8 + length));
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      out.push(`${type}\0${data.toString('latin1')}`);
      const nul = data.indexOf(0);
      const starts = new Set([nul + 1, nul + 2]);
      if (type === 'iTXt' && nul >= 0) {
        let p = data.indexOf(0, nul + 3) + 1;
        p = data.indexOf(0, p) + 1;
        starts.add(p);
      }
      for (const start of starts) {
        try {
          out.push(inflateSync(data.subarray(start)).toString('latin1'));
        } catch {
          /* not compressed at this offset */
        }
      }
    }
    i += 12 + length;
    if (type === 'IEND') {
      if (i < buffer.length) out.push(`after IEND\0${buffer.subarray(i).toString('latin1')}`);
      break;
    }
  }
  return out.join('\n');
}

function walkProject(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const relative_ = relative(root, path).split('\\').join('/');
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name) && relative_ !== 'test/.out') visit(path);
      } else if (entry.isFile() && !(/^\.env(\..*)?$/.test(entry.name) && entry.name !== '.env.example')) {
        out.push(relative_);
      }
    }
  };
  visit(root);
  return out;
}

/** The files of the project, relative to root: git's list of tracked and unignored files when root is in a git work tree, else a walk. */
export function listProjectFiles(root, { git = true } = {}) {
  let files = [];
  if (git) {
    try {
      const stdout = execFileSync('git', ['-c', 'core.quotepath=off', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      });
      files = stdout.split('\0').filter(Boolean);
    } catch {
      files = [];
    }
  }
  if (files.length === 0) files = walkProject(root);
  const set = new Set(files);
  const screenshots = join(root, 'test', 'browser', 'out'); // ignored by git, written by the browser suite
  for (const path of filesUnder(screenshots)) set.add(relative(root, path).split('\\').join('/'));
  return [...set].sort();
}

/**
 * scanProject(root, files) -> { problems, scanned, usedHolders, usedExcuses }. Each file is read as bytes; a PNG by its chunks; text as latin1
 * (so a canary is found in any encoding that keeps ASCII intact). A problem names the file and the kind of finding, never more than the first
 * six characters of a shape match.
 */
export function scanProject(root, files = listProjectFiles(root), { holders = CANARY_HOLDERS, sampleFiles = SHAPE_SAMPLE_FILES, excuses = SHAPE_EXCUSES } = {}) {
  const problems = [];
  const usedHolders = new Set();
  const usedExcuses = new Set();
  const usedSamples = new Set();
  let scanned = 0;
  for (const file of files) {
    let buffer;
    try {
      const path = join(root, file);
      if (!statSync(path).isFile()) continue;
      buffer = readFileSync(path);
    } catch {
      continue; // listed by git but deleted from the work tree
    }
    scanned += 1;
    const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    const binary = isPng || buffer.subarray(0, 8000).includes(0);
    const text = isPng ? pngAllChunkText(buffer) : buffer.toString('latin1');
    if (Object.hasOwn(holders, file)) usedHolders.add(file);
    else {
      for (const canary of CANARY_VALUES) {
        for (const form of forms(canary)) if (text.includes(form)) problems.push(`${file}: holds the canary ${canary.slice(0, 18)}…`);
      }
    }
    if (Object.hasOwn(sampleFiles, file)) {
      usedSamples.add(file);
      continue;
    }
    for (const [label, pattern] of PROJECT_SHAPES) {
      for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
        const excuse = excuses.find((e) => e.path === file && m[0].includes(e.has));
        if (excuse) usedExcuses.add(`${excuse.path} :: ${excuse.has}`);
        else problems.push(`${file}: ${label} (${m[0].slice(0, 6)}…)`);
      }
    }
    if (!binary || isPng) {
      const long = longCredential(text);
      if (long) problems.push(`${file}: long mixed-case token (${long.slice(0, 6)}…)`);
    }
  }
  return { problems: [...new Set(problems)], scanned, usedHolders, usedSamples, usedExcuses };
}

describe('RS-29 whole project: the scan is not vacuous (every place a secret could ship)', () => {
  const SECRET = CANARY.clientSecret;
  const dir = mkdtempSync(join(tmpdir(), 'rs-secrets-plant-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const png = async (type, payload) => {
    const { deflateSync } = await import('node:zlib');
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk(type, payload), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  };
  const put = (file, content) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };

  test('RS-29: a canary planted in each of 17 places (source, scripts, package.json, non-markdown documents, the record and its run logs, images of every kind and chunk) is reported with its path, and a clean tree is not', async () => {
    const { deflateSync } = await import('node:zlib');
    put('src/clean.js', 'export const ok = 1;\n');
    put('docs/note.txt', 'nothing here\n');
    assert.deepEqual(scanProject(dir, listProjectFiles(dir, { git: false })).problems, [], 'a clean tree is clean');

    put('README.md', `PLANT-P01 ${SECRET}\n`);
    put('.env.example', `# PLANT-P02 ${SECRET}\n`);
    put('docs/runbooks/plant-p03.md', `PLANT-P03 ${SECRET}\n`);
    put('public/js/plant-p04.js', `// PLANT-P04 ${SECRET}\n`);
    put('test/fixtures/contracts/plant-p05.json', JSON.stringify({ note: SECRET }));
    put('test/browser/out/plant-p06-360.png', await png('tEXt', Buffer.from(`Comment\0${SECRET}`, 'latin1')));
    put('test/browser/out/plant-p07-360.png', await png('eXIf', Buffer.from(`MM\0*${SECRET}`, 'latin1')));
    put('test/browser/out/plant-p08-360.png', await png('prVt', Buffer.from(SECRET, 'latin1')));
    put('docs/submission/plant-p09.txt', `PLANT-P09 ${SECRET}\n`);
    put('docs/plant-p10.png', await png('zTXt', Buffer.concat([Buffer.from('Note\0\0', 'latin1'), deflateSync(Buffer.from(SECRET))])));
    put('src/plant-p11.js', `export const PLANT_P11 = '${SECRET}';\n`);
    put('scripts/plant-p12.sh', `#!/bin/sh\nexport RS_PAYPAL_DEFAULT_CLIENT_SECRET=${SECRET}\n`);
    put('.eccode/artifacts/plant-p13.md', `PLANT-P13 ${SECRET}\n`);
    put('.eccode/evidence/plant-p14.log', `PLANT-P14 ${SECRET}\n`);
    put('test/fixtures/extraction/images/plant-p15.png', await png('tEXt', Buffer.from(`Comment\0${SECRET}`, 'latin1')));
    put('package.json', JSON.stringify({ name: 'x', plantP16: SECRET }));
    put('public/img/plant-p17.png', await png('zTXt', Buffer.concat([Buffer.from('Note\0\0', 'latin1'), deflateSync(Buffer.from(SECRET))])));
    const { problems } = scanProject(dir, listProjectFiles(dir, { git: false }));
    for (const planted of [
      'README.md', '.env.example', 'docs/runbooks/plant-p03.md', 'public/js/plant-p04.js', 'test/fixtures/contracts/plant-p05.json',
      'test/browser/out/plant-p06-360.png', 'test/browser/out/plant-p07-360.png', 'test/browser/out/plant-p08-360.png', 'docs/submission/plant-p09.txt',
      'docs/plant-p10.png', 'src/plant-p11.js', 'scripts/plant-p12.sh', '.eccode/artifacts/plant-p13.md', '.eccode/evidence/plant-p14.log',
      'test/fixtures/extraction/images/plant-p15.png', 'package.json', 'public/img/plant-p17.png',
    ]) {
      assert.ok(problems.some((p) => p.startsWith(`${planted}: holds the canary`)), `${planted} is reported: ${problems.join(' | ')}`);
    }
    assert.equal(problems.length, 17, `exactly the 17 planted files are reported: ${problems.join(' | ')}`);
  });

  test('RS-29: the other secret shapes (bearer, key, JWT, URL password, long mixed-case token) and bytes after IEND are reported in a record or a script; an image tail too', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'rs-secrets-shapes-'));
    try {
      const w = (file, content) => {
        mkdirSync(dirname(join(d2, file)), { recursive: true });
        writeFileSync(join(d2, file), content);
      };
      w('.eccode/evidence/a.log', 'Authorization: Bearer abcdefghijklmnopqrstuvwx\n');
      w('.eccode/evidence/b.log', 'key sk-ant-api03-abcdefghijklmnop\n');
      w('.eccode/evidence/c.log', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig\n');
      w('scripts/d.sh', 'curl https://user:hunter2hunter2@example.test/x\n');
      w('.eccode/evidence/e.log', `token ${'Ab1'.repeat(25)}\n`);
      w('docs/tail.png', Buffer.concat([await png('tEXt', Buffer.from('Comment\0fine', 'latin1')), Buffer.from(`trailing ${SECRET}`)]));
      // values that are NOT secrets: a slug, a hash, a package integrity value
      w('.eccode/reviews/slug.json', `{"id":"${'added-after-phase-g-delivery-lead-notes-about-the-release-gate-of-the-whole-project'}"}`);
      w('.eccode/evidence/hash.log', `tree ${'0123456789abcdef'.repeat(4)}\n`);
      w('package-lock.json', `{"integrity": "sha512-${'AbCd1234'.repeat(10)}"}`);
      const { problems } = scanProject(d2, listProjectFiles(d2, { git: false }));
      for (const [file, kind] of [
        ['.eccode/evidence/a.log', 'bearer token'], ['.eccode/evidence/b.log', 'Anthropic-style API key'], ['.eccode/evidence/c.log', 'JWT'],
        ['scripts/d.sh', 'URL with credentials'], ['.eccode/evidence/e.log', 'long mixed-case token'], ['docs/tail.png', 'holds the canary'],
      ]) assert.ok(problems.some((p) => p.startsWith(`${file}: ${kind}`) || (kind === 'holds the canary' && p.startsWith(`${file}: ${kind}`))), `${file} ${kind}: ${problems.join(' | ')}`);
      assert.equal(problems.length, 6, `slug, hash and integrity value are not reported: ${problems.join(' | ')}`);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });

  test('RS-29: an excuse covers its own path and fragment only: the same fake value elsewhere, and another value in the same file, are reported; a canary holder is excused for canaries only', () => {
    const d3 = mkdtempSync(join(tmpdir(), 'rs-secrets-excuse-'));
    try {
      const w = (file, content) => {
        mkdirSync(dirname(join(d3, file)), { recursive: true });
        writeFileSync(join(d3, file), content);
      };
      w('test/a.test.js', 'const url = "https://user:pw@example.test/";\n');
      w('test/b.test.js', 'const url = "https://user:pw@example.test/";\n');
      w('test/c.test.js', 'const a = "https://user:pw@example.test/"; const b = "https://admin:hunter2x@example.test/";\n');
      w('test/holder.test.js', `const c = "${CANARY.apiKey}"; const k = "sk-ant-api03-abcdefghijklmnop";\n`);
      w('test/other.test.js', `const c = "${CANARY.apiKey}";\n`);
      const excuses = [
        { path: 'test/a.test.js', has: 'user:pw@', reason: 'x' },
        { path: 'test/c.test.js', has: 'user:pw@', reason: 'x' },
      ];
      const result = scanProject(d3, listProjectFiles(d3, { git: false }), { holders: { 'test/holder.test.js': 'x' }, excuses });
      assert.deepEqual(result.problems.sort(), [
        'test/b.test.js: URL with credentials (https:…)',
        'test/c.test.js: URL with credentials (https:…)',
        'test/holder.test.js: Anthropic-style API key (sk-ant…)',
        'test/other.test.js: holds the canary canary-anthropic-a…',
      ].sort());
      assert.deepEqual([...result.usedExcuses].sort(), ['test/a.test.js :: user:pw@', 'test/c.test.js :: user:pw@']);
      assert.deepEqual([...result.usedHolders], ['test/holder.test.js']);
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  });
});

describe('RS-29 whole project: the real tree', () => {
  test('RS-29: every tracked or unignored file (src, scripts, package.json, every document, the project record and its run logs, every image chunk) holds no canary and no secret shape', () => {
    const files = listProjectFiles(ROOT);
    const has = (prefix) => files.some((f) => f === prefix || f.startsWith(prefix));
    assert.ok(files.length >= 300, `the scan lists ${files.length} files`);
    for (const must of ['src/', 'scripts/', 'package.json', 'package-lock.json', 'public/', 'test/fixtures/', 'docs/', 'README.md']) assert.ok(has(must), `${must} is in the scan`);
    for (const ext of ['.sql', '.sh', '.css', '.html', '.txt', '.ndjson', '.svg', '.md', '.json']) assert.ok(files.some((f) => f.endsWith(ext)), `${ext} files (not only .js and .md) are in the scan`);
    assert.ok(files.some((f) => f.endsWith('.png')), 'images are in the scan');
    assert.ok(files.some((f) => f.endsWith('.mjs')) && files.some((f) => f.endsWith('.cjs')), 'module scripts are in the scan');
    if (existsSync(join(ROOT, '.eccode', 'evidence'))) {
      assert.ok(files.some((f) => f.startsWith('.eccode/evidence/') && f.endsWith('.log')), 'the run logs of the project record are in the scan');
      assert.ok(files.some((f) => f.startsWith('.eccode/artifacts/')), 'the artifacts of the project record are in the scan');
    }
    const { problems, scanned, usedHolders, usedSamples, usedExcuses } = scanProject(ROOT, files);
    assert.ok(scanned >= 300, `${scanned} files were read`);
    assert.deepEqual(problems, []);
    // No stale entry: every holder and every excuse whose file exists still matches something.
    for (const path of Object.keys(CANARY_HOLDERS)) assert.ok(usedHolders.has(path), `${path} is listed as a canary holder but was not read`);
    for (const path of Object.keys(SHAPE_SAMPLE_FILES)) assert.ok(usedSamples.has(path), `${path} is listed as a shape-sample file but was not read`);
    const stale = SHAPE_EXCUSES.filter((e) => existsSync(join(ROOT, e.path)) && !usedExcuses.has(`${e.path} :: ${e.has}`));
    assert.deepEqual(stale.map((e) => `${e.path} :: ${e.has}`), [], 'excuses that match nothing any more must be removed');
  });
});

describe('RS-29: configuration errors are redacted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-secrets-config-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { PORT: '0', HOST: '127.0.0.1', RS_DB_PATH: join(dir, 'app.db'), RS_UPLOAD_DIR: join(dir, 'uploads'), RS_MODEL_PROVIDER: 'fake', RS_TEST_OFFLINE: '1' };
  const SHORT = 'canary-0042-xy'; // 14 characters: below the 16 the admin password needs and the 32 bytes the webhook secret needs

  function refused(env) {
    try {
      loadConfig({ ...base, ...env });
    } catch (err) {
      assert.ok(err instanceof ConfigError, `a ConfigError, got ${err}`);
      return err;
    }
    assert.fail('the configuration was accepted');
    return null;
  }

  test('RS-29: an invalid secret (too short, a placeholder, half a credential pair, a URL with a password) is refused by NAME and the message, problems and variables hold no value', () => {
    const cases = [
      { RS_ADMIN_PASSWORD: SHORT },
      { RS_FAKE_WEBHOOK_SECRET: SHORT },
      { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: CANARY.clientId },
      { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_SECRET: CANARY.clientSecret },
      { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: '<changeme-canary>', RS_PAYPAL_DEFAULT_CLIENT_SECRET: CANARY.clientSecret },
      { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: CANARY.clientId, RS_PAYPAL_DEFAULT_CLIENT_SECRET: CANARY.clientSecret, RS_PAYPAL_BASE_URL: `https://user:${CANARY.customerPassword}@api-m.sandbox.paypal.com` },
      { RS_PUBLIC_URL: `http://user:${CANARY.customerPassword}@localhost:1` },
      { ANTHROPIC_API_KEY: CANARY.apiKey, RS_MODEL_PROVIDER: 'nonsense-canary-provider' },
    ];
    for (const env of cases) {
      const err = refused(env);
      const everything = `${err.message}\n${JSON.stringify(err.problems)}\n${err.variables.join(',')}`;
      for (const secret of [SHORT, '<changeme-canary>', ...CANARY_VALUES, 'nonsense-canary-provider']) {
        for (const form of forms(secret)) assert.equal(everything.includes(form), false, `${JSON.stringify(Object.keys(env))}: the refusal repeats ${secret.slice(0, 16)}…`);
      }
      assert.ok(err.variables.length >= 1, 'the refusal names the variable');
      assert.match(err.message, /^Invalid configuration: /);
    }
  });

  test('RS-29: a server process started with such a configuration prints a one-line refusal that names variables only (the failure text holds no value)', async () => {
    let failure = null;
    try {
      const server = await startServer({ env: { RS_ADMIN_PASSWORD: SHORT, RS_FAKE_WEBHOOK_SECRET: CANARY.webhookSecret.slice(0, 12), RS_TEST_HOOKS: undefined } });
      await server.cleanup();
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, 'the server refused to start');
    const text = String(failure.message);
    assert.match(text, /RS_ADMIN_PASSWORD/);
    for (const value of [SHORT, CANARY.webhookSecret.slice(0, 12)]) assert.equal(text.includes(value), false, 'the refusal does not repeat a value');
  });
});
