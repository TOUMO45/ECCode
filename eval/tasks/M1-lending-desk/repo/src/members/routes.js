'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, { db }) {
  router.add('GET', '/api/members/:id', async (req, res, { params }) => {
    const m = repo.getMember(db, params.id);
    if (!m) return problem(res, 404, 'not_found', `Member ${params.id} not found`);
    json(res, 200, { id: m.id, name: m.name, cardNo: m.card_no, tier: m.tier, openLoans: repo.openLoanCount(db, m.id) });
  });
}

module.exports = { register };
