'use strict';
// Unit tests for src/config.js (spec C6.1, DES-1, DES-6; Security T11/T12).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadConfig, ConfigError } = require('../../src/config.js');

// BASE_URL_CASES copied verbatim from .eccode/artifacts/design/design-vectors.js (DES-1).
// `null` = rejected; a string = accepted, canonicalised to that value.
const BASE_URL_CASES = [
  ['https://api.anthropic.com', 'https://api.anthropic.com'],
  ['https://api.anthropic.com/', 'https://api.anthropic.com'],
  ['https://gateway.example/anthropic/', 'https://gateway.example/anthropic'],
  ['http://127.0.0.1:9', 'http://127.0.0.1:9'],
  ['http://localhost:8080', 'http://localhost:8080'],
  ['http://[::1]:9', 'http://[::1]:9'],
  ['HTTP://LOCALHOST:9/', 'http://localhost:9'],
  ['http://remote.example', null],       // cleartext to a non-loopback host
  ['http://127.0.0.2:9', null],
  ['http://localhost.evil.example', null],
  ['https://u:p@x.example', null],       // userinfo
  ['https://u@x.example', null],
  ['https://x.example/?q', null],        // query
  ['https://x.example/?', null],         // empty query
  ['https://x.example/#f', null],        // fragment
  ['ftp://x.example', null],
  ['file:///etc/passwd', null],
  ['not a url', null],
  ['', null],
];

const VECTORS_FILE = path.join(__dirname, '..', '..', '.eccode', 'artifacts', 'design', 'design-vectors.js');

