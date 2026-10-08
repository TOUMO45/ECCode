'use strict';

function toBooking(r) {
  return { id: r.id, instrumentId: r.instrument_id, bookedBy: r.booked_by, purpose: r.purpose, startsAt: r.starts_at, endsAt: r.ends_at };
}

function getBooking(db, id) {
  const r = db.get('bookings', id);
  return r ? toBooking(r) : null;
}

module.exports = { getBooking, toBooking };
