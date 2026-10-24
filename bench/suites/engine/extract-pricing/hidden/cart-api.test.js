'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

test('the cart keeps its public API: priceOf and cartTotal', () => {
  const cart = require('../src/cart');
  assert.strictEqual(typeof cart.priceOf, 'function');
  assert.strictEqual(cart.priceOf({ sku: 'notebook', qty: 12 }), 5443);
  assert.strictEqual(cart.cartTotal([{ sku: 'pen', qty: 10 }, { sku: 'book', qty: 2 }]), 4218);
});

test('the package main still exports priceOf', () => {
  const main = require(path.join('..', require('../package.json').main));
  assert.strictEqual(main.priceOf({ sku: 'pen', qty: 1 }), 180);
});

test('the sales quote script still works', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'quote.js'), 'pen', '10'], { encoding: 'utf8' });
  assert.strictEqual(out.trim(), '10 x pen: 16.20');
});
