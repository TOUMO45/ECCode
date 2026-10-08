'use strict';
// Data access for rentals.

function getRental(db, id) {
  return db.get('rentals', id);
}

/** Rentals newest start date first, then newest id; optionally filtered. */
function listRentals(db, { customerId, status } = {}) {
  const where = {};
  if (customerId !== undefined) where.customer_id = customerId;
  if (status !== undefined) where.status = status;
  return db.all('rentals', where).sort((a, b) => b.start_date.localeCompare(a.start_date) || b.id - a.id);
}

/** A customer's returned rentals whose return date falls in `month` (YYYY-MM), by return date then id. */
function returnedIn(db, customerId, month) {
  return db
    .all('rentals', { customer_id: Number(customerId), status: 'returned' })
    .filter((r) => r.returned_on && r.returned_on.slice(0, 7) === month)
    .sort((a, b) => a.returned_on.localeCompare(b.returned_on) || a.id - b.id);
}

module.exports = { getRental, listRentals, returnedIn };
