'use strict';
// Price quotes: catalog lookup plus the pricing engine. The engine quota is at
// most one call per SKU and quantity per minute, so prices are cached for a
// minute (see README "Pricing engine").
const { memo } = require('../../vendor/acme-kit/cache');
const money = require('../../vendor/acme-kit/money');
const engine = require('../pricing/engine');
const catalog = require('../catalog/repository');

const PRICE_TTL_MS = 60 * 1000;

function createQuoteService(db) {
  const unitPrice = memo(engine.unitPrice, { ttlMs: PRICE_TTL_MS });

  return {
    /** { sku, qty, unitPrice, total } with API money strings, or null if the SKU is not sold. */
    async quote(sku, qty) {
      if (!catalog.findProduct(db, sku)) return null;
      const unit = await unitPrice(sku, qty);
      if (unit === null) return null;
      return { sku, qty, unitPrice: money.toDecimal(unit), total: money.toDecimal(unit * qty) };
    },
  };
}

module.exports = { createQuoteService };
