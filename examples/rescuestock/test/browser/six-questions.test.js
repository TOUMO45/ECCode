// RS-35 (browser): the request page answers the six questions, in order, rendered by Chromium from the real server's answers.
//   1. What do you need?        the extracted requirements, each with its provenance ("From your text" with the original wording, or
//                               "Entered by you") — section "What you need"
//   2. Why this plan?           the planner's decision trace: the chosen plan, how it beat the next ones, the alternatives — "Why this plan"
//   3. What was rejected?       one rejection per supplier with its code AND the explanation written from the code — "What was rejected"
//   4. What does it cost?       integer cents per supplier (subtotal, prep fee, tax, total) and overall — "Total"; the price notice
//   5. Offer or commitment?     the catalog offer and the supplier-confirmed commitment side by side, "Not yet confirmed" until the
//                               supplier confirms — "Supplier commitments"
//   6. What if it fails?        the compensation state of every order and the next step — "If something fails"
// The journey: a fresh customer sends the canonical request, confirms the details, approves and reserves the A + B plan ($84.00);
// supplier A confirms through the API; B has not. Cross-checks against the database: the page's overall total equals the stored plan
// total, and the per-supplier totals add up to it in cents. Runs at 360 x 800 and 1280 x 800; each viewport starts a server of its own
// on a new database (supplier A's only bundle is reserved). Screenshots: test/browser/out/six-questions-<width>.png.
// Only under `npm run test:browser`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { assertAccessible } from './helpers/a11y-audit.js';
import { confirmSupplierOrders, createConfirmedRequest } from './helpers/purchase.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { takeScreenshot } from './helpers/screenshot.js';

const SECTION_ORDER = ['status', 'need', 'why', 'rejected', 'total', 'commitments', 'failure', 'actions'];
const SIX = [
  ['need', 'What you need'],
  ['why', 'Why this plan'],
  ['rejected', 'What was rejected'],
  ['total', 'Total'],
  ['commitments', 'Supplier commitments'],
  ['failure', 'If something fails'],
];
const cents = (text) => {
  const m = /\$(\d+)\.(\d{2})/.exec(text);
  assert.ok(m, `a dollar amount in "${text}"`);
  return Number(m[1]) * 100 + Number(m[2]);
};

async function pressWhenVisible(page, testid) {
  const button = page.locator(`[data-testid="${testid}"]`);
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
}

