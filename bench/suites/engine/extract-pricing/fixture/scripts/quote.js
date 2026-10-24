'use strict';
// Sales team quote: node scripts/quote.js <sku> <qty>
const { priceOf } = require('../src/cart');

const [sku, qty] = process.argv.slice(2);
const cents = priceOf({ sku, qty: Number(qty) });
console.log(`${qty} x ${sku}: ${(cents / 100).toFixed(2)}`);
