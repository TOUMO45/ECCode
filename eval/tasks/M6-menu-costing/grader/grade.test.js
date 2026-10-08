'use strict';
// Hidden acceptance and regression checks for M6 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

const NOW = '2026-03-10T15:00:00Z';

async function withApp(fn) {
  const server = createApp({ now: () => new Date(NOW) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const h = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed };
  };
  try {
    await fn({
      get: (p) => call('GET', p),
      put: (p, b, h) => call('PUT', p, b, h),
      patch: (p, b, h) => call('PATCH', p, b, h),
    });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const cost = (app, id, covers) => app.get(`/api/dishes/${id}/cost${covers ? `?covers=${covers}` : ''}`);
const totals = (r) => [r.body.totalCost, r.body.costPerPortion];
const lineCost = (r, name) => (r.body.lines.find((l) => l.name === name) || {}).cost;
const warm = async (app, ids) => { for (const id of ids) assert.strictEqual((await cost(app, id)).status, 200); };
const report = async (app, id) => (await app.get(`/api/menus/${id}/report`)).body.items.map((i) => [i.name, i.costPerPortion, i.foodCostPct, i.margin]);

test('AC1 [trap:cache-invalidate] a price change shows in the next cost of every recipe that uses the ingredient', () => withApp(async (app) => {
  await warm(app, [1, 2, 3, 4]);
  const put = await app.put('/api/ingredients/9', { price: '10.00' }); // mozzarella
  assert.strictEqual(put.status, 200);
  const lasagne = await cost(app, 3);
  assert.deepStrictEqual(totals(lasagne), ['16.79', '2.80']);
  assert.strictEqual(lineCost(lasagne, 'Mozzarella'), '2.00');
  assert.deepStrictEqual(totals(await cost(app, 4)), ['6.29', '1.57']);
  assert.deepStrictEqual(totals(await cost(app, 1)), ['13.70', '1.37']);
  assert.deepStrictEqual(totals(await cost(app, 2)), ['1.92', '0.24']);
}));

test('AC2 [trap:cache-dependents] a price change reaches recipes that use the ingredient through a sub-recipe', () => withApp(async (app) => {
  await warm(app, [1, 2, 3, 4]);
  await app.put('/api/ingredients/1', { price: '6.00' }); // plum tomatoes, used by the tomato sauce
  assert.deepStrictEqual(totals(await cost(app, 1)), ['16.10', '1.61']);
  const lasagne = await cost(app, 3);
  assert.deepStrictEqual(totals(lasagne), ['17.45', '2.91']);
  assert.strictEqual(lineCost(lasagne, 'Tomato sauce'), '6.44');
  const pizza = await cost(app, 4);
  assert.deepStrictEqual(totals(pizza), ['6.40', '1.60']);
  assert.strictEqual(lineCost(pizza, 'Tomato sauce'), '3.22');
  assert.deepStrictEqual(totals(await cost(app, 2)), ['1.92', '0.24']);
}));

test('AC3 editing the lines of a recipe changes its cost and the cost of recipes built on it', () => withApp(async (app) => {
  await warm(app, [2, 3]);
  const put = await app.put('/api/dishes/2/lines', { lines: [{ ingredientId: 6, quantity: 1000 }, { ingredientId: 7, quantity: 40 }, { ingredientId: 8, quantity: 80 }] });
  assert.deepStrictEqual([put.status, put.body], [200, { dishId: 2, lines: 3 }]);
  assert.deepStrictEqual(totals(await cost(app, 2)), ['1.56', '0.20']);
  const lasagne = await cost(app, 3);
  assert.strictEqual(lineCost(lasagne, 'Bechamel'), '0.59');
  assert.deepStrictEqual(totals(lasagne), ['16.36', '2.73']);
  await app.put('/api/dishes/3/lines', { lines: [{ ingredientId: 4, quantity: 600 }, { ingredientId: 9, quantity: 200 }, { subDishId: 1, quantity: 4 }, { subDishId: 2, quantity: 3 }] });
  const slimmer = await cost(app, 3);
  assert.deepStrictEqual(slimmer.body.lines.map((l) => l.name), ['Minced beef', 'Mozzarella', 'Tomato sauce', 'Bechamel']);
  assert.deepStrictEqual(totals(slimmer), ['15.51', '2.59']);
}));

test('AC4 changing a recipe yield changes the cost per portion and the recipes that use it', () => withApp(async (app) => {
  await warm(app, [1, 3, 4]);
  const patch = await app.patch('/api/dishes/1', { portions: 20 });
  assert.deepStrictEqual([patch.status, patch.body], [200, { id: 1, name: 'Tomato sauce', portions: 20 }]);
  const sauce = await cost(app, 1);
  assert.deepStrictEqual([sauce.body.covers, ...totals(sauce)], [20, '13.70', '0.69']);
  const lasagne = await cost(app, 3);
  assert.strictEqual(lineCost(lasagne, 'Tomato sauce'), '2.74');
  assert.deepStrictEqual(totals(lasagne), ['13.75', '2.29']);
  const pizza = await cost(app, 4);
  assert.strictEqual(lineCost(pizza, 'Tomato sauce'), '1.37');
  assert.deepStrictEqual(totals(pizza), ['4.55', '1.14']);
}));

test('AC5 [trap:cache-mutation] the cost for a number of covers depends only on that number', () => withApp(async (app) => {
  const first = await cost(app, 3, 12);
  assert.deepStrictEqual([first.body.covers, ...totals(first)], [12, '32.98', '2.75']);
  assert.deepStrictEqual([first.body.lines[0].quantity, first.body.lines[0].cost], [1200, '15.48']);
  const again = await cost(app, 3, 12);
  assert.deepStrictEqual(again.body, first.body);
  const small = await cost(app, 3, 3);
  assert.deepStrictEqual([small.body.covers, ...totals(small)], [3, '8.25', '2.75']);
  assert.deepStrictEqual([small.body.lines[0].quantity, small.body.lines[0].cost], [300, '3.87']);
  const plain = await cost(app, 3);
  assert.deepStrictEqual([plain.body.covers, ...totals(plain)], [6, '16.49', '2.75']);
  assert.deepStrictEqual([plain.body.lines[0].quantity, plain.body.lines[0].cost], [600, '7.74']);
  // a banquet of sauce must not leak into the recipes that use the sauce
  const banquet = await cost(app, 1, 40);
  assert.deepStrictEqual([banquet.body.covers, ...totals(banquet)], [40, '54.80', '1.37']);
  const lasagne = await cost(app, 3);
  assert.deepStrictEqual(totals(lasagne), ['16.49', '2.75']);
  assert.strictEqual(lineCost(lasagne, 'Tomato sauce'), '5.48');
  assert.deepStrictEqual(totals(await cost(app, 1)), ['13.70', '1.37']);
}));

test('AC6 [trap:report-memo] the menu report follows price changes and is not disturbed by cost lookups for covers', () => withApp(async (app) => {
  assert.deepStrictEqual(await report(app, 1), [['Lasagne al forno', '2.75', 22, '9.75'], ['Pizza margherita', '1.48', 16.4, '7.52']]);
  await app.put('/api/ingredients/1', { price: '6.00' });
  assert.deepStrictEqual(await report(app, 1), [['Lasagne al forno', '2.91', 23.3, '9.59'], ['Pizza margherita', '1.60', 17.8, '7.40']]);
  await cost(app, 3, 12);
  await cost(app, 1, 40);
  assert.deepStrictEqual(await report(app, 1), [['Lasagne al forno', '2.91', 23.3, '9.59'], ['Pizza margherita', '1.60', 17.8, '7.40']]);
}));

test('AC7 the menu report follows recipe yield changes, with the food cost percentage rounded to one decimal', () => withApp(async (app) => {
  assert.deepStrictEqual(await report(app, 2), [['Tomato sauce', '1.37', 45.7, '1.63'], ['Bechamel', '0.24', 24, '0.76']]);
  await report(app, 1);
  await app.patch('/api/dishes/1', { portions: 20 });
  assert.deepStrictEqual(await report(app, 2), [['Tomato sauce', '0.69', 23, '2.31'], ['Bechamel', '0.24', 24, '0.76']]);
  assert.deepStrictEqual(await report(app, 1), [['Lasagne al forno', '2.29', 18.3, '10.21'], ['Pizza margherita', '1.14', 12.7, '7.86']]);
}));

test('AC8 a run of changes with a lookup after each one always shows the latest state', () => withApp(async (app) => {
  await warm(app, [1, 2, 3]);
  await app.put('/api/ingredients/9', { price: '10.00' });
  assert.deepStrictEqual(totals(await cost(app, 3)), ['16.79', '2.80']);
  await app.put('/api/dishes/2/lines', { lines: [{ ingredientId: 6, quantity: 1000 }, { ingredientId: 7, quantity: 40 }, { ingredientId: 8, quantity: 80 }] });
  assert.deepStrictEqual(totals(await cost(app, 3)), ['16.66', '2.78']);
  await app.patch('/api/dishes/3', { portions: 8 });
  const eight = await cost(app, 3);
  assert.deepStrictEqual([eight.body.covers, ...totals(eight)], [8, '16.66', '2.08']);
  const sixteen = await cost(app, 3, 16);
  assert.deepStrictEqual([sixteen.body.covers, ...totals(sixteen)], [16, '33.32', '2.08']);
  await app.put('/api/ingredients/9', { price: '8.50' });
  assert.deepStrictEqual(totals(await cost(app, 3)), ['16.36', '2.05']);
}));

test('REG1 costs and menu reports are right before anything changes', () => withApp(async (app) => {
  assert.deepStrictEqual(totals(await cost(app, 1)), ['13.70', '1.37']);
  assert.deepStrictEqual(totals(await cost(app, 2)), ['1.92', '0.24']);
  assert.deepStrictEqual(totals(await cost(app, 3)), ['16.49', '2.75']);
  assert.deepStrictEqual(totals(await cost(app, 4)), ['5.92', '1.48']);
  const sauce = await cost(app, 1);
  assert.deepStrictEqual(sauce.body.lines.map((l) => [l.name, l.quantity, l.unit, l.cost]), [['Plum tomatoes', 2000, 'g', '9.60'], ['Olive oil', 100, 'ml', '1.12'], ['Onion', 300, 'g', '0.48'], ['Fresh basil', 2, 'each', '2.50']]);
  assert.deepStrictEqual(Object.keys(sauce.body).sort(), ['costPerPortion', 'covers', 'dishId', 'lines', 'name', 'portions', 'totalCost']);
  assert.deepStrictEqual(await report(app, 2), [['Tomato sauce', '1.37', 45.7, '1.63'], ['Bechamel', '0.24', 24, '0.76']]);
  assert.deepStrictEqual(await report(app, 1), [['Lasagne al forno', '2.75', 22, '9.75'], ['Pizza margherita', '1.48', 16.4, '7.52']]);
  const r = await app.get('/api/menus/1/report');
  assert.deepStrictEqual([r.body.menuId, r.body.name, Object.keys(r.body.items[0]).sort()], [1, 'Lunch menu', ['costPerPortion', 'dishId', 'foodCostPct', 'margin', 'name', 'sellPrice']]);
}));

test('REG2 the write endpoints keep their responses and validation', () => withApp(async (app) => {
  const price = await app.put('/api/ingredients/9', { price: '9.00' });
  assert.deepStrictEqual([price.status, price.body], [200, { id: 9, name: 'Mozzarella', unit: 'g', price: '9.00' }]);
  for (const body of [{ price: '0.00' }, { price: 'cheap' }, {}]) {
    const bad = await app.put('/api/ingredients/9', body);
    assert.deepStrictEqual([bad.status, bad.body.error.code, bad.body.error.fields], [422, 'validation_failed', ['price']], JSON.stringify(body));
  }
  const portions = await app.patch('/api/dishes/4', { portions: 6 });
  assert.deepStrictEqual([portions.status, portions.body], [200, { id: 4, name: 'Pizza margherita', portions: 6 }]);
  for (const body of [{ portions: 0 }, { portions: 'six' }, {}]) {
    const bad = await app.patch('/api/dishes/4', body);
    assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['portions']], JSON.stringify(body));
  }
  const lines = await app.put('/api/dishes/4/lines', { lines: [{ ingredientId: 8, quantity: 500 }] });
  assert.deepStrictEqual([lines.status, lines.body], [200, { dishId: 4, lines: 1 }]);
  const invalid = [
    { lines: [] },
    { lines: [{ ingredientId: 8, subDishId: 1, quantity: 5 }] },
    { lines: [{ ingredientId: 99, quantity: 5 }] },
    { lines: [{ ingredientId: 8, quantity: 0 }] },
    { lines: [{ subDishId: 4, quantity: 1 }] },
    {},
  ];
  for (const body of invalid) {
    const bad = await app.put('/api/dishes/4/lines', body);
    assert.deepStrictEqual([bad.status, bad.body.error.code, bad.body.error.fields], [422, 'validation_failed', ['lines']], JSON.stringify(body));
  }
  const cycle = await app.put('/api/dishes/1/lines', { lines: [{ subDishId: 3, quantity: 1 }] }); // dish 3 already contains dish 1
  assert.deepStrictEqual([cycle.status, cycle.body.error.fields], [422, ['lines']]);
}));

test('REG3 covers are validated, and unknown records and malformed bodies get the standard errors', () => withApp(async (app) => {
  for (const covers of ['0', 'abc', '-1', '5001', '2.5']) {
    const r = await app.get(`/api/dishes/3/cost?covers=${covers}`);
    assert.deepStrictEqual([r.status, r.body.error.code, r.body.error.fields], [422, 'validation_failed', ['covers']], `covers=${covers}`);
  }
  for (const p of ['/api/dishes/99/cost', '/api/menus/99/report']) {
    const r = await app.get(p);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'not_found'], p);
  }
  const missing = await app.put('/api/ingredients/99', { price: '1.00' });
  assert.deepStrictEqual([missing.status, missing.body.error.code], [404, 'not_found']);
  const broken = await app.put('/api/ingredients/9', '{"price":', { 'content-type': 'application/json' });
  assert.deepStrictEqual([broken.status, broken.body.error.code], [400, 'bad_request']);
  const wrongType = await app.put('/api/ingredients/9', 'price=1.00', { 'content-type': 'text/plain' });
  assert.deepStrictEqual([wrongType.status, wrongType.body.error.code], [415, 'unsupported_media_type']);
}));
