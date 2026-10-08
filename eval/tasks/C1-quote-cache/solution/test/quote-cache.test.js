'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const engine = require('../src/pricing/engine');

const unitPrice = async (app, sku, qty) => (await app.get(`/api/quote?sku=${sku}&qty=${qty}`)).body.unitPrice;

test('each quantity gets its own tier price, in any order (CAT-417)', async () => {
  const app = await start();
  try {
    assert.strictEqual(await unitPrice(app, 'CBL-1', 1), '4.20');
    assert.strictEqual(await unitPrice(app, 'CBL-1', 10), '3.80');
    assert.strictEqual(await unitPrice(app, 'CBL-1', 1), '4.20');
    assert.strictEqual(await unitPrice(app, 'CBL-12', 3), '18.50');
    assert.strictEqual(await unitPrice(app, 'CBL-1', 23), '3.80');
  } finally {
    await app.close();
  }
});

test('repeated quotes still call the pricing engine once per SKU and quantity', async () => {
  const app = await start();
  engine.resetStats();
  try {
    for (const qty of [10, 10, 1, 10, 1]) await unitPrice(app, 'CBL-1', qty);
    assert.strictEqual(engine.stats().calls, 2);
  } finally {
    await app.close();
  }
});
