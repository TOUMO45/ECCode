'use strict';
// Data access for ingredients. DECIMAL prices are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toIngredient = (r) => r && { ...r, priceCents: money.fromDecimal(r.price) };

function getIngredient(db, id) {
  return toIngredient(db.get('ingredients', id));
}

function setPrice(db, id, cents) {
  return toIngredient(db.update('ingredients', id, { price: money.toDecimal(cents) }));
}

module.exports = { getIngredient, setPrice };
