'use strict';
const catalog = require('./catalog');

const TAX_RATE = 0.2;
const BULK_QTY = 10; // from this many units of one sku...
const BULK_DISCOUNT = 0.1; // ...the line gets 10% off, before tax

/** Price of one cart line { sku, qty } in cents: bulk discount first, then tax, rounded once. */
function priceOf(line) {
  const { unitCents, taxed } = catalog.find(line.sku);
  let cents = unitCents * line.qty;
  if (line.qty >= BULK_QTY) cents *= 1 - BULK_DISCOUNT;
  if (taxed) cents *= 1 + TAX_RATE;
  return Math.round(cents);
}

function cartTotal(lines) {
  return lines.reduce((sum, line) => sum + priceOf(line), 0);
}

module.exports = { priceOf, cartTotal };
