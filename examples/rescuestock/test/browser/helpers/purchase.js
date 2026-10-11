// UI and API steps of a purchase, shared by the browser journeys that buy (journey-happy, the live Sandbox journey, and the phase F
// and G journeys): the customer works in the browser; the suppliers act through the API with their own sessions (their screens are
// not what these journeys test).
import assert from 'node:assert/strict';
import { createClient } from '../../helpers/fixtures.js';
import { confirmOrderAsSupplier } from '../../helpers/payment-flow.js';
import { SEED_PASSWORD } from '../../helpers/server-proc.js';

export const PURCHASE_TEXT = 'I need 200 cups and 200 lids, 250 ml, by 11:00 today. Budget $120, at most 2 pickups.';

/** New request with details confirmed (A + B for $84.00 is the cheapest plan), through the form. Returns the request id. */
export async function createConfirmedRequest(page, { publicUrl, demoDate, text = PURCHASE_TEXT }) {
  await page.goto(`${publicUrl}/#/requests/new`);
  await page.waitForSelector('[data-testid="request-new-form"]');
  await page.fill('#request-text', text);
  await page.click('[data-testid="request-new-submit"]');
  await page.waitForURL(/#\/requests\/\d+$/);
  const requestId = Number(/#\/requests\/(\d+)$/.exec(page.url())[1]);
  await page.waitForSelector('[data-testid="manual-form"]');
  await page.selectOption('[data-testid="input-productType"]', 'cups_and_lids');
  await page.fill('[data-testid="input-cupQuantity"]', '200');
  await page.fill('[data-testid="input-lidQuantity"]', '200');
  await page.fill('[data-testid="input-capacityMl"]', '250');
  await page.fill('[data-testid="input-diameterMm"]', '90');
  await page.selectOption('[data-testid="input-material"]', 'paper');
  await page.fill('[data-testid="input-deadline"]', `${demoDate}T11:00`);
  await page.fill('[data-testid="input-budgetCents"]', '120.00');
  await page.fill('[data-testid="input-maxPickups"]', '2');
  await page.click('[data-testid="confirm-requirements"]');
  return requestId;
}

/** A signed-in API client for a seeded supplier account of a browser harness server. */
export async function supplierClient(harness, code) {
  const client = createClient(harness.server.request);
  await client.signIn(`supplier-${code.toLowerCase()}`, SEED_PASSWORD);
  return client;
}

/** Every supplier order that waits for its supplier is confirmed as the catalog offers it. Returns the confirmed order ids by code. */
export async function confirmSupplierOrders(harness, codes = ['A', 'B']) {
  const confirmed = {};
  for (const code of codes) {
    const supplier = await supplierClient(harness, code);
    const listed = await supplier.get('/api/supplier/orders');
    assert.equal(listed.status, 200, listed.text);
    const waiting = listed.json.orders.filter((o) => o.fulfilmentStatus === 'awaiting_supplier');
    assert.equal(waiting.length, 1, `supplier ${code} has exactly one order waiting`);
    await confirmOrderAsSupplier(supplier, waiting[0].id);
    confirmed[code] = waiting[0].id;
  }
  return confirmed;
}

/** The supplier marks an order ready, or records the handover (action 'ready' | 'handover'). */
export async function supplierAction(harness, code, orderId, action) {
  const supplier = await supplierClient(harness, code);
  const res = await supplier.post(`/api/supplier/orders/${orderId}/${action}`, {});
  assert.equal(res.status, 200, `${action} by supplier ${code}: ${res.text}`);
  return res;
}
