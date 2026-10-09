import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ConfigError, Secret, isPlaceholder, loadConfig } from '../../../src/config.js';

function refusal(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, 'expected a ConfigError');
    return err;
  }
  assert.fail('expected the configuration to be refused');
}

const LONG_ADMIN = 'correct-horse-battery-staple-9';
const DEMO = 'demo-pass-phrase-12';
const HMAC = 'h'.repeat(40);

test('NFR4: secrets are read only from the environment and wrapped in Secret', () => {
  const config = loadConfig({
    RS_ADMIN_PASSWORD: LONG_ADMIN,
    RS_DEMO_PASSWORD: DEMO,
    RS_FAKE_WEBHOOK_SECRET: HMAC,
    ANTHROPIC_API_KEY: 'sk-ant-test-key-value',
    RS_PAYPAL_A_CLIENT_ID: 'client-id-a',
    RS_PAYPAL_A_CLIENT_SECRET: 'client-secret-a',
    RS_PAYPAL_A_WEBHOOK_ID: 'webhook-id-a',
  });
  for (const secret of [
    config.adminPassword,
    config.demoPassword,
    config.fakeWebhookSecret,
    config.anthropicApiKey,
    config.paypal.merchants.A.clientId,
    config.paypal.merchants.A.clientSecret,
    config.paypal.merchants.A.webhookId,
  ]) {
    assert.ok(secret instanceof Secret);
  }
  assert.equal(config.adminPassword.reveal(), LONG_ADMIN);
  assert.equal(config.paypal.merchants.A.clientSecret.reveal(), 'client-secret-a');
});

test('NFR4: unset secrets are null and no secret has a default value in code', () => {
  const config = loadConfig({});
  assert.equal(config.adminPassword, null);
  assert.equal(config.demoPassword, null);
  assert.equal(config.fakeWebhookSecret, null);
  assert.equal(config.anthropicApiKey, null);
  assert.deepEqual(config.paypal.merchants, {});
  // An empty string counts as unset.
  assert.equal(loadConfig({ RS_ADMIN_PASSWORD: '' }).adminPassword, null);
});

test('SEC-5: Secret redacts itself in toString, JSON, template strings and util.inspect', () => {
  const secret = new Secret('very-secret-value-123');
  assert.equal(String(secret), '[redacted]');
  assert.equal(`${secret}`, '[redacted]');
  assert.equal(JSON.stringify({ secret }), '{"secret":"[redacted]"}');
  assert.equal(inspect(secret), '[redacted]');
  assert.equal(inspect({ nested: { secret } }, { depth: 5 }), '{ nested: { secret: [redacted] } }');
  assert.equal(secret.reveal(), 'very-secret-value-123');
});

test('SEC-5: serialising or inspecting the whole config leaks no secret value', () => {
  const env = {
    RS_ADMIN_PASSWORD: LONG_ADMIN,
    RS_DEMO_PASSWORD: DEMO,
    RS_FAKE_WEBHOOK_SECRET: HMAC,
    ANTHROPIC_API_KEY: 'sk-ant-test-key-value',
    RS_PAYPAL_DEFAULT_CLIENT_ID: 'default-client-id-xyz',
    RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'default-client-secret-xyz',
  };
  const config = loadConfig(env);
  const dumps = [JSON.stringify(config), inspect(config, { depth: 10 }), String(JSON.stringify(config.paypal))];
  for (const dump of dumps) {
    for (const value of Object.values(env)) assert.ok(!dump.includes(value), `a secret value leaked: ${value.slice(0, 6)}...`);
  }
});

test('SEC-5: placeholder-shaped values are refused for every secret, naming only the variable', () => {
  const names = [
    'RS_ADMIN_PASSWORD',
    'RS_DEMO_PASSWORD',
    'RS_FAKE_WEBHOOK_SECRET',
    'ANTHROPIC_API_KEY',
    'RS_PAYPAL_A_CLIENT_ID',
    'RS_PAYPAL_DEFAULT_CLIENT_SECRET',
    'RS_PAYPAL_E_WEBHOOK_ID',
  ];
  for (const name of names) {
    for (const value of ['<placeholder>', '<your-key-here>', '<>', 'changeme', 'ChangeMe', 'password', 'Password', '  password  ']) {
      const err = refusal({ [name]: value });
      assert.ok(err.variables.includes(name), `${name} should be named for ${JSON.stringify(value)}`);
      assert.match(err.message, new RegExp(name));
      assert.doesNotMatch(err.message, /your-key-here|changeme|ChangeMe/i);
    }
  }
});

test('SEC-5: isPlaceholder recognises <...>, changeme and password only', () => {
  for (const v of ['<x>', '<placeholder>', 'changeme', 'CHANGEME', 'password']) assert.equal(isPlaceholder(v), true, v);
  for (const v of ['a<b>', '<a', 'a>', 'changeme2', 'passwords', 'correct-horse']) assert.equal(isPlaceholder(v), false, v);
});

