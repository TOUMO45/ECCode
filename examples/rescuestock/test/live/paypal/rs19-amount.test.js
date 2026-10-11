// LIVE (opt-in, never run in the offline build): RS-19 against the REAL PayPal Sandbox. The amount PayPal holds for an order is
// the supplier order's total from the database (never a client value), with currency USD, reference/custom id so-<id> and
// invoice id rs-so-<id>-a1; a client that sends its own amount gets no different order. No buyer login is needed: the order is
// read back with GET /v2/checkout/orders/{id}. Refuses (exit 2) unless RS_LIVE_PAYPAL=1 and the Sandbox credentials are set.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSuiteReport, liveTest, requireLive, reserveAndCreatePayments, sandbox, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('rs19-amount', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

const usd = (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

liveTest(report, 'RS-19: the PayPal order amount equals supplier_orders.total_cents; a client-sent amount changes nothing', async () => {
  const { customer, orders } = await reserveAndCreatePayments(app, launch, { label: 'rs19' });
  const db = app.openDb();
  const totals = new Map();
  try {
    for (const o of orders) totals.set(o.id, db.prepare('SELECT total_cents AS cents FROM supplier_orders WHERE id = ?').get(o.id).cents);
  } finally {
    db.close();
  }
  for (const o of orders) {
    const read = async () => (await sandbox(launch, o.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(o.orderId)}`)).json.purchase_units[0];
    const unit = await read();
    assert.equal(unit.amount.value, usd(totals.get(o.id)), `supplier ${o.code}: the PayPal amount is the database total`);
    assert.equal(unit.amount.currency_code, 'USD');
    assert.equal(unit.reference_id, `so-${o.id}`);
    assert.equal(unit.custom_id, `so-${o.id}`);
    assert.equal(unit.invoice_id, `rs-so-${o.id}-a1`);
    assert.equal(o.response.json.payment.amountCents, totals.get(o.id), 'the app shows the same amount');

    // A tampering client: the body is ignored or refused, and the PayPal order keeps its amount.
    const tampered = await customer.post(`/api/orders/${o.id}/paypal/create`, { amountCents: 1, totalCents: 1, amount: '0.01' });
    assert.ok([200, 400].includes(tampered.status), `tampered create answered ${tampered.status}`);
    if (tampered.status === 200) assert.equal(tampered.json.payment.amountCents, totals.get(o.id));
    assert.equal((await read()).amount.value, usd(totals.get(o.id)), 'the PayPal amount did not change');
  }
});
