// RS-17 (browser): a supplier refuses its order after the buyer approved the other supplier's payment. The buyer is told why, the money
// held for the other supplier is voided, the page offers "Review the new plan", and the new plan leaves the refusing supplier out.
//   1. A fresh customer signs up, asks for 200 cups and 200 lids, confirms the details, approves the A + B plan ($84.00) and reserves it.
//   2. Supplier B confirms (API); the customer approves B on the fake approval page (shared approval round-trip helper, F-TR-14).
//   3. Supplier A signs in through the UI and refuses its order with a reason (the form has no confirm dialog).
//   4. The customer page, polling by itself, shows: the refusal message with the supplier's reason, "No money was taken" truth about
//      the voided authorization under "If something fails" (the reason is shown there too), and, once the reconciler drained the re-plan
//      queue (at most one 300 ms interval later), the next step "Review the new plan" with a new proposed plan from B + E.
//   5. "Review the new plan" moves keyboard focus to "Why this plan"; the new plan is approved and its stock reserved.
//   Data checks: the old plan is non_executable (SUPPLIER_REFUSED), the old orders are refused/cancelled, B's authorization was voided
//   once, nothing was captured, the old reservation was released; the server log shows exactly one return (B's approval).
// Runs at 360 x 800 and 1280 x 800 in Chromium; each viewport starts a server of its own on a new database (supplier A's only bundle is
// reserved by the first plan). Screenshots: test/browser/out/refusal-<width>.png. Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { userIdOf } from './helpers/db.js';
import { approvalRoundTrip, assertRoundTripTotals } from './helpers/approval-roundtrip.js';
import { confirmSupplierOrders, createConfirmedRequest } from './helpers/purchase.js';
import { RECOVERY_ENV, assertNoOverflow, orderIdOf, planLinesShown, refuseThroughUi, signInThroughUi, testIdsOf, waitForText } from './helpers/recovery.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { takeScreenshot } from './helpers/screenshot.js';
import { SEED_PASSWORD } from '../helpers/server-proc.js';
import { waitFor } from '../helpers/payment-flow.js';

const REASON = 'Out of lids';
const REFUSAL_MESSAGE = `Supplier A refused the order: ${REASON}. No money was taken.`;

async function pressWhenVisible(page, testid) {
  const button = page.locator(`[data-testid="${testid}"]`);
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
}

