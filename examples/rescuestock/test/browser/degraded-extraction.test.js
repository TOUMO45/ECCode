// RS-03 (browser part) and FU-17: when automatic reading is unavailable the journey continues by hand.
// The fake provider is forced to time out (admin fault fake_model:timeout, test/browser/helpers/model-fault.js). The customer
// sends a request, sees the degraded notice and the manual form with every field, confirms the details (provenance manual)
// and reaches a planning run. At 360 x 800 the "What you need" table is stacked: every column (Original wording included) is
// readable and nothing scrolls sideways inside it (FU-17, TR-C-6). A second test per viewport checks the same table with a
// successful extraction, where the Original wording column holds text.
// Runs in Chromium (Playwright) against a server of its own on a new database (test/browser/helpers/harness.js), at 360 x 800
// and 1280 x 800. Screenshots: test/browser/out/degraded-extraction-<width>.png. Only under `npm run test:browser`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { startBrowserHarness, VIEWPORTS } from './helpers/harness.js';
import { purchaseCounts } from './helpers/db.js';
import { ADMIN_PASSWORD, armModelFault, clearModelFaults } from './helpers/model-fault.js';
import { signUpFreshCustomer } from './helpers/signup.js';
import { screenshotPath, takeScreenshot } from './helpers/screenshot.js';

const TEXT = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00 today. Budget $120, at most 2 pickups.';
const SCREENSHOT_NAME = 'degraded-extraction';
const DEGRADED_NOTICE = 'Automatic reading unavailable — please enter the details';
const COLUMNS = ['Field', 'Value', 'Source', 'Original wording'];
const FIELDS = ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups'];
const CORE = ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']; // required in the manual form

let harness;
before(async () => {
  harness = await startBrowserHarness({ env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD } });
});
after(async () => {
  if (harness) await harness.close();
});

// What the browser actually lays out for the "What you need" table: the display of the table and its cells, the title each
// cell shows (the ::before content of a stacked cell), the box of every cell, and any scroll region or clipped box.
function measureNeedTable() {
  const table = document.querySelector('[data-testid="fields-table"]');
  const viewport = window.innerWidth;
  const scrollRegions = [];
  for (let node = table; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowX)) scrollRegions.push(node.className || node.tagName.toLowerCase());
  }
  // A box that is visually hidden on purpose (the caption, and the header row of the stacked layout) is not "clipped".
  const hiddenOnPurpose = (node) => {
    for (let n = node; n && n !== table.parentElement; n = n.parentElement) {
      const box = n.getBoundingClientRect();
      if (box.width <= 2 && box.height <= 2) return true;
    }
    return false;
  };
  const clipped = [];
  for (const node of [table, ...table.querySelectorAll('*')]) {
    if (hiddenOnPurpose(node)) continue;
    if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== 'inline') clipped.push(`${node.tagName.toLowerCase()}.${node.className || ''} ${node.scrollWidth}>${node.clientWidth}`);
  }
  const headerCells = Array.from(table.querySelectorAll('thead th')).map((th) => {
    const box = th.getBoundingClientRect();
    return { text: th.textContent.trim(), visible: getComputedStyle(th).visibility !== 'hidden' && box.width > 4 && box.height > 4 };
  });
  const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => ({
    testid: tr.getAttribute('data-testid'),
    cells: Array.from(tr.children).map((cell) => {
      const box = cell.getBoundingClientRect();
      const title = getComputedStyle(cell, '::before').content;
      return {
        tag: cell.tagName.toLowerCase(),
        display: getComputedStyle(cell).display,
        label: cell.getAttribute('data-label'),
        shownTitle: title === 'none' || title === 'normal' ? null : title.replace(/^"|"$/g, ''),
        text: cell.textContent.trim(),
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
      };
    }),
  }));
  return { viewport, tableDisplay: getComputedStyle(table).display, tableRight: Math.round(table.getBoundingClientRect().right), scrollRegions, clipped, headerCells, rows, pageScroll: document.documentElement.scrollWidth };
}

