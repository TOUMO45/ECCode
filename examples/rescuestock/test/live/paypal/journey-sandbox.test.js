// LIVE (opt-in, never run in the offline build): the Sandbox journeys, RS-31(b) and RS-32(b). Both need a HUMAN at the PayPal approval
// page (PayPal's login pages cannot be automated reliably), so they run on your machine with a Sandbox BUYER account.
//   RS-31(b)  RS_LIVE_PAYPAL_HEADED=1 opens a visible Chromium. The test drives the app (sign up, request, plan, reserve, the
//             suppliers confirm through the API) and clicks "Approve with PayPal"; YOU log in at PayPal Sandbox and approve (you
//             have 10 minutes per order). It then checks that the browser is back on the app origin with the session, the
//             purchase completes, and the plan is executed with captured Sandbox payments. Without RS_LIVE_PAYPAL_HEADED=1 it is
//             reported as SKIPPED (a headless browser cannot approve), never as passed.
//   RS-32(b)  The API variant of the replacement: both orders are approved by you at PayPal (links printed), the authorizations
//             are created through the return route, then the organiser's stock_depletion fault supersedes the plan and the
//             void rule voids the authorizations: PayPal must show both authorizations VOIDED and the old plan non_executable.
//             The approval of the REPLACEMENT plan is not exercised here (phase F's journey-replacement owns that UI).
// Refuses (exit 2) unless RS_LIVE_PAYPAL=1 and the Sandbox credentials are set. All money is Sandbox money.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../helpers/fixtures.js';
import { launchChromium } from '../../helpers/playwright.js';
import { waitFor } from '../../helpers/payment-flow.js';
import { userIdOf } from '../../browser/helpers/db.js';
import { confirmSupplierOrders, createConfirmedRequest } from '../../browser/helpers/purchase.js';
import { signUpFreshCustomer } from '../../browser/helpers/signup.js';
import { awaitBuyerApproval, createSuiteReport, liveTest, requireLive, reserveAndCreatePayments, sandbox, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('journey-sandbox', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

const TEN_MINUTES = 10 * 60_000;

liveTest(report, 'RS-31(b): a customer approves two PayPal Sandbox orders in a visible browser and the purchase is executed', async (_t, skip) => {
  if (process.env.RS_LIVE_PAYPAL_HEADED !== '1') {
    skip('RS_LIVE_PAYPAL_HEADED=1 is not set: a person must approve at PayPal Sandbox in a visible browser');
    return;
  }
  const publicUrl = app.server.env.RS_PUBLIC_URL;
  const appOrigin = new URL(publicUrl).origin;
  const browser = await launchChromium({ headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: publicUrl });
    const page = await context.newPage();
    const customer = await signUpFreshCustomer(page, publicUrl);
    const db = app.openDb();
    try {
      const userId = userIdOf(db, customer.username);
      const requestId = await createConfirmedRequest(page, { publicUrl, demoDate: app.demoDate });
      await page.locator('[data-testid="approve-plan"]').click({ timeout: 20000 });
      await page.locator('[data-testid="reserve"]').click({ timeout: 20000 });
      const orders = await confirmSupplierOrders({ server: app.server });
      assert.equal(Object.keys(orders).length, 2);
      for (const code of ['A', 'B']) {
        await page.locator(`[data-testid="paypal-approve-${code}"]`).click({ timeout: 30000 });
        process.stdout.write(`\n# Supplier ${code}: log in to PayPal Sandbox with your BUYER account and approve (10 minutes)\n`);
        await page.waitForURL((url) => url.origin === appOrigin, { timeout: TEN_MINUTES });
        assert.match(page.url(), /paypal=returned/);
        const returns = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment.return' AND outcome = 'ok' AND actor_user_id = ?").get(userId).n;
        assert.ok(returns >= 1, 'the return ran as the signed-in customer (the session cookie came back with the redirect)');
      }
      await page.locator('[data-testid="execute"]').click({ timeout: 60000 });
      await waitFor(() => db.prepare("SELECT 1 FROM plan_versions WHERE request_id = ? AND status = 'executed'").get(requestId), { what: 'the plan to be executed', timeoutMs: 180_000, intervalMs: 500 });
      assert.deepEqual(db.prepare('SELECT status FROM payment_operations ORDER BY supplier_order_id').all().map((r) => r.status), ['captured', 'captured']);
    } finally {
      db.close();
    }
  } finally {
    await browser.close();
  }
});

liveTest(report, 'RS-32(b): after a stock_depletion supersession PayPal shows both authorizations VOIDED and the old plan is non_executable', async () => {
  const { customer, plan, orders } = await reserveAndCreatePayments(app, launch, { label: 'rs32' });
  await awaitBuyerApproval(launch, orders.map((o) => ({ label: `supplier ${o.code}`, approvalUrl: o.approvalUrl, orderId: o.orderId, merchantKey: o.merchantKey })), { timeoutMs: TEN_MINUTES });
  for (const o of orders) {
    const ret = await customer.get(`/api/paypal/return?token=${encodeURIComponent(o.orderId)}`);
    assert.equal(ret.status, 303, ret.text);
  }
  const db = app.openDb();
  try {
    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'authorized'").get().n === orders.length, { what: 'both operations to be authorized', timeoutMs: 60_000 });
    const authIds = Object.fromEntries(orders.map((o) => [o.id, db.prepare('SELECT provider_authorization_id AS id FROM payment_operations WHERE supplier_order_id = ?').get(o.id).id]));

    const admin = createClient(app.server.request);
    await admin.signIn('admin', app.adminPassword);
    const fault = await admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'B' });
    assert.equal(fault.status, 200, fault.text);

    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'voided'").get().n === orders.length, { what: 'both operations to be voided', timeoutMs: 120_000, intervalMs: 500 });
    assert.equal(db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status, 'non_executable');
    for (const o of orders) {
      const auth = await sandbox(launch, o.merchantKey, 'GET', `/v2/payments/authorizations/${encodeURIComponent(authIds[o.id])}`);
      assert.equal(auth.json.status, 'VOIDED', `supplier ${o.code}: PayPal shows the authorization VOIDED`);
    }
  } finally {
    db.close();
  }
});
