'use strict';
// Monthly fuel purchase export (RFC 4180 style CSV).
const { problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../purchases/repository');
const { parseMonth } = require('../month');

const COLUMNS = ['purchase_id', 'date', 'plate', 'driver', 'station', 'net', 'vat', 'gross'];
const field = (v) => {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const byTime = (a, b) => (a.purchasedAt < b.purchasedAt ? -1 : a.purchasedAt > b.purchasedAt ? 1 : a.id - b.id);

function register(router, db) {
  router.add('GET', '/api/exports/fuel-purchases.csv', async (req, res, { query }) => {
    const month = parseMonth(query.get('month'));
    if (!month) return problem(res, 422, 'validation_failed', 'month must be YYYY-MM', { fields: ['month'] });
    const rows = repo.purchasesBetween(db, month).sort(byTime).map((p) => {
      const vat = money.percent(p.netCents, p.vatBp);
      return [p.id, p.purchasedAt.slice(0, 10), p.plate, p.driver, p.station, money.toDecimal(p.netCents), money.toDecimal(vat), money.toDecimal(p.netCents + vat)];
    });
    const csv = [COLUMNS, ...rows].map((r) => r.map(field).join(',')).join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(csv);
  });
}

module.exports = { register };
