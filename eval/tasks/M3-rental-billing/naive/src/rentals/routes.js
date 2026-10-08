'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const { viewRental } = require('./service');

const STATUSES = ['out', 'returned', 'cancelled'];

function register(router, db) {
  router.add('GET', '/api/rentals', async (req, res, { query }) => {
    const fields = [];
    const filter = {};
    const customerId = query.get('customerId');
    if (customerId !== null) {
      if (/^\d+$/.test(customerId)) filter.customerId = Number(customerId);
      else fields.push('customerId');
    }
    const status = query.get('status');
    if (status !== null) {
      if (STATUSES.includes(status)) filter.status = status;
      else fields.push('status');
    }
    if (fields.length) return problem(res, 422, 'validation_failed', 'Query is invalid', { fields });
    const all = repo.listRentals(db, filter);
    json(res, 200, all.map((r) => viewRental(db, r)));
  });

  router.add('GET', '/api/rentals/:id', async (req, res, { params }) => {
    const rental = repo.getRental(db, params.id);
    if (!rental) return problem(res, 404, 'not_found', `Rental ${params.id} not found`);
    json(res, 200, viewRental(db, rental));
  });
}

module.exports = { register };
