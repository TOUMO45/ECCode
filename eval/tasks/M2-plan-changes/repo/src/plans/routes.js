'use strict';
const { json } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

function register(router, { db }) {
  // The price list is short; billing clients read the whole array.
  router.add('GET', '/api/plans', async (req, res) => {
    json(res, 200, repo.listPlans(db).map((p) => ({ code: p.code, name: p.name, pricePerSeat: money.toDecimal(p.priceCents), seatLimit: p.seat_limit })));
  });
}

module.exports = { register };
