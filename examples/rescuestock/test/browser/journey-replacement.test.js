// RS-32(a) (browser): the replacement journey. The stock of supplier B is depleted (the admin fault) before B confirms. The approved A + B plan
// is superseded under the void rule, the buyer reviews and approves the A + E plan ($95.00) and completes the purchase through collection.
//   1. A fresh customer signs up, asks for 200 cups and 200 lids, confirms the details, approves the A + B plan ($84.00) and reserves it.
//   2. Supplier A confirms (API); supplier B does not. The customer approves A's payment on the fake approval page: A is authorized.
//   3. The admin fault stock_depletion for B withdraws B's offers. The old plan is superseded with a void for A's authorization and B's
//      order is cancelled; the reconciler drains the re-plan queue (at most one 300 ms interval later) and the page, polling by itself,
//      offers "Review the new plan": a proposed plan from A and E at $95.00.
//   4. The customer approves the new plan and reserves it; A and E confirm; the customer approves both payments (two more trips to the fake
//      approval page), completes the purchase; A and E mark their orders ready and record the handover, the customer records both
//      receipts and the request reads "Collected".
//   Every approval goes through the shared approval round-trip helper (F-TR-14): the click is followed by waitForURL on the app origin, exactly
//   one GET /api/paypal/return per approval run as the session's user, no "Content Security Policy" message. Three approvals in all.
//   Data checks: old plan superseded (OFFER_WITHDRAWN) with one void for A's first authorization, B's order cancelled, the old reservation
//   released; the new plan executed with one capture per order under so:<id>:capture:1; every order collected.
// Runs at 360 x 800 and 1280 x 800 in Chromium; each viewport starts a server of its own on a new database. Screenshots:
// test/browser/out/journey-replacement-<width>.png. Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { userIdOf } from './helpers/db.js';
import { approvalRoundTrip, assertRoundTripTotals } from './helpers/approval-roundtrip.js';
import { confirmSupplierOrders, createConfirmedRequest, supplierAction } from './helpers/purchase.js';
import { RECOVERY_ENV, adminClient, assertNoOverflow, orderIdOf, planLinesShown, waitForText } from './helpers/recovery.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { takeScreenshot } from './helpers/screenshot.js';
import { waitFor } from '../helpers/payment-flow.js';

async function pressWhenVisible(page, testid) {
  const button = page.locator(`[data-testid="${testid}"]`);
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
}

