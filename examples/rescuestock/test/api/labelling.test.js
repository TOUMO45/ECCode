// RS-34 [D] (spec: Conventions > Labels; Frontend labels; Security T18/SEC-3): everything that is not real is labelled in the API, for
// BOTH payment adapters.
//   fake adapter       payments carry provider "fake", simulated true, sandbox false; labels.simulatedPayments true
//   Sandbox adapter    payments carry provider "paypal-sandbox", simulated false, sandbox true; labels.sandbox true, merchantMode
//                      single-credential (one DEFAULT merchant), the canonical single-credential notice
//                      The Sandbox adapter here talks to the loopback stub (test/helpers/paypal-stub.js), which is allowed ONLY under
//                      RS_TEST_OFFLINE=1; that mode also sets labels.testMode and the UI banner "Test mode — local stubs, nothing is
//                      real" in addition to the adapter badge (SEC-3). Nothing here contacts a PayPal host.
//   both               extraction objects carry provider and simulated (the model is the fake offline); suppliers, offers and plan lines
//                      carry demo true; every response with seeded prices carries labels.priceNotice "Test prices, not market prices";
//                      config refuses a loopback PayPal base URL without RS_TEST_OFFLINE=1 and refuses the live host with it.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DEMO_PASSWORD, startHarness, testEnv } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { startPaypalStub } from '../helpers/paypal-stub.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DAY = '2026-10-20';
const PRICE_NOTICE = 'Test prices, not market prices';
const BANNER_TEST_MODE = 'Test mode — local stubs, nothing is real';
const SINGLE_CREDENTIAL = 'All demo suppliers are paid to one Sandbox account';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
const stubs = [];
after(async () => {
  for (const h of harnesses) await h.close();
  for (const s of stubs) await s.close();
});

async function startFake() {
  const h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
  harnesses.push(h);
  return { h, stub: null };
}

async function startSandbox() {
  const stub = await startPaypalStub();
  stubs.push(stub);
  const h = await startHarness({
    seed: true,
    env: {
      RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
      RS_PAYMENT_PROVIDER: 'paypal-sandbox',
      RS_PAYPAL_BASE_URL: stub.baseUrl,
      RS_PAYPAL_DEFAULT_CLIENT_ID: stub.merchants.DEFAULT.clientId,
      RS_PAYPAL_DEFAULT_CLIENT_SECRET: stub.merchants.DEFAULT.clientSecret,
      RS_PAYPAL_DEFAULT_WEBHOOK_ID: stub.merchants.DEFAULT.webhookId,
    },
  });
  harnesses.push(h);
  stub.appOrigin = `http://localhost:${h.port}`;
  return { h, stub };
}

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

