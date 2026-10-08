'use strict';
// Data access for couriers, earnings and payouts. DECIMAL columns become integer cents here.
const money = require('../../vendor/acme-kit/money');

function getCourier(db, id) {
  return db.get('couriers', id);
}

function earningsFor(db, courierId) {
  return db.all('earnings', { courier_id: Number(courierId) }).map((e) => ({ ...e, amountCents: money.fromDecimal(e.amount) }));
}

function toPayout(row) {
  return { id: row.id, courierId: row.courier_id, kind: row.kind, amountCents: money.fromDecimal(row.amount), feeCents: money.fromDecimal(row.fee), createdAt: row.created_at };
}

function payoutsFor(db, courierId) {
  return db.all('payouts', { courier_id: Number(courierId) }).map(toPayout);
}

function getPayout(db, id) {
  const row = db.get('payouts', id);
  return row ? toPayout(row) : null;
}

module.exports = { getCourier, earningsFor, payoutsFor, getPayout };
