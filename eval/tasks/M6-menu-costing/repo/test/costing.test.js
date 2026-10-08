'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('a recipe is costed line by line, sub-recipes included', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/dishes/3/cost');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.name, 'Lasagne al forno');
    assert.deepStrictEqual(body.lines.map((l) => [l.name, l.cost]), [
      ['Minced beef', '7.74'],
      ['Lasagne sheets', '0.85'],
      ['Mozzarella', '1.70'],
      ['Tomato sauce', '5.48'],
      ['Bechamel', '0.72'],
    ]);
    assert.deepStrictEqual([body.totalCost, body.costPerPortion, body.covers], ['16.49', '2.75', 6]);
  } finally {
    await app.close();
  }
});

test('the menu report compares cost per portion with the selling price', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/menus/1/report');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.items.map((i) => [i.name, i.sellPrice, i.costPerPortion, i.foodCostPct, i.margin]), [
      ['Lasagne al forno', '12.50', '2.75', 22, '9.75'],
      ['Pizza margherita', '9.00', '1.48', 16.4, '7.52'],
    ]);
  } finally {
    await app.close();
  }
});

test('an ingredient price can be updated', async () => {
  const app = await start();
  try {
    const r = await app.put('/api/ingredients/9', { price: '9.00' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { id: 9, name: 'Mozzarella', unit: 'g', price: '9.00' });
    const bad = await app.put('/api/ingredients/9', { price: 'cheap' });
    assert.strictEqual(bad.status, 422);
    assert.deepStrictEqual(bad.body.error.fields, ['price']);
  } finally {
    await app.close();
  }
});

test('unknown dishes, menus and ingredients are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const [method, p] of [['get', '/api/dishes/99/cost'], ['get', '/api/menus/99/report'], ['put', '/api/ingredients/99']]) {
      const { status, body } = await app[method](p, method === 'put' ? { price: '1.00' } : undefined);
      assert.strictEqual(status, 404);
      assert.strictEqual(body.error.code, 'not_found');
    }
  } finally {
    await app.close();
  }
});
