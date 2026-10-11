// NFR2 (browser): accessibility and states, at 360 x 800 and 1280 x 800, in Chromium against a real server.
//   1. KEYBOARD-ONLY HAPPY PATH. A person who never touches the mouse registers, asks for 200 cups and 200 lids, types the details,
//      approves and reserves the A + B plan, approves both payments on the fake approval page, completes the purchase and ends with
//      the plan executed. Focus moves with Tab only, text is typed, buttons are pressed with Enter; a pointer event anywhere (the app
//      page or the approval page) fails the test. Every approval goes through the shared approval round-trip helper (F-TR-14).
//   2. EVERY STATE. loading (a slow answer), empty (no requests), error with Retry, timeout (the 15 s client limit), degraded
//      extraction, expired reservation with Re-plan, and the recovery states no journey reaches (FU-51): refunding (compensation in
//      progress), failed_needs_attention ("Contact the organiser"), and the admin forced-reset stranded list. Each state is audited:
//      one h1 and one main, every control named, 44 px targets, 4.5:1 text contrast computed from the rendered colours, no horizontal
//      scroll, and a Tab walk in which every stop draws a focus indicator and the walk leaves the page (no keyboard trap).
//   3. A refusal reason with a right-to-left mark and a zero-width character is rendered inside <bdi> (g1's unverified item).
// Each viewport starts its own server(s) on new databases (supplier A has one bundle). Screenshots: test/browser/out/a11y-<state>-<width>.png.
// Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { assertAccessible, keyboardWalk } from './helpers/a11y-audit.js';
import { approvalRoundTrip, assertRoundTripTotals } from './helpers/approval-roundtrip.js';
import {
  adminApi, armFakeFault, executePurchase, operationOf, payBoth, refundOrderAsAdmin, registerApiCustomer, reserveForCustomer, signedInAs,
} from './helpers/api-purchase.js';
import { forbidPointer, pressEnterOn, tabTo, typeDateTime, typeInto } from './helpers/keyboard.js';
import { confirmSupplierOrders, PURCHASE_TEXT } from './helpers/purchase.js';
import { BROWSER_ADMIN_PASSWORD, RECOVERY_ENV, signInThroughUi, waitForText } from './helpers/recovery.js';
import { userIdOf } from './helpers/db.js';
import { JOURNEY_PASSWORD, freshUsername } from './helpers/signup.js';
import { takeScreenshot } from './helpers/screenshot.js';
import { waitFor } from '../helpers/payment-flow.js';
import { writeDb } from '../helpers/saga-flow.js';

const shot = (page, state, width) => takeScreenshot(page, `a11y-${state}`, width);

// The audit every state goes through: the rendered page is accessible and the Tab walk is clean and ends.
async function checkState(page, { width, label }) {
  await assertAccessible(page, { width, label });
  const walk = await keyboardWalk(page);
  assert.deepEqual(walk.problems, [], `${label}: keyboard walk at ${width} px`);
  assert.equal(walk.wraps, true, `${label}: Tab leaves the page (no keyboard trap) after ${walk.stops.length} stops`);
  assert.ok(walk.stops.length >= 1, `${label}: the page has at least one keyboard stop`);
  return walk;
}

