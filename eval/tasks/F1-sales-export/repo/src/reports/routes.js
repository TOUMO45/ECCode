'use strict';
const { json, HttpError } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const { salesReport } = require('./service');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseMonth(query) {
  const month = query.get('month');
  if (!month || !MONTH.test(month)) throw new HttpError(422, 'validation_failed', 'month must be YYYY-MM', { fields: ['month'] });
  return month;
}

function register(router, db) {
  router.add('GET', '/api/reports/sales', async (req, res, { query }) => {
    const report = salesReport(db, parseMonth(query));
    json(res, 200, {
      month: report.month,
      orders: report.orders.map((o) => ({ number: o.number, customer: o.customer, placedAt: o.placedAt, total: money.toDecimal(o.totalCents) })),
      total: money.toDecimal(report.totalCents),
    });
  });
}

module.exports = { register };
