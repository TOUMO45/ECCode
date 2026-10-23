'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('src/pricing.js prices lines exactly as the cart did', () => {
  const { priceOf } = require('../src/pricing');
  assert.strictEqual(priceOf({ sku: 'pen', qty: 2 }), 360);
  assert.strictEqual(priceOf({ sku: 'book', qty: 1 }), 1299);
  assert.strictEqual(priceOf({ sku: 'pen', qty: 10 }), 1620);
  assert.strictEqual(priceOf({ sku: 'notebook', qty: 12 }), 5443);
  assert.strictEqual(priceOf({ sku: 'book', qty: 10 }), 11691);
  assert.throws(() => priceOf({ sku: 'lamp', qty: 1 }), /unknown sku/);
});

test('pricing does not load the cart', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pricing.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/cart['"]\)/);
});

test('the rules live in one place: the cart no longer computes tax itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cart.js'), 'utf8');
  assert.doesNotMatch(src, /TAX_RATE\s*=/);
});
