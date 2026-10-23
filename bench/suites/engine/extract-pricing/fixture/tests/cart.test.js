'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { priceOf, cartTotal } = require('../src/cart');

test('tax applies to taxed items only', () => {
  assert.strictEqual(priceOf({ sku: 'pen', qty: 2 }), 360);
  assert.strictEqual(priceOf({ sku: 'book', qty: 1 }), 1299);
});

test('the bulk discount starts at 10 units, before tax', () => {
  assert.strictEqual(priceOf({ sku: 'pen', qty: 10 }), 1620);
});

test('the cart total sums the lines', () => {
  assert.strictEqual(cartTotal([{ sku: 'pen', qty: 2 }, { sku: 'book', qty: 1 }]), 1659);
});