describe('NFR2: keyboard-only happy path (no pointer), approval round trip through the shared helper', () => {
  for (const viewport of VIEWPORTS) {
    test(`NFR2: at ${viewport.width}x${viewport.height} register, ask, type the details, approve, reserve, approve both payments and complete the purchase with the keyboard alone`, async () => {
      const harness = await startBrowserHarness();
      try {
        const { context, page, problems } = await harness.newJourney(viewport);
        const pointerEvents = await forbidPointer(context);
        const username = freshUsername('kbd');

        // Register.
        await page.goto(`${harness.publicUrl}/#/register`);
        await page.waitForSelector('[data-testid="register-form"]');
        await typeInto(page, '#register-username', username);
        await typeInto(page, '#register-display-name', 'Keyboard Cafe');
        await typeInto(page, '#register-password', JOURNEY_PASSWORD);
        await pressEnterOn(page, '[data-testid="register-submit"]');
        await page.waitForSelector('[data-testid="session-user"]');
        const db = harness.openDb();
        try {
          const userId = userIdOf(db, username);

          // Ask.
          await page.goto(`${harness.publicUrl}/#/requests/new`);
          await page.waitForSelector('[data-testid="request-new-form"]');
          await typeInto(page, '#request-text', PURCHASE_TEXT);
          await pressEnterOn(page, '[data-testid="request-new-submit"]');
          await page.waitForURL(/#\/requests\/\d+$/);
          const requestId = Number(/#\/requests\/(\d+)$/.exec(page.url())[1]);
          await page.waitForSelector('[data-testid="manual-form"]');

          // The details, typed.
          await typeInto(page, '[data-testid="input-productType"]', 'Cups and lids');
          await typeInto(page, '[data-testid="input-cupQuantity"]', '200');
          await typeInto(page, '[data-testid="input-lidQuantity"]', '200');
          await typeInto(page, '[data-testid="input-capacityMl"]', '250');
          await typeInto(page, '[data-testid="input-diameterMm"]', '90');
          await typeInto(page, '[data-testid="input-material"]', 'Paper');
          await typeDateTime(page, '[data-testid="input-deadline"]', `${harness.demoDate}T11:00`);
          await typeInto(page, '[data-testid="input-budgetCents"]', '120.00');
          await typeInto(page, '[data-testid="input-maxPickups"]', '2');
          await pressEnterOn(page, '[data-testid="confirm-requirements"]');

          // Approve and reserve.
          await page.waitForSelector('[data-testid="approve-plan"]', { timeout: 20000 });
          await checkState(page, { width: viewport.width, label: 'keyboard path: plan proposed' });
          await pressEnterOn(page, '[data-testid="approve-plan"]');
          await page.waitForSelector('[data-testid="success-approve"]', { timeout: 20000 });
          await pressEnterOn(page, '[data-testid="reserve"]');
          await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
          await confirmSupplierOrders(harness);
          await page.waitForSelector('[data-testid="paypal-approve-A"]', { timeout: 20000 });
          await checkState(page, { width: viewport.width, label: 'keyboard path: payments to approve' });

          // Both approvals, keyboard on both pages.
          for (const code of ['A', 'B']) {
            await page.waitForSelector(`[data-testid="paypal-approve-${code}"]`, { timeout: 20000 });
            await approvalRoundTrip(page, {
              harness, userId, label: `approve ${code} (keyboard)`, action: 'approve', keyboard: true,
              trigger: () => pressEnterOn(page, `[data-testid="paypal-approve-${code}"]`),
            });
          }
          await pressEnterOn(page, '[data-testid="execute"]');
          await page.waitForSelector('[data-testid="success-execute"]', { timeout: 20000 });
          await waitFor(() => db.prepare("SELECT 1 FROM plan_versions WHERE request_id = ? AND status = 'executed'").get(requestId), { what: 'the plan to be executed' });
          assertRoundTripTotals(harness.server, { approvals: 2, cancels: 0 });
          await shot(page, 'keyboard-path', viewport.width);
        } finally {
          db.close();
        }
        assert.deepEqual(pointerEvents, [], 'no mouse pointer event happened in the whole journey');
        assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests');
      } finally {
        await harness.close();
      }
    });
  }
});

// ---- 2. every state ------------------------------------------------------------------------------------------------------------

function newApiBrowserHarness() {
  return startBrowserHarness({ env: { ...RECOVERY_ENV } });
}

async function customerPage(harness, viewport, customer) {
  const journey = await harness.newJourney(viewport);
  await signInThroughUi(journey.page, harness.publicUrl, customer.username, customer.password);
  return journey;
}

describe('NFR2: every state is rendered, audited and keyboard-walkable', () => {
  for (const viewport of VIEWPORTS) {
    test(`NFR2: at ${viewport.width}x${viewport.height} empty, loading, error with Retry, timeout, degraded extraction, expired reservation with Re-plan, refunding and needs-attention`, { timeout: 240000 }, async () => {
      const harness = await newApiBrowserHarness();
      const width = viewport.width;
      try {
        // ---- empty, loading, error with Retry, timeout (a customer with no requests)
        const first = await registerApiCustomer(harness, 'st0');
        const a = await customerPage(harness, viewport, first);
        await a.page.goto(`${harness.publicUrl}/#/requests`);
        await a.page.waitForSelector('[data-testid="requests-empty"]');
        assert.match(await a.page.textContent('[data-testid="requests-empty"]'), /No rescue requests yet/);
        await checkState(a.page, { width, label: 'empty list' });
        await shot(a.page, 'empty', width);

        // loading: the answer is held back; the page says so, as a status, and then shows the list.
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        await a.page.route('**/api/requests', async (route) => {
          await held;
          await route.continue();
        });
        await a.page.goto(`${harness.publicUrl}/#/signin`);
        await a.page.goto(`${harness.publicUrl}/#/requests`);
        await a.page.waitForSelector('[data-testid="state-loading"]');
        assert.equal(await a.page.getAttribute('[data-testid="state-loading"]', 'role'), 'status');
        assert.equal(await a.page.getAttribute('[data-testid="state-loading"]', 'aria-busy'), 'true');
        await assertAccessible(a.page, { width, label: 'loading state' });
        await shot(a.page, 'loading', width);
        release();
        await a.page.waitForSelector('[data-testid="requests-empty"]');
        await a.page.unroute('**/api/requests');

        // error: the request fails; an alert with Retry; Retry recovers.
        await a.page.route('**/api/requests', (route) => route.abort('failed'));
        await a.page.goto(`${harness.publicUrl}/#/signin`);
        await a.page.goto(`${harness.publicUrl}/#/requests`);
        await a.page.waitForSelector('[data-testid="state-error"]');
        assert.equal(await a.page.getAttribute('[data-testid="state-error"]', 'role'), 'alert');
        await checkState(a.page, { width, label: 'error state' });
        await shot(a.page, 'error', width);
        await a.page.unroute('**/api/requests');
        await tabTo(a.page, '[data-testid="retry"]');
        await a.page.keyboard.press('Enter');
        await a.page.waitForSelector('[data-testid="requests-empty"]');

        // timeout: no answer within the 15 s client limit.
        await a.page.route('**/api/requests', () => {});
        await a.page.goto(`${harness.publicUrl}/#/signin`);
        await a.page.goto(`${harness.publicUrl}/#/requests`);
        await a.page.waitForSelector('[data-testid="state-timeout"]', { timeout: 30000 });
        assert.match(await a.page.textContent('[data-testid="state-timeout"]'), /The server is taking too long\./);
        await checkState(a.page, { width, label: 'timeout state' });
        await shot(a.page, 'timeout', width);
        await a.page.unroute('**/api/requests');

        // ---- degraded extraction (the fake model times out once)
        const admin = await adminApi(harness);
        assert.equal((await admin.post('/api/admin/faults', { kind: 'fake_model', fault: 'timeout', count: 1 })).status, 200);
        const second = await registerApiCustomer(harness, 'st1');
        const b = await customerPage(harness, viewport, second);
        await b.page.goto(`${harness.publicUrl}/#/requests/new`);
        await b.page.waitForSelector('[data-testid="request-new-form"]');
        await b.page.fill('#request-text', PURCHASE_TEXT);
        await b.page.click('[data-testid="request-new-submit"]');
        await b.page.waitForURL(/#\/requests\/\d+$/);
        await b.page.waitForSelector('[data-testid="manual-form"]');
        await waitForText(b.page, 'degraded-notice', /Automatic reading unavailable — please enter the details/);
        await checkState(b.page, { width, label: 'degraded extraction' });
        await shot(b.page, 'degraded', width);

        // ---- expired reservation with Re-plan
        const third = await registerApiCustomer(harness, 'st2');
        const expired = await reserveForCustomer(harness, third, { confirm: false });
        const c = await customerPage(harness, viewport, third);
        await c.page.goto(`${harness.publicUrl}/#/requests/${expired.requestId}`);
        await c.page.waitForSelector('[data-testid="reserve"], [data-testid="paypal-approvals"], [data-testid="rescue-status"]');
        const rw = writeDb(harness.server.dbPath);
        try {
          rw.exec('PRAGMA busy_timeout = 10000');
          assert.equal(rw.prepare("UPDATE reservations SET expires_at = ? WHERE plan_version_id = ? AND status = 'active'").run(new Date(Date.now() - 60_000).toISOString(), expired.planId).changes, 1);
        } finally {
          rw.close();
        }
        await c.page.reload();
        await c.page.waitForSelector('[data-testid="reservation-expired"]', { timeout: 30000 });
        assert.match(await c.page.textContent('[data-testid="reservation-expired"]'), /Reservation expired — no money was taken; re-plan with current stock/);
        await checkState(c.page, { width, label: 'expired reservation' });
        await shot(c.page, 'expired', width);
        await tabTo(c.page, '[data-testid="replan"]');
        await c.page.keyboard.press('Enter');
        await c.page.waitForSelector('[data-testid="success-replan"]', { timeout: 20000 });
        assert.equal(await c.page.locator('[data-testid="reservation-expired"]').count(), 0, 'after Re-plan the expired notice is gone');
        assert.ok((await c.page.locator('[data-testid="plan-line-A"]').count()) === 1, 'and a new plan is shown');

        // ---- refunding, then needs attention (an executed purchase whose refunds are in doubt)
        const fourth = await registerApiCustomer(harness, 'st3');
        const bought = await reserveForCustomer(harness, fourth);
        await payBoth(fourth, bought);
        await executePurchase(harness, fourth, bought);
        const d = await customerPage(harness, viewport, fourth);
        await d.page.goto(`${harness.publicUrl}/#/requests/${bought.requestId}`);
        await d.page.waitForSelector('[data-testid="rescue-status"]');
        await armFakeFault(harness, 'refund_pending', 'A');
        await refundOrderAsAdmin(harness, bought.orders.A);
        await waitForText(d.page, 'rescue-status', /Refunding/, { timeout: 30000 });
        assert.match(await d.page.textContent('[data-testid="compensation-summary"]'), /Refunds: 1 outstanding, 0 done\./);
        assert.match(await d.page.textContent('[data-testid="failure-A-payment"]'), /Refund/i);
        await checkState(d.page, { width, label: 'refunding (compensation in progress)' });
        await shot(d.page, 'refunding', width);

        await armFakeFault(harness, 'refund_failed', 'B');
        await refundOrderAsAdmin(harness, bought.orders.B);
        await waitForText(d.page, 'rescue-status', /Needs the organiser’s attention/, { timeout: 30000 });
        const attention = await d.page.textContent('[data-testid="contact-organiser"]');
        assert.match(attention, /Contact the organiser/);
        assert.match(attention, new RegExp(`Quote request #${bought.requestId}`));
        assert.equal(await d.page.getAttribute('[data-testid="contact-organiser"]', 'role'), 'alert');
        assert.match(await d.page.textContent('[data-testid="compensation-summary"]'), /1 failed: Contact the organiser\./);
        assert.match(await d.page.textContent('[data-testid="failure-B-payment"]'), /Refund failed|failed/i);
        await checkState(d.page, { width, label: 'failed_needs_attention' });
        await shot(d.page, 'needs-attention', width);
        const db = harness.openDb();
        try {
          assert.deepEqual([operationOf(db, bought.orders.A), operationOf(db, bought.orders.B)], ['refund_pending', 'refund_failed']);
        } finally {
          db.close();
        }
        assert.deepEqual(c.problems, [], 'no problems on the re-plan page');
        assert.deepEqual(d.problems, [], 'no problems on the recovery page');
      } finally {
        await harness.close();
      }
    });

    test(`NFR2: at ${viewport.width}x${viewport.height} the admin forced-reset stranded list is audited and walkable (FU-51)`, { timeout: 180000 }, async () => {
      const harness = await newApiBrowserHarness();
      const width = viewport.width;
      try {
        const customer = await registerApiCustomer(harness, 'st4');
        const purchase = await reserveForCustomer(harness, customer);
        await payBoth(customer, purchase);
        await armFakeFault(harness, 'capture_pending', 'A');
        await executePurchase(harness, customer, purchase, { until: (db) => operationOf(db, purchase.orders.A) === 'capture_pending' });
        const { page, problems } = await harness.newJourney(viewport);
        page.on('dialog', (dialog) => dialog.accept());
        await signInThroughUi(page, harness.publicUrl, 'admin', BROWSER_ADMIN_PASSWORD);
        await page.goto(`${harness.publicUrl}/#/admin`);
        await page.waitForSelector('[data-testid="reset-form"]');
        await tabTo(page, '#reset-force');
        await page.keyboard.press('Space');
        await typeInto(page, '#reset-reason', 'Accessibility check: one capture is still pending');
        await pressEnterOn(page, '[data-testid="reset-submit"]');
        await page.waitForSelector('[data-testid="reset-stranded"]', { timeout: 40000 });
        assert.match(await page.textContent('[data-testid="reset-stranded"]'), /Operation \d+: capture_pending, .*plan executing/);
        assert.match(await page.textContent('[data-testid="reset-done"]'), /The demo was reset\. \d+ payment operations were archived\./);
        await checkState(page, { width, label: 'forced reset with a stranded operation' });
        await shot(page, 'stranded', width);
        assert.deepEqual(problems, []);
      } finally {
        await harness.close();
      }
    });
  }
});

// ---- 3. a refusal reason with bidirectional and zero-width characters ---------------------------------------------------------------

const RLM = '‏';
const ZWSP = '​';
// Arabic "out of lids" with a right-to-left mark and a zero-width space inside, and a Latin tail.
const REASON = `نفدت الأغطية${RLM} ${ZWSP}today`;

describe('NFR2 / FU-58: a refusal reason with an RLM and a zero-width character is isolated in <bdi>', () => {
  for (const viewport of VIEWPORTS) {
    test(`NFR2: at ${viewport.width}x${viewport.height} the sentence "Supplier A refused the order: <reason>. No money was taken." keeps its order and the reason is a <bdi> unit`, async () => {
      const harness = await newApiBrowserHarness();
      try {
        const customer = await registerApiCustomer(harness, 'st5');
        const purchase = await reserveForCustomer(harness, customer, { confirm: false });
        const supplier = await signedInAs(harness, 'supplier-a');
        const refused = await supplier.post(`/api/supplier/orders/${purchase.orders.A}/refuse`, { reason: REASON });
        assert.equal(refused.status, 200, refused.text);
        const { page, problems } = await customerPage(harness, viewport, customer);
        await page.goto(`${harness.publicUrl}/#/requests/${purchase.requestId}`);
        const message = page.locator('[data-testid="rescue-message"]');
        await message.waitFor({ timeout: 20000 });
        await page.waitForFunction(() => /refused the order/.test(document.querySelector('[data-testid="rescue-message"]')?.textContent ?? ''), null, { timeout: 30000 });
        const facts = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="rescue-message"]');
          const bdi = root.querySelector('bdi');
          const style = bdi ? getComputedStyle(bdi) : null;
          return {
            text: root.textContent,
            bdiCount: root.querySelectorAll('bdi').length,
            bdiText: bdi?.textContent ?? null,
            dirAttr: bdi?.getAttribute('dir') ?? null,
            unicodeBidi: style?.unicodeBidi ?? null,
            direction: style?.direction ?? null,
            rootDirection: getComputedStyle(root).direction,
          };
        });
        assert.equal(facts.bdiCount, 1, 'exactly the reason is isolated');
        assert.equal(facts.bdiText, REASON, 'the reason is shown as it was given: nothing stripped, including the RLM and the zero-width space');
        assert.equal(facts.dirAttr, 'auto');
        assert.match(facts.unicodeBidi, /isolate/, 'bdi isolates its content from the sentence around it');
        assert.equal(facts.direction, 'rtl', 'an Arabic-first reason reads right to left inside its own unit');
        assert.equal(facts.rootDirection, 'ltr', 'while the sentence around it keeps the page direction');
        assert.equal(facts.text, `Supplier A refused the order: ${REASON}. No money was taken.`);
        await checkState(page, { width: viewport.width, label: 'refusal with a bidi reason' });
        await shot(page, 'bidi-reason', viewport.width);
        assert.deepEqual(problems, []);
      } finally {
        await harness.close();
      }
    });
  }
});
