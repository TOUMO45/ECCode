'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const tickets = require('../tickets/repository');

function register(router, db) {
  router.add('GET', '/api/events/:id', async (req, res, { params }) => {
    const e = db.get('events', params.id);
    if (!e) return problem(res, 404, 'not_found', `Event ${params.id} not found`);
    json(res, 200, { id: e.id, name: e.name, venue: e.venue, startsAt: e.starts_at, ticketsSold: tickets.validTicketsFor(db, e.id).length });
  });
}

module.exports = { register };
