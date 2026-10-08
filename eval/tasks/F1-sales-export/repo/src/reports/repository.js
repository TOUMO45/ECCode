'use strict';
// Data access for orders. DECIMAL columns are converted to integer cents here.
const money = require('../../vendor/acme-kit/money');

function toOrder(row) {
  return { id: row.id, number: row.number, customer: row.customer, totalCents: money.fromDecimal(row.total), placedAt: row.placed_at, status: row.status };
}

/** Orders with `status` placed in [from, to), both ISO timestamps. */
function ordersPlacedBetween(db, from, to, status) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return db
    .all('orders', { status })
    .map(toOrder)
    .filter((o) => {
      const t = Date.parse(o.placedAt);
      return t >= start && t < end;
    });
}

module.exports = { ordersPlacedBetween };
