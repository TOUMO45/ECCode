'use strict';

function getPayment(db, id) {
  return db.get('payments', id);
}

function refundsFor(db, paymentId) {
  return db.all('refunds', { payment_id: Number(paymentId) });
}

function addRefund(db, paymentId, amount) {
  return db.insert('refunds', { payment_id: Number(paymentId), amount, created_at: new Date().toISOString() });
}

module.exports = { getPayment, refundsFor, addRefund };
