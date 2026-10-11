// RS-34 [B] (spec: Frontend labels; Security T18/SEC-3): everything that is not real is labelled on screen, for BOTH payment adapters,
// at 360 x 800 and 1280 x 800, rendered by Chromium.
//   fake adapter          banner "Simulated payments and/or AI — nothing here is real", badge "Simulated" on every payment element,
//                         no "PayPal Sandbox" badge anywhere
//   Sandbox adapter       the adapter runs against the loopback stub (test/helpers/paypal-stub.js; allowed only with RS_TEST_OFFLINE=1,
//                         which the harness sets): badge "PayPal Sandbox — no real money" on every payment element, the single-credential
//                         banner, and NO "Simulated" badge on a payment element (the model is still the fake, so the page banner still
//                         says simulated AI)
//   both                  the persistent banner "Test mode — local stubs, nothing is real" on every route (anonymous, customer,
//                         supplier, admin); "Demo data" badges and "Test prices, not market prices" wherever seeded prices show; the
//                         approval page the click lands on is the provider's own simulation (fake page or stub page) on 127.0.0.1;
//                         the admin screen names the payment provider in each section; the forced-reset result is worded per adapter
//                         (g1's unverified item: until now only unit-tested on a fake DOM)
// A customer registered through the API drives the purchase; the page is opened signed in as that customer. Each adapter and
// viewport starts a server of its own. Screenshots: test/browser/out/labelling-<adapter>-<width>.png. Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { approvalRoundTrip, assertRoundTripTotals } from './helpers/approval-roundtrip.js';
import { armFakeFault, executePurchase, operationOf, payFor, registerApiCustomer, reserveForCustomer } from './helpers/api-purchase.js';
import { assertAccessible } from './helpers/a11y-audit.js';
import { BROWSER_ADMIN_PASSWORD, RECOVERY_ENV, assertNoOverflow, signInThroughUi, testIdsOf } from './helpers/recovery.js';
import { takeScreenshot } from './helpers/screenshot.js';
import { SEED_PASSWORD } from '../helpers/server-proc.js';
import { startPaypalStub } from '../helpers/paypal-stub.js';

const BANNER_SIMULATED = 'Simulated payments and/or AI — nothing here is real';
const BANNER_TEST_MODE = 'Test mode — local stubs, nothing is real';
const SANDBOX_BADGE = 'PayPal Sandbox — no real money';
const SINGLE_CREDENTIAL = 'All demo suppliers are paid to one Sandbox account';
const PRICE_NOTICE = 'Test prices, not market prices';
const RESET_INTRO = Object.freeze({
  fake: "The forced reset cleared the simulated provider's records, so there is nothing to check outside RescueStock. These payments were not finished when the reset ran.",
  'sandbox-stub': 'These payments were not finished when the reset ran. The Sandbox adapter was talking to a local stub (test mode), so there is nothing to check outside RescueStock.',
});

const ADAPTERS = Object.freeze([
  { name: 'fake', sandbox: false },
  { name: 'sandbox-stub', sandbox: true },
]);

const texts = (page, testid) => page.locator(`[data-testid="${testid}"]`).allTextContents().then((all) => all.map((t) => t.trim()));

// The banner lines of the page, by test id.
async function bannerOf(page) {
  await page.waitForSelector('[data-testid="banner-test-mode"]');
  return {
    simulated: await texts(page, 'banner-simulated'),
    testMode: await texts(page, 'banner-test-mode'),
    singleCredential: await texts(page, 'banner-single-credential'),
  };
}

function assertBanner(banner, adapter, where) {
  assert.deepEqual(banner.simulated, [BANNER_SIMULATED], `${where}: the simulated banner (the model is the fake offline)`);
  assert.deepEqual(banner.testMode, [BANNER_TEST_MODE], `${where}: the test-mode banner is persistent`);
  assert.deepEqual(banner.singleCredential, adapter.sandbox ? [SINGLE_CREDENTIAL] : [], `${where}: the single-credential banner only for the Sandbox adapter`);
}

async function paymentBadges(page, scopeTestId) {
  const scope = page.locator(`[data-testid="${scopeTestId}"]`);
  return {
    simulated: await scope.locator('[data-testid="badge-simulated"]').allTextContents(),
    sandbox: await scope.locator('[data-testid="badge-sandbox"]').allTextContents(),
  };
}

