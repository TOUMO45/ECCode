'use strict';
// Hidden acceptance tests for mealie-pantry (bench/suites/pantry), run by
// check.js against the built service: SERVICE_URL (the service), MEALIE_DATA
// (the dataset the fake Mealie serves), SERVICE_DIR (the project, for its
// migrations). Test names start with the item that introduced them (c1:, c2:,
// c3:), and check.js runs one item's tests at a time. Each test empties the
// pantry first. Expectations come from the dataset through the rules the
// requests state (the oracle below); fields a later request adds are ignored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SERVICE_URL;
const DATA = JSON.parse(fs.readFileSync(process.env.MEALIE_DATA, 'utf8'));

async function call(method, url, body) {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

// ---- the oracle: the requests' rules, applied to the dataset ----
const MASS = { g: 1, kg: 1000 };
const VOLUME = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 };
const kindOf = (u) => (u == null ? 'count' : u in MASS ? 'mass' : u in VOLUME ? 'volume' : `other:${u}`);
const toBase = (q, u) => (u in MASS ? q * MASS[u] : u in VOLUME ? q * VOLUME[u] : q);
const round = (x) => Math.round(x * 100) / 100;
function shown(food, kind, total) {
  if (kind === 'mass') return total < 1000 ? { food, quantity: round(total), unit: 'g' } : { food, quantity: round(total / 1000), unit: 'kg' };
  if (kind === 'volume') return total < 1000 ? { food, quantity: round(total), unit: 'ml' } : { food, quantity: round(total / 1000), unit: 'l' };
  return { food, quantity: round(total), unit: kind === 'count' ? null : kind.slice(6) };
}
const byFoodUnit = (a, b) => (a.food < b.food ? -1 : a.food > b.food ? 1 : a.unit === b.unit ? 0 : a.unit === null ? -1 : b.unit === null ? 1 : a.unit < b.unit ? -1 : 1);
const recipe = (slug) => DATA.recipes.find((r) => r.slug === slug);
function needsOf(r, times = 1, into = new Map()) {
  for (const i of r.recipeIngredient) {
    if (!i.food) continue;
    const u = i.unit ? i.unit.abbreviation : null;
    const key = `${i.food.name.toLowerCase()}|${kindOf(u)}`;
    into.set(key, (into.get(key) || 0) + times * toBase(i.quantity == null ? 1 : i.quantity, u));
  }
  return into;
}
/** held: Map "food|kind" -> base amount. */
function lacking(needs, held) {
  const out = [];
  for (const [key, need] of needs) {
    const [food, kind] = key.split('|');
    const lack = need - (held.get(key) || 0);
    if (lack > 1e-9) out.push(shown(food, kind, lack));
  }
  return out.sort(byFoodUnit);
}
function expectedCookable(held, max, tags = []) {
  return DATA.recipes
    .filter((r) => tags.every((t) => r.tags.some((x) => x.slug === t)))
    .map((r) => ({ slug: r.slug, name: r.name, missing: lacking(needsOf(r), held) }))
    .filter((r) => r.missing.length <= max)
    .sort((a, b) => a.missing.length - b.missing.length || (a.slug < b.slug ? -1 : 1));
}
const LABEL = new Map(DATA.foods.map((f) => [f.name.toLowerCase(), f.label ? f.label.name : null]));
function expectedShopping(slugs, held) {
  const needs = new Map();
  for (const s of new Set(slugs)) needsOf(recipe(s), slugs.filter((x) => x === s).length, needs);
  const items = lacking(needs, held).map((i) => ({ ...i, label: LABEL.get(i.food) || 'Other' }));
  const rank = (l) => (l === 'Other' ? 1 : 0);
  return items.sort((a, b) => rank(a.label) - rank(b.label) || (a.label < b.label ? -1 : a.label > b.label ? 1 : byFoodUnit(a, b)));
}
/** A recipe's needs as pantry additions, in the units the recipe uses (amounts merge by kind). */
function additionsFor(r) {
  return r.recipeIngredient.filter((i) => i.food).map((i) => ({ food: i.food.name, quantity: i.quantity == null ? 1 : i.quantity, unit: i.unit ? i.unit.abbreviation : null }));
}
// The recipe the cooking tests use: the first by slug with a mass ingredient, a unit-converted volume and at least three foods.
const COOK = DATA.recipes.slice().sort((a, b) => (a.slug < b.slug ? -1 : 1)).find((r) => {
  const units = r.recipeIngredient.filter((i) => i.food).map((i) => (i.unit ? i.unit.abbreviation : null));
  return units.length >= 3 && units.some((u) => u in MASS) && units.some((u) => ['tsp', 'tbsp', 'cup'].includes(u));
});
const MASS_FOOD = COOK.recipeIngredient.find((i) => i.food && i.unit && i.unit.abbreviation in MASS);

