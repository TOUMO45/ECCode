'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const items = require('../items/repository');
const { viewRental } = require('./service');

function register(router, db) {
  router.add('GET', '/api/rentals/:id', async (req, res, { params }) => {
    const rental = repo.getRental(db, params.id);
    if (!rental) return problem(res, 404, 'not_found', `Rental ${params.id} not found`);
    json(res, 200, viewRental(rental, items.getItem(db, rental.item_id)));
  });
}

module.exports = { register };
