'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

function register(router, db) {
  router.add('GET', '/api/tickets/:code', async (req, res, { params }) => {
    const t = repo.getByCode(db, params.code);
    if (!t) return problem(res, 404, 'not_found', `Ticket ${params.code} not found`);
    json(res, 200, { code: t.code, eventId: t.eventId, holderName: t.holderName, tier: t.tier, status: t.status, checkedIn: t.checkedIn, price: money.toDecimal(t.priceCents) });
  });
}

module.exports = { register };
