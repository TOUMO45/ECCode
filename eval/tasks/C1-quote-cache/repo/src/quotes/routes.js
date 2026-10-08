'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const { createQuoteService } = require('./service');

const SKU = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const QTY = /^\d{1,5}$/;
const MAX_QTY = 10000;

function register(router, db) {
  const quotes = createQuoteService(db);

  router.add('GET', '/api/quote', async (req, res, { query }) => {
    const sku = query.get('sku') || '';
    const qty = query.get('qty') || '';
    const fields = [];
    if (!SKU.test(sku)) fields.push('sku');
    if (!QTY.test(qty) || Number(qty) < 1 || Number(qty) > MAX_QTY) fields.push('qty');
    if (fields.length) return problem(res, 422, 'validation_failed', 'Invalid quote request', { fields });
    const quote = await quotes.quote(sku, Number(qty));
    if (!quote) return problem(res, 404, 'not_found', `Unknown SKU ${sku}`);
    json(res, 200, quote);
  });
}

module.exports = { register };
