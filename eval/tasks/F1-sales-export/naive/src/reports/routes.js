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

// RFC 4180: quote a field only when it contains a comma, a quote or a line break.
const csvField = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (fields) => fields.map(csvField).join(',');

function register(router, db) {
  router.add('GET', '/api/reports/sales', async (req, res, { query }) => {
    const report = salesReport(db, parseMonth(query));
    json(res, 200, {
      month: report.month,
      orders: report.orders.map((o) => ({ number: o.number, customer: o.customer, placedAt: o.placedAt, total: money.toDecimal(o.totalCents) })),
      total: money.toDecimal(report.totalCents),
    });
  });

  router.add('GET', '/api/reports/sales.csv', async (req, res, { query }) => {
    const report = salesReport(db, parseMonth(query));
    const lines = [csvLine(['order_number', 'customer', 'placed_on', 'total'])];
    for (const o of report.orders) lines.push(csvLine([o.number, o.customer, o.placedAt.slice(0, 10), money.toDecimal(o.totalCents)]));
    lines.push(csvLine(['TOTAL', '', '', money.toDecimal(report.totalCents)]));
    const csv = `${lines.join('\n')}\n`;
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${report.month}.csv"` });
    res.end(csv);
  });
}

module.exports = { register };
