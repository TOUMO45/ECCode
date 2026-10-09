// Contract tests for the two public routes (spec: Interface Contracts > Public and health):
//   GET /api/health -> 200 {status:"ok", requestId}; 503 DB_BUSY with Retry-After when SELECT 1 fails.
//   GET /api/config -> 200 {labels, extractionProvider, paymentProvider, signupEnabled, reservationTtlMin, requestId}
//                      and no secret, client id or merchant id.
// Runs the real app in-process through test/helpers/app-harness.js (fake adapters, fixed clock).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers/app-harness.js';

const SENTINELS = {
  ANTHROPIC_API_KEY: 'sk-ant-test-SENTINEL-8c1d5e7f9a2b4c6d',
  RS_ADMIN_PASSWORD: 'admin-SENTINEL-pass-0123456789',
  RS_DEMO_PASSWORD: 'demo-SENTINEL-pass-0123',
  RS_FAKE_WEBHOOK_SECRET: 'webhook-SENTINEL-secret-0123456789abcdef0123456789',
  RS_PAYPAL_DEFAULT_CLIENT_ID: 'AaSENTINELclientid1234567890',
  RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'EeSENTINELclientsecret1234567890',
  RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'WH-SENTINEL-1234567890',
  RS_PAYPAL_A_CLIENT_ID: 'AaSENTINELmerchantA-id',
  RS_PAYPAL_A_CLIENT_SECRET: 'EeSENTINELmerchantA-secret',
};
const SECRET_KEY_NAME = /secret|password|token|apikey|api_key|client_?id|merchant_?id|merchant_?key|webhook_?id|authorization/i;

function keysDeep(value, path = '') {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [`${path}${k}`, ...keysDeep(v, `${path}${k}.`)]);
}

