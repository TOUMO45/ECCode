'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  router.add('GET', '/api/products/:sku', async (req, res, { params }) => {
    const product = repo.findProduct(db, params.sku);
    if (!product) return problem(res, 404, 'not_found', `Unknown SKU ${params.sku}`);
    json(res, 200, { sku: product.sku, name: product.name });
  });
}

module.exports = { register };