describe('RS-17: a supplier refuses; the buyer sees the reason, "Review the new plan" and a new plan without that supplier', () => {
  for (const viewport of VIEWPORTS) {
    test(`RS-17: at ${viewport.width}x${viewport.height} the refusal reason, the voided authorization, "Review the new plan" and the B + E plan are shown`, async () => {
      const harness = await startBrowserHarness({ env: RECOVERY_ENV });
      try {
        const { page, problems } = await harness.newJourney(viewport);
        const customer = await signUpFreshCustomer(page, harness.publicUrl);
        const db = harness.openDb();
        try {
          const userId = userIdOf(db, customer.username);

          // 1. Request, plan, approval, reservation.
          const requestId = await createConfirmedRequest(page, { publicUrl: harness.publicUrl, demoDate: harness.demoDate });
          await pressWhenVisible(page, 'approve-plan');
          await pressWhenVisible(page, 'reserve');
          await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
          const oldPlan = db.prepare('SELECT id, plan_hash AS hash, total_cents AS total FROM plan_versions WHERE request_id = ?').get(requestId);
          assert.equal(oldPlan.total, 8400, 'the first plan is A + B for $84.00');

          // 2. Supplier B confirms; the customer approves B's payment at the fake page.
          await confirmSupplierOrders(harness, ['B']);
          await page.waitForSelector('[data-testid="paypal-approve-B"]', { timeout: 20000 });
          await approvalRoundTrip(page, {
            harness, userId, label: 'approve B', action: 'approve',
            trigger: () => page.click('[data-testid="paypal-approve-B"]'),
          });
          await waitFor(() => db.prepare("SELECT 1 FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN suppliers s ON s.id = so.supplier_id WHERE s.code = 'B' AND po.status = 'authorized'").get(), { what: "B's authorization" });

          // 3. Supplier A refuses through its own screen, in a second browser context (a different person, a different session).
          const supplierSide = await harness.newJourney(viewport);
          await signInThroughUi(supplierSide.page, harness.publicUrl, 'supplier-a', SEED_PASSWORD);
          const orderA = orderIdOf(db, requestId, 'A');
          await refuseThroughUi(supplierSide.page, harness.publicUrl, orderA, REASON);
          assert.match(await supplierSide.page.textContent('[data-testid="action-done"]'), /refus/i, 'the supplier is told the refusal was recorded');
          assert.deepEqual(supplierSide.problems, [], 'no problems on the supplier screen');

          // 4. The buyer's page updates by itself: the reason, the voided authorization, and the way forward.
          const message = await waitForText(page, 'rescue-message', REFUSAL_MESSAGE);
          assert.equal(message.trim(), REFUSAL_MESSAGE, 'the message names the supplier, gives the supplier\'s reason and says no money was taken');
          const nextStep = await waitForText(page, 'next-step-action', /^Review the new plan$/);
          assert.equal(nextStep.trim(), 'Review the new plan');
          assert.match(await page.textContent('[data-testid="rescue-status"]'), /plan/i);
          // "If something fails" repeats the reason and the way forward. Once the voids are done and the new plan exists the server
          // lists no order of the closed plan (nothing is outstanding), so the section holds the empty state plus the same message.
          assert.deepEqual(await testIdsOf(page, 'failure-'), ['failure-empty', 'failure-message', 'failure-next-step']);
          assert.equal((await page.textContent('[data-testid="failure-message"]')).trim(), REFUSAL_MESSAGE);
          assert.match(await page.textContent('[data-testid="failure-next-step"]'), /Next step: Review the new plan/);
          assert.equal(
            db.prepare("SELECT po.status FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN suppliers s ON s.id = so.supplier_id WHERE s.code = 'B'").get().status,
            'voided',
            "B's authorization was voided: the money held for it is released",
          );

          // 5. The new plan leaves the refusing supplier out; "Review the new plan" takes the buyer to it.
          await page.locator('[data-testid="next-step-action"]').click();
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'section-why-title', 'focus moved to "Why this plan"');
          const lines = await planLinesShown(page);
          assert.deepEqual(Object.keys(lines).sort(), ['B', 'E'], 'the new plan buys from B and E, not from A');
          const newPlan = db.prepare("SELECT id, status, total_cents AS total FROM plan_versions WHERE request_id = ? AND status = 'proposed'").get(requestId);
          assert.ok(newPlan && newPlan.id !== oldPlan.id, 'a new proposed version exists');
          assert.match(await page.textContent('[data-testid="total-overall"]'), new RegExp(`\\$${(newPlan.total / 100).toFixed(2)}`), 'the page shows the new total');
          await takeScreenshot(page, 'refusal', viewport.width);

          // 6. The buyer can approve the new plan and reserve its stock.
          await pressWhenVisible(page, 'approve-plan');
          await page.waitForSelector('[data-testid="success-approve"]', { timeout: 20000 });
          await pressWhenVisible(page, 'reserve');
          await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
          assert.equal(db.prepare("SELECT status FROM plan_versions WHERE id = ?").get(newPlan.id).status, 'approved');
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE plan_version_id = ? AND status = 'active'").get(newPlan.id).n, 1);

          // Data: nothing was captured, the old plan is closed for the right reason, the old reservation is released.
          const old = db.prepare('SELECT status, non_executable_reason AS reason FROM plan_versions WHERE id = ?').get(oldPlan.id);
          assert.deepEqual({ ...old }, { status: 'non_executable', reason: 'SUPPLIER_REFUSED' });
          assert.equal(db.prepare('SELECT fulfilment_status AS s, refusal_reason AS reason FROM supplier_orders WHERE id = ?').get(orderA).s, 'refused');
          assert.equal(db.prepare('SELECT refusal_reason AS reason FROM supplier_orders WHERE id = ?').get(orderA).reason, REASON);
          assert.equal(db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(oldPlan.id).status, 'released');
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE kind = 'capture'").get().n, 0, 'no capture: no money was taken');
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE kind = 'void'").get().n, 1, "one void: B's authorization");
          assertRoundTripTotals(harness.server, { approvals: 1, cancels: 0 });
        } finally {
          db.close();
        }

        await assertNoOverflow(page, viewport.width);
        assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests during the journey');
        const shot = await takeScreenshot(page, 'refusal-final', viewport.width);
        assert.ok(existsSync(shot) && statSync(shot).size > 1000, `screenshot written: ${shot}`);
      } finally {
        await harness.close();
      }
    });
  }
});
