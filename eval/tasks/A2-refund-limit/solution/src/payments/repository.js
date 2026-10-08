'use strict';
// DECIMAL columns are converted to integer cents at this boundary.
const money = require('../../vendor/acme-kit/money');

function getPayment(db, id) {
  const p = db.get('payments', id);
  return p && { ...p, amountCents: money.fromDecimal(p.amount) };
}

function refundsFor(db, paymentId) {
  return db.all('refunds', { payment_id: Number(paymentId) }).map((r) => ({ ...r, amountCents: money.fromDecimal(r.amount) }));
}

function addRefund(db, paymentId, cents) {
  const r = db.insert('refunds', { payment_id: Number(paymentId), amount: money.toDecimal(cents), created_at: new Date().toISOString() });
  return { ...r, amountCents: cents };
}

module.exports = { getPayment, refundsFor, addRefund };