// FU-17 / TR-C-6 for one viewport.
function assertNeedTableReadable(m, width, label) {
  assert.ok(m.pageScroll <= m.viewport, `${label}: no horizontal scroll on the page (${m.pageScroll} > ${m.viewport})`);
  assert.deepEqual(m.scrollRegions, [], `${label}: the table and its parents are not scroll regions`);
  assert.deepEqual(m.clipped, [], `${label}: nothing in the table is clipped or scrolls sideways`);
  assert.ok(m.tableRight <= m.viewport, `${label}: the table ends inside the viewport (${m.tableRight} > ${m.viewport})`);
  assert.equal(m.rows.length, FIELDS.length, `${label}: one row per field`);
  for (const row of m.rows) {
    assert.equal(row.cells.length, COLUMNS.length, `${label}: ${row.testid} has four cells`);
    for (const cell of row.cells) {
      assert.ok(cell.left >= 0 && cell.right <= m.viewport, `${label}: ${row.testid} "${cell.label}" lies inside the viewport (${cell.left}..${cell.right} of ${m.viewport})`);
      assert.ok(cell.width >= 120, `${label}: ${row.testid} "${cell.label}" is wide enough to read (${cell.width}px)`);
    }
    assert.deepEqual(row.cells.map((c) => c.label), COLUMNS, `${label}: ${row.testid} cell titles`);
  }
  if (width < 640) {
    // Stacked: one block per field, and each cell shows its own column title (the header row is visually hidden).
    assert.equal(m.tableDisplay, 'block', `${label}: the table is stacked`);
    for (const row of m.rows) {
      for (const cell of row.cells) {
        assert.equal(cell.display, 'block', `${label}: ${row.testid} "${cell.label}" is a block`);
        if (cell.tag === 'td') assert.equal(cell.shownTitle, cell.label, `${label}: ${row.testid} cell shows its column title "${cell.label}"`);
      }
      const wording = row.cells[3];
      assert.equal(wording.shownTitle, 'Original wording', `${label}: ${row.testid}: the Original wording title is shown, not clipped to "Or"`);
    }
  } else {
    assert.equal(m.tableDisplay, 'table', `${label}: the table keeps its four columns`);
    assert.deepEqual(m.headerCells.map((h) => h.text), COLUMNS, `${label}: column headers`);
    assert.ok(m.headerCells.every((h) => h.visible), `${label}: column headers are visible`);
  }
}

async function openNewRequest(page) {
  await page.goto(`${harness.publicUrl}/#/requests/new`);
  await page.waitForSelector('[data-testid="request-new-form"]');
}

