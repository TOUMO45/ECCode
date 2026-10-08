'use strict';
// Pricing engine client. Owned by the pricing team; do not change.
//
// unitPrice(sku, qty) resolves to the unit price in cents for `qty` units of
// `sku` (volume tiers applied), or null when the engine has no price for it.
// In production this is an HTTP call to the pricing engine, which is slow and
// rate-limited. Locally and in tests it answers from the sandbox price book.
//
// stats() / resetStats() expose the number of upstream calls (quota monitoring).
const money = require('../../vendor/acme-kit/money');
const SANDBOX_PRICEBOOK = require('./pricebook.json');

const SANDBOX_LATENCY_MS = 5;
let calls = 0;

async function unitPrice(sku, qty) {
  calls++;
  await new Promise((resolve) => setTimeout(resolve, SANDBOX_LATENCY_MS));
  const tier = (SANDBOX_PRICEBOOK[sku] || [])
    .filter((t) => qty >= t.minQty)
    .sort((a, b) => b.minQty - a.minQty)[0];
  return tier ? money.fromDecimal(tier.unitPrice) : null;
}

function stats() {
  return { calls };
}

function resetStats() {
  calls = 0;
}

module.exports = { unitPrice, stats, resetStats };
