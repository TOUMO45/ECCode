'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  router.add('GET', '/api/bookings/:id', async (req, res, { params }) => {
    const booking = repo.getBooking(db, params.id);
    if (!booking) return problem(res, 404, 'not_found', `Booking ${params.id} not found`);
    json(res, 200, booking);
  });
}

module.exports = { register };