// `count` payment elements (one per order, or one for a section line) each carry the adapter's badge text and not the other's.
function assertPaymentBadges(badges, adapter, where, count = 1) {
  const expected = Array.from({ length: count }, () => (adapter.sandbox ? SANDBOX_BADGE : 'Simulated'));
  if (adapter.sandbox) {
    assert.deepEqual(badges.sandbox.map((t) => t.trim()), expected, `${where}: the Sandbox badge on every payment element`);
    assert.deepEqual(badges.simulated, [], `${where}: a Sandbox payment is not labelled Simulated`);
  } else {
    assert.deepEqual(badges.simulated.map((t) => t.trim()), expected, `${where}: the Simulated badge on every payment element`);
    assert.deepEqual(badges.sandbox, [], `${where}: a fake payment never claims to be the Sandbox`);
  }
}

describe('RS-34 [B]: everything that is not real is labelled, for both payment adapters', () => {
  for (const adapter of ADAPTERS) {
    for (const viewport of VIEWPORTS) {
      test(`RS-34: ${adapter.name} adapter at ${viewport.width}x${viewport.height}: banners on every route, payment badges, demo data and price notice, the provider's own approval page, the admin provider lines and the forced-reset wording`, async () => {
        const stub = adapter.sandbox ? await startPaypalStub() : null;
        let harness;
        try {
          harness = await startBrowserHarness({
            env: {
              ...RECOVERY_ENV,
              ...(stub
                ? {
                  RS_PAYMENT_PROVIDER: 'paypal-sandbox',
                  RS_TEST_HOOKS: undefined, // the test hooks are refused with the Sandbox adapter (config), so this server runs without them
                  RS_PAYPAL_BASE_URL: stub.baseUrl,
                  RS_PAYPAL_DEFAULT_CLIENT_ID: stub.merchants.DEFAULT.clientId,
                  RS_PAYPAL_DEFAULT_CLIENT_SECRET: stub.merchants.DEFAULT.clientSecret,
                  RS_PAYPAL_DEFAULT_WEBHOOK_ID: stub.merchants.DEFAULT.webhookId,
                }
                : {}),
            },
          });
          if (stub) stub.appOrigin = harness.publicUrl;
          const config = await harness.server.request({ path: '/api/config' });
          assert.equal(config.json.paymentProvider, adapter.sandbox ? 'paypal-sandbox' : 'fake');
          assert.equal(config.json.labels.testMode, true, 'RS_TEST_OFFLINE=1 puts the server in test mode');

          // ---- anonymous: the banners are there before anybody signs in
          const anonymous = await harness.newJourney(viewport);
          await anonymous.page.goto(`${harness.publicUrl}/#/signin`);
          assertBanner(await bannerOf(anonymous.page), adapter, 'sign-in page');
          assert.deepEqual(anonymous.problems, []);

          // ---- the customer's page: price notice, demo data, payment badges
          const customer = await registerApiCustomer(harness, `lab${adapter.sandbox ? 's' : 'f'}`);
          const purchase = await reserveForCustomer(harness, customer);
          const { page, problems } = await harness.newJourney(viewport);
          await signInThroughUi(page, harness.publicUrl, customer.username, customer.password);
          await page.goto(`${harness.publicUrl}/#/requests/${purchase.requestId}`);
          await page.waitForSelector('[data-testid="paypal-approve-A"]', { timeout: 20000 });
          assertBanner(await bannerOf(page), adapter, 'request page');
          assert.equal((await page.textContent('[data-testid="price-notice"]')).trim(), PRICE_NOTICE, 'seeded prices carry the notice');
          assert.ok((await page.locator('[data-testid="plan-lines"] [data-testid="badge-demo"]').count()) >= 2, 'each plan line shows the Demo data badge');
          assert.equal((await texts(page, 'badge-demo')).every((t) => t === 'Demo data'), true);
          assertPaymentBadges(await paymentBadges(page, 'paypal-approvals'), adapter, 'PayPal approvals', 2);
          assertPaymentBadges(await paymentBadges(page, 'failure-list'), adapter, 'If something fails', 2);
          assert.equal((await testIdsOf(page, 'single-credential-notice')).length, adapter.sandbox ? 1 : 0);
          await assertAccessible(page, { width: viewport.width, label: `${adapter.name} request page` });
          const shot = await takeScreenshot(page, `labelling-${adapter.name}`, viewport.width);
          assert.ok(existsSync(shot) && statSync(shot).size > 1000, `screenshot written: ${shot}`);

          // ---- the click lands on the provider's own simulation, on 127.0.0.1, and comes back with the session
          await approvalRoundTrip(page, {
            harness, userId: customer.id, label: `approve A (${adapter.name})`, action: 'approve', stub: adapter.sandbox,
            trigger: () => page.click('[data-testid="paypal-approve-A"]'),
          });
          assertRoundTripTotals(harness.server, { approvals: 1, cancels: 0 });

          // ---- supplier and admin screens carry the same banners, demo data and price notice
          const supplierSide = await harness.newJourney(viewport);
          await signInThroughUi(supplierSide.page, harness.publicUrl, 'supplier-c', SEED_PASSWORD);
          await supplierSide.page.goto(`${harness.publicUrl}/#/supplier/inventory`);
          await supplierSide.page.waitForSelector('[data-testid="price-notice"]');
          assertBanner(await bannerOf(supplierSide.page), adapter, 'supplier inventory');
          assert.equal((await supplierSide.page.textContent('[data-testid="price-notice"]')).trim(), PRICE_NOTICE);
          assert.ok((await supplierSide.page.locator('[data-testid="badge-demo"]').count()) >= 1, 'demo data badge on the supplier screen');
          assert.deepEqual(supplierSide.problems, []);

          // ---- a capture that stays PENDING, so the forced reset has something it cannot settle
          await payFor(customer, purchase, 'B');
          if (stub) stub.fault('capture_pending', { count: 1 });
          else await armFakeFault(harness, 'capture_pending', 'A');
          const operationA = purchase.orders.A;
          await executePurchase(harness, customer, purchase, { until: (db) => operationOf(db, operationA) === 'capture_pending' });

          const adminSide = await harness.newJourney(viewport);
          adminSide.page.on('dialog', (dialog) => dialog.accept());
          await signInThroughUi(adminSide.page, harness.publicUrl, 'admin', BROWSER_ADMIN_PASSWORD);
          await adminSide.page.goto(`${harness.publicUrl}/#/admin`);
          await adminSide.page.waitForSelector('[data-testid="reset-form"]');
          assertBanner(await bannerOf(adminSide.page), adapter, 'admin screen');
          for (const section of ['admin-reset', 'admin-faults', 'admin-timeline', 'admin-metrics']) {
            const badges = await paymentBadges(adminSide.page, `provider-${section}`);
            assertPaymentBadges(badges, adapter, `admin ${section}`);
          }
          await adminSide.page.check('#reset-force');
          await adminSide.page.fill('#reset-reason', 'Browser check: one capture is still pending at the provider');
          await adminSide.page.click('[data-testid="reset-submit"]');
          await adminSide.page.waitForSelector('[data-testid="reset-stranded"]', { timeout: 40000 });
          const resetText = await adminSide.page.textContent('[data-testid="reset-done"]');
          assert.ok(resetText.includes(RESET_INTRO[adapter.name]), `the forced-reset intro for the ${adapter.name} adapter, got: ${resetText}`);
          const otherIntro = RESET_INTRO[adapter.sandbox ? 'fake' : 'sandbox-stub'];
          assert.equal(resetText.includes(otherIntro), false, 'and not the other adapter\'s wording');
          if (!adapter.sandbox) assert.equal(resetText.includes('PayPal Sandbox dashboard'), false, 'the fake adapter never sends the operator to a Sandbox dashboard');
          assert.match(await adminSide.page.textContent('[data-testid="reset-stranded"]'), /Operation \d+: capture_pending, .*plan executing/);
          await assertNoOverflow(adminSide.page, viewport.width);
          await takeScreenshot(adminSide.page, `labelling-${adapter.name}-reset`, viewport.width);
          assert.deepEqual(adminSide.problems, []);
          assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests on the customer page');
        } finally {
          if (harness) await harness.close();
          if (stub) await stub.close();
        }
      });
    }
  }
});
