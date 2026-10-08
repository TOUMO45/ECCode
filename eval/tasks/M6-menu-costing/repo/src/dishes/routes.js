'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');
const ingredients = require('../ingredients/repository');
const { roundDiv } = require('../costing/calc');

/** Scale a recipe's cost to a number of covers. */
function scaleToCovers(cost, covers) {
  for (const l of cost.lines) {
    l.quantity = roundDiv(l.quantity * covers, cost.portions);
    l.costCents = roundDiv(l.costCents * covers, cost.portions);
  }
  cost.totalCents = money.sum(cost.lines.map((l) => l.costCents));
  return cost;
}

function viewCost(cost, covers) {
  return {
    dishId: cost.dishId,
    name: cost.name,
    portions: cost.portions,
    covers,
    lines: cost.lines.map((l) => ({ name: l.name, quantity: l.quantity, unit: l.unit, cost: money.toDecimal(l.costCents) })),
    totalCost: money.toDecimal(cost.totalCents),
    costPerPortion: money.toDecimal(roundDiv(cost.totalCents, covers)),
  };
}

/** Check a replacement list of lines; returns the invalid state or null. */
function badLines(db, dishId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return true;
  return lines.some((l) => {
    if (!l || typeof l !== 'object' || !Number.isInteger(l.quantity) || l.quantity < 1) return true;
    const hasIng = l.ingredientId !== undefined;
    const hasSub = l.subDishId !== undefined;
    if (hasIng === hasSub) return true;
    if (hasIng) return !Number.isInteger(l.ingredientId) || !ingredients.getIngredient(db, l.ingredientId);
    return !Number.isInteger(l.subDishId) || !repo.getDish(db, l.subDishId) || repo.contains(db, l.subDishId, dishId);
  });
}

function register(router, { db, costing }) {
  router.add('GET', '/api/dishes/:id/cost', async (req, res, { params, query }) => {
    const dish = repo.getDish(db, params.id);
    if (!dish) return problem(res, 404, 'not_found', `Dish ${params.id} not found`);
    const raw = query.get('covers');
    if (raw !== null && !(/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 5000)) {
      return problem(res, 422, 'validation_failed', 'covers must be a whole number from 1 to 5000', { fields: ['covers'] });
    }
    const covers = raw === null ? dish.portions : Number(raw);
    const cost = costing.dishCost(dish.id);
    if (covers !== cost.portions) scaleToCovers(cost, covers);
    json(res, 200, viewCost(cost, covers));
  });

  router.add('PATCH', '/api/dishes/:id', async (req, res, { params }) => {
    const dish = repo.getDish(db, params.id);
    if (!dish) return problem(res, 404, 'not_found', `Dish ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, { portions: { type: 'integer', required: true, min: 1, max: 1000 } });
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    const updated = repo.setPortions(db, dish.id, body.portions);
    json(res, 200, { id: updated.id, name: updated.name, portions: updated.portions });
  });

  router.add('PUT', '/api/dishes/:id/lines', async (req, res, { params }) => {
    const dish = repo.getDish(db, params.id);
    if (!dish) return problem(res, 404, 'not_found', `Dish ${params.id} not found`);
    const body = await readJson(req);
    if (!body || badLines(db, dish.id, body.lines)) {
      return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: ['lines'] });
    }
    const lines = repo.replaceLines(db, dish.id, body.lines);
    json(res, 200, { dishId: dish.id, lines: lines.length });
  });
}

module.exports = { register };