/** Asserts fn throws a ConfigError whose message names `variable` and does not contain `value`. */
function assertConfigError(fn, variable, value) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected a ConfigError naming ${variable}`);
  assert.ok(caught instanceof ConfigError, `expected ConfigError, got ${caught && caught.name}`);
  assert.ok(caught instanceof Error);
  assert.match(caught.message, new RegExp('\\b' + variable + '\\b'), 'message names the variable');
  // Values shorter than 3 characters ('0', '-1') can occur inside any fixed text, so only longer values are
  // checked here; the VALUE-MARKER test below covers every variable with an unambiguous value.
  if (typeof value === 'string' && value.trim().length >= 3) {
    assert.ok(!caught.message.includes(value), 'message must not echo the value');
    assert.ok(!caught.message.includes(value.trim()), 'message must not echo the trimmed value');
  }
  return caught;
}

test('defaults with an empty env', () => {
  const c = loadConfig({});
  assert.deepEqual({ ...c, warnings: [...c.warnings] }, {
    host: '127.0.0.1',
    port: 3000,
    allowRemote: false,
    apiKey: null,
    model: 'claude-haiku-5-5',
    baseUrl: 'https://api.anthropic.com',
    baseUrlCustom: false,
    timeoutMs: 20000,
    maxTokens: 2048,
    warnings: [],
  });
});

test('reads only the C6.1 variables (no other key is accessed)', () => {
  const read = new Set();
  const env = new Proxy({ HOME: '/x', PATH: '/bin', ANTHROPIC_BASE_URL: 'http://evil.example' }, {
    get(target, key) { read.add(key); return target[key]; },
    has(target, key) { read.add(key); return key in target; },
    ownKeys(target) { read.add('<ownKeys>'); return Reflect.ownKeys(target); },
  });
  loadConfig(env);
  const allowed = new Set(['HOST', 'TRIAGE_ALLOW_REMOTE', 'PORT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'TRIAGE_ANTHROPIC_BASE_URL', 'TRIAGE_TIMEOUT_MS', 'TRIAGE_MAX_TOKENS']);
  for (const k of read) assert.ok(allowed.has(k), `loadConfig accessed ${String(k)}`);
});

test('unrelated variables have no effect', () => {
  const base = loadConfig({});
  const noisy = loadConfig({ HOME: '/root', NODE_ENV: 'production', ANTHROPIC_AUTH_TOKEN: 'x', BASE_URL: 'http://x' });
  assert.deepEqual(noisy, base);
});

test('DES-1: ANTHROPIC_BASE_URL alone is ignored', () => {
  const c = loadConfig({ ANTHROPIC_BASE_URL: 'http://evil.example' });
  assert.equal(c.baseUrl, 'https://api.anthropic.com');
  assert.equal(c.baseUrlCustom, false);
  assert.deepEqual([...c.warnings], []);
});

test('DES-1: the copied BASE_URL_CASES table matches design-vectors.js exactly', () => {
  const src = fs.readFileSync(VECTORS_FILE, 'utf8');
  const start = src.indexOf('const BASE_URL_CASES = [');
  assert.ok(start >= 0, 'BASE_URL_CASES found in design-vectors.js');
  const end = src.indexOf('\n];', start);
  const literal = src.slice(start + 'const BASE_URL_CASES = '.length, end + 3);
  const original = vm.runInNewContext('(' + literal.replace(/;$/, '') + ')');
  assert.deepEqual(JSON.parse(JSON.stringify(original)), BASE_URL_CASES);
});

for (const [input, expected] of BASE_URL_CASES) {
  test(`DES-1: TRIAGE_ANTHROPIC_BASE_URL ${JSON.stringify(input)} → ${expected === null ? 'reject' : expected}`, () => {
    if (input === '') {
      // Empty after trim means "not set": default URL, not custom, no error (C6.1).
      const c = loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: input });
      assert.equal(c.baseUrl, 'https://api.anthropic.com');
      assert.equal(c.baseUrlCustom, false);
      return;
    }
    if (expected === null) {
      assertConfigError(() => loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: input }), 'TRIAGE_ANTHROPIC_BASE_URL', input);
    } else {
      const c = loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: input });
      assert.equal(c.baseUrl, expected);
      assert.equal(c.baseUrlCustom, true);
      assert.deepEqual([...c.warnings], ['custom_base_url']);
    }
  });
}

test('DES-1: whitespace-only TRIAGE_ANTHROPIC_BASE_URL counts as unset', () => {
  const c = loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: '   ' });
  assert.equal(c.baseUrl, 'https://api.anthropic.com');
  assert.equal(c.baseUrlCustom, false);
  assert.deepEqual([...c.warnings], []);
});

test('DES-1: a set TRIAGE_ANTHROPIC_BASE_URL equal to the default is still custom', () => {
  const c = loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  assert.equal(c.baseUrlCustom, true);
  assert.deepEqual([...c.warnings], ['custom_base_url']);
});

test('DES-1: rejected base URL with a secret-looking value never echoes it', () => {
  const secret = 'https://user:sk-ant-SECRET-123@proxy.example/';
  const e = assertConfigError(() => loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: secret }), 'TRIAGE_ANTHROPIC_BASE_URL', secret);
  assert.ok(!e.message.includes('sk-ant-SECRET-123'));
  assert.ok(!e.message.includes('proxy.example'));
});

test('DES-6: loopback HOST values need no opt-in', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST', ' localhost ']) {
    const c = loadConfig({ HOST: h });
    assert.equal(c.host, h.trim());
    assert.equal(c.allowRemote, false);
    assert.deepEqual([...c.warnings], []);
  }
});

test('DES-6: HOST=0.0.0.0 without opt-in throws a ConfigError naming HOST', () => {
  const e = assertConfigError(() => loadConfig({ HOST: '0.0.0.0' }), 'HOST', '0.0.0.0');
  assert.equal(e.message, 'HOST is not a loopback address; set TRIAGE_ALLOW_REMOTE=1 to expose the server to the network');
});

test('DES-6: other non-loopback HOST values are refused without opt-in', () => {
  for (const h of ['::', '192.168.1.10', '10.0.0.5', 'myhost.local', '[::1]']) {
    assertConfigError(() => loadConfig({ HOST: h }), 'HOST', h);
    assertConfigError(() => loadConfig({ HOST: h, TRIAGE_ALLOW_REMOTE: '0' }), 'HOST', h);
    assertConfigError(() => loadConfig({ HOST: h, TRIAGE_ALLOW_REMOTE: '' }), 'HOST', h);
  }
});

test('DES-6: TRIAGE_ALLOW_REMOTE=1 loads a non-loopback HOST with the non_loopback_host warning', () => {
  const c = loadConfig({ HOST: '0.0.0.0', TRIAGE_ALLOW_REMOTE: '1' });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.allowRemote, true);
  assert.deepEqual([...c.warnings], ['non_loopback_host']);
});

test('DES-6: TRIAGE_ALLOW_REMOTE=1 with a loopback HOST adds no warning', () => {
  const c = loadConfig({ TRIAGE_ALLOW_REMOTE: '1' });
  assert.equal(c.allowRemote, true);
  assert.deepEqual([...c.warnings], []);
});

test('DES-6: warnings keep table order when both apply', () => {
  const c = loadConfig({ HOST: '0.0.0.0', TRIAGE_ALLOW_REMOTE: '1', TRIAGE_ANTHROPIC_BASE_URL: 'https://gw.example' });
  assert.deepEqual([...c.warnings], ['non_loopback_host', 'custom_base_url']);
});

test('TRIAGE_ALLOW_REMOTE values other than unset, "", "0", "1" throw', () => {
  for (const v of ['yes', 'true', 'TRUE', '2', ' 1', 'on']) {
    assertConfigError(() => loadConfig({ TRIAGE_ALLOW_REMOTE: v }), 'TRIAGE_ALLOW_REMOTE', v);
  }
  assert.equal(loadConfig({ TRIAGE_ALLOW_REMOTE: '' }).allowRemote, false);
  assert.equal(loadConfig({ TRIAGE_ALLOW_REMOTE: '0' }).allowRemote, false);
  assert.equal(loadConfig({ TRIAGE_ALLOW_REMOTE: '1' }).allowRemote, true);
});

test('HOST empty after trim throws', () => {
  assertConfigError(() => loadConfig({ HOST: '' }), 'HOST');
  assertConfigError(() => loadConfig({ HOST: '   ' }), 'HOST');
});

test('PORT: integer 0–65535', () => {
  assert.equal(loadConfig({ PORT: '0' }).port, 0);
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ PORT: '65535' }).port, 65535);
  for (const v of ['65536', '-1', '3000.5', 'abc', '', '1e3', '0x10', '99999999999']) {
    assertConfigError(() => loadConfig({ PORT: v }), 'PORT', v);
  }
});

test('ANTHROPIC_API_KEY: trimmed, empty means null', () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: '' }).apiKey, null);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: '   ' }).apiKey, null);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: '  test-key-FAKE \n' }).apiKey, 'test-key-FAKE');
});

test('ANTHROPIC_MODEL: pattern /^[A-Za-z0-9._:-]{1,100}$/', () => {
  assert.equal(loadConfig({ ANTHROPIC_MODEL: 'claude-opus-5-5' }).model, 'claude-opus-5-5');
  assert.equal(loadConfig({ ANTHROPIC_MODEL: 'a'.repeat(100) }).model, 'a'.repeat(100));
  assert.equal(loadConfig({ ANTHROPIC_MODEL: 'vendor.model:v1_2' }).model, 'vendor.model:v1_2');
  for (const v of ['', 'a'.repeat(101), 'model with space', 'model/../x', 'm\nx', 'modèle']) {
    assertConfigError(() => loadConfig({ ANTHROPIC_MODEL: v }), 'ANTHROPIC_MODEL', v);
  }
});

test('TRIAGE_TIMEOUT_MS: integer 100–120000', () => {
  assert.equal(loadConfig({ TRIAGE_TIMEOUT_MS: '100' }).timeoutMs, 100);
  assert.equal(loadConfig({ TRIAGE_TIMEOUT_MS: '300' }).timeoutMs, 300);
  assert.equal(loadConfig({ TRIAGE_TIMEOUT_MS: '120000' }).timeoutMs, 120000);
  for (const v of ['99', '120001', '0', 'x', '', '250.5']) {
    assertConfigError(() => loadConfig({ TRIAGE_TIMEOUT_MS: v }), 'TRIAGE_TIMEOUT_MS', v);
  }
});

test('TRIAGE_MAX_TOKENS: integer 256–16000', () => {
  assert.equal(loadConfig({ TRIAGE_MAX_TOKENS: '256' }).maxTokens, 256);
  assert.equal(loadConfig({ TRIAGE_MAX_TOKENS: '16000' }).maxTokens, 16000);
  for (const v of ['255', '16001', 'lots', '']) {
    assertConfigError(() => loadConfig({ TRIAGE_MAX_TOKENS: v }), 'TRIAGE_MAX_TOKENS', v);
  }
});

test('ConfigError is an Error subclass with name ConfigError', () => {
  const e = new ConfigError('PORT is invalid');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ConfigError');
  assert.equal(e.message, 'PORT is invalid');
});

test('ConfigError messages never contain the value (all variables)', () => {
  const marker = 'VALUE-MARKER-91x';
  const cases = [
    ['HOST', { HOST: marker }],
    ['TRIAGE_ALLOW_REMOTE', { TRIAGE_ALLOW_REMOTE: marker }],
    ['PORT', { PORT: marker }],
    ['ANTHROPIC_MODEL', { ANTHROPIC_MODEL: marker + ' x' }],
    ['TRIAGE_ANTHROPIC_BASE_URL', { TRIAGE_ANTHROPIC_BASE_URL: 'http://' + marker + '.example' }],
    ['TRIAGE_TIMEOUT_MS', { TRIAGE_TIMEOUT_MS: marker }],
    ['TRIAGE_MAX_TOKENS', { TRIAGE_MAX_TOKENS: marker }],
  ];
  for (const [variable, env] of cases) {
    const e = assertConfigError(() => loadConfig(env), variable);
    assert.ok(!e.message.includes(marker), `${variable} message echoes the value`);
    assert.ok(!e.message.toLowerCase().includes(marker.toLowerCase()));
  }
});

test('loadConfig does not mutate env and is deterministic', () => {
  const env = { PORT: '0', ANTHROPIC_API_KEY: ' k ', TRIAGE_ANTHROPIC_BASE_URL: 'https://gw.example/' };
  const copy = { ...env };
  const a = loadConfig(env);
  const b = loadConfig(env);
  assert.deepEqual(env, copy);
  assert.deepEqual(a, b);
});

test('the full C6.5 test env from the spec loads', () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: 'test-key-FAKE', PORT: '0', TRIAGE_TIMEOUT_MS: '300' });
  assert.equal(c.apiKey, 'test-key-FAKE');
  assert.equal(c.port, 0);
  assert.equal(c.timeoutMs, 300);
});
