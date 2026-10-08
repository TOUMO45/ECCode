'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const { computeTotals } = require('./service');

function register(router, db) {
  router.add('GET', '/api/invoices', async (req, res) => {
    const out = repo.listInvoices(db).map((inv) => ({ id: inv.id, number: inv.number, customer: inv.customer, total: computeTotals(inv, repo.linesFor(db, inv.id)).total }));
    json(res, 200, out);
  });

  router.add('GET', '/api/invoices/:id', async (req, res, { params }) => {
    const inv = repo.getInvoice(db, params.id);
    if (!inv) return problem(res, 404, 'not_found', `Invoice ${params.id} not found`);
    json(res, 200, { id: inv.id, number: inv.number, customer: inv.customer, ...computeTotals(inv, repo.linesFor(db, inv.id)) });
  });

  // Accounting's import format: one row per line, then a TOTAL row.
  router.add('GET', '/api/invoices/:id/export.csv', async (req, res, { params }) => {
    const inv = repo.getInvoice(db, params.id);
    if (!inv) return problem(res, 404, 'not_found', `Invoice ${params.id} not found`);
    const rows = ['description,unit_price,quantity,line_total'];
    let subtotal = 0;
    for (const l of repo.linesFor(db, inv.id)) {
      const lineTotal = l.unit_price * l.quantity;
      subtotal += lineTotal;
      rows.push(`${l.description},${l.unit_price},${l.quantity},${lineTotal.toFixed(2)}`);
    }
    const total = subtotal - (subtotal * inv.discount_bp) / 10000 + (inv.shipping_fee || 0);
    rows.push(`TOTAL,,,${typeof total === 'number' ? total.toFixed(2) : total}`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(rows.join('\n') + '\n');
  });
}

module.exports = { register };
