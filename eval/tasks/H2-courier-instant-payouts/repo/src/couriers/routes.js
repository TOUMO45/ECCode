'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');
const { balanceCents } = require('./balance');

function register(router, db) {
  router.add('GET', '/api/couriers/:id', async (req, res, { params }) => {
    const c = repo.getCourier(db, params.id);
    if (!c) return problem(res, 404, 'not_found', `Courier ${params.id} not found`);
    json(res, 200, { id: c.id, name: c.name, city: c.city, balance: money.toDecimal(balanceCents(db, c.id)) });
  });
}

module.exports = { register };
