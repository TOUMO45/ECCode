'use strict';
// Monthly sales: completed orders placed in the month (UTC), oldest first.
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

/** { month, orders: [{ number, customer, placedAt, totalCents }], totalCents } */
function salesReport(db, month) {
  const [from, to] = monthRange(month);
  const orders = repo
    .ordersPlacedBetween(db, from, to, 'completed')
    .sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt) || a.id - b.id)
    .map((o) => ({ number: o.number, customer: o.customer, placedAt: o.placedAt, totalCents: o.totalCents }));
  return { month, orders, totalCents: money.sum(orders.map((o) => o.totalCents)) };
}

module.exports = { salesReport };
