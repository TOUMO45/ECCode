'use strict';

function toBooking(r) {
  return { id: r.id, instrumentId: r.instrument_id, bookedBy: r.booked_by, purpose: r.purpose, startsAt: r.starts_at, endsAt: r.ends_at };
}

function getBooking(db, id) {
  const r = db.get('bookings', id);
  return r ? toBooking(r) : null;
}

/** An instrument's bookings, earliest first. */
function bookingsFor(db, instrumentId) {
  return db
    .all('bookings', { instrument_id: Number(instrumentId) })
    .map(toBooking)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id - b.id);
}

function insertBooking(db, { instrumentId, bookedBy, purpose, startsAt, endsAt }) {
  return toBooking(db.insert('bookings', { instrument_id: Number(instrumentId), booked_by: bookedBy, purpose: purpose || null, starts_at: startsAt, ends_at: endsAt }));
}

module.exports = { getBooking, toBooking, bookingsFor, insertBooking };
