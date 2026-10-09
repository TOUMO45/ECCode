import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, MERCHANT_KEYS, buildLabels, loadConfig } from '../../../src/config.js';

test('NFR4: every variable of the Deployment table has its documented default', () => {
  const c = loadConfig({}, { now: () => Date.UTC(2026, 9, 20, 6, 0) });
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.publicUrl, null);
  assert.equal(c.dbPath, 'data/app.db');
  assert.equal(c.uploadDir, 'data/uploads');
  assert.equal(c.dbBusyTimeoutMs, 5000);
  assert.equal(c.demoDate, '2026-10-20');
  assert.equal(c.taxBp, 0);
  assert.equal(c.reservationTtlMin, 30);
  assert.equal(c.authExpiryMarginMin, 10);
  assert.equal(c.sagaLeaseMs, 60000);
  assert.equal(c.paypalTimeoutMs, 20000);
  assert.equal(c.reconcileIntervalMs, 15000);
  assert.equal(c.retentionIntervalMs, 3600000);
  assert.equal(c.imageRetentionDays, 7);
  assert.equal(c.unknownEscalateMin, 15);
  assert.equal(c.pendingEscalateMin, 1440);
  assert.equal(c.paymentProvider, 'fake');
  assert.equal(c.paypalBaseUrl, 'https://api-m.sandbox.paypal.com');
  assert.equal(c.fakeApprovalHost, '127.0.0.1');
  assert.equal(c.fakeApprovalPort, 0);
  assert.equal(c.modelProvider, 'cli');
  assert.equal(c.model, 'haiku');
  assert.equal(c.modelTimeoutMs, 30000);
  assert.equal(c.modelCallCapUsd, 0.05);
  assert.equal(c.modelDailyBudgetUsd, 1);
  assert.equal(c.fakeModelCostUsd, 0);
  assert.equal(c.anthropicModel, 'claude-haiku-4-5-20251001');
  assert.equal(c.anthropicBaseUrl, 'https://api.anthropic.com');
  assert.equal(c.anthropicUsdPerMtokIn, 1);
  assert.equal(c.anthropicUsdPerMtokOut, 5);
  assert.equal(c.explainRephrase, false);
  assert.equal(c.allowSignup, true);
  assert.equal(c.maxLiveReservationsPerCustomer, 1);
  assert.equal(c.maxRequestsPerCustomerPerDay, 10);
  assert.equal(c.modelCustomerDailyShare, 0.2);
  assert.deepEqual([...c.allowedHosts], []);
  assert.deepEqual([...c.oldNodeBins], []);
  assert.equal(c.trustProxy, false);
  assert.equal(c.testHooks, false);
  assert.equal(c.testOffline, false);
  assert.equal(c.liveModel, false);
  assert.equal(c.livePaypal, false);
  assert.equal(c.registerPerIpPerHour, 5);
});

