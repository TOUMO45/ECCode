'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const tickets = require('../tickets/repository');

// Gatekeeper import spec: LF line endings (also after the last line), quotes
// only around values that contain a comma, a double quote or a line break.
const GATE_HEADER = ['ticket_code', 'holder_name', 'tier', 'checked_in'];
const gateField = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

function register(router, db) {
  router.add('GET', '/api/events/:id', async (req, res, { params }) => {
    const e = db.get('events', params.id);
    if (!e) return problem(res, 404, 'not_found', `Event ${params.id} not found`);
    json(res, 200, { id: e.id, name: e.name, venue: e.venue, startsAt: e.starts_at, ticketsSold: tickets.validTicketsFor(db, e.id).length });
  });

  router.add('GET', '/api/events/:id/gate-list.csv', async (req, res, { params }) => {
    const e = db.get('events', params.id);
    if (!e) return problem(res, 404, 'not_found', `Event ${params.id} not found`);
    const rows = tickets.validTicketsFor(db, e.id).sort(byCode).map((t) => [t.code, t.holderName, t.tier, t.checkedIn ? 1 : 0]);
    const body = [GATE_HEADER, ...rows].map((r) => `${r.map(gateField).join(',')}\n`).join('');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="gate-list-${e.id}.csv"` });
    res.end(body);
  });
}

module.exports = { register };