test('SEC-5: RS_ADMIN_PASSWORD needs at least 16 characters', () => {
  assert.equal(loadConfig({ RS_ADMIN_PASSWORD: 'a'.repeat(16) }).adminPassword.reveal(), 'a'.repeat(16));
  const err = refusal({ RS_ADMIN_PASSWORD: 'a'.repeat(15) });
  assert.deepEqual(err.variables, ['RS_ADMIN_PASSWORD']);
  assert.doesNotMatch(err.message, /aaaa/);
});

test('SEC-5: RS_DEMO_PASSWORD needs at least 12 characters', () => {
  assert.ok(loadConfig({ RS_DEMO_PASSWORD: 'b'.repeat(12) }).demoPassword);
  const err = refusal({ RS_DEMO_PASSWORD: 'b'.repeat(11) });
  assert.deepEqual(err.variables, ['RS_DEMO_PASSWORD']);
});

test('SEC-5: RS_FAKE_WEBHOOK_SECRET needs at least 32 bytes (bytes, not characters)', () => {
  assert.ok(loadConfig({ RS_FAKE_WEBHOOK_SECRET: 'c'.repeat(32) }).fakeWebhookSecret);
  assert.deepEqual(refusal({ RS_FAKE_WEBHOOK_SECRET: 'c'.repeat(31) }).variables, ['RS_FAKE_WEBHOOK_SECRET']);
  // 16 two-byte characters are 32 bytes.
  assert.ok(loadConfig({ RS_FAKE_WEBHOOK_SECRET: 'é'.repeat(16) }).fakeWebhookSecret);
});

test('SEC-5: a refusal reports every problem at once and never contains a value', () => {
  const err = refusal({
    RS_ADMIN_PASSWORD: 'short-marker',
    RS_DEMO_PASSWORD: 'changeme',
    RS_FAKE_WEBHOOK_SECRET: 'tiny-marker',
  });
  assert.deepEqual([...err.variables].sort(), ['RS_ADMIN_PASSWORD', 'RS_DEMO_PASSWORD', 'RS_FAKE_WEBHOOK_SECRET']);
  assert.doesNotMatch(err.message, /marker|changeme/);
});

test('NFR4: PayPal client id and secret must be set together', () => {
  assert.deepEqual(refusal({ RS_PAYPAL_B_CLIENT_ID: 'only-id' }).variables, ['RS_PAYPAL_B_CLIENT_SECRET']);
  assert.deepEqual(refusal({ RS_PAYPAL_B_CLIENT_SECRET: 'only-secret' }).variables, ['RS_PAYPAL_B_CLIENT_ID']);
});

test('NFR4: the Sandbox payment provider needs a complete credential set; the fake does not', () => {
  assert.equal(loadConfig({ RS_PAYMENT_PROVIDER: 'fake' }).paymentProvider, 'fake');
  assert.deepEqual(refusal({ RS_PAYMENT_PROVIDER: 'paypal-sandbox' }).variables, ['RS_PAYPAL_DEFAULT_CLIENT_ID']);
  const single = loadConfig({
    RS_PAYMENT_PROVIDER: 'paypal-sandbox',
    RS_PAYPAL_DEFAULT_CLIENT_ID: 'cid',
    RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'csecret',
  });
  assert.equal(single.merchantMode, 'single-credential');
  const env = { RS_PAYMENT_PROVIDER: 'paypal-sandbox' };
  for (const key of ['A', 'B', 'C', 'D', 'E']) {
    env[`RS_PAYPAL_${key}_CLIENT_ID`] = `cid-${key}`;
    env[`RS_PAYPAL_${key}_CLIENT_SECRET`] = `csecret-${key}`;
  }
  assert.equal(loadConfig(env).merchantMode, 'per-supplier');
});

test('RS_TEST_HOOKS is refused when the Sandbox adapter is selected', () => {
  const env = {
    RS_PAYMENT_PROVIDER: 'paypal-sandbox',
    RS_PAYPAL_DEFAULT_CLIENT_ID: 'cid',
    RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'csecret',
    RS_TEST_HOOKS: '1',
  };
  assert.deepEqual(refusal(env).variables, ['RS_TEST_HOOKS']);
  assert.equal(loadConfig({ RS_TEST_HOOKS: '1' }).testHooks, true);
});

test('NFR1: RS_TEST_OFFLINE=1 forces the fake model provider; otherwise the provider follows RS_MODEL_PROVIDER and the API key', () => {
  assert.equal(loadConfig({ RS_TEST_OFFLINE: '1', RS_MODEL_PROVIDER: 'cli' }).extractionProvider, 'fake');
  assert.equal(loadConfig({}).extractionProvider, 'cli');
  assert.equal(loadConfig({ RS_MODEL_PROVIDER: 'fake' }).extractionProvider, 'fake');
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key-value' }).extractionProvider, 'anthropic');
  assert.deepEqual(refusal({ RS_MODEL_PROVIDER: 'anthropic' }).variables, ['ANTHROPIC_API_KEY']);
});
