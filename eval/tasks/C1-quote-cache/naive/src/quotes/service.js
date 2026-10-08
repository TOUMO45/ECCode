'use strict';
// Price quotes: catalog lookup plus the pricing engine.
const money = require('../../vendor/acme-kit/money');
const engine = require('../pricing/engine');
const catalog = require('../catalog/repository');

function createQuoteService(db) {
  return {
    /** { sku, qty, unitPrice, total } with API money strings, or null if the SKU is not sold. */
    async quote(sku, qty) {
      if (!catalog.findProduct(db, sku)) return null;
      // Always ask the engine: the cached price ignored the quantity (CAT-417).
      const unit = await engine.unitPrice(sku, qty);
      if (unit === null) return null;
      return { sku, qty, unitPrice: money.toDecimal(unit), total: money.toDecimal(unit * qty) };
    },
  };
}

module.exports = { createQuoteService };
