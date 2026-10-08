'use strict';
// Integer cost arithmetic. All amounts are cents.

/** a / b rounded to the nearest integer, halves up (a >= 0, b > 0). */
function roundDiv(a, b) {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Cost of `quantity` of an ingredient priced per kg / litre (g, ml) or per piece (each). */
function ingredientCost(priceCents, unit, quantity) {
  return roundDiv(priceCents * quantity, unit === 'each' ? 1 : 1000);
}

/** Food cost as a percentage of the selling price, one decimal, halves up. */
function foodCostPct(costCents, sellCents) {
  return roundDiv(costCents * 1000, sellCents) / 10;
}

module.exports = { roundDiv, ingredientCost, foodCostPct };
