// src/payments/merchants.js (merchant mapping, decision dec-mv16pz0g-01d5c4c2) and the wiring of the payment adapters from the
// configuration (src/payments/provider.js createPayments), plus the two src/config.js follow-ups that e1 owns:
//   FU-27 (TR-D-7): RS_MODEL_TIMEOUT_MS is bounded to 1..40000.
//   FU-25: RS_EXPLAIN_REPHRASE is parsed again, default 0, with no consumer in src/ outside config
//          (decision dec-mv38g19z-01f0a99f, which amends dec-mv330t7a-017a2211).
// These config assertions live here because test/unit/config/limits.test.js is outside e1's ownership.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { ConfigError, MAX_MODEL_TIMEOUT_MS, Secret, loadConfig } from '../../../src/config.js';
import { fixedClock } from '../../../src/clock.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import {
  SUPPLIER_MERCHANT_KEYS, activeMerchantKeys, describeMerchants, isActiveMerchantKey, isMerchantKey, merchantCredentials, merchantKeyForSupplier, merchantMode,
  sandboxMerchants,
} from '../../../src/payments/merchants.js';
import { createPayments } from '../../../src/payments/provider.js';
import { STUB_START_MS } from '../../helpers/paypal-stub.js';

const cred = (key, n = '1') => ({
  [`RS_PAYPAL_${key}_CLIENT_ID`]: `client-id-${key}-${n}`,
  [`RS_PAYPAL_${key}_CLIENT_SECRET`]: `client-secret-${key}-${n}`,
  [`RS_PAYPAL_${key}_WEBHOOK_ID`]: `webhook-id-${key}-${n}`,
});
const all = (keys) => Object.assign({}, ...keys.map((k) => cred(k)));
const sandbox = (extra = {}) => loadConfig({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', ...extra });
const refusal = (env) => {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `a ConfigError, got ${err}`);
    return err;
  }
  assert.fail('the configuration was accepted');
  return null;
};

