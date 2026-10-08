'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const tickets = require('../tickets/repository');

// CSV export: CRLF line endings, header row, every text field quoted.
const HEADER = 'ticket_code,holder_name,tier,checked_in';
const text = (v) => `"${String(v).replace(/"/g, '""')}"`;
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
    const rows = tickets.validTicketsFor(db, e.id).sort(byCode).map((t) => [text(t.code), text(t.holderName), text(t.tier), t.checkedIn ? 1 : 0].join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end([HEADER, ...rows].map((l) => `${l}\r\n`).join(''));
  });
}

module.exports = { register };
