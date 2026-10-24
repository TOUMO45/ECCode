'use strict';
// Hidden acceptance tests for mealie-planner (bench/suites/planner), run by
// check.js against the built service: PLANNER_URL (the service), MEALIE_DATA
// (the dataset the fake Mealie serves), PLANNER_DIR (the project, for its
// migrations). Test names start with the item that introduced them (c1:, c2:,
// c3:), and check.js runs one item's tests at a time. Expectations come from
// the dataset through the rules the requests state (the oracle below).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.PLANNER_URL;
const DATA = JSON.parse(fs.readFileSync(process.env.MEALIE_DATA, 'utf8'));
const MONDAY = '2026-11-02';

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
const minutes = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
};
const LABEL = new Map(DATA.foods.map((f) => [f.name.toLowerCase(), f.label ? f.label.name : null]));
const BANNED = { vegetarian: ['Meat', 'Fish'], vegan: ['Meat', 'Fish', 'Dairy', 'Egg'], 'gluten-free': ['Gluten'] };
function eligible(rules = {}) {
  const inc = rules.includeTags || [];
  const exc = rules.excludeTags || [];
  const banned = new Set((rules.diet || []).flatMap((d) => BANNED[d]));
  return DATA.recipes.filter((r) => {
    const tags = r.tags.map((t) => t.slug);
    if (!inc.every((t) => tags.includes(t)) || exc.some((t) => tags.includes(t))) return false;
    if (rules.maxTotalTimeMinutes != null) {
      const m = minutes(r.totalTime);
      if (m === null || m > rules.maxTotalTimeMinutes) return false;
    }
    return !r.recipeIngredient.some((i) => i.food && banned.has(LABEL.get(i.food.name.toLowerCase())));
  }).sort((a, b) => (a.slug < b.slug ? -1 : 1));
}
const SLOTS = { 1: ['dinner'], 2: ['lunch', 'dinner'], 3: ['breakfast', 'lunch', 'dinner'] };
function expectedDays(weekStart, days, rules = {}) {
  const pool = eligible(rules);
  const slots = SLOTS[rules.mealsPerDay || 1];
  let k = 0;
  return Array.from({ length: days }, (_, d) => {
    const date = new Date(`${weekStart}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + d);
    return { date: date.toISOString().slice(0, 10), meals: slots.map((slot) => ({ slot, recipeSlug: pool[k++ % pool.length].slug })) };
  });
}
const MASS = { g: 1, kg: 1000 };
const VOLUME = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 };
const round = (x) => Math.round(x * 100) / 100;
function expectedList(days) {
  const sums = new Map();
  const notes = new Set();
  for (const d of days) {
    for (const m of d.meals) {
      for (const i of DATA.recipes.find((r) => r.slug === m.recipeSlug).recipeIngredient) {
        if (!i.food) {
          notes.add(i.note);
          continue;
        }
        const food = i.food.name.toLowerCase();
        const q = i.quantity == null ? 1 : i.quantity;
        const u = i.unit ? i.unit.abbreviation : null;
        const kind = u === null ? 'count' : u in MASS ? 'mass' : u in VOLUME ? 'volume' : `other:${u}`;
        const amount = kind === 'mass' ? q * MASS[u] : kind === 'volume' ? q * VOLUME[u] : q;
        const key = `${food}|${kind}`;
        sums.set(key, (sums.get(key) || 0) + amount);
      }
    }
  }
  const items = [...sums].map(([key, total]) => {
    const [food, kind] = key.split('|');
    if (kind === 'mass') return total < 1000 ? { food, quantity: round(total), unit: 'g' } : { food, quantity: round(total / 1000), unit: 'kg' };
    if (kind === 'volume') return total < 1000 ? { food, quantity: round(total), unit: 'ml' } : { food, quantity: round(total / 1000), unit: 'l' };
    return { food, quantity: round(total), unit: kind === 'count' ? null : kind.slice(6) };
  });
  items.sort((a, b) => (a.food < b.food ? -1 : a.food > b.food ? 1 : a.unit === b.unit ? 0 : a.unit === null ? -1 : b.unit === null ? 1 : a.unit < b.unit ? -1 : 1));
  return { items, notes: [...notes].sort() };
}
const slugsOf = (plan) => plan.days.map((d) => ({ date: d.date, meals: d.meals.map((m) => ({ slot: m.slot, recipeSlug: m.recipeSlug })) }));
const sortItems = (items) => items.map((i) => ({ food: i.food, quantity: i.quantity, unit: i.unit === undefined ? null : i.unit }));

// ---- c1: plans and shopping lists ----
test('c1: health', async () => {
  const r = await call('GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
});

test('c1: a week of dinners in slug order', async () => {
  const rules = { includeTags: ['dinner'] };
  const r = await call('POST', '/plans', { weekStart: MONDAY, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(typeof r.body.id, 'string');
  assert.strictEqual(r.body.weekStart, MONDAY);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 7, rules));
  const named = DATA.recipes.find((x) => x.slug === r.body.days[0].meals[0].recipeSlug).name;
  assert.strictEqual(r.body.days[0].meals[0].recipeName, named);
});

test('c1: three meals a day with excluded tags and a time limit', async () => {
  const rules = { mealsPerDay: 3, excludeTags: ['dessert'], maxTotalTimeMinutes: 30 };
  const r = await call('POST', '/plans', { weekStart: MONDAY, days: 3, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 3, rules));
});

test('c1: fewer recipes than meals starts again from the first', async () => {
  const rules = { includeTags: ['breakfast'], mealsPerDay: 2 };
  const r = await call('POST', '/plans', { weekStart: MONDAY, days: 5, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 5, rules));
});

test('c1: every page of recipes is read', async () => {
  const rules = { mealsPerDay: 3 };
  const r = await call('POST', '/plans', { weekStart: MONDAY, days: 14, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 14, rules));
});

test('c1: the plan reads back by id, and an unknown id is 404', async () => {
  const made = await call('POST', '/plans', { weekStart: MONDAY, days: 2, rules: { includeTags: ['lunch'] } });
  const back = await call('GET', `/plans/${made.body.id}`);
  assert.strictEqual(back.status, 200);
  assert.deepStrictEqual(slugsOf(back.body), slugsOf(made.body));
  assert.strictEqual((await call('GET', '/plans/no-such-plan')).status, 404);
});

test('c1: invalid input is 400', async () => {
  for (const body of [{ weekStart: '2026-11-03' }, { weekStart: '2026-13-01' }, { weekStart: 'monday' }, {}, { weekStart: MONDAY, days: 0 }, { weekStart: MONDAY, days: 15 }, { weekStart: MONDAY, rules: { mealsPerDay: 4 } }]) {
    const r = await call('POST', '/plans', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(typeof (r.body && r.body.error), 'string', `an error message for ${JSON.stringify(body)}`);
  }
});

test('c1: no eligible recipe is 409', async () => {
  assert.strictEqual((await call('POST', '/plans', { weekStart: MONDAY, rules: { includeTags: ['no-such-tag'] } })).status, 409);
});

test('c1: the shopping list merges and converts units', async () => {
  for (const [days, rules] of [[7, { includeTags: ['dinner'] }], [4, { mealsPerDay: 3, includeTags: ['vegetarian'] }], [14, { mealsPerDay: 3 }]]) {
    const made = await call('POST', '/plans', { weekStart: MONDAY, days, rules });
    const r = await call('GET', `/plans/${made.body.id}/shopping-list`);
    assert.strictEqual(r.status, 200, r.text);
    const want = expectedList(expectedDays(MONDAY, days, rules));
    assert.strictEqual(r.body.planId, made.body.id);
    assert.deepStrictEqual(sortItems(r.body.items), want.items, JSON.stringify(rules));
    assert.deepStrictEqual(r.body.notes, want.notes);
  }
  assert.strictEqual((await call('GET', '/plans/no-such-plan/shopping-list')).status, 404);
});

// ---- c2: diets and label groups ----
test('c2: vegetarian excludes meat and fish', async () => {
  const rules = { mealsPerDay: 2, diet: ['vegetarian'] };
  const r = await call('POST', '/plans', { weekStart: MONDAY, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 7, rules));
});

test('c2: vegan and gluten-free combine with tags', async () => {
  const rules = { diet: ['vegan', 'gluten-free'], includeTags: ['dinner'] };
  const r = await call('POST', '/plans', { weekStart: MONDAY, days: 6, rules });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(slugsOf(r.body), expectedDays(MONDAY, 6, rules));
});

test('c2: an unknown diet is 400', async () => {
  assert.strictEqual((await call('POST', '/plans', { weekStart: MONDAY, rules: { diet: ['carnivore'] } })).status, 400);
});

test('c2: the shopping list grouped by label', async () => {
  const rules = { mealsPerDay: 3 };
  const made = await call('POST', '/plans', { weekStart: MONDAY, days: 5, rules });
  const r = await call('GET', `/plans/${made.body.id}/shopping-list?groupBy=label`);
  assert.strictEqual(r.status, 200, r.text);
  const want = expectedList(expectedDays(MONDAY, 5, rules));
  const groups = new Map();
  for (const i of want.items) {
    const label = LABEL.get(i.food) || 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a < b ? -1 : 1));
  assert.deepStrictEqual(r.body.groups.map((g) => ({ label: g.label, items: sortItems(g.items) })), order.map((label) => ({ label, items: groups.get(label) })));
  assert.deepStrictEqual(r.body.notes, want.notes);
});

// ---- c3: households, through a new migration ----
test('c3: households are created and read back', async () => {
  const made = await call('POST', '/households', { name: 'Flat 4' });
  assert.strictEqual(made.status, 201, made.text);
  assert.strictEqual(made.body.name, 'Flat 4');
  const back = await call('GET', `/households/${made.body.id}`);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.body.name, 'Flat 4');
  assert.strictEqual((await call('POST', '/households', { name: '' })).status, 400);
  assert.strictEqual((await call('GET', '/households/no-such-household')).status, 404);
});

test('c3: a plan belongs to a household and is listed under it', async () => {
  const h = (await call('POST', '/households', { name: 'House' })).body;
  const later = await call('POST', '/plans', { weekStart: '2026-11-09', days: 2, householdId: h.id });
  const first = await call('POST', '/plans', { weekStart: MONDAY, days: 2, householdId: h.id });
  assert.strictEqual(first.status, 201, first.text);
  assert.strictEqual(first.body.householdId, h.id);
  const list = await call('GET', `/households/${h.id}/plans`);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.map((p) => p.id), [first.body.id, later.body.id], 'sorted by weekStart');
  assert.strictEqual((await call('GET', '/households/no-such-household/plans')).status, 404);
});

test('c3: plans without a household still work', async () => {
  const r = await call('POST', '/plans', { weekStart: MONDAY, days: 1 });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.householdId, null);
  assert.strictEqual((await call('GET', `/plans/${r.body.id}/shopping-list`)).status, 200);
});

test('c3: an unknown household is 404 when planning', async () => {
  assert.strictEqual((await call('POST', '/plans', { weekStart: MONDAY, householdId: 'no-such-household' })).status, 404);
});

test('c3: migrations are append-only', () => {
  const dir = path.join(process.env.PLANNER_DIR, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2, `households come in a new migration file (found ${files.join(', ')})`);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /household/i, `${files[0]} predates households and must not change`);
  assert.ok(files.slice(1).some((f) => /household/i.test(fs.readFileSync(path.join(dir, f), 'utf8'))), 'a later migration adds households');
});