// cafe1 with an approved, reserved plan and A's order confirmed; then A's PayPal order is created.
async function paymentWorld(h) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o]));
  const supplierA = await signIn(h, 'supplier-a');
  const confirmed = await supplierA.post(`/api/supplier/orders/${orders.A.id}/confirm`, { lines: [{ offerId: 1, committedBundles: 1 }], committedReadyAt: READY.A });
  assert.equal(confirmed.status, 200, confirmed.text);
  const created = await cafe1.post(`/api/orders/${orders.A.id}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  return { cafe1, requestId, plan, orders, created, supplierA };
}

function fetchText(h, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: h.port, path, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ADAPTERS = Object.freeze([
  {
    name: 'fake adapter',
    start: startFake,
    labels: { simulatedPayments: true, simulatedExtraction: true, sandbox: false, demoData: true, priceNotice: PRICE_NOTICE, merchantMode: 'per-supplier', singleCredentialNotice: null, testMode: true },
    payment: { provider: 'fake', simulated: true, sandbox: false, merchantMode: 'per-supplier' },
    paymentProvider: 'fake',
  },
  {
    name: 'Sandbox adapter against the loopback stub',
    start: startSandbox,
    labels: { simulatedPayments: false, simulatedExtraction: true, sandbox: true, demoData: true, priceNotice: PRICE_NOTICE, merchantMode: 'single-credential', singleCredentialNotice: SINGLE_CREDENTIAL, testMode: true },
    payment: { provider: 'paypal-sandbox', simulated: false, sandbox: true, merchantMode: 'single-credential' },
    paymentProvider: 'paypal-sandbox',
  },
]);

for (const adapter of ADAPTERS) {
  describe(`RS-34 [D]: ${adapter.name}`, () => {
    test('RS-34: GET /api/config carries the exact label set for this adapter, the price notice and testMode (RS_TEST_OFFLINE=1)', async () => {
      const { h } = await adapter.start();
      const res = await createClient(h.request).get('/api/config');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.labels, adapter.labels);
      assert.equal(res.json.paymentProvider, adapter.paymentProvider);
      assert.equal(res.json.extractionProvider, 'fake', 'the offline model is the labelled fake');
    });

    test('RS-34: every payment object (create answer and request view) carries provider, simulated and sandbox for this adapter, never the other adapter\'s', async () => {
      const { h } = await adapter.start();
      const w = await paymentWorld(h);
      const pay = w.created.json.payment;
      for (const [key, value] of Object.entries(adapter.payment)) assert.equal(pay[key], value, `payment.${key} in the create answer`);
      const view = await w.cafe1.get(`/api/requests/${w.requestId}`);
      assert.equal(view.status, 200, view.text);
      assert.equal(view.json.orders.length, 2);
      for (const order of view.json.orders.filter((o) => o.payment !== null)) {
        for (const [key, value] of Object.entries(adapter.payment)) assert.equal(order.payment[key], value, `orders[${order.supplier.code}].payment.${key} in the request view`);
      }
      assert.deepEqual(view.json.labels, adapter.labels, 'the request view repeats the label set');
      // simulated and sandbox are never both true
      for (const order of view.json.orders.filter((o) => o.payment !== null)) assert.equal(order.payment.simulated && order.payment.sandbox, false);
    });

    test('RS-34: the approval link of this adapter points at its own page (the fake listener or the loopback stub), on 127.0.0.1 and never a PayPal host', async () => {
      const { h, stub } = await adapter.start();
      const w = await paymentWorld(h);
      const url = new URL(w.created.json.approvalUrl);
      assert.equal(url.hostname, '127.0.0.1');
      assert.doesNotMatch(url.hostname, /paypal\.com$/);
      if (stub) assert.equal(url.port, String(new URL(stub.baseUrl).port), 'the Sandbox adapter\'s approval page is the stub\'s');
      else assert.match(url.pathname, /^\/fake-paypal\/checkout\/FAKE-[0-9a-f]{32}$/);
    });

    test('RS-34: suppliers, offers and plan lines carry demo true, every response with seeded prices carries the price notice, and the extraction is labelled simulated', async () => {
      const { h } = await adapter.start();
      const cafe1 = await signIn(h, 'cafe1');
      h.clock.advance(61_000);
      const created = await cafe1.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
      assert.equal(created.status, 201, created.text);
      const requestId = created.json.request.id;
      const extracted = await cafe1.post(`/api/requests/${requestId}/extract`, {});
      assert.equal(extracted.status, 200, extracted.text);
      assert.equal(extracted.json.extraction.simulated, true);
      assert.equal(extracted.json.extraction.provider, 'fake');
      const { requestId: planRequestId, plan } = await approvedPlan(cafe1, DAY);
      assert.ok(plan.body.lines.length >= 1);
      for (const line of plan.body.lines) assert.equal(line.demo, true, `plan line of supplier ${line.supplierCode}`);
      const planAnswer = await cafe1.get(`/api/requests/${requestId}`);
      assert.equal(planAnswer.status, 200, planAnswer.text);
      assert.equal(planAnswer.json.labels.priceNotice, PRICE_NOTICE, 'a request view without a plan still carries the notice');
      const reserved = await reserve(cafe1, plan.id, idempotencyKey(`labels-${plan.id}`));
      assert.equal(reserved.status, 201, reserved.text);
      for (const order of reserved.json.orders) assert.equal(order.supplier.demo, true, `order supplier ${order.supplier.code}`);
      const view = await cafe1.get(`/api/requests/${planRequestId}`);
      assert.equal(view.status, 200, view.text);
      assert.equal(view.json.labels.priceNotice, PRICE_NOTICE);
      assert.equal(view.json.labels.demoData, true);
      const supplier = await signIn(h, 'supplier-a');
      const inventory = await supplier.get('/api/supplier/inventory');
      assert.equal(inventory.status, 200, inventory.text);
      assert.ok(inventory.json.items.length >= 1);
      for (const item of inventory.json.items) assert.equal(item.demo, true, 'inventory item');
      assert.deepEqual(inventory.json.labels, adapter.labels, 'the supplier\'s price list repeats the label set, price notice included');
    });

    test('RS-34 / SEC-3: the page the server sends carries the test-mode banner text and the adapter badge texts in its UI constants', async () => {
      const { h } = await adapter.start();
      const texts = await fetchText(h, '/js/texts.js');
      assert.equal(texts.status, 200);
      assert.ok(texts.text.includes(BANNER_TEST_MODE), 'the persistent test-mode banner text is shipped');
      assert.ok(texts.text.includes(PRICE_NOTICE));
      assert.ok(texts.text.includes('PayPal Sandbox — no real money'));
      assert.ok(texts.text.includes('Simulated payments and/or AI — nothing here is real'));
    });
  });
}

describe('RS-34 / T18: a loopback or live PayPal base URL is refused unless it is the Sandbox host or a stub under RS_TEST_OFFLINE=1', () => {
  const dir = mkdtempSync(`${tmpdir()}/rs-labelling-`);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const creds = { RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'AaStubClientId0001', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'EeStubClientSecret0001', RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'WH-STUB-0001' };
  const config = (overrides) => loadConfig({ ...testEnv(dir), ...creds, ...overrides });

  test('RS-34: a loopback base URL without RS_TEST_OFFLINE=1 refuses startup, naming the variable and not a secret', () => {
    assert.throws(
      () => config({ RS_TEST_OFFLINE: undefined, RS_PAYPAL_BASE_URL: 'http://127.0.0.1:9' }),
      (err) => err instanceof ConfigError && /RS_PAYPAL_BASE_URL/.test(err.message) && !err.message.includes(creds.RS_PAYPAL_DEFAULT_CLIENT_SECRET),
    );
  });

  test('RS-34: the live PayPal host is refused even with RS_TEST_OFFLINE=1; the loopback stub is accepted with it and sets testMode', () => {
    assert.throws(() => config({ RS_PAYPAL_BASE_URL: 'https://api-m.paypal.com' }), (err) => err instanceof ConfigError && /RS_PAYPAL_BASE_URL/.test(err.message));
    const ok = config({ RS_PAYPAL_BASE_URL: 'http://127.0.0.1:9' });
    assert.equal(ok.testMode, true);
    assert.equal(ok.paymentProvider, 'paypal-sandbox');
  });

  test('RS-34: the default Sandbox host needs no flag and does not set testMode when the offline switch is off', () => {
    const ok = config({ RS_TEST_OFFLINE: undefined, RS_MODEL_PROVIDER: 'fake' });
    assert.equal(ok.paymentProvider, 'paypal-sandbox');
    assert.equal(ok.testMode, false);
    assert.match(ok.paypalBaseUrl, /^https:\/\/api-m\.sandbox\.paypal\.com\/?$/);
  });
});
