'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../couriers/repository');

function view(p) {
  return {
    id: p.id,
    courierId: p.courierId,
    kind: p.kind,
    amount: money.toDecimal(p.amountCents),
    fee: money.toDecimal(p.feeCents),
    net: money.toDecimal(p.amountCents - p.feeCents),
    createdAt: p.createdAt,
  };
}

function register(router, db) {
  router.add('GET', '/api/payouts/:id', async (req, res, { params }) => {
    const p = repo.getPayout(db, params.id);
    if (!p) return problem(res, 404, 'not_found', `Payout ${params.id} not found`);
    json(res, 200, view(p));
  });
}

module.exports = { register, view };
