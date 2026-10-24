'use strict';
// Reference mealie-planner (c1-c3), dependency-free: node:http and node:sqlite.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const MEALIE = (process.env.MEALIE_URL || '').replace(/\/$/, '');
const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(__dirname, 'planner.db'));

// Migrations: plain SQL files in name order, each recorded once.
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY)');
for (const f of fs.readdirSync(path.join(__dirname, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(f)) continue;
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
  db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(502, `Mealie answered ${r.status} for ${url}`);
  return r.json();
}
async function allPages(endpoint) {
  const out = [];
  for (let page = 1; ; page++) {
    const p = await getJson(`${MEALIE}${endpoint}?page=${page}&perPage=50`);
    out.push(...p.items);
    if (page >= p.total_pages) return out;
  }
}

const minutes = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
};
const BANNED = { vegetarian: ['Meat', 'Fish'], vegan: ['Meat', 'Fish', 'Dairy', 'Egg'], 'gluten-free': ['Gluten'] };
const SLOTS = { 1: ['dinner'], 2: ['lunch', 'dinner'], 3: ['breakfast', 'lunch', 'dinner'] };

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

async function makePlan(body) {
  const start = validDate(body.weekStart);
  if (!start || start.getUTCDay() !== 1) throw new HttpError(400, 'weekStart must be a date (YYYY-MM-DD) that is a Monday');
  const days = body.days === undefined ? 7 : body.days;
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new HttpError(400, 'days must be 1 to 14');
  const rules = body.rules || {};
  const perDay = rules.mealsPerDay === undefined ? 1 : rules.mealsPerDay;
  if (!SLOTS[perDay]) throw new HttpError(400, 'mealsPerDay must be 1 to 3');
  const diet = rules.diet || [];
  if (!Array.isArray(diet) || diet.some((d) => !BANNED[d])) throw new HttpError(400, `unknown diet; use ${Object.keys(BANNED).join(', ')}`);
  let householdId = null;
  if (body.householdId !== undefined && body.householdId !== null) {
    if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(body.householdId)) throw new HttpError(404, 'unknown household');
    householdId = body.householdId;
  }
  const inc = rules.includeTags || [];
  const exc = rules.excludeTags || [];
  let pool = (await allPages('/api/recipes')).filter((r) => {
    const tags = (r.tags || []).map((t) => t.slug);
    if (!inc.every((t) => tags.includes(t)) || exc.some((t) => tags.includes(t))) return false;
    if (rules.maxTotalTimeMinutes !== undefined && rules.maxTotalTimeMinutes !== null) {
      const m = minutes(r.totalTime);
      if (m === null || m > rules.maxTotalTimeMinutes) return false;
    }
    return true;
  });
  if (diet.length) {
    const labels = new Map((await allPages('/api/foods')).map((f) => [f.name.toLowerCase(), f.label ? f.label.name : null]));
    const banned = new Set(diet.flatMap((d) => BANNED[d]));
    const details = await Promise.all(pool.map((r) => getJson(`${MEALIE}/api/recipes/${r.slug}`)));
    pool = pool.filter((r, i) => !details[i].recipeIngredient.some((x) => x.food && banned.has(labels.get(x.food.name.toLowerCase()))));
  }
  pool.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  if (!pool.length) throw new HttpError(409, 'no recipe matches these rules');
  let k = 0;
  const plan = {
    id: crypto.randomUUID(),
    weekStart: body.weekStart,
    householdId,
    days: Array.from({ length: days }, (_, d) => {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + d);
      return { date: date.toISOString().slice(0, 10), meals: SLOTS[perDay].map((slot) => { const r = pool[k++ % pool.length]; return { slot, recipeSlug: r.slug, recipeName: r.name }; }) };
    }),
  };
  db.prepare('INSERT INTO plans (id, week_start, body, created_at, household_id) VALUES (?, ?, ?, ?, ?)').run(plan.id, plan.weekStart, JSON.stringify(plan), new Date().toISOString(), householdId);
  return plan;
}