describe('NFR1: GET /api/health', () => {
  let h;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  test('NFR1: answers 200 {status: "ok", requestId} with the request id in the header too', async () => {
    const res = await h.request({ path: '/api/health' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json; charset=utf-8$/i);
    assert.deepEqual(Object.keys(res.json).sort(), ['requestId', 'status']);
    assert.equal(res.json.status, 'ok');
    assert.equal(typeof res.json.requestId, 'string');
    assert.equal(res.headers['x-request-id'], res.json.requestId);
  });

  test('NFR6: a valid inbound X-Request-Id is kept, an invalid one is replaced', async () => {
    const kept = await h.request({ path: '/api/health', headers: { 'X-Request-Id': 'abc-12345678' } });
    assert.equal(kept.json.requestId, 'abc-12345678');
    assert.equal(kept.headers['x-request-id'], 'abc-12345678');
    for (const bad of ['short', 'has space in it 123', `${'a'.repeat(65)}`, 'bad/char/12345']) {
      const res = await h.request({ path: '/api/health', headers: { 'X-Request-Id': bad } });
      assert.equal(res.status, 200);
      assert.notEqual(res.json.requestId, bad);
      assert.match(res.json.requestId, /^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  test('NFR1: needs no session and sets no cookie or CORS header', async () => {
    const res = await h.request({ path: '/api/health' });
    assert.equal(res.headers['set-cookie'], undefined);
    for (const name of Object.keys(res.headers)) assert.equal(name.startsWith('access-control-'), false, name);
  });

  test('NFR1: a method other than GET is refused with the error envelope, not served', async () => {
    const res = await h.request({ method: 'POST', path: '/api/health', jsonBody: {} });
    assert.equal(res.status, 405);
    assert.equal(res.json.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(typeof res.json.error.requestId, 'string');
    assert.equal(res.json.status, undefined);
  });

  test('NFR1: a Host outside the allow-list gets 421 MISDIRECTED_REQUEST', async () => {
    const res = await h.request({ path: '/api/health', host: 'rebind.example' });
    assert.equal(res.status, 421);
    assert.equal(res.json.error.code, 'MISDIRECTED_REQUEST');
  });
});

describe('NFR1: GET /api/health with an unusable database', () => {
  test('NFR1: answers 503 DB_BUSY with Retry-After: 1 and the error envelope', async () => {
    const h = await startHarness();
    try {
      h.db.close();
      const res = await h.request({ path: '/api/health' });
      assert.equal(res.status, 503);
      assert.equal(res.headers['retry-after'], '1');
      assert.equal(res.json.error.code, 'DB_BUSY');
      assert.equal(typeof res.json.error.requestId, 'string');
      assert.equal(res.headers['x-request-id'], res.json.error.requestId);
      assert.equal(JSON.stringify(res.json).includes('SELECT'), false, 'no SQL in the body');
    } finally {
      await h.close();
    }
  });
});

describe('NFR4: GET /api/config', () => {
  let h;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  test('NFR3: returns labels, provider names, signup flag and reservation TTL with the documented types (test mode, fake adapters)', async () => {
    const res = await h.request({ path: '/api/config' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['extractionProvider', 'labels', 'paymentProvider', 'requestId', 'reservationTtlMin', 'signupEnabled']);
    assert.equal(res.json.extractionProvider, 'fake');
    assert.equal(res.json.paymentProvider, 'fake');
    assert.equal(typeof res.json.signupEnabled, 'boolean');
    assert.equal(Number.isInteger(res.json.reservationTtlMin) && res.json.reservationTtlMin > 0, true);
    assert.equal(res.headers['x-request-id'], res.json.requestId);
    const labels = res.json.labels;
    assert.equal(labels.testMode, true, 'RS_TEST_OFFLINE=1 shows test mode (SEC-3)');
    assert.equal(labels.simulatedPayments, true);
    assert.equal(labels.simulatedExtraction, true);
    assert.equal(labels.sandbox, false);
    assert.equal(labels.demoData, true);
    assert.equal(labels.priceNotice, 'Test prices, not market prices');
  });

  test('RS-34: outside test mode testMode is false and a fake extraction provider is still labelled simulated', async () => {
    const live = await startHarness({ env: { RS_TEST_OFFLINE: '0', RS_MODEL_PROVIDER: 'fake' } });
    try {
      const res = await live.request({ path: '/api/config' });
      assert.equal(res.status, 200);
      assert.equal(res.json.labels.testMode, false);
      assert.equal(res.json.extractionProvider, 'fake');
      assert.equal(res.json.labels.simulatedExtraction, true, 'a fake extraction provider is labelled even outside test mode');
    } finally {
      await live.close();
    }
  });

  test('NFR6: the default model provider outside test mode is the CLI, labelled as not simulated', async () => {
    const live = await startHarness({ env: { RS_TEST_OFFLINE: '0', RS_MODEL_PROVIDER: undefined } });
    try {
      const res = await live.request({ path: '/api/config' });
      assert.equal(res.json.extractionProvider, 'cli');
      assert.equal(res.json.labels.simulatedExtraction, false);
    } finally {
      await live.close();
    }
  });

  test('NFR4: no secret, client id or merchant id appears, whatever the configuration holds (value and key-name scan)', async () => {
    const env = { ...SENTINELS, RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_MODEL_PROVIDER: 'anthropic', RS_ALLOW_SIGNUP: '0' };
    const secured = await startHarness({ env });
    try {
      assert.equal(secured.config.paymentProvider, 'paypal-sandbox', 'the sandbox configuration was accepted');
      for (const path of ['/api/config', '/api/health']) {
        const res = await secured.request({ path });
        assert.equal(res.status, 200, path);
        for (const [name, value] of Object.entries(SENTINELS)) {
          assert.equal(res.text.includes(value), false, `${path} leaks the value of ${name}`);
          assert.equal(res.text.includes(value.slice(0, 12)), false, `${path} leaks the start of ${name}`);
        }
        const offending = keysDeep(res.json).filter((k) => SECRET_KEY_NAME.test(k));
        assert.deepEqual(offending, [], `${path} has secret-like keys`);
      }
      const config = await secured.request({ path: '/api/config' });
      assert.equal(config.json.paymentProvider, 'paypal-sandbox');
      assert.equal(config.json.extractionProvider, 'fake', 'RS_TEST_OFFLINE=1 forces the fake extraction provider');
      assert.equal(config.json.signupEnabled, false);
      assert.equal(config.json.labels.sandbox, true);
      assert.equal(config.json.labels.simulatedPayments, false);
    } finally {
      await secured.close();
    }
  });

  test('NFR4: the same scan over the default configuration finds no secret-like keys and no token-shaped text', async () => {
    const res = await h.request({ path: '/api/config' });
    assert.deepEqual(keysDeep(res.json).filter((k) => SECRET_KEY_NAME.test(k)), []);
    assert.equal(/\b[A-Za-z0-9_-]{32,}\b/.test(res.text), false, 'no 32+ character token-shaped string');
  });

  test('NFR1: needs no session; a POST is refused with 405', async () => {
    const res = await h.request({ method: 'POST', path: '/api/config', jsonBody: {} });
    assert.equal(res.status, 405);
    assert.equal(res.json.error.code, 'METHOD_NOT_ALLOWED');
  });
});