describe('merchant mode and keys', () => {
  test('the fake is per-supplier with every key active; supplier A-E map to their own key, any other code to DEFAULT', () => {
    const c = loadConfig({});
    assert.equal(c.paymentProvider, 'fake');
    assert.equal(merchantMode(c), 'per-supplier');
    assert.deepEqual(activeMerchantKeys(c), ['A', 'B', 'C', 'D', 'E', 'DEFAULT']);
    for (const code of SUPPLIER_MERCHANT_KEYS) assert.equal(merchantKeyForSupplier(c, code), code);
    assert.equal(merchantKeyForSupplier(c, 'Z'), 'DEFAULT');
    assert.equal(merchantKeyForSupplier(c, undefined), null);
    assert.equal(merchantKeyForSupplier(c, 7), null);
    assert.deepEqual(sandboxMerchants(c), {}, 'the fake has no credentials');
  });

  test('Sandbox with A-E all configured is per-supplier: each supplier is paid through its own merchant', () => {
    const c = sandbox(all(['A', 'B', 'C', 'D', 'E']));
    assert.equal(merchantMode(c), 'per-supplier');
    assert.deepEqual(activeMerchantKeys(c), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(merchantKeyForSupplier(c, 'C'), 'C');
    assert.equal(merchantKeyForSupplier(c, 'Z'), null, 'no DEFAULT to fall back on');
    for (const key of ['A', 'E']) assert.equal(isActiveMerchantKey(c, key), true);
    assert.equal(isActiveMerchantKey(c, 'DEFAULT'), false);
    assert.deepEqual(Object.keys(sandboxMerchants(c)), ['A', 'B', 'C', 'D', 'E']);
  });

  test('per-supplier with a DEFAULT as well: DEFAULT catches the supplier codes outside A-E', () => {
    const c = sandbox(all(['A', 'B', 'C', 'D', 'E', 'DEFAULT']));
    assert.equal(merchantMode(c), 'per-supplier');
    assert.equal(merchantKeyForSupplier(c, 'B'), 'B');
    assert.equal(merchantKeyForSupplier(c, 'Z'), 'DEFAULT');
    assert.equal(isActiveMerchantKey(c, 'DEFAULT'), true);
  });

  test('Sandbox with DEFAULT only is single-credential: every supplier goes to DEFAULT, and the keys A-E are not active', () => {
    const c = sandbox(all(['DEFAULT']));
    assert.equal(merchantMode(c), 'single-credential');
    assert.deepEqual(activeMerchantKeys(c), ['DEFAULT']);
    for (const code of ['A', 'B', 'E', 'Z']) assert.equal(merchantKeyForSupplier(c, code), 'DEFAULT');
    assert.equal(isActiveMerchantKey(c, 'DEFAULT'), true);
    assert.equal(isActiveMerchantKey(c, 'A'), false);
  });

  test('a partial set A-D plus DEFAULT is single-credential: the incomplete per-supplier keys are ignored, not half used', () => {
    const c = sandbox(all(['A', 'B', 'C', 'D', 'DEFAULT']));
    assert.equal(merchantMode(c), 'single-credential');
    assert.equal(merchantKeyForSupplier(c, 'A'), 'DEFAULT');
    assert.deepEqual(Object.keys(sandboxMerchants(c)), ['DEFAULT']);
    assert.equal(isActiveMerchantKey(c, 'A'), false);
  });

  test('Sandbox with no usable credential set is refused at startup, naming the variable only', () => {
    const err = refusal({ RS_PAYMENT_PROVIDER: 'paypal-sandbox' });
    assert.deepEqual(err.variables, ['RS_PAYPAL_DEFAULT_CLIENT_ID']);
    const half = refusal({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'only-an-id-1234' });
    assert.ok(half.variables.includes('RS_PAYPAL_DEFAULT_CLIENT_SECRET'));
    assert.equal(half.message.includes('only-an-id-1234'), false);
    assert.deepEqual(refusal({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: '<placeholder>', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'x-secret-value' }).variables.includes('RS_PAYPAL_DEFAULT_CLIENT_ID'), true);
  });

  test('isMerchantKey accepts exactly A-E and DEFAULT', () => {
    for (const key of ['A', 'B', 'C', 'D', 'E', 'DEFAULT']) assert.equal(isMerchantKey(key), true, key);
    for (const key of ['F', 'a', 'default', '', 'A ', null, undefined, 1, '__proto__', 'constructor']) assert.equal(isMerchantKey(key), false, String(key));
  });
});

describe('credentials are Secret values and never leave through a summary', () => {
  test('merchantCredentials returns the Secret wrappers; webhookId is null when it was not set', () => {
    const c = sandbox({ ...cred('DEFAULT'), RS_PAYPAL_B_CLIENT_ID: 'client-id-B-9', RS_PAYPAL_B_CLIENT_SECRET: 'client-secret-B-9' });
    const d = merchantCredentials(c, 'DEFAULT');
    assert.ok(d.clientId instanceof Secret && d.clientSecret instanceof Secret && d.webhookId instanceof Secret);
    assert.equal(d.clientSecret.reveal(), 'client-secret-DEFAULT-1');
    assert.equal(merchantCredentials(c, 'B').webhookId, null);
    assert.equal(merchantCredentials(c, 'C'), null);
    assert.equal(merchantCredentials(c, 'nope'), null);
  });

  test('neither the configuration, the adapter map nor describeMerchants prints a credential (JSON, String, util.inspect)', () => {
    const c = sandbox(all(['A', 'B', 'C', 'D', 'E', 'DEFAULT']));
    const values = [];
    for (const key of ['A', 'B', 'C', 'D', 'E', 'DEFAULT']) values.push(`client-id-${key}-1`, `client-secret-${key}-1`, `webhook-id-${key}-1`);
    const text = [
      JSON.stringify(c), inspect(c, { depth: 8 }), JSON.stringify(sandboxMerchants(c)), inspect(sandboxMerchants(c), { depth: 8 }),
      JSON.stringify(describeMerchants(c)), String(merchantCredentials(c, 'A').clientSecret), `${merchantCredentials(c, 'A').clientId}`,
    ].join('\n');
    for (const value of values) assert.equal(text.includes(value), false, value);
    assert.deepEqual(describeMerchants(c), {
      mode: 'per-supplier', provider: 'paypal-sandbox', keys: ['A', 'B', 'C', 'D', 'E', 'DEFAULT'], webhookIds: ['A', 'B', 'C', 'D', 'E', 'DEFAULT'],
    });
  });
});

describe('createPayments wires the adapter the configuration names', () => {
  test('fake: the provider and the approval listener start together; close() releases the port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-pay-wire-'));
    const config = loadConfig({ RS_DB_PATH: join(dir, 'app.db'), RS_PAYMENT_PROVIDER: 'fake', RS_TEST_OFFLINE: '1' });
    const db = openDb(config.dbPath);
    migrate(db, { clock: fixedClock(STUB_START_MS) });
    try {
      const payments = await createPayments({ config, db, clock: fixedClock(STUB_START_MS), appOrigin: 'http://localhost:3000' });
      assert.equal(payments.provider.id, 'fake');
      assert.ok(payments.listener.port > 0);
      const order = await payments.provider.createOrder({
        merchantKey: 'A', requestId: 'so:1:create_order:1', amountCents: 500, currency: 'USD', referenceId: 'so-1',
        returnUrl: 'http://localhost:3000/api/paypal/return', cancelUrl: 'http://localhost:3000/api/paypal/cancel',
      });
      assert.equal(order.value.approvalUrl.startsWith(payments.listener.origin), true);
      const res = await fetch(order.value.approvalUrl);
      assert.equal(res.status, 200);
      await payments.close();
      await assert.rejects(fetch(order.value.approvalUrl), 'the listener is closed');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('paypal-sandbox: the Sandbox adapter, no listener, credentials taken from the configuration; a loopback base needs RS_TEST_OFFLINE=1', async () => {
    const c = sandbox({ ...all(['DEFAULT']), RS_TEST_OFFLINE: '1', RS_PAYPAL_BASE_URL: 'http://127.0.0.1:4999' });
    let seen = null;
    const payments = await createPayments({
      config: c, clock: fixedClock(STUB_START_MS), log: undefined,
      overrides: { sandbox: { fetch: async (url, init) => { seen = { url: String(url), auth: init.headers.authorization }; return new Response('{"error":"invalid_client"}', { status: 401 }); } } },
    });
    assert.equal(payments.listener, null);
    assert.deepEqual([payments.provider.id, payments.provider.sandbox, payments.provider.simulated], ['paypal-sandbox', true, false]);
    const outcome = await payments.provider.getOrder({ merchantKey: 'DEFAULT', orderId: 'O-1' });
    assert.deepEqual([outcome.kind, outcome.httpStatus], ['retryable', 401]);
    assert.equal(seen.url, 'http://127.0.0.1:4999/v1/oauth2/token');
    assert.equal(seen.auth, `Basic ${Buffer.from('client-id-DEFAULT-1:client-secret-DEFAULT-1').toString('base64')}`);
    await payments.close();
    // Without the flag the configuration itself refuses the loopback base, so no adapter can be built from it.
    assert.deepEqual(refusal({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', ...all(['DEFAULT']), RS_PAYPAL_BASE_URL: 'http://127.0.0.1:4999' }).variables, ['RS_PAYPAL_BASE_URL']);
  });

  test('an unknown provider or a missing configuration is an error, not a silent fake', async () => {
    await assert.rejects(createPayments({ config: { paymentProvider: 'stripe' } }), RangeError);
    await assert.rejects(createPayments({}), TypeError);
    await assert.rejects(createPayments({ config: { paymentProvider: 'fake' } }), TypeError, 'the fake needs the database');
  });
});

describe('src/config.js follow-ups owned by e1', () => {
  test('TR-D-7: RS_MODEL_TIMEOUT_MS above 40000 is refused at startup and names only the variable; 1..40000 and the default 30000 are accepted', () => {
    assert.equal(MAX_MODEL_TIMEOUT_MS, 40000);
    assert.equal(loadConfig({}).modelTimeoutMs, 30000, 'the default stays 30000');
    for (const ok of ['1', '60', '30000', '39999', '40000']) assert.equal(loadConfig({ RS_MODEL_TIMEOUT_MS: ok }).modelTimeoutMs, Number(ok), ok);
    for (const bad of ['40001', '44000', '45000', '60000', '600000', '0', '-1', '1.5', '30s', 'abc', '0x10', '1e4']) {
      const err = refusal({ RS_MODEL_TIMEOUT_MS: bad });
      assert.deepEqual(err.variables, ['RS_MODEL_TIMEOUT_MS'], bad);
      if (/[a-z]/.test(bad)) assert.equal(err.message.includes(bad), false, `the refusal does not echo ${bad}`);
      assert.match(err.problems[0].reason, /integer from 1 to 40000/);
    }
  });

  test('FU-25: RS_EXPLAIN_REPHRASE is parsed (default 0 = false, 1 = true, anything else refused by name) and nothing in src/ outside config reads it', () => {
    assert.equal(loadConfig({}).explainRephrase, false);
    assert.equal(loadConfig({ RS_EXPLAIN_REPHRASE: '0' }).explainRephrase, false);
    assert.equal(loadConfig({ RS_EXPLAIN_REPHRASE: '1' }).explainRephrase, true);
    for (const bad of ['yes', 'true', '2']) {
      const err = refusal({ RS_EXPLAIN_REPHRASE: bad });
      assert.deepEqual(err.variables, ['RS_EXPLAIN_REPHRASE'], bad);
    }
    const srcDir = fileURLToPath(new URL('../../../src/', import.meta.url));
    const consumers = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && full !== join(srcDir, 'config.js')) {
          if (/explainRephrase/.test(readFileSync(full, 'utf8'))) consumers.push(full);
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(consumers, [], 'no consumer of config.explainRephrase in src/ outside config.js (decision dec-mv38g19z-01f0a99f)');
  });
});
