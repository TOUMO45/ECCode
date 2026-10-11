// RS-31(a): browser journey, the happy path with the fake PayPal adapter. A fresh customer signs up, asks for 200 cups and 200 lids,
// confirms the details, approves the A + B plan, reserves the stock, and (after both suppliers confirmed) pays: approves supplier A on
// the fake approval page, CANCELS the approval of supplier B (RS-18 path) and then tries again and approves it, completes the
// purchase, and, once the supplier marked the order ready, records the receipt. The journey ends with the plan executed.
// The app runs on http://localhost:<port> and the fake approval page on http://127.0.0.1:<port2> (cross-site); every approval
// round trip goes through the shared helper test/browser/helpers/approval-roundtrip.js (F-TR-14): the click is followed by
// waitForURL on the app origin, the server log shows exactly one GET /api/paypal/return per approval (one GET /api/paypal/cancel
// for the cancel) run as the session's user, and no "Content Security Policy" console message appears.
// Runs at 360 x 800 and 1280 x 800 in Chromium (Playwright). Each viewport starts its own server on a new database seeded with
// RS-FIX-1 because the buy uses supplier A's only bundle (test/browser/helpers/harness.js). Screenshots:
// test/browser/out/journey-happy-<width>.png and journey-happy-approvals-<width>.png. Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { userIdOf } from './helpers/db.js';
import { approvalRoundTrip, assertRoundTripTotals } from './helpers/approval-roundtrip.js';
import { confirmSupplierOrders, createConfirmedRequest, supplierAction } from './helpers/purchase.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { screenshotPath, takeScreenshot } from './helpers/screenshot.js';
import { waitFor } from '../helpers/payment-flow.js';

const SCREENSHOT_NAME = 'journey-happy';

async function pressWhenVisible(page, testid) {
  const button = page.locator(`[data-testid="${testid}"]`);
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
}

describe('RS-31(a): a customer buys the A + B plan through the fake PayPal approval page', () => {
  for (const viewport of VIEWPORTS) {
    test(`RS-31(a): at ${viewport.width}x${viewport.height} two approvals (one after a cancel) end with the plan executed and the receipt recorded`, async () => {
      const harness = await startBrowserHarness();
      try {
        assert.match(harness.publicUrl, /^http:\/\/localhost:\d+$/);
        const { page, problems } = await harness.newJourney(viewport);
        const customer = await signUpFreshCustomer(page, harness.publicUrl);
        const db0 = harness.openDb();
        const userId = userIdOf(db0, customer.username);
        db0.close();

        // 1. Request, details, plan, approval, reservation.
        const requestId = await createConfirmedRequest(page, { publicUrl: harness.publicUrl, demoDate: harness.demoDate });
        await pressWhenVisible(page, 'approve-plan');
        await pressWhenVisible(page, 'reserve');

        // 2. The suppliers confirm (API); the page then offers the PayPal approvals.
        const orders = await confirmSupplierOrders(harness);
        await page.waitForSelector('[data-testid="paypal-approve-A"]', { timeout: 20000 });
        assert.match(await page.textContent('[data-testid="paypal-A"]'), /PayPal approvals: 1 of 2 — Demo Supplier A|PayPal approvals: 1 of 2 — Supplier A/);
        assert.match(await page.textContent('[data-testid="paypal-approvals"]'), /Simulated/, 'the provider badge says Simulated');

        // 3. Approve supplier A.
        const approvedA = await approvalRoundTrip(page, {
          harness, userId, label: 'approve A', action: 'approve',
          trigger: () => page.click('[data-testid="paypal-approve-A"]'),
        });
        await page.waitForSelector('[data-testid="paypal-returned"]');

        // 4. Cancel supplier B's approval (RS-18 path): the browser comes back on /api/paypal/cancel with the session.
        const cancelledB = await approvalRoundTrip(page, {
          harness, userId, label: 'cancel B', action: 'cancel',
          trigger: () => page.click('[data-testid="paypal-approve-B"]'),
        });
        await page.waitForSelector('[data-testid="paypal-cancelled"]');
        assert.match(await page.textContent('[data-testid="paypal-cancelled"]'), /cancelled\. Nothing was paid/);
        assert.match(await page.textContent('[data-testid="paypal-approve-B"]'), /Try approval again/);
        await page.waitForSelector('[data-testid="abandon"]');
        const approvalsShot = await takeScreenshot(page, `${SCREENSHOT_NAME}-approvals`, viewport.width);
        assert.ok(existsSync(approvalsShot) && statSync(approvalsShot).size > 1000, `screenshot written: ${approvalsShot}`);

        // 5. Try again and approve supplier B.
        const approvedB = await approvalRoundTrip(page, {
          harness, userId, label: 'approve B (after cancel)', action: 'approve',
          trigger: () => page.click('[data-testid="paypal-approve-B"]'),
        });
        assert.notEqual(approvedB.requestId, cancelledB.requestId);
        assert.notEqual(approvedB.requestId, approvedA.requestId);

        // 6. Complete the purchase.
        await pressWhenVisible(page, 'execute');
        await page.waitForSelector('[data-testid="success-execute"]', { timeout: 20000 });
        assert.match(await page.textContent('[data-testid="success-execute"]'), /Purchase started/);
        const db = harness.openDb();
        try {
          await waitFor(() => db.prepare("SELECT 1 FROM plan_versions WHERE request_id = ? AND status = 'executed'").get(requestId), { what: 'the plan to be executed' });

          // 7. The supplier marks A ready; the customer records the receipt.
          await supplierAction(harness, 'A', orders.A, 'ready');
          await page.reload();
          await pressWhenVisible(page, 'receipt-A');
          await page.waitForSelector('[data-testid="success-receipt"]', { timeout: 20000 });
          assert.match(await page.textContent('[data-testid="success-receipt"]'), /Receipt recorded/);

          // 8. The purchase is real in the data: executed, captured, one capture per order with its deterministic request id.
          assert.equal(db.prepare('SELECT status FROM plan_versions WHERE request_id = ?').get(requestId).status, 'executed');
          assert.deepEqual(db.prepare('SELECT status FROM payment_operations ORDER BY supplier_order_id').all().map((r) => r.status), ['captured', 'captured']);
          assert.deepEqual(
            db.prepare("SELECT request_id AS id FROM fake_paypal_calls WHERE kind = 'capture' ORDER BY id").all().map((r) => r.id),
            [`so:${orders.A}:capture:1`, `so:${orders.B}:capture:1`],
          );
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pickup_confirmations').get().n, 1, 'the receipt is stored once');
        } finally {
          db.close();
        }

        // 9. The server log: two returns (A, B) and one cancel (B), no more; the page is healthy at this width.
        assertRoundTripTotals(harness.server, { approvals: 2, cancels: 1 });
        await page.waitForSelector('[data-testid="rescue-status"]');
        assert.match(await page.textContent('[data-testid="rescue-status"]'), /Purchase confirmed/i, 'the request page shows the executed purchase');
        const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        assert.ok(overflow.scroll <= overflow.inner, `no horizontal scroll at ${viewport.width}px: scrollWidth ${overflow.scroll} > ${overflow.inner}`);
        assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests during the journey');

        const path = await takeScreenshot(page, SCREENSHOT_NAME, viewport.width);
        assert.equal(path, screenshotPath(SCREENSHOT_NAME, viewport.width));
        assert.ok(existsSync(path) && statSync(path).size > 1000, `screenshot written: ${path}`);
      } finally {
        await harness.close();
      }
    });
  }
});
