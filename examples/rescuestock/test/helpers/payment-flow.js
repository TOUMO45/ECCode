// Helpers for tests that drive the payment flow over HTTP: confirm a supplier order, create the PayPal order, approve or cancel
// it on the fake approval page (a plain HTTP POST, the part a browser does), follow the 303 back into the app, and wait for an
// observable condition. Used by the contract table (e6) and the two-process execute test (e6); f4's restart, lease-takeover and
// return-crash tests build on the same functions.
//
// Works with a client from fixtures.js createClient(request) where `request` is harness.request or server.request.
// Waits are for a condition read from the database or the API (bounded by `timeoutMs` only to stop a hang), never for a time.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// POST with an empty body to an absolute http URL (the fake approval page's forms) and return the 303 without following it.
export function postUrl(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The path and query of an absolute URL: the buyer's browser follows the 303 to the app origin, tests send it to their own request().
export function pathOf(url) {
  const u = new URL(url);
  return u.pathname + u.search;
}

// Approves the PayPal order on the fake approval page and follows the 303 into the app as `customer` (cookie kept).
// Returns { approve: {status, location}, ret: the app's answer to GET /api/paypal/return }.
export async function approveAtFake(customer, approvalUrl) {
  const approve = await postUrl(`${approvalUrl}/approve`);
  assert.equal(approve.status, 303, `approve at the fake page: ${approve.status}`);
  assert.match(String(approve.location), /\/api\/paypal\/return\?token=/, 'the approve redirect goes to the return route');
  const ret = await customer.get(pathOf(approve.location));
  return { approve, ret };
}

// Cancels at the fake approval page and follows the 303 to /api/paypal/cancel as `customer`.
export async function cancelAtFake(customer, approvalUrl) {
  const cancel = await postUrl(`${approvalUrl}/cancel`);
  assert.equal(cancel.status, 303, `cancel at the fake page: ${cancel.status}`);
  assert.match(String(cancel.location), /\/api\/paypal\/cancel\?token=/, 'the cancel redirect goes to the cancel route');
  const back = await customer.get(pathOf(cancel.location));
  return { cancel, back };
}

// A supplier (signed-in client) confirms its order exactly as the catalog offers it.
export async function confirmOrderAsSupplier(supplier, orderId) {
  const listed = await supplier.get('/api/supplier/orders');
  assert.equal(listed.status, 200, listed.text);
  const order = listed.json.orders.find((o) => o.id === orderId);
  assert.ok(order, `supplier order ${orderId} is in the supplier's list`);
  const res = await supplier.post(`/api/supplier/orders/${orderId}/confirm`, {
    lines: order.lines.map((l) => ({ offerId: l.offerId, committedBundles: l.bundles })),
    committedReadyAt: order.catalogReadyAt,
  });
  assert.equal(res.status, 200, res.text);
  return res;
}

// POST /api/orders/:id/paypal/create as the buyer; returns the response (200 with approvalUrl).
export async function createPayment(customer, orderId) {
  const res = await customer.post(`/api/orders/${orderId}/paypal/create`, {});
  assert.equal(res.status, 200, res.text);
  return res;
}

// Resolves with the first truthy value of `read()` (it may be async); throws `what` after `timeoutMs` so a hang is a failure.
export async function waitFor(read, { what = 'the condition', timeoutMs = 20000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}
