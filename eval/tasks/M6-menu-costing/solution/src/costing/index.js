'use strict';
// Costing of recipes, with their results cached in memory (costing nested recipes is slow).
const { ttlCache, memo } = require('../../vendor/acme-kit/cache');
const money = require('../../vendor/acme-kit/money');
const dishesRepo = require('../dishes/repository');
const ingredientsRepo = require('../ingredients/repository');
const menusRepo = require('../menus/repository');
const { roundDiv, ingredientCost, foodCostPct } = require('./calc');

const COST_TTL_MS = 5 * 60 * 1000;
const REPORT_TTL_MS = 60 * 1000;

/** A cost is shared by every reader of the cache, so it must never be changed in place. */
function freezeCost(cost) {
  cost.lines.forEach(Object.freeze);
  Object.freeze(cost.lines);
  return Object.freeze(cost);
}

function createCosting({ db, now }) {
  const costs = ttlCache({ ttlMs: COST_TTL_MS, now: () => now().getTime() });

  function compute(dishId) {
    const dish = dishesRepo.getDish(db, dishId);
    const lines = dishesRepo.linesOf(db, dishId).map((l) => {
      if (l.ingredient_id !== null) {
        const ing = ingredientsRepo.getIngredient(db, l.ingredient_id);
        return { name: ing.name, unit: ing.unit, quantity: l.quantity, costCents: ingredientCost(ing.priceCents, ing.unit, l.quantity) };
      }
      const sub = dishCost(l.sub_dish_id);
      return { name: sub.name, unit: 'portion', quantity: l.quantity, costCents: roundDiv(sub.totalCents * l.quantity, sub.portions) };
    });
    return freezeCost({ dishId: dish.id, name: dish.name, portions: dish.portions, lines, totalCents: money.sum(lines.map((l) => l.costCents)) });
  }

  /** The cost of one recipe at its own yield (a shared, read-only object). */
  function dishCost(dishId) {
    const hit = costs.get(dishId);
    if (hit) return hit;
    return costs.set(dishId, compute(dishId));
  }

  const buildReport = (menuId) => {
    const menu = menusRepo.getMenu(db, menuId);
    return {
      menuId: menu.id,
      name: menu.name,
      items: menusRepo.itemsOf(db, menu.id).map((item) => {
        const cost = dishCost(item.dish_id);
        const perPortion = roundDiv(cost.totalCents, cost.portions);
        return {
          dishId: cost.dishId,
          name: cost.name,
          sellPrice: money.toDecimal(item.sellCents),
          costPerPortion: money.toDecimal(perPortion),
          foodCostPct: foodCostPct(perPortion, item.sellCents),
          margin: money.toDecimal(item.sellCents - perPortion),
        };
      }),
    };
  };

  // The menu report is looked at a lot; keep it for a minute.
  const menuReport = memo(buildReport, { ttlMs: REPORT_TTL_MS, now: () => now().getTime() });

  /** The given recipes and every recipe that uses them, directly or through sub-recipes. */
  function withParents(startIds) {
    const seen = new Set();
    const queue = [...startIds];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...dishesRepo.dishesUsingDish(db, id));
    }
    return seen;
  }

  function drop(dishIds) {
    for (const id of dishIds) costs.invalidate(id);
    menuReport.clear();
  }

  return {
    dishCost,
    menuReport,
    /** An ingredient's price changed: every recipe that contains it, however deep, must be costed again. */
    ingredientChanged(ingredientId) {
      drop(withParents(dishesRepo.dishesUsingIngredient(db, ingredientId)));
    },
    /** A recipe's lines or yield changed: it and everything built on it must be costed again. */
    dishChanged(dishId) {
      drop(withParents([Number(dishId)]));
    },
  };
}

module.exports = { createCosting };