function loadPlan(id) {
  const row = db.prepare('SELECT body, household_id FROM plans WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'unknown plan');
  return { ...JSON.parse(row.body), householdId: row.household_id || null };
}

const MASS = { g: 1, kg: 1000 };
const VOLUME = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 };
const round = (x) => Math.round(x * 100) / 100;
async function shoppingList(plan, groupBy) {
  const sums = new Map();
  const notes = new Set();
  const cache = new Map();
  for (const d of plan.days) {
    for (const m of d.meals) {
      if (!cache.has(m.recipeSlug)) cache.set(m.recipeSlug, await getJson(`${MEALIE}/api/recipes/${m.recipeSlug}`));
      for (const i of cache.get(m.recipeSlug).recipeIngredient) {
        if (!i.food) {
          if (i.note) notes.add(i.note);
          continue;
        }
        const food = i.food.name.toLowerCase();
        const q = i.quantity == null ? 1 : i.quantity;
        const u = i.unit ? i.unit.abbreviation : null;
        const kind = u === null ? 'count' : u in MASS ? 'mass' : u in VOLUME ? 'volume' : `other:${u}`;
        const key = `${food}|${kind}`;
        sums.set(key, (sums.get(key) || 0) + (kind === 'mass' ? q * MASS[u] : kind === 'volume' ? q * VOLUME[u] : q));
      }
    }
  }
  const items = [...sums].map(([key, total]) => {
    const [food, kind] = key.split('|');
    if (kind === 'mass') return total < 1000 ? { food, quantity: round(total), unit: 'g' } : { food, quantity: round(total / 1000), unit: 'kg' };
    if (kind === 'volume') return total < 1000 ? { food, quantity: round(total), unit: 'ml' } : { food, quantity: round(total / 1000), unit: 'l' };
    return { food, quantity: round(total), unit: kind === 'count' ? null : kind.slice(6) };
  }).sort((a, b) => (a.food < b.food ? -1 : a.food > b.food ? 1 : a.unit === b.unit ? 0 : a.unit === null ? -1 : b.unit === null ? 1 : a.unit < b.unit ? -1 : 1));
  const out = { planId: plan.id, notes: [...notes].sort() };
  if (groupBy !== 'label') return { ...out, items };
  const labels = new Map((await allPages('/api/foods')).map((f) => [f.name.toLowerCase(), f.label ? f.label.name : null]));
  const groups = new Map();
  for (const i of items) {
    const label = labels.get(i.food) || 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  }
  return { ...out, groups: [...groups.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a < b ? -1 : 1)).map((label) => ({ label, items: groups.get(label) })) };
}

async function handle(req, url, body) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/health') return [200, { ok: true }];
  if (req.method === 'POST' && p === '/plans') return [201, await makePlan(body || {})];
  let m = p.match(/^\/plans\/([^/]+)$/);
  if (req.method === 'GET' && m) return [200, loadPlan(m[1])];
  m = p.match(/^\/plans\/([^/]+)\/shopping-list$/);
  if (req.method === 'GET' && m) return [200, await shoppingList(loadPlan(m[1]), url.searchParams.get('groupBy'))];
  if (req.method === 'POST' && p === '/households') {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
    const h = { id: crypto.randomUUID(), name: body.name };
    db.prepare('INSERT INTO households (id, name) VALUES (?, ?)').run(h.id, h.name);
    return [201, h];
  }
  m = p.match(/^\/households\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const h = db.prepare('SELECT id, name FROM households WHERE id = ?').get(m[1]);
    if (!h) throw new HttpError(404, 'unknown household');
    return [200, { id: h.id, name: h.name }];
  }
  m = p.match(/^\/households\/([^/]+)\/plans$/);
  if (req.method === 'GET' && m) {
    if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(m[1])) throw new HttpError(404, 'unknown household');
    return [200, db.prepare('SELECT id, week_start FROM plans WHERE household_id = ? ORDER BY week_start, id').all(m[1]).map((r) => ({ id: r.id, weekStart: r.week_start }))];
  }
  throw new HttpError(404, 'not found');
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
      }
      const [code, obj] = await handle(req, new URL(req.url, 'http://x'), body);
      send(code, obj);
    } catch (e) {
      send(e.status || 500, { error: e.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`listening on http://127.0.0.1:${PORT}\n`));
