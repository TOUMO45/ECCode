'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  router.add('GET', '/api/customers/:id', async (req, res, { params }) => {
    const c = repo.getCustomer(db, params.id);
    if (!c) return problem(res, 404, 'not_found', `Customer ${params.id} not found`);
    // credit_balance is a DECIMAL(10,2) string, already in the API's "12.50" format.
    json(res, 200, { id: c.id, name: c.name, creditBalance: c.credit_balance });
  });
}

module.exports = { register };
