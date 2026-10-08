'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

const vatRate = (bp) => `${bp / 100}%`;

function view(p) {
  return {
    id: p.id,
    vehicleId: p.vehicleId,
    plate: p.plate,
    driver: p.driver,
    station: p.station,
    purchasedAt: p.purchasedAt,
    litres: p.litres,
    net: money.toDecimal(p.netCents),
    vatRate: vatRate(p.vatBp),
  };
}

function register(router, db) {
  router.add('GET', '/api/fuel-purchases/:id', async (req, res, { params }) => {
    const p = repo.getPurchase(db, params.id);
    if (!p) return problem(res, 404, 'not_found', `Fuel purchase ${params.id} not found`);
    json(res, 200, view(p));
  });
}

module.exports = { register };
