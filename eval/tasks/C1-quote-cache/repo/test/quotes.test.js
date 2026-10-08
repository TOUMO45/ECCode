'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('quotes a single unit at the list price', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/quote?sku=CBL-1&qty=1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { sku: 'CBL-1', qty: 1, unitPrice: '4.20', total: '4.20' });
  } finally {
    await app.close();
  }
});

test('quotes a volume order at the tier price', async () => {
  const app = await start();
  try {
    const { body } = await app.get('/api/quote?sku=SW-24&qty=5');
    assert.deepStrictEqual(body, { sku: 'SW-24', qty: 5, unitPrice: '172.50', total: '862.50' });
  } finally {
    await app.close();
  }
});

test('unknown SKU is a 404 and an invalid quantity a 422', async () => {
  const app = await start();
  try {
    const unknown = await app.get('/api/quote?sku=CBL-99&qty=1');
    assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
    const bad = await app.get('/api/quote?sku=CBL-1&qty=0');
    assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['qty']]);
  } finally {
    await app.close();
  }
});

test('shows a product', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/products/CBL-12');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { sku: 'CBL-12', name: 'Cat6 patch cable, 12 m' });
  } finally {
    await app.close();
  }
});
