'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../purchases/repository');
const { parseMonth } = require('../month');

function register(router, db) {
  router.add('GET', '/api/vehicles/:id/fuel-spend', async (req, res, { params, query }) => {
    const vehicle = repo.getVehicle(db, params.id);
    if (!vehicle) return problem(res, 404, 'not_found', `Vehicle ${params.id} not found`);
    const month = parseMonth(query.get('month'));
    if (!month) return problem(res, 422, 'validation_failed', 'month must be YYYY-MM', { fields: ['month'] });
    const purchases = repo.purchasesBetween(db, month, { vehicle_id: vehicle.id });
    json(res, 200, {
      vehicleId: vehicle.id,
      plate: vehicle.plate,
      month: month.month,
      purchases: purchases.length,
      net: money.toDecimal(money.sum(purchases.map((p) => p.netCents))),
    });
  });
}

module.exports = { register };
