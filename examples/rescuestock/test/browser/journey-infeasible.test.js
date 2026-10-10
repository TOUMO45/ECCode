// RS-33: browser journey. An infeasible request ends on an explanation screen with the blocking constraints, the
// per-candidate codes and the computed relaxations, and no reservation, order or payment operation exists.
// Runs at 360 x 800 and 1280 x 800 in Chromium (Playwright), against a server of its own on a new database seeded with
// RS-FIX-1 (test/browser/helpers/harness.js). Each viewport signs up its own customer. Screenshots:
// test/browser/out/journey-infeasible-<width>.png. Only under `npm run test:browser`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { purchaseCounts } from './helpers/db.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { screenshotPath, takeScreenshot } from './helpers/screenshot.js';

const TEXT = 'I need 200 cups and 200 lids, 250 ml, by 11:00 today. Budget $50, at most 2 pickups.';
const SCREENSHOT_NAME = 'journey-infeasible';

// The request page asks for an extraction after creating the request and tolerates a failure (it then opens the manual
// form). POST /api/requests/:id/extract is built in phase d; until then it answers 404, and the browser logs one
// "Failed to load resource ... 404" console error per call. Exactly those entries are set aside here, nothing else.
function withoutUnregisteredExtract(problems) {
  const isExtract404 = (p) => /^HTTP 404: POST http:\/\/localhost:\d+\/api\/requests\/\d+\/extract$/.test(p);
  const calls = problems.filter(isExtract404).length;
  let consoleLinesToDrop = calls;
  return problems.filter((p) => {
    if (isExtract404(p)) return false;
    if (consoleLinesToDrop > 0 && /^console error: Failed to load resource: the server responded with a status of 404/.test(p)) {
      consoleLinesToDrop -= 1;
      return false;
    }
    return true;
  });
}

let harness;
before(async () => {
  harness = await startBrowserHarness();
});
after(async () => {
  if (harness) await harness.close();
});

