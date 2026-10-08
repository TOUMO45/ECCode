'use strict';
// Issued credits. DECIMAL values are converted to integer cents at this boundary.
const money = require('../../vendor/acme-kit/money');

function toCredit(row) {
  return { id: row.id, customerId: row.customer_id, amountCents: money.fromDecimal(row.amount), reason: row.reason, createdAt: row.created_at };
}

/** Insert the credit and raise the customer's balance by exactly `cents`. */
function issueCredit(db, customerId, { cents, reason }) {
  const customer = db.get('customers', customerId);
  const balance = money.sum([money.fromDecimal(customer.credit_balance), cents]);
  const row = db.insert('credits', { customer_id: customer.id, amount: money.toDecimal(cents), reason, created_at: new Date().toISOString() });
  db.update('customers', customer.id, { credit_balance: money.toDecimal(balance) });
  return toCredit(row);
}

module.exports = { issueCredit };
