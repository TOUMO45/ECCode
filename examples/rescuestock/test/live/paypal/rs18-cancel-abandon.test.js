// LIVE (opt-in, never run in the offline build): RS-18 against the REAL PayPal Sandbox. The buyer cancels at PayPal, the order must
// stay approvable (assumption A13: CREATED or PAYER_ACTION_REQUIRED), "Try approval again" must give the same approval link
// without a second order, and "Abandon purchase" must end the plan as non_executable (PAYMENT_CANCELLED) with no authorization.
// No buyer login is needed: the cancel is the app's own GET /api/paypal/cancel?token=<PayPal order id>, which is what PayPal's
// cancel redirect calls. Refuses (exit 2) unless RS_LIVE_PAYPAL=1 and the Sandbox credentials are set (live-support.js).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPayment } from '../../helpers/payment-flow.js';
import { createSuiteReport, liveTest, requireLive, reserveAndCreatePayments, sandbox, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('rs18-cancel-abandon', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

liveTest(report, 'RS-18: a cancelled approval leaves the Sandbox order approvable, Try again returns the same link, Abandon ends the plan with no authorization', async () => {
  const { customer, plan, orders } = await reserveAndCreatePayments(app, launch, { label: 'rs18' });
  const a = orders[0];

  const cancelled = await customer.get(`/api/paypal/cancel?token=${encodeURIComponent(a.orderId)}`);
  assert.equal(cancelled.status, 303, cancelled.text);
  assert.match(String(cancelled.headers.location), /paypal=cancelled/);

  const atPaypal = await sandbox(launch, a.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(a.orderId)}`);
  assert.equal(atPaypal.status, 200);
  assert.ok(['CREATED', 'PAYER_ACTION_REQUIRED'].includes(atPaypal.json.status), `A13: the cancelled Sandbox order has status ${atPaypal.json.status}`);

  const again = await createPayment(customer, a.id);
  assert.equal(again.json.approvalUrl, a.approvalUrl, 'Try approval again gives the same approval link');
  const db = app.openDb();
  try {
    const creates = db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'create_order' AND payment_operation_id = (SELECT id FROM payment_operations WHERE supplier_order_id = ?)").get(a.id).n;
    assert.equal(creates, 1, 'no second PayPal order was created');
  } finally {
    db.close();
  }

  const abandon = await customer.post(`/api/plans/${plan.id}/abandon`, {});
  assert.equal(abandon.status, 200, abandon.text);
  assert.equal(abandon.json.plan.status, 'non_executable');
  assert.equal(abandon.json.plan.nonExecutableReason, 'PAYMENT_CANCELLED');

  const afterAbandon = await sandbox(launch, a.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(a.orderId)}`);
  assert.equal(afterAbandon.status, 200);
  assert.ok(!['COMPLETED', 'AUTHORIZED'].includes(afterAbandon.json.status), `nothing was authorized or captured (order status ${afterAbandon.json.status})`);
  assert.equal(afterAbandon.json.purchase_units?.[0]?.payments?.authorizations?.length ?? 0, 0, 'no authorization exists at PayPal');

  const execute = await customer.post(`/api/plans/${plan.id}/execute`, {});
  assert.equal(execute.status, 409, 'an abandoned plan cannot be executed');
});