describe('RS-33: an infeasible request ends with an explanation and no purchase', () => {
  test('RS-33: Chromium launched and the app answers on the localhost public URL', async () => {
    assert.match(harness.publicUrl, /^http:\/\/localhost:\d+$/);
    assert.equal(harness.server.env.RS_TEST_OFFLINE, '1');
    assert.equal(harness.server.env.RS_REGISTER_PER_IP_PER_HOUR, '1000');
    assert.equal(harness.server.env.RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY, '1000');
    assert.equal(harness.server.env.RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER, '1');
    assert.match(harness.browserVersion, /^\d+\.\d+/);
    console.log(`# Chromium ${harness.browserVersion}, app ${harness.publicUrl}`);
  });

  for (const viewport of VIEWPORTS) {
    test(`RS-33: at ${viewport.width}x${viewport.height} the infeasible request shows blocking constraints, candidate codes and relaxations; nothing is reserved, ordered or paid`, async () => {
      const { page, problems } = await harness.newJourney(viewport);

      // 1. A fresh customer signs up through the UI.
      const customer = await signUpFreshCustomer(page, harness.publicUrl);

      // 2. A new request whose budget no plan can meet.
      await page.goto(`${harness.publicUrl}/#/requests/new`);
      await page.waitForSelector('[data-testid="request-new-form"]');
      await page.fill('#request-text', TEXT);
      await page.click('[data-testid="request-new-submit"]');
      await page.waitForURL(/#\/requests\/\d+$/);
      const requestId = Number(/#\/requests\/(\d+)$/.exec(page.url())[1]);
      await page.waitForSelector('[data-testid="manual-form"]');

      // The new page takes keyboard focus on its heading (route change).
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'page-title', 'focus is on the h1 after the route change');

      // 3. The details are confirmed (the form is open until they are): the budget is $50.00, below any plan ($84.00 at best).
      await page.selectOption('[data-testid="input-productType"]', 'cups_and_lids');
      await page.fill('[data-testid="input-cupQuantity"]', '200');
      await page.fill('[data-testid="input-lidQuantity"]', '200');
      await page.fill('[data-testid="input-capacityMl"]', '250');
      await page.fill('[data-testid="input-diameterMm"]', '90');
      await page.selectOption('[data-testid="input-material"]', 'paper');
      await page.fill('[data-testid="input-deadline"]', `${harness.demoDate}T11:00`);
      await page.fill('[data-testid="input-budgetCents"]', '50.00');
      await page.fill('[data-testid="input-maxPickups"]', '2');
      await page.click('[data-testid="confirm-requirements"]');

      // 4. The explanation screen.
      await page.waitForSelector('[data-testid="infeasible"]');
      const infeasible = await page.textContent('[data-testid="infeasible"]');
      assert.match(infeasible, /No plan satisfies every constraint\. Nothing was reserved, ordered or paid\./);

      const blocking = page.locator('[data-testid="blocking"]');
      await blocking.waitFor();
      assert.match(await blocking.textContent(), /Blocking constraints/);
      assert.match(await page.textContent('[data-testid="blocking-OVER_BUDGET"]'), /OVER_BUDGET.*budget is too low/);

      const candidates = page.locator('[data-testid="candidates"]');
      await candidates.waitFor();
      const candidateCodes = await candidates.locator('li[data-testid^="candidate-"] .code').allTextContents();
      assert.ok(candidateCodes.length > 0, 'per-candidate codes are listed');
      assert.ok(candidateCodes.every((c) => /^[A-Z_]+$/.test(c.trim())), `candidate codes are codes: ${candidateCodes.join(',')}`);
      assert.ok(candidateCodes.map((c) => c.trim()).includes('OVER_BUDGET'));

      const relaxation = page.locator('[data-testid="relax-budget"]');
      await relaxation.waitFor();
      assert.match(await relaxation.textContent(), /^Raise budget to \$84\.00 → A\+B$/, 'the computed relaxation names the cheapest plan');

      // No way to buy: no approve, reserve or PayPal controls.
      for (const testid of ['approve-plan', 'reserve', 'execute']) {
        assert.equal(await page.locator(`[data-testid="${testid}"]`).count(), 0, `no ${testid} button`);
      }
      assert.equal(await page.locator('[data-testid^="paypal-approve-"]').count(), 0, 'no PayPal approval button');

      // Layout and page health at this width.
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      assert.ok(overflow.scroll <= overflow.inner, `no horizontal scroll at ${viewport.width}px: scrollWidth ${overflow.scroll} > ${overflow.inner}`);
      assert.deepEqual(withoutUnregisteredExtract(problems), [], 'no console errors, CSP violations, page errors or failed requests during the journey');

      // 5. Screenshot.
      const path = await takeScreenshot(page, SCREENSHOT_NAME, viewport.width);
      assert.equal(path, screenshotPath(SCREENSHOT_NAME, viewport.width));
      assert.ok(existsSync(path) && statSync(path).size > 1000, `screenshot written: ${path}`);

      // 6. The database: the run is stored as infeasible, and no reservation, order or payment operation exists.
      const db = harness.openDb();
      try {
        const run = db.prepare('SELECT feasible FROM planning_runs WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId);
        assert.ok(run, 'a planning run is stored for the request');
        assert.equal(run.feasible, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE request_id = ?').get(requestId).n, 0, 'no plan version for the request');
        const owner = db.prepare('SELECT u.username AS username FROM rescue_requests r JOIN users u ON u.id = r.customer_id WHERE r.id = ?').get(requestId);
        assert.equal(owner.username, customer.username, 'the request belongs to this journey\'s fresh customer');
        assert.deepEqual(
          purchaseCounts(db),
          { reservations: 0, reservation_items: 0, supplier_orders: 0, payment_operations: 0, provider_calls: 0, fake_paypal_calls: 0, plan_versions: 0, plan_approvals: 0 },
          'no reservation, order or payment operation exists',
        );
        assert.equal(db.prepare('SELECT COALESCE(SUM(reserved), 0) AS n FROM inventory').get().n, 0, 'no stock is held');
      } finally {
        db.close();
      }
    });
  }
});