describe('RS-32(a): stock depletion of B before B confirms: the A + E plan is approved and the purchase is collected', () => {
  for (const viewport of VIEWPORTS) {
    test(`RS-32(a): at ${viewport.width}x${viewport.height} the old plan is superseded with a void, B is cancelled, the A + E plan ($95.00) is bought and collected`, async () => {
      const harness = await startBrowserHarness({ env: RECOVERY_ENV });
      try {
        const { page, problems } = await harness.newJourney(viewport);
        const customer = await signUpFreshCustomer(page, harness.publicUrl);
        const db = harness.openDb();
        try {
          const userId = userIdOf(db, customer.username);

          // 1. The first plan: A + B for $84.00, approved and reserved.
          const requestId = await createConfirmedRequest(page, { publicUrl: harness.publicUrl, demoDate: harness.demoDate });
          await pressWhenVisible(page, 'approve-plan');
          await pressWhenVisible(page, 'reserve');
          await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
          const oldPlan = db.prepare('SELECT id, total_cents AS total FROM plan_versions WHERE request_id = ?').get(requestId);
          assert.equal(oldPlan.total, 8400);
          const oldOrderA = orderIdOf(db, requestId, 'A');
          const oldOrderB = orderIdOf(db, requestId, 'B');

          // 2. A confirms and the buyer approves A's payment. B has not confirmed.
          await confirmSupplierOrders(harness, ['A']);
          await page.waitForSelector('[data-testid="paypal-approve-A"]', { timeout: 20000 });
          await approvalRoundTrip(page, {
            harness, userId, label: 'approve A (first plan)', action: 'approve',
            trigger: () => page.click('[data-testid="paypal-approve-A"]'),
          });
          await waitFor(() => db.prepare("SELECT 1 FROM payment_operations WHERE supplier_order_id = ? AND status = 'authorized'").get(oldOrderA), { what: "A's first authorization" });

          // 3. B's stock is depleted. The old plan is superseded under the void rule; the page offers the new plan by itself.
          const admin = await adminClient(harness);
          const depleted = await admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'B' });
          assert.equal(depleted.status, 200, depleted.text);
          assert.deepEqual(depleted.json.applied, { kind: 'stock_depletion', supplierCode: 'B' });
          assert.deepEqual(depleted.json.superseded, [oldPlan.id], 'the depletion superseded exactly the approved A + B plan');
          await waitForText(page, 'next-step-action', /^Review the new plan$/);
          const lines = await planLinesShown(page);
          assert.deepEqual(Object.keys(lines).sort(), ['A', 'E'], 'the new plan buys from A and E');
          assert.match(await page.textContent('[data-testid="total-overall"]'), /\$95\.00/, 'the new plan costs $95.00');
          const afterDepletion = db.prepare('SELECT id, status, supersede_reason AS reason, total_cents AS total FROM plan_versions WHERE id = ?').get(oldPlan.id);
          assert.deepEqual({ status: afterDepletion.status, reason: afterDepletion.reason }, { status: 'superseded', reason: 'OFFER_WITHDRAWN' });
          assert.equal(db.prepare('SELECT status FROM payment_operations WHERE supplier_order_id = ?').get(oldOrderA).status, 'voided', "A's first authorization was voided");
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'void' AND status = 'succeeded'").get().n, 1, 'one void');
          assert.equal(db.prepare('SELECT fulfilment_status AS s FROM supplier_orders WHERE id = ?').get(oldOrderB).s, 'cancelled', "B's order was cancelled");
          assert.equal(db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(oldPlan.id).status, 'released');
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE kind = 'capture'").get().n, 0, 'no money was taken');
          await takeScreenshot(page, 'journey-replacement-review', viewport.width);

          // 4. Review, approve, reserve; A and E confirm; the buyer approves both payments.
          await page.locator('[data-testid="next-step-action"]').click();
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'section-why-title', 'focus moved to "Why this plan"');
          const newPlan = db.prepare("SELECT id, total_cents AS total FROM plan_versions WHERE request_id = ? AND status = 'proposed'").get(requestId);
          assert.equal(newPlan.total, 9500);
          await pressWhenVisible(page, 'approve-plan');
          await page.waitForSelector('[data-testid="success-approve"]', { timeout: 20000 });
          await pressWhenVisible(page, 'reserve');
          await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
          const orders = await confirmSupplierOrders(harness, ['A', 'E']);
          assert.notEqual(orders.A, oldOrderA, 'A has a new order on the new plan');
          for (const code of ['A', 'E']) {
            await page.waitForSelector(`[data-testid="paypal-approve-${code}"]`, { timeout: 20000 });
            await approvalRoundTrip(page, {
              harness, userId, label: `approve ${code} (new plan)`, action: 'approve',
              trigger: () => page.click(`[data-testid="paypal-approve-${code}"]`),
            });
            await waitFor(() => db.prepare("SELECT 1 FROM payment_operations WHERE supplier_order_id = ? AND status = 'authorized'").get(orders[code]), { what: `${code}'s authorization` });
          }

          // 5. Complete the purchase; the suppliers mark ready; the buyer collects.
          await pressWhenVisible(page, 'execute');
          await page.waitForSelector('[data-testid="success-execute"]', { timeout: 20000 });
          await waitFor(() => db.prepare("SELECT 1 FROM plan_versions WHERE id = ? AND status = 'executed'").get(newPlan.id), { what: 'the new plan to be executed' });
          for (const code of ['A', 'E']) {
            await supplierAction(harness, code, orders[code], 'ready');
            await supplierAction(harness, code, orders[code], 'handover');
          }
          await page.reload();
          for (const code of ['A', 'E']) {
            await pressWhenVisible(page, `receipt-${code}`);
            await waitFor(() => db.prepare("SELECT 1 FROM pickup_confirmations WHERE supplier_order_id = ? AND kind = 'receipt'").get(orders[code]), { what: `the receipt for ${code}` });
          }
          await waitForText(page, 'rescue-status', /^\s*Collected\s*$/);

          // The purchase in the data: superseded plan closed, new plan executed and collected, one capture per new order.
          assert.deepEqual(
            db.prepare("SELECT id, status FROM plan_versions WHERE request_id = ? ORDER BY id").all(requestId).map((p) => p.status),
            ['superseded', 'executed'],
          );
          assert.deepEqual(db.prepare('SELECT fulfilment_status AS s FROM supplier_orders WHERE id IN (?, ?) ORDER BY id').all(orders.A, orders.E).map((o) => o.s), ['collected', 'collected']);
          assert.deepEqual(
            db.prepare("SELECT request_id AS id FROM fake_paypal_calls WHERE kind = 'capture' ORDER BY id").all().map((r) => r.id).sort(),
            [`so:${orders.A}:capture:1`, `so:${orders.E}:capture:1`].sort(),
            'one capture per order of the new plan',
          );
          assert.equal(db.prepare('SELECT status FROM payment_operations WHERE supplier_order_id = ?').get(oldOrderA).status, 'voided', "the first plan's authorization stayed voided");
          assertRoundTripTotals(harness.server, { approvals: 3, cancels: 0 });
        } finally {
          db.close();
        }

        await assertNoOverflow(page, viewport.width);
        assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests during the journey');
        const shot = await takeScreenshot(page, 'journey-replacement', viewport.width);
        assert.ok(existsSync(shot) && statSync(shot).size > 1000, `screenshot written: ${shot}`);
      } finally {
        await harness.close();
      }
    });
  }
});
