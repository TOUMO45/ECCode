'use strict';
const { problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const customers = require('../customers/repository');
const rentals = require('../rentals/repository');
const { chargeOf } = require('../rentals/service');
const { text, toCsv } = require('../lib/csv');

const HEADER = ['rental_id', 'sku', 'item', 'start_date', 'returned_on', 'days', 'late_days', 'subtotal', 'tax', 'total'].map(text);

function register(router, db) {
  // Monthly statement for Finance: rentals returned in the month, as a CSV file for the accounting system.
  router.add('GET', '/api/customers/:id/statement.csv', async (req, res, { params, query }) => {
    const customer = customers.getCustomer(db, params.id);
    if (!customer) return problem(res, 404, 'not_found', `Customer ${params.id} not found`);
    const month = query.get('month');
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return problem(res, 422, 'validation_failed', 'month must look like 2026-02', { fields: ['month'] });
    }
    const rows = rentals.returnedIn(db, customer.id, month).map((r) => {
      const { item, charge } = chargeOf(db, r);
      return [
        r.id,
        text(item.sku),
        text(item.name),
        text(r.start_date),
        text(r.returned_on),
        charge.days,
        charge.lateDays,
        money.toDecimal(charge.subtotal),
        money.toDecimal(charge.tax),
        money.toDecimal(charge.total),
      ];
    });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(toCsv(HEADER, rows));
  });
}

module.exports = { register };
