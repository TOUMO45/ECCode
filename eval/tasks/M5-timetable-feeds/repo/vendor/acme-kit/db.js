'use strict';
// acme-kit/db: in-memory table store with the same value semantics as the
// production SQL driver (see README "Column types"). DECIMAL columns are
// returned as strings with fixed scale ("12.50"), exactly like the driver,
// so code written against this store behaves the same in production.

const TYPES = new Set(['INTEGER', 'TEXT', 'BOOLEAN', 'DECIMAL', 'TIMESTAMP']);

function parseType(t) {
  const m = /^(INTEGER|TEXT|BOOLEAN|TIMESTAMP|DECIMAL)(?:\((\d+),(\d+)\))?$/.exec(String(t).replace(/\s+/g, ''));
  if (!m || !TYPES.has(m[1])) throw new Error(`acme-kit/db: unknown column type ${t}`);
  return { base: m[1], scale: m[1] === 'DECIMAL' ? Number(m[3] || 2) : null };
}

function normalizeDecimal(v, scale) {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'number' ? v.toFixed(scale) : String(v).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`acme-kit/db: invalid DECIMAL value ${JSON.stringify(v)}`);
  const frac = (m[3] || '').padEnd(scale, '0');
  if (frac.length > scale) throw new Error(`acme-kit/db: DECIMAL value ${s} exceeds scale ${scale}`);
  return `${m[1] || ''}${m[2].replace(/^0+(?=\d)/, '')}.${frac}`;
}

function coerce(col, v) {
  if (v === null || v === undefined) return null;
  switch (col.base) {
    case 'INTEGER':
      if (!Number.isInteger(Number(v))) throw new Error(`acme-kit/db: invalid INTEGER ${v}`);
      return Number(v);
    case 'BOOLEAN':
      return Boolean(v);
    case 'DECIMAL':
      return normalizeDecimal(v, col.scale);
    case 'TIMESTAMP':
      return new Date(v).toISOString();
    default:
      return String(v);
  }
}

/**
 * createDb({ tables: { name: { columns: { col: 'TYPE' }, rows: [...] } } })
 * Rows always have an integer `id` column.
 */
function createDb(spec = { tables: {} }) {
  const tables = new Map();
  for (const [name, t] of Object.entries(spec.tables || {})) {
    const columns = Object.fromEntries(Object.entries({ id: 'INTEGER', ...t.columns }).map(([c, ty]) => [c, parseType(ty)]));
    const rows = [];
    let nextId = 1;
    for (const r of t.rows || []) {
      const row = {};
      for (const [c, col] of Object.entries(columns)) row[c] = coerce(col, r[c]);
      if (row.id === null) row.id = nextId;
      nextId = Math.max(nextId, row.id + 1);
      rows.push(row);
    }
    tables.set(name, { columns, rows, nextId });
  }
  const table = (name) => {
    const t = tables.get(name);
    if (!t) throw new Error(`acme-kit/db: no table ${name}`);
    return t;
  };
  const copy = (r) => ({ ...r });
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);
  return {
    /** All rows matching an equality filter, in id order. */
    all(name, where) {
      return table(name).rows.filter((r) => matches(r, where)).map(copy);
    },
    get(name, id) {
      const r = table(name).rows.find((x) => x.id === Number(id));
      return r ? copy(r) : null;
    },
    insert(name, values) {
      const t = table(name);
      const row = {};
      for (const [c, col] of Object.entries(t.columns)) row[c] = coerce(col, values[c]);
      row.id = t.nextId++;
      t.rows.push(row);
      return copy(row);
    },
    update(name, id, patch) {
      const t = table(name);
      const r = t.rows.find((x) => x.id === Number(id));
      if (!r) return null;
      for (const [c, v] of Object.entries(patch)) {
        if (c === 'id' || !t.columns[c]) continue;
        r[c] = coerce(t.columns[c], v);
      }
      return copy(r);
    },
    remove(name, id) {
      const t = table(name);
      const i = t.rows.findIndex((x) => x.id === Number(id));
      if (i === -1) return false;
      t.rows.splice(i, 1);
      return true;
    },
  };
}

module.exports = { createDb };
