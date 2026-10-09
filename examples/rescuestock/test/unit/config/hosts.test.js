import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_API, ConfigError, PAYPAL_SANDBOX_API, buildLabels, loadConfig } from '../../../src/config.js';

function refusal(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, 'expected a ConfigError');
    return err;
  }
  assert.fail('expected the configuration to be refused');
}

test('SEC-3: the PayPal base URL defaults to the Sandbox API host', () => {
  const config = loadConfig({});
  assert.equal(config.paypalBaseUrl, PAYPAL_SANDBOX_API);
  assert.equal(config.paypalBaseUrl, 'https://api-m.sandbox.paypal.com');
});

test('SEC-3: the exact Sandbox host is accepted, with or without a trailing slash', () => {
  assert.equal(loadConfig({ RS_PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com' }).paypalBaseUrl, PAYPAL_SANDBOX_API);
  assert.equal(loadConfig({ RS_PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com/' }).paypalBaseUrl, PAYPAL_SANDBOX_API);
});

test('SEC-3: the live PayPal host api-m.paypal.com refuses startup, with and without test mode', () => {
  for (const extra of [{}, { RS_TEST_OFFLINE: '1' }]) {
    const err = refusal({ ...extra, RS_PAYPAL_BASE_URL: 'https://api-m.paypal.com' });
    assert.deepEqual(err.variables, ['RS_PAYPAL_BASE_URL']);
  }
});

test('SEC-3: a loopback PayPal URL without RS_TEST_OFFLINE=1 is refused', () => {
  for (const url of ['http://127.0.0.1:4010', 'http://localhost:4010']) {
    const err = refusal({ RS_PAYPAL_BASE_URL: url });
    assert.deepEqual(err.variables, ['RS_PAYPAL_BASE_URL']);
  }
});

test('SEC-3: a loopback PayPal URL with RS_TEST_OFFLINE=1 is accepted and turns on testMode', () => {
  const config = loadConfig({ RS_TEST_OFFLINE: '1', RS_PAYPAL_BASE_URL: 'http://127.0.0.1:4010' });
  assert.equal(config.paypalBaseUrl, 'http://127.0.0.1:4010');
  assert.equal(config.testMode, true);
  assert.equal(buildLabels(config).testMode, true);
  assert.equal(loadConfig({}).testMode, false);
  assert.equal(buildLabels(loadConfig({})).testMode, false);
  assert.equal(loadConfig({ RS_TEST_OFFLINE: '1', RS_PAYPAL_BASE_URL: 'http://localhost:4011' }).paypalBaseUrl, 'http://localhost:4011');
});

test('SEC-3: look-alike and off-list PayPal URLs are refused even in test mode', () => {
  const bad = [
    'https://api-m.sandbox.paypal.com.evil.example',
    'https://evil.example/https://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com@evil.example',
    'https://user:pw@api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com/v1',
    'http://api-m.sandbox.paypal.com',
    'https://127.0.0.1:4010',
    'http://127.0.0.1',
    'http://127.0.0.1:99999',
    'http://127.0.0.1.evil.example:4010',
    'http://localhost.evil.example:4010',
    'http://0.0.0.0:4010',
    'http://[::1]:4010',
    'ftp://api-m.sandbox.paypal.com',
    'api-m.sandbox.paypal.com',
  ];
  for (const url of bad) {
    const err = refusal({ RS_TEST_OFFLINE: '1', RS_PAYPAL_BASE_URL: url });
    assert.deepEqual(err.variables, ['RS_PAYPAL_BASE_URL'], url);
  }
});

test('SEC-19: the Anthropic base URL defaults to and only accepts https://api.anthropic.com', () => {
  assert.equal(loadConfig({}).anthropicBaseUrl, ANTHROPIC_API);
  assert.equal(loadConfig({ RS_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }).anthropicBaseUrl, 'https://api.anthropic.com');
  for (const url of ['https://api.anthropic.com.evil.example', 'https://example.com', 'http://api.anthropic.com', 'https://api.anthropic.com/v1']) {
    const err = refusal({ RS_ANTHROPIC_BASE_URL: url });
    assert.deepEqual(err.variables, ['RS_ANTHROPIC_BASE_URL'], url);
  }
});

test('SEC-19: a loopback Anthropic URL is accepted only with RS_TEST_OFFLINE=1', () => {
  const err = refusal({ RS_ANTHROPIC_BASE_URL: 'http://127.0.0.1:4020' });
  assert.deepEqual(err.variables, ['RS_ANTHROPIC_BASE_URL']);
  const config = loadConfig({ RS_TEST_OFFLINE: '1', RS_ANTHROPIC_BASE_URL: 'http://127.0.0.1:4020' });
  assert.equal(config.anthropicBaseUrl, 'http://127.0.0.1:4020');
  assert.equal(config.testMode, true);
});

test('SEC-3: a refusal names the variable and the allowed host, never the rejected value', () => {
  const err = refusal({ RS_PAYPAL_BASE_URL: 'https://evil.example/leaky-marker-7731' });
  assert.match(err.message, /RS_PAYPAL_BASE_URL/);
  assert.doesNotMatch(err.message, /evil\.example|leaky-marker-7731/);
});

test('SEC-13: RS_ALLOWED_HOSTS is parsed as a lower-cased list and bad entries are refused', () => {
  assert.deepEqual([...loadConfig({ RS_ALLOWED_HOSTS: 'Demo.Example.com, other.example:8443 ,' }).allowedHosts], [
    'demo.example.com',
    'other.example:8443',
  ]);
  assert.deepEqual(refusal({ RS_ALLOWED_HOSTS: 'ok.example, bad host/x' }).variables, ['RS_ALLOWED_HOSTS']);
});

test('RS_PUBLIC_URL must be an http(s) origin; https turns on secure cookies', () => {
  assert.equal(loadConfig({}).publicUrl, null);
  assert.equal(loadConfig({ RS_PUBLIC_URL: 'http://localhost:3000' }).secureCookies, false);
  const secure = loadConfig({ RS_PUBLIC_URL: 'https://rescue.example.com' });
  assert.equal(secure.secureCookies, true);
  assert.equal(secure.publicUrl, 'https://rescue.example.com');
  for (const url of ['rescue.example.com', 'ftp://x.example', 'https://x.example/path', 'https://u:p@x.example', 'https://x.example/?q=1']) {
    assert.deepEqual(refusal({ RS_PUBLIC_URL: url }).variables, ['RS_PUBLIC_URL'], url);
  }
});

test('RS_FAKE_APPROVAL_HOST is 127.0.0.1 outside test mode; loopback names only in test mode', () => {
  assert.equal(loadConfig({}).fakeApprovalHost, '127.0.0.1');
  assert.deepEqual(refusal({ RS_FAKE_APPROVAL_HOST: '0.0.0.0' }).variables, ['RS_FAKE_APPROVAL_HOST']);
  assert.deepEqual(refusal({ RS_FAKE_APPROVAL_HOST: 'localhost' }).variables, ['RS_FAKE_APPROVAL_HOST']);
  assert.equal(loadConfig({ RS_TEST_OFFLINE: '1', RS_FAKE_APPROVAL_HOST: 'localhost' }).fakeApprovalHost, 'localhost');
  assert.deepEqual(refusal({ RS_TEST_OFFLINE: '1', RS_FAKE_APPROVAL_HOST: '10.0.0.5' }).variables, ['RS_FAKE_APPROVAL_HOST']);
});