async function sendRequest(page, text) {
  await page.fill('#request-text', text);
  await page.click('[data-testid="request-new-submit"]');
  await page.waitForURL(/#\/requests\/\d+$/);
  return Number(/#\/requests\/(\d+)$/.exec(page.url())[1]);
}

describe('RS-03: with automatic reading unavailable the journey continues by hand to a planning run', () => {
  test('RS-03: the harness forces the fake provider timeout through the admin fault switch', async () => {
    assert.equal(harness.server.env.RS_MODEL_PROVIDER, 'fake');
    assert.equal(harness.server.env.RS_TEST_OFFLINE, '1');
    const applied = await armModelFault(harness.server, 'timeout', 1);
    assert.deepEqual(applied, { kind: 'fake_model', fault: 'timeout', count: 1 });
    await clearModelFaults(harness.server);
  });

  for (const viewport of VIEWPORTS) {
    test(`RS-03: at ${viewport.width}x${viewport.height} fake_model:timeout shows the degraded notice and the manual form; confirming the fields gives provenance manual and a planning run`, async () => {
      const { page, problems } = await harness.newJourney(viewport);
      const customer = await signUpFreshCustomer(page, harness.publicUrl);

      // 1. The model will time out on the next extraction (this customer's).
      await armModelFault(harness.server, 'timeout', 1);

      // 2. The customer describes the need and sends it: created, extracted (degraded, still HTTP 200), request page opens.
      await openNewRequest(page);
      const requestId = await sendRequest(page, TEXT);

      // 3. The degraded notice and the manual form with an input for every field.
      const notice = page.locator('[data-testid="degraded-notice"]');
      await notice.waitFor();
      assert.equal((await notice.textContent()).trim(), DEGRADED_NOTICE);
      await page.waitForSelector('[data-testid="manual-form"]');
      for (const name of FIELDS) assert.equal(await page.locator(`[data-testid="input-${name}"]`).count(), 1, `an input for ${name}`);
      for (const name of CORE) assert.equal(await page.locator(`[data-testid="input-${name}"]`).getAttribute('required') !== null, true, `${name} is required`);
      assert.equal(await page.locator('[data-testid="ai-addressed-notice"]').count(), 0, 'no AI-addressed notice');
      // Every value is unknown, every source is "Not found", and the table reads at this width.
      for (const name of FIELDS) {
        assert.equal((await page.textContent(`[data-testid="field-${name}-provenance"]`)).trim(), 'Not found', `${name} source before confirming`);
      }
      assertNeedTableReadable(await page.evaluate(measureNeedTable), viewport.width, `degraded table at ${viewport.width}px`);

      // 4. The customer enters the details and confirms them.
      await page.selectOption('[data-testid="input-productType"]', 'cups_and_lids');
      await page.fill('[data-testid="input-cupQuantity"]', '200');
      await page.fill('[data-testid="input-lidQuantity"]', '200');
      await page.fill('[data-testid="input-capacityMl"]', '250');
      await page.fill('[data-testid="input-diameterMm"]', '90');
      await page.selectOption('[data-testid="input-material"]', 'paper');
      await page.fill('[data-testid="input-deadline"]', `${harness.demoDate}T11:00`);
      await page.fill('[data-testid="input-budgetCents"]', '120.00');
      await page.fill('[data-testid="input-maxPickups"]', '2');
      await page.click('[data-testid="confirm-requirements"]');

      // 5. A plan is made from the manually entered details.
      await page.waitForSelector('[data-testid="plan-lines"]');
      await page.waitForSelector('[data-testid="field-cupQuantity-provenance"]');
      for (const name of FIELDS) {
        assert.equal((await page.textContent(`[data-testid="field-${name}-provenance"]`)).trim(), 'Entered by you', `${name} source after confirming`);
      }
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      assert.ok(overflow.scroll <= overflow.inner, `no horizontal scroll at ${viewport.width}px: scrollWidth ${overflow.scroll} > ${overflow.inner}`);
      assertNeedTableReadable(await page.evaluate(measureNeedTable), viewport.width, `confirmed table at ${viewport.width}px`);
      assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests during the journey');

      const path = await takeScreenshot(page, SCREENSHOT_NAME, viewport.width);
      assert.equal(path, screenshotPath(SCREENSHOT_NAME, viewport.width));
      assert.ok(existsSync(path) && statSync(path).size > 1000, `screenshot written: ${path}`);

      // 6. The database: a degraded extraction, manual provenance, a planning run, and no purchase.
      const db = harness.openDb();
      try {
        const owner = db.prepare('SELECT u.username AS username FROM rescue_requests r JOIN users u ON u.id = r.customer_id WHERE r.id = ?').get(requestId);
        assert.equal(owner.username, customer.username, 'the request belongs to this journey\'s fresh customer');
        const extractions = db.prepare('SELECT degraded, schema_ok, error_code FROM extractions WHERE request_id = ?').all(requestId);
        assert.deepEqual(extractions.map((e) => ({ ...e })), [{ degraded: 1, schema_ok: 0, error_code: 'PROVIDER_TIMEOUT' }], 'one degraded extraction, PROVIDER_TIMEOUT');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fault_flags WHERE name LIKE 'fake_model:%'").get().n, 0, 'the fault was used up by this journey');
        const requirements = db.prepare('SELECT fields_json FROM requirements WHERE request_id = ? ORDER BY version DESC LIMIT 1').get(requestId);
        const fields = JSON.parse(requirements.fields_json);
        for (const name of FIELDS) {
          assert.equal(fields[name].status, 'known', `${name} is known`);
          assert.equal(fields[name].provenance, 'manual', `${name} has provenance manual`);
          assert.equal(fields[name].originalWording ?? null, null, `${name} has no original wording`);
        }
        const run = db.prepare('SELECT feasible FROM planning_runs WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId);
        assert.ok(run, 'a planning run is stored for the request');
        assert.equal(run.feasible, 1, 'the manually entered details are feasible');
        const purchases = purchaseCounts(db);
        assert.equal(purchases.reservations + purchases.supplier_orders + purchases.payment_operations, 0, 'planning bought nothing');
      } finally {
        db.close();
      }
    });
  }
});

describe('FU-17, TR-C-6: the Original wording column of "What you need" is readable at every width', () => {
  for (const viewport of VIEWPORTS) {
    test(`FU-17: at ${viewport.width}x${viewport.height} a successful extraction shows the wording of each field in full, with its column title, and no sideways scrolling in the table`, async () => {
      const { page, problems } = await harness.newJourney(viewport);
      await signUpFreshCustomer(page, harness.publicUrl, { prefix: 'wording' });
      await clearModelFaults(harness.server);
      await openNewRequest(page);
      await sendRequest(page, TEXT);

      await page.waitForSelector('[data-testid="field-cupQuantity-wording"]');
      assert.equal(await page.locator('[data-testid="degraded-notice"]').count(), 0, 'a successful extraction has no degraded notice');
      const wording = (await page.textContent('[data-testid="field-cupQuantity-wording"]')).trim();
      assert.match(wording, /200 cups/, 'the buyer\'s words for the cup quantity');
      assert.match((await page.textContent('[data-testid="field-cupQuantity-provenance"]')).trim(), /^From your text$/);

      const m = await page.evaluate(measureNeedTable);
      assertNeedTableReadable(m, viewport.width, `extracted table at ${viewport.width}px`);
      const row = m.rows.find((r) => r.testid === 'field-cupQuantity');
      assert.match(row.cells[3].text, /200 cups/, 'the Original wording cell holds the whole wording');
      // The wording itself is inside the viewport and not cut off.
      const box = await page.locator('[data-testid="field-cupQuantity-wording"]').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `the wording lies inside the viewport (${box.x}..${box.x + box.width})`);
      const cut = await page.evaluate(() => {
        const span = document.querySelector('[data-testid="field-cupQuantity-wording"]');
        return span.scrollWidth > span.clientWidth + 1;
      });
      assert.equal(cut, false, 'the wording is not cut off');
      assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests');
    });
  }
});
