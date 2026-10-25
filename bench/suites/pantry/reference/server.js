'use strict';
// Reference mealie-pantry (c1-c3), dependency-free: node:http and node:sqlite.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const MEALIE = (process.env.MEALIE_URL || '').replace(/\/$/, '');
const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(__dirname, 'pantry.db'));

// Migrations: plain SQL files in name order, each recorded once.
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY)');
for (const f of fs.readdirSync(path.join(__dirname, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(f)) continue;
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
  db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function mealie(pathname) {
  const r = await fetch(`${MEALIE}${pathname}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, `Mealie answered ${r.status} for ${pathname}`);
  return r.json();
}
async function allPages(endpoint) {
  const out = [];
  for (let page = 1; ; page++) {
    const p = await mealie(`${endpoint}?page=${page}&perPage=50`);
    out.push(...p.items);
    if (page >= p.total_pages) return out;
  }
}

// ---- amounts: a food, a kind of unit, a total in the kind's base unit ----
const MASS = { g: 1, kg: 1000 };
const VOLUME = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 };
const EPS = 1e-9;
const kindOf = (u) => (u == null ? 'count' : u in MASS ? 'mass' : u in VOLUME ? 'volume' : `other:${u}`);
const toBase = (q, u) => (u in MASS ? q * MASS[u] : u in VOLUME ? q * VOLUME[u] : q);
const round = (x) => Math.round(x * 100) / 100;
function shown(food, kind, total) {
  if (kind === 'mass') return total < 1000 ? { food, quantity: round(total), unit: 'g' } : { food, quantity: round(total / 1000), unit: 'kg' };
  if (kind === 'volume') return total < 1000 ? { food, quantity: round(total), unit: 'ml' } : { food, quantity: round(total / 1000), unit: 'l' };
  return { food, quantity: round(total), unit: kind === 'count' ? null : kind.slice(6) };
}
const byFoodUnit = (a, b) => (a.food < b.food ? -1 : a.food > b.food ? 1 : a.unit === b.unit ? 0 : a.unit === null ? -1 : b.unit === null ? 1 : a.unit < b.unit ? -1 : 1);

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---- the pantry: lots of (food, kind, expiry) ----
const lots = () => db.prepare('SELECT rowid AS id, food, kind, expires_on AS expiresOn, amount FROM pantry_lots').all();
function totals() {
  const m = new Map();
  for (const l of lots()) {
    const key = `${l.food}|${l.kind}`;
    const t = m.get(key) || { food: l.food, kind: l.kind, amount: 0, expiresOn: null };
    t.amount += l.amount;
    if (l.expiresOn && (!t.expiresOn || l.expiresOn < t.expiresOn)) t.expiresOn = l.expiresOn;
    m.set(key, t);
  }
  return m;
}
const pantryItems = () => [...totals().values()].map((t) => ({ ...shown(t.food, t.kind, t.amount), expiresOn: t.expiresOn })).sort(byFoodUnit);

function addItem(body) {
  const food = typeof body.food === 'string' ? body.food.trim().toLowerCase() : '';
  if (!food) throw new HttpError(400, 'food must be a non-empty string');
  if (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity) || body.quantity <= 0) throw new HttpError(400, 'quantity must be a positive number');
  const unit = body.unit === undefined ? null : body.unit;
  if (unit !== null && typeof unit !== 'string') throw new HttpError(400, 'unit must be a string or null');
  const expiresOn = body.expiresOn === undefined ? null : body.expiresOn;
  if (expiresOn !== null && !validDate(expiresOn)) throw new HttpError(400, 'expiresOn must be a date (YYYY-MM-DD)');
  const kind = kindOf(unit);
  const existing = db.prepare('SELECT rowid AS id FROM pantry_lots WHERE food = ? AND kind = ? AND expires_on IS ?').get(food, kind, expiresOn);
  if (existing) db.prepare('UPDATE pantry_lots SET amount = amount + ? WHERE rowid = ?').run(toBase(body.quantity, unit), existing.id);
  else db.prepare('INSERT INTO pantry_lots (food, kind, expires_on, amount) VALUES (?, ?, ?, ?)').run(food, kind, expiresOn, toBase(body.quantity, unit));
  const t = totals().get(`${food}|${kind}`);
  return { ...shown(food, kind, t.amount), expiresOn: t.expiresOn };
}

// ---- recipes: what they need, what the pantry lacks ----
function needsOf(recipe, times = 1, into = new Map()) {
  for (const i of recipe.recipeIngredient || []) {
    if (!i.food) continue;
    const food = i.food.name.toLowerCase();
    const u = i.unit ? i.unit.abbreviation : null;
    const key = `${food}|${kindOf(u)}`;
    into.set(key, (into.get(key) || 0) + times * toBase(i.quantity == null ? 1 : i.quantity, u));
  }
  return into;
}
function lacking(needs) {
  const held = totals();
  const out = [];
  for (const [key, need] of needs) {
    const [food, kind] = key.split('|');
    const lack = need - (held.has(key) ? held.get(key).amount : 0);
    if (lack > EPS) out.push(shown(food, kind, lack));
  }
  return out.sort(byFoodUnit);
}

async function cookable(query) {
  const raw = query.get('maxMissing');
  if (raw !== null && !/^\d+$/.test(raw)) throw new HttpError(400, 'maxMissing must be an integer from 0 to 20');
  const max = raw === null ? 0 : Number(raw);
  if (max > 20) throw new HttpError(400, 'maxMissing must be an integer from 0 to 20');
  const tags = (query.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const summary of await allPages('/api/recipes')) {
    const has = summary.tags.map((t) => t.slug);
    if (!tags.every((t) => has.includes(t))) continue;
    const recipe = await mealie(`/api/recipes/${encodeURIComponent(summary.slug)}`);
    const missing = lacking(needsOf(recipe));
    if (missing.length <= max) out.push({ slug: summary.slug, name: summary.name, missing });
  }
  return { recipes: out.sort((a, b) => a.missing.length - b.missing.length || (a.slug < b.slug ? -1 : 1)) };
}

async function cook(body) {
  if (typeof body.slug !== 'string' || !body.slug) throw new HttpError(400, 'slug is required');
  const recipe = await mealie(`/api/recipes/${encodeURIComponent(body.slug)}`);
  if (!recipe) throw new HttpError(404, `no recipe ${body.slug}`);
  const needs = needsOf(recipe);
  const missing = lacking(needs);
  if (missing.length) throw new HttpError(409, 'the pantry does not hold everything this recipe needs', { missing });
  db.exec('BEGIN');
  try {
    for (const [key, need] of needs) {
      const [food, kind] = key.split('|');
      let left = need;
      // The lots that expire first go first; a lot without a date last.
      const rows = db.prepare('SELECT rowid AS id, amount FROM pantry_lots WHERE food = ? AND kind = ? ORDER BY expires_on IS NULL, expires_on, rowid').all(food, kind);
      for (const r of rows) {
        if (left <= EPS) break;
        const take = Math.min(r.amount, left);
        left -= take;
        if (r.amount - take <= EPS) db.prepare('DELETE FROM pantry_lots WHERE rowid = ?').run(r.id);
        else db.prepare('UPDATE pantry_lots SET amount = ? WHERE rowid = ?').run(r.amount - take, r.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { slug: body.slug, items: pantryItems() };
}

async function shoppingList(body) {
  const slugs = body.recipes;
  if (!Array.isArray(slugs) || !slugs.length || slugs.some((s) => typeof s !== 'string' || !s)) throw new HttpError(400, 'recipes must be a non-empty list of slugs');
  const needs = new Map();
  for (const slug of new Set(slugs)) {
    const recipe = await mealie(`/api/recipes/${encodeURIComponent(slug)}`);
    if (!recipe) throw new HttpError(404, `no recipe ${slug}`);
    needsOf(recipe, slugs.filter((s) => s === slug).length, needs);
  }
  const labels = new Map((await allPages('/api/foods')).map((f) => [f.name.toLowerCase(), f.label ? f.label.name : null]));
  const items = lacking(needs).map((i) => ({ ...i, label: labels.get(i.food) || 'Other' }));
  const rank = (l) => (l === 'Other' ? 1 : 0);
  items.sort((a, b) => rank(a.label) - rank(b.label) || (a.label < b.label ? -1 : a.label > b.label ? 1 : byFoodUnit(a, b)));
  return { items };
}

function expiring(query) {
  const before = query.get('before');
  if (!validDate(before)) throw new HttpError(400, 'before must be a date (YYYY-MM-DD)');
  const items = lots().filter((l) => l.expiresOn && l.expiresOn <= before).map((l) => ({ ...shown(l.food, l.kind, l.amount), expiresOn: l.expiresOn }));
  items.sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : byFoodUnit(a, b)));
  return { items };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new HttpError(400, 'the body is not JSON'));
      }
    });
  });
}

http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/health') return send(200, { ok: true });
    if (req.method === 'POST' && p === '/pantry/items') return send(201, addItem(await readBody(req)));
    if (req.method === 'GET' && p === '/pantry') return send(200, { items: pantryItems() });
    if (req.method === 'GET' && p === '/pantry/expiring') return send(200, expiring(url.searchParams));
    const del = req.method === 'DELETE' && p.match(/^\/pantry\/items\/(.+)$/);
    if (del) {
      const food = decodeURIComponent(del[1]).trim().toLowerCase();
      const r = db.prepare('DELETE FROM pantry_lots WHERE food = ?').run(food);
      return r.changes ? send(204) : send(404, { error: `no ${food} in the pantry` });
    }
    if (req.method === 'GET' && p === '/recipes/cookable') return send(200, await cookable(url.searchParams));
    if (req.method === 'POST' && p === '/cook') return send(200, await cook(await readBody(req)));
    if (req.method === 'POST' && p === '/shopping-list') return send(200, await shoppingList(await readBody(req)));
    return send(404, { error: 'not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra });
    return send(500, { error: String(e.message || e) });
  }
}).listen(PORT);
