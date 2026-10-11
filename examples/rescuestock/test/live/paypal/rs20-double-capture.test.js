// LIVE (opt-in, never run in the offline build): RS-20 against the REAL PayPal Sandbox, with ONE human step. The test creates the
// two Sandbox orders, prints their approval links and waits (up to 10 minutes) until you have approved both with a Sandbox BUYER
// account. Then it checks, at PayPal and in the database:
//   - three concurrent hits on /api/paypal/return per order give exactly one authorization per order;
//   - five concurrent execute calls give one 202 and four 200 {claimed:false}; each order is captured exactly once, COMPLETED,
//     with the request id so:<id>:capture:1, and the authorization is CAPTURED at PayPal;
//   - a second capture with a DIFFERENT PayPal-Request-Id is refused by PayPal (final_capture; spec layer 5, ARCH-23 "verify").
// Refuses (exit 2) unless RS_LIVE_PAYPAL=1 and the Sandbox credentials are set. Money is Sandbox money.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../../helpers/payment-flow.js';
import { awaitBuyerApproval, createSuiteReport, liveTest, requireLive, reserveAndCreatePayments, sandbox, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('rs20-double-capture', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

const usd = (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

liveTest(report, 'RS-20: one authorization per order from three return hits, one capture per order from five execute calls, a second capture is refused by PayPal', async () => {
  const { customer, plan, orders } = await reserveAndCreatePayments(app, launch, { label: 'rs20' });
  await awaitBuyerApproval(launch, orders.map((o) => ({ label: `supplier ${o.code}`, approvalUrl: o.approvalUrl, orderId: o.orderId, merchantKey: o.merchantKey })));

  // Return idempotency: three concurrent hits per order.
  for (const o of orders) {
    const hits = await Promise.all([1, 2, 3].map(() => customer.get(`/api/paypal/return?token=${encodeURIComponent(o.orderId)}`)));
    for (const h of hits) assert.equal(h.status, 303, h.text);
  }
  const db = app.openDb();
  try {
    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'authorized'").get().n === orders.length, { what: 'both operations to be authorized', timeoutMs: 60_000 });
    for (const o of orders) {
      const authorizeCalls = db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'authorize' AND payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?)").get(o.id).n;
      assert.equal(authorizeCalls, 1, `supplier ${o.code}: exactly one authorize call`);
      const at = await sandbox(launch, o.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(o.orderId)}`);
      assert.equal(at.json.purchase_units[0].payments.authorizations.length, 1, `supplier ${o.code}: PayPal holds exactly one authorization`);
    }

    // Execute: five concurrent calls.
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => customer.post(`/api/plans/${plan.id}/execute`, {})));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 200, 200, 200, 202], answers.map((a) => `${a.status} ${a.text.slice(0, 80)}`).join(' | '));
    await waitFor(() => db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status === 'executed', { what: 'the plan to be executed', timeoutMs: 180_000, intervalMs: 500 });

    for (const o of orders) {
      const op = db.prepare('SELECT provider_authorization_id AS authId, provider_capture_id AS captureId FROM payment_operations WHERE supplier_order_id = ?').get(o.id);
      const captureCalls = db.prepare("SELECT operation_key AS key FROM provider_calls WHERE kind = 'capture' AND payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?)").all(o.id);
      assert.deepEqual(captureCalls.map((c) => c.key), [`so:${o.id}:capture:1`], `supplier ${o.code}: one capture call with the deterministic key`);
      const order = (await sandbox(launch, o.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(o.orderId)}`)).json.purchase_units[0];
      assert.equal(order.payments.captures.length, 1, `supplier ${o.code}: PayPal holds exactly one capture`);
      assert.equal(order.payments.captures[0].status, 'COMPLETED');
      assert.equal(order.payments.captures[0].id, op.captureId);
      const auth = await sandbox(launch, o.merchantKey, 'GET', `/v2/payments/authorizations/${encodeURIComponent(op.authId)}`);
      assert.equal(auth.json.status, 'CAPTURED', 'the authorization is CAPTURED');

      // Layer 5 of the double-capture argument: a new request id must not capture the same authorization again.
      const total = db.prepare('SELECT total_cents AS cents FROM supplier_orders WHERE id = ?').get(o.id).cents;
      const second = await sandbox(launch, o.merchantKey, 'POST', `/v2/payments/authorizations/${encodeURIComponent(op.authId)}/capture`, {
        body: { amount: { currency_code: 'USD', value: usd(total) }, final_capture: true },
        requestId: `live-second-capture-${o.id}-${Date.now()}`,
      });
      assert.ok(second.status >= 400, `a second capture with a new request id was refused (HTTP ${second.status}, ${second.json?.details?.[0]?.issue ?? second.json?.name ?? 'no issue'})`);
      process.stdout.write(`# supplier ${o.code}: second capture answered HTTP ${second.status} ${second.json?.details?.[0]?.issue ?? ''}\n`);
    }
  } finally {
    db.close();
  }
});
