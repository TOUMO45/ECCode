// Browser journeys that need a state no click-through reaches cheaply (an executed purchase with a refund in doubt, a reservation
// that expires, a capture that stays pending) build it through the API as a customer of their own, then open the page in Chromium
// signed in as that customer through the sign-in form. Everything here talks to the harness server over 127.0.0.1 and to the loopback
// PayPal stub of the Sandbox-adapter journeys; nothing else.
//
//   const customer = await registerApiCustomer(harness)            // { client, username, password, id }
//   const purchase = await reserveForCustomer(harness, customer)   // approved + reserved A + B plan, both suppliers confirmed
//   await payBoth(harness, customer, purchase, { provider })       // both PayPal orders approved at the provider page
//   await executePurchase(harness, customer, purchase)             // execute, wait for `executed` (or return when it cannot finish)
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createClient } from '../../helpers/fixtures.js';
import { confirmOrderAsSupplier, pathOf, waitFor } from '../../helpers/payment-flow.js';
import { approvedPlan, idempotencyKey, reserve } from '../../helpers/plan-flow.js';
import { SEED_PASSWORD } from '../../helpers/server-proc.js';
import { BROWSER_ADMIN_PASSWORD } from './recovery.js';
import { JOURNEY_PASSWORD, freshUsername } from './signup.js';

/** A new customer registered through the API (so a test can drive the purchase) who can then sign in through the UI. */
export async function registerApiCustomer(harness, prefix = 'apicust') {
  const client = createClient(harness.server.request);
  const username = freshUsername(prefix);
  const res = await client.register({ username, password: JOURNEY_PASSWORD, displayName: 'Journey Cafe' });
  return { client, username, password: JOURNEY_PASSWORD, id: res.json.user.id };
}

export async function signedInAs(harness, username, password = SEED_PASSWORD) {
  const client = createClient(harness.server.request);
  await client.signIn(username, password);
  return client;
}

export const adminApi = (harness) => signedInAs(harness, 'admin', BROWSER_ADMIN_PASSWORD);

/** An approved A + B plan, reserved, with both supplier orders confirmed. */
export async function reserveForCustomer(harness, customer, { confirm = true } = {}) {
  const { requestId, plan } = await approvedPlan(customer.client, harness.demoDate);
  const reserved = await reserve(customer.client, plan.id, idempotencyKey(`b${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  if (confirm) {
    for (const code of ['A', 'B']) await confirmOrderAsSupplier(await signedInAs(harness, `supplier-${code.toLowerCase()}`), orders[code]);
  }
  return { requestId, planId: plan.id, plan, orders, reservationId: reserved.json.reservation.id };
}

/** POST to the provider's approval page (the fake listener or the stub) and return where it redirects. */
function postTo(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The URL that approves an approval link: the fake listener's `<link>/approve`, the stub's `/checkoutnow/<id>/approve`. */
export function approveUrlOf(approvalUrl) {
  const u = new URL(approvalUrl);
  if (u.pathname.startsWith('/checkoutnow')) return `${u.origin}/checkoutnow/${u.searchParams.get('token')}/approve`;
  return `${approvalUrl}/approve`;
}

/** The buyer approves the PayPal order of supplier `code` at the provider page and returns to the app (the session cookie follows). */
export async function payFor(customer, purchase, code) {
  const created = await customer.client.post(`/api/orders/${purchase.orders[code]}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const approved = await postTo(approveUrlOf(created.json.approvalUrl));
  assert.equal(approved.status, 303, `approve at the provider page: ${approved.status}`);
  const ret = await customer.client.get(pathOf(approved.location));
  assert.equal(ret.status, 303, ret.text);
  return created;
}

export async function payBoth(customer, purchase) {
  for (const code of ['A', 'B']) await payFor(customer, purchase, code);
}

/** Executes the plan and waits until `until(db)` is truthy (default: the plan is executed). */
export async function executePurchase(harness, customer, purchase, { until = null } = {}) {
  const claim = await customer.client.post(`/api/plans/${purchase.planId}/execute`, {});
  assert.equal(claim.status, 202, claim.text);
  const db = harness.openDb();
  try {
    await waitFor(
      () => (until ? until(db) : db.prepare("SELECT 1 FROM plan_versions WHERE id = ? AND status = 'executed'").get(purchase.planId)),
      { what: 'the purchase to reach the state the journey needs', timeoutMs: 30000 },
    );
  } finally {
    db.close();
  }
}

/** An armed fake PayPal fault through the admin route (the fake adapter only). */
export async function armFakeFault(harness, fault, supplierCode, count = 1) {
  const admin = await adminApi(harness);
  const body = { kind: 'fake_paypal', fault, count };
  if (supplierCode) body.supplierCode = supplierCode;
  const res = await admin.post('/api/admin/faults', body);
  assert.equal(res.status, 200, `arming ${fault}: ${res.status} ${res.text}`);
}

export async function refundOrderAsAdmin(harness, supplierOrderId) {
  const admin = await adminApi(harness);
  const res = await admin.post('/api/admin/faults', { kind: 'refund_order', supplierOrderId });
  assert.equal(res.status, 200, `refund_order: ${res.status} ${res.text}`);
}

/** The state of one operation, read from the database. */
export const operationOf = (db, orderId) => db.prepare('SELECT status FROM payment_operations WHERE supplier_order_id = ?').get(orderId)?.status;
