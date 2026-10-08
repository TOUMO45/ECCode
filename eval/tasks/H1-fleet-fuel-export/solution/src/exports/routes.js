'use strict';
// CSV exports for accounting: CRLF line endings, a header row, every text
// field in double quotes, amounts as plain two-digit decimals.
const { problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../purchases/repository');
const { parseMonth } = require('../month');

const COLUMNS = ['purchase_id', 'date', 'plate', 'driver', 'station', 'net', 'vat', 'gross'];
const text = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;

const byTime = (a, b) => (a.purchasedAt < b.purchasedAt ? -1 : a.purchasedAt > b.purchasedAt ? 1 : a.id - b.id);

function row(p) {
  const vat = money.percent(p.netCents, p.vatBp);
  return [p.id, p.purchasedAt.slice(0, 10), text(p.plate), text(p.driver), text(p.station), money.toDecimal(p.netCents), money.toDecimal(vat), money.toDecimal(money.sum([p.netCents, vat]))].join(',');
}

function register(router, db) {
  router.add('GET', '/api/exports/fuel-purchases.csv', async (req, res, { query }) => {
    const month = parseMonth(query.get('month'));
    if (!month) return problem(res, 422, 'validation_failed', 'month must be YYYY-MM', { fields: ['month'] });
    const lines = [COLUMNS.map(text).join(','), ...repo.purchasesBetween(db, month).sort(byTime).map(row)];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fuel-purchases-${month.month}.csv"` });
    res.end(lines.map((l) => `${l}\r\n`).join(''));
  });
}

module.exports = { register };
