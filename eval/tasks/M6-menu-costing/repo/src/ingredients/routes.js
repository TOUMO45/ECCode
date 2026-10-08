'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

const PRICE = /^\d+(\.\d{1,2})?$/;

function register(router, { db }) {
  router.add('PUT', '/api/ingredients/:id', async (req, res, { params }) => {
    const ing = repo.getIngredient(db, params.id);
    if (!ing) return problem(res, 404, 'not_found', `Ingredient ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, { price: { type: 'string', required: true, pattern: PRICE } });
    if (!check.ok || money.fromDecimal(body.price) <= 0) {
      return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: ['price'] });
    }
    const updated = repo.setPrice(db, ing.id, money.fromDecimal(body.price));
    json(res, 200, { id: updated.id, name: updated.name, unit: updated.unit, price: money.toDecimal(updated.priceCents) });
  });
}

module.exports = { register };