const pick = (items) => items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit === undefined ? null : i.unit }));
async function empty() {
  const r = await call('GET', '/pantry');
  assert.strictEqual(r.status, 200, r.text);
  for (const food of new Set(r.body.items.map((i) => i.food))) {
    const d = await call('DELETE', `/pantry/items/${encodeURIComponent(food)}`);
    assert.strictEqual(d.status, 204, `DELETE ${food}: ${d.text}`);
  }
}
async function add(item) {
  const r = await call('POST', '/pantry/items', item);
  assert.strictEqual(r.status, 201, `${JSON.stringify(item)}: ${r.text}`);
  return r.body;
}
async function stock(items) {
  for (const i of items) await add(i);
}
function heldOf(items) {
  const held = new Map();
  for (const i of items) {
    const key = `${i.food.toLowerCase()}|${kindOf(i.unit)}`;
    held.set(key, (held.get(key) || 0) + toBase(i.quantity, i.unit));
  }
  return held;
}

// ---- c1: the pantry, what it can cook, cooking ----
test('c1: health', async () => {
  const r = await call('GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
});

test('c1: amounts of a food add up within a kind of unit and are reported converted', async () => {
  await empty();
  assert.deepStrictEqual(pick([await add({ food: 'Flour', quantity: 500, unit: 'g' })]), [{ food: 'flour', quantity: 500, unit: 'g' }]);
  assert.deepStrictEqual(pick([await add({ food: 'flour', quantity: 1, unit: 'kg' })]), [{ food: 'flour', quantity: 1.5, unit: 'kg' }]);
  assert.deepStrictEqual(pick([await add({ food: 'olive oil', quantity: 2, unit: 'tbsp' })]), [{ food: 'olive oil', quantity: 30, unit: 'ml' }]);
  assert.deepStrictEqual(pick([await add({ food: 'olive oil', quantity: 0.1, unit: 'l' })]), [{ food: 'olive oil', quantity: 130, unit: 'ml' }]);
  assert.deepStrictEqual(pick([await add({ food: 'egg', quantity: 2, unit: null })]), [{ food: 'egg', quantity: 2, unit: null }]);
  assert.deepStrictEqual(pick([await add({ food: 'Egg', quantity: 3 })]), [{ food: 'egg', quantity: 5, unit: null }], 'no unit is a count');
  assert.deepStrictEqual(pick([await add({ food: 'salt', quantity: 1, unit: 'pinch' })]), [{ food: 'salt', quantity: 1, unit: 'pinch' }]);
  assert.deepStrictEqual(pick([await add({ food: 'flour', quantity: 2, unit: null })]), [{ food: 'flour', quantity: 2, unit: null }], 'a count is another kind');
  const r = await call('GET', '/pantry');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(pick(r.body.items), [
    { food: 'egg', quantity: 5, unit: null },
    { food: 'flour', quantity: 2, unit: null },
    { food: 'flour', quantity: 1.5, unit: 'kg' },
    { food: 'olive oil', quantity: 130, unit: 'ml' },
    { food: 'salt', quantity: 1, unit: 'pinch' },
  ]);
});

test('c1: an invalid amount is 400', async () => {
  for (const body of [{}, { food: '', quantity: 1, unit: 'g' }, { food: 'rice', quantity: 0, unit: 'g' }, { food: 'rice', quantity: -2, unit: 'g' }, { food: 'rice', quantity: '2', unit: 'g' }, { food: 'rice', quantity: 2, unit: 5 }]) {
    const r = await call('POST', '/pantry/items', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assert.strictEqual(typeof (r.body && r.body.error), 'string', `${JSON.stringify(body)}: {"error": "..."}`);
  }
});

test('c1: deleting a food removes every amount of it; a food the pantry lacks is 404', async () => {
  await empty();
  await stock([{ food: 'rice', quantity: 200, unit: 'g' }, { food: 'rice', quantity: 2, unit: null }, { food: 'oats', quantity: 1, unit: 'kg' }]);
  assert.strictEqual((await call('DELETE', `/pantry/items/${encodeURIComponent('Rice')}`)).status, 204);
  assert.deepStrictEqual(pick((await call('GET', '/pantry')).body.items), [{ food: 'oats', quantity: 1, unit: 'kg' }]);
  assert.strictEqual((await call('DELETE', '/pantry/items/rice')).status, 404);
});

test('c1: cookable recipes read every page of Mealie, and maxMissing widens the list', async () => {
  await empty();
  const held = new Map();
  for (const max of [0, 2, 20]) {
    const r = await call('GET', `/recipes/cookable${max ? `?maxMissing=${max}` : ''}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.recipes.map((x) => ({ slug: x.slug, name: x.name, missing: pick(x.missing) })), expectedCookable(held, max), `maxMissing ${max}`);
  }
});

test('c1: a pantry holding a recipe\'s needs, in other units, makes it cookable', async () => {
  await empty();
  const items = additionsFor(COOK);
  await stock(items);
  const held = heldOf(items);
  const r = await call('GET', '/recipes/cookable?maxMissing=1');
  assert.strictEqual(r.status, 200, r.text);
  const got = r.body.recipes.map((x) => ({ slug: x.slug, name: x.name, missing: pick(x.missing) }));
  assert.deepStrictEqual(got, expectedCookable(held, 1));
  assert.deepStrictEqual(got.find((x) => x.slug === COOK.slug), { slug: COOK.slug, name: COOK.name, missing: [] });
});

test('c1: maxMissing outside 0 to 20 is 400', async () => {
  for (const q of ['-1', '21', 'x', '1.5']) assert.strictEqual((await call('GET', `/recipes/cookable?maxMissing=${q}`)).status, 400, q);
});

test('c1: cooking subtracts what the recipe needs and removes what reaches zero', async () => {
  await empty();
  const items = additionsFor(COOK);
  await stock([...items, { food: MASS_FOOD.food.name, quantity: 100, unit: 'g' }]);
  const r = await call('POST', '/cook', { slug: COOK.slug });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.slug, COOK.slug);
  const left = [{ food: MASS_FOOD.food.name.toLowerCase(), quantity: 100, unit: 'g' }];
  assert.deepStrictEqual(pick(r.body.items), left);
  assert.deepStrictEqual(pick((await call('GET', '/pantry')).body.items), left);
});

test('c1: a recipe the pantry cannot cook is 409 and changes nothing; an unknown recipe is 404; no slug is 400', async () => {
  await empty();
  const items = additionsFor(COOK).filter((i) => i.food !== MASS_FOOD.food.name);
  await stock(items);
  const before = (await call('GET', '/pantry')).body.items;
  const r = await call('POST', '/cook', { slug: COOK.slug });
  assert.strictEqual(r.status, 409, r.text);
  assert.strictEqual(typeof r.body.error, 'string');
  assert.deepStrictEqual(pick(r.body.missing), lacking(needsOf(COOK), heldOf(items)));
  assert.deepStrictEqual((await call('GET', '/pantry')).body.items, before);
  assert.strictEqual((await call('POST', '/cook', { slug: 'no-such-recipe' })).status, 404);
  assert.strictEqual((await call('POST', '/cook', {})).status, 400);
});

// ---- c2: a shopping list against the pantry, labels, tags ----
const pickLabelled = (items) => items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit === undefined ? null : i.unit, label: i.label }));
const TWO = DATA.recipes.slice().sort((a, b) => (a.slug < b.slug ? -1 : 1)).filter((r) => r.recipeIngredient.some((i) => i.food && !LABEL.get(i.food.name.toLowerCase()))).slice(0, 2).map((r) => r.slug);

test('c2: the shopping list is what the pantry lacks for the recipes, labelled', async () => {
  await empty();
  const have = additionsFor(recipe(TWO[0])).slice(0, 2);
  await stock(have);
  const r = await call('POST', '/shopping-list', { recipes: TWO });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(pickLabelled(r.body.items), expectedShopping(TWO, heldOf(have)));
});

test('c2: a recipe listed twice counts twice, and Other comes last', async () => {
  await empty();
  const have = additionsFor(recipe(TWO[1]));
  await stock(have);
  const r = await call('POST', '/shopping-list', { recipes: [TWO[1], TWO[1], TWO[0]] });
  assert.strictEqual(r.status, 200, r.text);
  const expected = expectedShopping([TWO[1], TWO[1], TWO[0]], heldOf(have));
  assert.ok(expected.some((i) => i.label === 'Other') && expected.some((i) => i.label !== 'Other'), 'the dataset exercises both');
  assert.deepStrictEqual(pickLabelled(r.body.items), expected);
});

test('c2: an empty or invalid list is 400; an unknown recipe is 404', async () => {
  for (const body of [{}, { recipes: [] }, { recipes: [7] }, { recipes: 'carrot-soup' }]) assert.strictEqual((await call('POST', '/shopping-list', body)).status, 400, JSON.stringify(body));
  assert.strictEqual((await call('POST', '/shopping-list', { recipes: ['no-such-recipe'] })).status, 404);
});

test('c2: cookable recipes filter by tags', async () => {
  await empty();
  const r = await call('GET', '/recipes/cookable?maxMissing=20&tags=dinner,vegan');
  assert.strictEqual(r.status, 200, r.text);
  const expected = expectedCookable(new Map(), 20, ['dinner', 'vegan']);
  assert.ok(expected.length >= 2 && expected.length < DATA.recipes.length);
  assert.deepStrictEqual(r.body.recipes.map((x) => ({ slug: x.slug, name: x.name, missing: pick(x.missing) })), expected);
});

// ---- c3: expiry dates, through a new migration ----
test('c3: amounts with different expiry dates are kept apart, and the pantry reports the earliest date', async () => {
  await empty();
  const a = await add({ food: 'rice', quantity: 500, unit: 'g', expiresOn: '2026-11-20' });
  assert.deepStrictEqual({ ...pick([a])[0], expiresOn: a.expiresOn }, { food: 'rice', quantity: 500, unit: 'g', expiresOn: '2026-11-20' });
  const b = await add({ food: 'rice', quantity: 300, unit: 'g', expiresOn: '2026-11-10' });
  assert.deepStrictEqual({ ...pick([b])[0], expiresOn: b.expiresOn }, { food: 'rice', quantity: 800, unit: 'g', expiresOn: '2026-11-10' });
  const c = await add({ food: 'rice', quantity: 200, unit: 'g' });
  assert.deepStrictEqual({ ...pick([c])[0], expiresOn: c.expiresOn }, { food: 'rice', quantity: 1, unit: 'kg', expiresOn: '2026-11-10' });
  await add({ food: 'milk', quantity: 1, unit: 'l' });
  const r = await call('GET', '/pantry');
  assert.deepStrictEqual(r.body.items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit, expiresOn: i.expiresOn })), [
    { food: 'milk', quantity: 1, unit: 'l', expiresOn: null },
    { food: 'rice', quantity: 1, unit: 'kg', expiresOn: '2026-11-10' },
  ]);
  for (const bad of ['2026-11-31', '11/20/2026', 20261120]) assert.strictEqual((await call('POST', '/pantry/items', { food: 'rice', quantity: 1, unit: 'g', expiresOn: bad })).status, 400, String(bad));
});

test('c3: expiring lists every lot up to a date; a missing or invalid date is 400', async () => {
  await empty();
  await stock([
    { food: 'yoghurt', quantity: 500, unit: 'g', expiresOn: '2026-11-08' },
    { food: 'rice', quantity: 300, unit: 'g', expiresOn: '2026-11-10' },
    { food: 'rice', quantity: 500, unit: 'g', expiresOn: '2026-11-20' },
    { food: 'butter', quantity: 250, unit: 'g', expiresOn: '2026-11-10' },
    { food: 'oats', quantity: 1, unit: 'kg' },
  ]);
  const r = await call('GET', '/pantry/expiring?before=2026-11-10');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.body.items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit, expiresOn: i.expiresOn })), [
    { food: 'yoghurt', quantity: 500, unit: 'g', expiresOn: '2026-11-08' },
    { food: 'butter', quantity: 250, unit: 'g', expiresOn: '2026-11-10' },
    { food: 'rice', quantity: 300, unit: 'g', expiresOn: '2026-11-10' },
  ]);
  for (const q of ['', '?before=', '?before=2026-02-30', '?before=tomorrow']) assert.strictEqual((await call('GET', `/pantry/expiring${q}`)).status, 400, q);
});

test('c3: cooking takes from the lots that expire first', async () => {
  await empty();
  const need = needsOf(COOK).get(`${MASS_FOOD.food.name.toLowerCase()}|mass`);
  const others = additionsFor(COOK).filter((i) => i.food !== MASS_FOOD.food.name);
  await stock([...others, { food: MASS_FOOD.food.name, quantity: need, unit: 'g' }, { food: MASS_FOOD.food.name, quantity: need, unit: 'g', expiresOn: '2026-11-05' }]);
  const r = await call('POST', '/cook', { slug: COOK.slug });
  assert.strictEqual(r.status, 200, r.text);
  const food = MASS_FOOD.food.name.toLowerCase();
  assert.deepStrictEqual(r.body.items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit, expiresOn: i.expiresOn })), [{ ...shown(food, 'mass', need), expiresOn: null }], 'the dated lot was used first');
  assert.deepStrictEqual((await call('GET', '/pantry/expiring?before=2026-12-31')).body.items, []);
});

test('c3: amounts without a date keep working as before', async () => {
  await empty();
  await stock(additionsFor(COOK));
  const r = await call('POST', '/cook', { slug: COOK.slug });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.body.items, []);
});

test('c3: migrations are append-only', () => {
  const dir = path.join(process.env.SERVICE_DIR, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2, `expiry dates come in a new migration file (found ${files.join(', ')})`);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /expir/i, `${files[0]} predates expiry dates and must not change`);
  assert.ok(files.slice(1).some((f) => /expir/i.test(fs.readFileSync(path.join(dir, f), 'utf8'))), 'a later migration adds expiry dates');
});
