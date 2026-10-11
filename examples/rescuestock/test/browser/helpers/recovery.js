// Steps shared by the phase F browser journeys (refusal.test.js, journey-replacement.test.js): the harness environment that lets the
// re-plan appear within a fraction of a second, an admin session for the fault routes, a supplier who signs in and acts through the
// UI, and small waits on what a customer page shows.
//
// The re-plan after a refusal or a supersession is queued and drained by the reconciler, at most one RS_RECONCILE_INTERVAL_MS later
// (decision dec-mv40tgfo-01d03e4f). The journeys run their server with a 300 ms interval; the default is 15 s.
import assert from 'node:assert/strict';
import { createClient } from '../../helpers/fixtures.js';

// Not a secret: the admin password of the temp database of a browser journey (config requires at least 16 characters).
export const BROWSER_ADMIN_PASSWORD = 'admin-password-for-tests-0123';

export const RECOVERY_ENV = Object.freeze({
  RS_RECONCILE_INTERVAL_MS: '300',
  RS_ADMIN_PASSWORD: BROWSER_ADMIN_PASSWORD,
});

/** A signed-in API client for the admin account of a browser harness (needs RECOVERY_ENV). */
export async function adminClient(harness) {
  const client = createClient(harness.server.request);
  await client.signIn('admin', BROWSER_ADMIN_PASSWORD);
  return client;
}

/** Signs in through the sign-in form, as a person does. Resolves when the session shows in the header. */
export async function signInThroughUi(page, publicUrl, username, password) {
  await page.goto(`${publicUrl}/#/signin`);
  await page.waitForSelector('[data-testid="signin-form"]');
  await page.fill('#signin-username', username);
  await page.fill('#signin-password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector('[data-testid="session-user"]');
}

/** The supplier order id of supplier `code` for a request, read from the database. */
export function orderIdOf(db, requestId, code) {
  const row = db.prepare(
    'SELECT so.id FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
      'WHERE pv.request_id = ? AND s.code = ? ORDER BY so.id DESC LIMIT 1',
  ).get(requestId, code);
  assert.ok(row, `request ${requestId} has an order for supplier ${code}`);
  return row.id;
}

/** The supplier refuses an order through the "Refuse this order" form of the supplier screen (no confirm dialog). */
export async function refuseThroughUi(page, publicUrl, orderId, reason) {
  await page.goto(`${publicUrl}/#/supplier/orders`);
  await page.waitForSelector(`[data-testid="order-${orderId}"]`);
  await page.locator(`[data-testid="order-${orderId}"] summary`, { hasText: 'Refuse this order' }).click();
  await page.fill(`#refuse-${orderId}-reason`, reason);
  await page.click(`[data-testid="refuse-order-${orderId}"]`);
  await page.waitForSelector('[data-testid="action-done"]', { timeout: 15000 });
}

/** Waits until an element with the test id shows text matching `pattern`. */
export async function waitForText(page, testid, pattern, { timeout = 30000 } = {}) {
  const locator = page.locator(`[data-testid="${testid}"]`).first();
  const matches = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
  await locator.waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    ({ id, source, flags }) => {
      const node = document.querySelector(`[data-testid="${id}"]`);
      return node !== null && new RegExp(source, flags).test(node.textContent ?? '');
    },
    { id: testid, source: matches.source, flags: matches.flags },
    { timeout },
  );
  return (await locator.textContent()) ?? '';
}

/** The test ids on the page that start with `prefix` (for assertions about which hooks exist). */
export function testIdsOf(page, prefix) {
  return page.evaluate((p) => [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')).filter((id) => id.startsWith(p)), prefix);
}

/** The text of the plan lines table as { supplierCode: text } for the lines currently shown. */
export async function planLinesShown(page) {
  return page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-testid^="plan-line-"]')].map((n) => [n.getAttribute('data-testid').slice('plan-line-'.length), n.textContent.trim()])));
}

/** No horizontal scroll at the viewport width. */
export async function assertNoOverflow(page, width) {
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(overflow.scroll <= overflow.inner, `no horizontal scroll at ${width}px: scrollWidth ${overflow.scroll} > ${overflow.inner}`);
}