describe('RS-35: the request page answers the six questions', () => {
  for (const viewport of VIEWPORTS) {
    test(`RS-35: at ${viewport.width}x${viewport.height} requirements with provenance, decision trace, rejection codes with explanations, cents totals, offer next to commitment, compensation state and next step`, async () => {
      const harness = await startBrowserHarness();
      try {
        const { page, problems } = await harness.newJourney(viewport);
        await signUpFreshCustomer(page, harness.publicUrl);
        const requestId = await createConfirmedRequest(page, { publicUrl: harness.publicUrl, demoDate: harness.demoDate });
        await pressWhenVisible(page, 'approve-plan');
        await pressWhenVisible(page, 'reserve');
        await page.waitForSelector('[data-testid="success-reserve"]', { timeout: 20000 });
        await confirmSupplierOrders(harness, ['A']);
        await page.reload();
        await page.waitForSelector('[data-testid="commit-A-confirmed"]');
        await page.waitForFunction(() => /Supplier confirmed\s*1 bundle/.test(document.querySelector('[data-testid="commit-A-confirmed"]')?.textContent ?? ''), null, { timeout: 20000 });

        // The six answers are sections of the page, in this order, each with its heading.
        const sections = await page.evaluate(() => [...document.querySelectorAll('section[id^="section-"]')].map((s) => ({ id: s.id.slice('section-'.length), heading: s.querySelector('h2')?.textContent?.trim() })));
        assert.deepEqual(sections.map((s) => s.id), SECTION_ORDER);
        for (const [id, heading] of SIX) assert.equal(sections.find((s) => s.id === id).heading, heading, `section ${id}`);

        // 1. Requirements with provenance.
        const need = (name) => page.textContent(`[data-testid="field-${name}-provenance"]`);
        assert.equal((await need('cupQuantity')).trim(), 'From your text');
        assert.equal((await page.textContent('[data-testid="field-cupQuantity-wording"]')).trim(), '200 cups', 'the original wording is shown beside the value');
        assert.equal((await page.textContent('[data-testid="field-capacityMl-value"]')).trim(), '250');
        assert.equal((await need('diameterMm')).trim(), 'Entered by you', 'a value the customer typed is marked as theirs');
        assert.equal((await page.textContent('[data-testid="field-budgetCents-value"]')).trim(), '$120.00');
        assert.match(await page.textContent('[data-testid="field-deadline-value"]'), /11:00 \(Amman\)/);
        assert.equal(await page.locator('[data-testid^="field-"][data-testid$="-provenance"]').count(), 9, 'all nine fields show a source');

        // 2. The decision trace.
        assert.match(await page.textContent('[data-testid="plan-summary"]'), /Best plan: A\+B for \$84\.00 in total, 2 pickups/);
        assert.match(await page.textContent('[data-testid="trace-comparison-1"]'), /A\+B beats A\+E: total \$84\.00 < \$95\.00/);
        assert.match(await page.textContent('[data-testid="trace-comparison-2"]'), /A\+B beats B\+E: total \$84\.00 < \$99\.00/);
        assert.ok((await page.locator('[data-testid^="alternative-"]').count()) >= 2, 'the alternatives that were considered are listed');
        assert.deepEqual(await page.locator('[data-testid^="plan-line-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid'))), ['plan-line-A', 'plan-line-B']);

        // 3. Rejections: the code and the sentence written from it.
        const rejC = await page.textContent('[data-testid="rejection-INCOMPATIBLE_LID_DIAMETER-C"]');
        assert.match(rejC, /INCOMPATIBLE_LID_DIAMETER/);
        assert.match(rejC, /its cups are 90 mm and its lids 95 mm/, 'the explanation is generated from the planner code, not the code alone');
        const rejD = await page.textContent('[data-testid="rejection-READY_AFTER_DEADLINE-D"]');
        assert.match(rejD, /READY_AFTER_DEADLINE/);
        assert.match(rejD, /ready at 11:20, after the 11:00 deadline/);

        // 4. Integer cents per supplier and overall.
        const totalA = cents(await page.textContent('[data-testid="total-A"] td:last-child'));
        const totalB = cents(await page.textContent('[data-testid="total-B"] td:last-child'));
        const overall = cents(await page.textContent('[data-testid="total-overall"]'));
        assert.deepEqual([totalA, totalB, overall], [4000, 4400, 8400]);
        assert.equal(totalA + totalB, overall, 'the per-supplier totals add up to the overall total in cents');
        assert.equal((await page.textContent('[data-testid="price-notice"]')).trim(), 'Test prices, not market prices');
        const db = harness.openDb();
        try {
          assert.equal(db.prepare('SELECT total_cents AS t FROM plan_versions WHERE request_id = ?').get(requestId).t, overall, 'the page shows the stored total');
          assert.deepEqual(db.prepare('SELECT total_cents AS t FROM supplier_orders ORDER BY id').all().map((r) => r.t), [totalA, totalB], 'and the stored per-supplier totals');
        } finally {
          db.close();
        }

        // 5. Catalog offer and supplier-confirmed commitment, side by side.
        assert.match(await page.textContent('[data-testid="commit-A-catalog"]'), /Catalog offer\s*1 bundle, ready \d{2}:\d{2}/);
        assert.match(await page.textContent('[data-testid="commit-A-confirmed"]'), /Supplier confirmed\s*1 bundle, ready \d{2}:\d{2}/);
        assert.match(await page.textContent('[data-testid="commit-B-catalog"]'), /Catalog offer\s*1 bundle/);
        assert.match(await page.textContent('[data-testid="commit-B-confirmed"]'), /Supplier confirmed\s*Not yet confirmed/);

        // 6. Compensation state per order, the summary and the next step.
        for (const code of ['A', 'B']) {
          assert.match(await page.textContent(`[data-testid="failure-${code}-payment"]`), /Payment: Not yet approved/);
          assert.match(await page.textContent(`[data-testid="failure-${code}"] [data-testid="compensation"]`), /Compensation: Nothing to undo/);
        }
        assert.match(await page.textContent('[data-testid="compensation-summary"]'), /Voids: 0 outstanding, 0 done\. Refunds: 0 outstanding, 0 done\./);
        assert.match(await page.textContent('[data-testid="failure-next-step"]'), /Next step: Approve each payment with PayPal/);
        assert.equal((await page.textContent('[data-testid="next-step"]')).trim(), 'Approve each payment with PayPal', 'the header repeats the next step');

        await assertAccessible(page, { width: viewport.width, label: 'the request page with all six answers' });
        const shot = await takeScreenshot(page, 'six-questions', viewport.width);
        assert.ok(existsSync(shot) && statSync(shot).size > 1000, `screenshot written: ${shot}`);
        assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests');
      } finally {
        await harness.close();
      }
    });
  }
});
