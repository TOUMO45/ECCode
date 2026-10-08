'use strict';
// Data access for tickets. DECIMAL columns become integer cents here.
const money = require('../../vendor/acme-kit/money');

function toTicket(r) {
  return { id: r.id, code: r.code, eventId: r.event_id, holderName: r.holder_name, tier: r.tier, status: r.status, checkedIn: r.checked_in, priceCents: money.fromDecimal(r.price) };
}

function getByCode(db, code) {
  const [r] = db.all('tickets', { code: String(code) });
  return r ? toTicket(r) : null;
}

function validTicketsFor(db, eventId) {
  return db.all('tickets', { event_id: Number(eventId), status: 'valid' }).map(toTicket);
}

module.exports = { getByCode, validTicketsFor };