test('NFR4: every variable of the Deployment table is read from the environment', () => {
  const env = {
    PORT: '4123',
    HOST: '0.0.0.0',
    RS_PUBLIC_URL: 'https://rescue.example.com',
    RS_DB_PATH: '/var/rs/app.db',
    RS_UPLOAD_DIR: '/var/rs/uploads',
    RS_DB_BUSY_TIMEOUT_MS: '250',
    RS_DEMO_DATE: '2026-10-21',
    RS_TAX_BP: '1600',
    RS_RESERVATION_TTL_MIN: '45',
    RS_AUTH_EXPIRY_MARGIN_MIN: '12',
    RS_SAGA_LEASE_MS: '90000',
    RS_PAYPAL_TIMEOUT_MS: '25000',
    RS_RECONCILE_INTERVAL_MS: '200',
    RS_RETENTION_INTERVAL_MS: '60000',
    RS_IMAGE_RETENTION_DAYS: '3',
    RS_UNKNOWN_ESCALATE_MIN: '20',
    RS_PENDING_ESCALATE_MIN: '600',
    RS_PAYMENT_PROVIDER: 'fake',
    RS_FAKE_APPROVAL_HOST: '127.0.0.1',
    RS_FAKE_APPROVAL_PORT: '4555',
    RS_MODEL_PROVIDER: 'fake',
    RS_MODEL: 'sonnet',
    RS_MODEL_TIMEOUT_MS: '10000',
    RS_MODEL_CALL_CAP_USD: '0.1',
    RS_MODEL_DAILY_BUDGET_USD: '2.50',
    RS_FAKE_MODEL_COST_USD: '0.01',
    RS_ANTHROPIC_MODEL: 'claude-test-model',
    RS_ANTHROPIC_USD_PER_MTOK_IN: '0.8',
    RS_ANTHROPIC_USD_PER_MTOK_OUT: '4',
    RS_EXPLAIN_REPHRASE: '1',
    RS_ALLOW_SIGNUP: '0',
    RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '2',
    RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
    RS_MODEL_CUSTOMER_DAILY_SHARE: '1',
    RS_ALLOWED_HOSTS: 'a.example,b.example:81',
    RS_OLD_NODE_BINS: '/opt/node18/bin/node,/opt/node20/bin/node',
    RS_TRUST_PROXY: '1',
    RS_TEST_HOOKS: '1',
    RS_TEST_OFFLINE: '1',
    RS_LIVE_MODEL: '1',
    RS_LIVE_PAYPAL: '1',
  };
  const c = loadConfig(env);
  assert.equal(c.port, 4123);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.publicUrl, 'https://rescue.example.com');
  assert.equal(c.dbPath, '/var/rs/app.db');
  assert.equal(c.uploadDir, '/var/rs/uploads');
  assert.equal(c.dbBusyTimeoutMs, 250);
  assert.equal(c.demoDate, '2026-10-21');
  assert.equal(c.taxBp, 1600);
  assert.equal(c.reservationTtlMin, 45);
  assert.equal(c.authExpiryMarginMin, 12);
  assert.equal(c.sagaLeaseMs, 90000);
  assert.equal(c.paypalTimeoutMs, 25000);
  assert.equal(c.reconcileIntervalMs, 200);
  assert.equal(c.retentionIntervalMs, 60000);
  assert.equal(c.imageRetentionDays, 3);
  assert.equal(c.unknownEscalateMin, 20);
  assert.equal(c.pendingEscalateMin, 600);
  assert.equal(c.fakeApprovalPort, 4555);
  assert.equal(c.model, 'sonnet');
  assert.equal(c.modelTimeoutMs, 10000);
  assert.equal(c.modelCallCapUsd, 0.1);
  assert.equal(c.modelDailyBudgetUsd, 2.5);
  assert.equal(c.fakeModelCostUsd, 0.01);
  assert.equal(c.anthropicModel, 'claude-test-model');
  assert.equal(c.anthropicUsdPerMtokIn, 0.8);
  assert.equal(c.anthropicUsdPerMtokOut, 4);
  assert.equal(c.explainRephrase, true);
  assert.equal(c.allowSignup, false);
  assert.equal(c.maxLiveReservationsPerCustomer, 2);
  assert.equal(c.maxRequestsPerCustomerPerDay, 1000);
  assert.equal(c.modelCustomerDailyShare, 1);
  assert.deepEqual([...c.allowedHosts], ['a.example', 'b.example:81']);
  assert.deepEqual([...c.oldNodeBins], ['/opt/node18/bin/node', '/opt/node20/bin/node']);
  assert.equal(c.trustProxy, true);
  assert.equal(c.testHooks, true);
  assert.equal(c.liveModel, true);
  assert.equal(c.livePaypal, true);
});

test('NFR4: PayPal credentials are read for every merchant key A-E and DEFAULT', () => {
  const env = {};
  for (const key of MERCHANT_KEYS) {
    env[`RS_PAYPAL_${key}_CLIENT_ID`] = `id-${key}`;
    env[`RS_PAYPAL_${key}_CLIENT_SECRET`] = `secret-${key}`;
    env[`RS_PAYPAL_${key}_WEBHOOK_ID`] = `hook-${key}`;
  }
  const c = loadConfig(env);
  assert.deepEqual(Object.keys(c.paypal.merchants).sort(), [...MERCHANT_KEYS].sort());
  for (const key of MERCHANT_KEYS) {
    assert.equal(c.paypal.merchants[key].clientId.reveal(), `id-${key}`);
    assert.equal(c.paypal.merchants[key].clientSecret.reveal(), `secret-${key}`);
    assert.equal(c.paypal.merchants[key].webhookId.reveal(), `hook-${key}`);
  }
});

test('numeric variables reject non-numbers, and the config object is frozen', () => {
  for (const [name, value] of [['PORT', 'abc'], ['PORT', '70000'], ['RS_TAX_BP', '-1'], ['RS_MODEL_CALL_CAP_USD', '0'], ['RS_IMAGE_RETENTION_DAYS', '0']]) {
    assert.throws(() => loadConfig({ [name]: value }), (err) => err instanceof ConfigError && err.variables.includes(name), `${name}=${value}`);
  }
  const c = loadConfig({});
  assert.throws(() => {
    'use strict';
    c.port = 1;
  }, TypeError);
});

test('buildLabels carries no secret and reports the provider modes', () => {
  const fake = buildLabels(loadConfig({}));
  assert.deepEqual(Object.keys(fake).sort(), [
    'demoData', 'merchantMode', 'priceNotice', 'sandbox', 'simulatedExtraction', 'simulatedPayments', 'singleCredentialNotice', 'testMode',
  ]);
  assert.equal(fake.simulatedPayments, true);
  assert.equal(fake.sandbox, false);
  assert.equal(fake.priceNotice, 'Test prices, not market prices');
  assert.equal(fake.demoData, true);
  const sandbox = buildLabels(
    loadConfig({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'cid', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'csecret' }),
  );
  assert.equal(sandbox.sandbox, true);
  assert.equal(sandbox.simulatedPayments, false);
  assert.equal(sandbox.merchantMode, 'single-credential');
  assert.equal(typeof sandbox.singleCredentialNotice, 'string');
});
