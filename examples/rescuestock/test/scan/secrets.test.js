// Log part of the secrets scan (NFR6, RS-29, spec Observability and threat T21): every log line of the server runs in this
// suite carries a requestId and holds no Authorization header value, access token, client secret, password, payer e-mail
// or name, session or CSRF token, buyer text or provider body. The logger drops every key outside an allow-list, so the
// scan drives real flows (sign-up, sign-in, request, photo upload, extraction through the fake and through the real CLI and
// Anthropic adapters against stubs, degraded paths, refusals, malformed input, admin) with canary values placed in every
// channel a secret could leak through, then checks the lines that the server wrote.
// Phase G (g3) extends this file to built assets, recorded responses, screenshots and submission files (RS-29): see the describe blocks from "RS-29: built assets" down.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  ['Anthropic-style API key', /sk-[A-Za-z0-9_-]{10,}/],
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
