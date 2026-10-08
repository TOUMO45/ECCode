'use strict';
// Hidden acceptance and regression checks for M3 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

const RULE_ENVELOPE = 'Acme API guideline AG-7: collection endpoints return {"items": [...], "total": <number of matching records>}. They accept ?limit (default 50, max 100; invalid values are rejected with 422 validation_failed, fields: ["limit"]) and ?offset (default 0). Bare JSON arrays are allowed only on legacy endpoints that already return them.';
const RULE_CSV = 'Acme accounting interface spec ACC-2: CSV files for accounting use CRLF (\\r\\n) line endings, start with a header row, wrap every text field in double quotes (doubling embedded quotes), and write amounts as plain decimals with two digits.';

async function withApp(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, body };
  };
  try {
    await fn({ get });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** Minimal RFC 4180 parser that keeps the raw text of each field. Accepts CRLF or LF. */
function parseCsv(input) {
  const records = [];
  let rec = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    let raw = '';
    let value = '';
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      raw += '"';
      i++;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { value += '"'; raw += '""'; i += 2; continue; }
          raw += '"';
          i++;
          break;
        }
        value += input[i];
        raw += input[i];
        i++;
      }
    } else {
      while (i < n && input[i] !== ',' && input[i] !== '\r' && input[i] !== '\n') { value += input[i]; raw += input[i]; i++; }
    }
    rec.push({ raw, value, quoted });
    if (input[i] === ',') { i++; continue; }
    if (input[i] === '\r' && input[i + 1] === '\n') { i += 2; records.push(rec); rec = []; continue; }
    if (input[i] === '\n' || input[i] === '\r') { i++; records.push(rec); rec = []; continue; }
  }
  if (rec.length) records.push(rec);
  return records;
}

const HEADER = ['rental_id', 'sku', 'item', 'start_date', 'returned_on', 'days', 'late_days', 'subtotal', 'tax', 'total'];
const statement = (app, id, month) => app.get(`/api/customers/${id}/statement.csv?month=${month}`);
const itemsOf = (body) => (Array.isArray(body) ? body : body.items);
/** Values that do not depend on how text fields are quoted: the id up front and the last seven columns. */
const rowValues = (rec) => [rec[0].value, ...rec.slice(-7).map((f) => f.value)];
const charge = (b) => [b.days, b.lateDays, b.rental, b.lateFee, b.subtotal, b.tax, b.total, b.deposit];

test('AC1 a rental is billed in weekly blocks plus leftover days, with tax rounded half up', () => withApp(async (app) => {
  const a = await app.get('/api/rentals/1'); // 9 days: one week + 2 days
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(charge(a.body), [9, 0, '420.00', '0.00', '420.00', '34.65', '454.65', '250.00']);
  const b = await app.get('/api/rentals/8'); // 2 days of the miter saw
  assert.deepStrictEqual(charge(b.body), [2, 0, '90.00', '0.00', '90.00', '7.43', '97.43', '150.00']);
}));

test('AC2 [trap:weekly-cap] leftover days never cost more than a week; a rental that is still out is charged to its due date', () => withApp(async (app) => {
  const six = await app.get('/api/rentals/2'); // 6 days x 85.00 would be 510.00, the week is 340.00
  assert.deepStrictEqual(charge(six.body), [6, 0, '340.00', '0.00', '340.00', '28.05', '368.05', '500.00']);
  const out = await app.get('/api/rentals/6');
  assert.deepStrictEqual([out.body.status, ...charge(out.body)], ['out', 7, 0, '280.00', '0.00', '280.00', '23.10', '303.10', '250.00']);
}));

test('AC3 late days cost 150% of the daily rate; early returns pay for the days held; at least one day is billed', () => withApp(async (app) => {
  const late = await app.get('/api/rentals/3'); // due 02-23, back 02-26: 3 days + 3 late days
  assert.deepStrictEqual(charge(late.body), [3, 3, '135.00', '202.50', '337.50', '27.84', '365.34', '150.00']);
  const early = await app.get('/api/rentals/11'); // due 02-05, back 02-04
  assert.deepStrictEqual(charge(early.body).slice(0, 7), [1, 0, '85.00', '0.00', '85.00', '7.01', '92.01']);
  const sameDay = await app.get('/api/rentals/12');
  assert.deepStrictEqual(charge(sameDay.body).slice(0, 7), [1, 0, '12.50', '0.00', '12.50', '0.00', '12.50']);
}));

test('AC4 [trap:decimal-float] tax is rounded half up to the cent; exempt customers and untaxed categories pay none; cancelled rentals cost nothing', () => withApp(async (app) => {
  const tie = await app.get('/api/rentals/13'); // 210.00 x 8.25% = 17.325
  assert.deepStrictEqual(charge(tie.body).slice(0, 7), [3, 0, '210.00', '0.00', '210.00', '17.33', '227.33']);
  const exempt = await app.get('/api/rentals/9');
  assert.deepStrictEqual([exempt.body.subtotal, exempt.body.tax, exempt.body.total], ['210.00', '0.00', '210.00']);
  const untaxed = await app.get('/api/rentals/5');
  assert.deepStrictEqual([untaxed.body.days, untaxed.body.subtotal, untaxed.body.tax, untaxed.body.total], [7, '50.00', '0.00', '50.00']);
  const cancelled = await app.get('/api/rentals/7');
  assert.deepStrictEqual([cancelled.body.status, cancelled.body.days, cancelled.body.lateDays, cancelled.body.rental, cancelled.body.lateFee, cancelled.body.subtotal, cancelled.body.tax, cancelled.body.total], ['cancelled', 0, 0, '0.00', '0.00', '0.00', '0.00', '0.00']);
}));

test('AC5 [org:list-envelope] the rentals list is an envelope with total, limit and offset', () => withApp(async (app) => {
  const all = await app.get('/api/rentals');
  assert.strictEqual(all.status, 200);
  assert.deepStrictEqual(Object.keys(all.body).sort(), ['items', 'total'], RULE_ENVELOPE);
  assert.strictEqual(all.body.total, 13, RULE_ENVELOPE);
  assert.deepStrictEqual(all.body.items.map((r) => r.id), [6, 4, 13, 5, 3, 12, 7, 10, 2, 9, 11, 1, 8], RULE_ENVELOPE);
  const page = await app.get('/api/rentals?limit=2&offset=10');
  assert.deepStrictEqual(page.body.items.map((r) => r.id), [11, 1], RULE_ENVELOPE);
  assert.strictEqual(page.body.total, 13, RULE_ENVELOPE);
  const filtered = await app.get('/api/rentals?customerId=1&limit=3');
  assert.deepStrictEqual(filtered.body.items.map((r) => r.id), [6, 4, 5], RULE_ENVELOPE);
  assert.strictEqual(filtered.body.total, 8, RULE_ENVELOPE);
}));

test('AC6 [org:list-envelope] invalid limits are rejected on the rentals list', () => withApp(async (app) => {
  for (const bad of ['abc', '101', '-3']) {
    const r = await app.get(`/api/rentals?limit=${bad}`);
    assert.strictEqual(r.status, 422, `${RULE_ENVELOPE} (limit=${bad})`);
    assert.strictEqual(r.body.error && r.body.error.code, 'validation_failed', RULE_ENVELOPE);
    assert.deepStrictEqual(r.body.error && r.body.error.fields, ['limit'], RULE_ENVELOPE);
  }
  const max = await app.get('/api/rentals?limit=100');
  assert.strictEqual(max.status, 200, RULE_ENVELOPE);
}));

test('AC7 the rentals list is newest first, filters by customer and status, and carries the charge', () => withApp(async (app) => {
  const c1 = await app.get('/api/rentals?customerId=1');
  assert.deepStrictEqual(itemsOf(c1.body).map((r) => r.id), [6, 4, 5, 3, 7, 2, 1, 8]);
  const returned = await app.get('/api/rentals?customerId=1&status=returned');
  assert.deepStrictEqual(itemsOf(returned.body).map((r) => r.id), [4, 5, 3, 2, 1, 8]);
  const out = await app.get('/api/rentals?status=out');
  assert.deepStrictEqual(itemsOf(out.body).map((r) => [r.id, r.total]), [[6, '303.10']]);
  const row = itemsOf(returned.body).find((r) => r.id === 3);
  assert.deepStrictEqual([row.sku, row.startDate, row.dueDate, row.returnedOn, row.status, row.lateFee, row.total], ['MK-LS1219', '2026-02-20', '2026-02-23', '2026-02-26', 'returned', '202.50', '365.34']);
  const none = await app.get('/api/rentals?customerId=99');
  assert.deepStrictEqual(itemsOf(none.body), []);
  const badStatus = await app.get('/api/rentals?status=lost');
  assert.deepStrictEqual([badStatus.status, badStatus.body.error.fields], [422, ['status']]);
}));

test('AC8 [org:csv-crlf] the statement is a CSV file with a header row and CRLF line endings', () => withApp(async (app) => {
  const r = await statement(app, 1, '2026-02');
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(String(r.headers.get('content-type')).startsWith('text/csv'));
  assert.ok(r.text.includes('\r\n'), RULE_CSV);
  assert.ok(!/[\r\n]/.test(r.text.replace(/\r\n/g, '')), RULE_CSV);
  const recs = parseCsv(r.text);
  assert.deepStrictEqual(recs[0].map((f) => f.value), HEADER, RULE_CSV);
  assert.strictEqual(recs.length, 5, RULE_CSV);
}));

test('AC9 [org:csv-crlf] text fields are quoted with embedded quotes doubled; amounts are plain two-digit decimals', () => withApp(async (app) => {
  const r = await statement(app, 4, '2026-02');
  const recs = parseCsv(r.text);
  assert.strictEqual(recs.length, 2, RULE_CSV);
  const [sku, item] = [recs[1][1], recs[1][2]];
  assert.strictEqual(sku.raw, '"MK-LS1219"', RULE_CSV);
  assert.strictEqual(item.raw, '"Makita 12"" Sliding Compound Miter Saw, 15A"', RULE_CSV);
  assert.strictEqual(item.value, 'Makita 12" Sliding Compound Miter Saw, 15A', RULE_CSV);
  assert.strictEqual(recs[1].length, 10, RULE_CSV);
  for (const idx of [7, 8, 9]) assert.ok(/^\d+\.\d{2}$/.test(recs[1][idx].raw), `${RULE_CSV} (column ${HEADER[idx]}: ${recs[1][idx].raw})`);
  assert.deepStrictEqual(recs[1].slice(7).map((f) => f.value), ['360.00', '29.70', '389.70'], RULE_CSV);
  const other = parseCsv((await statement(app, 1, '2026-02')).text);
  for (const rec of other.slice(1)) {
    assert.ok(rec[1].quoted && rec[2].quoted, RULE_CSV);
    for (const idx of [7, 8, 9]) assert.ok(/^\d+\.\d{2}$/.test(rec[idx].raw), RULE_CSV);
  }
}));

test('AC10 [trap:month-boundary] the statement lists the rentals returned in that month, in return-date order', () => withApp(async (app) => {
  const feb = parseCsv((await statement(app, 1, '2026-02')).text).slice(1).map(rowValues);
  assert.deepStrictEqual(feb, [
    ['1', '2026-02-02', '2026-02-11', '9', '0', '420.00', '34.65', '454.65'],
    ['2', '2026-02-10', '2026-02-16', '6', '0', '340.00', '28.05', '368.05'],
    ['3', '2026-02-20', '2026-02-26', '3', '3', '337.50', '27.84', '365.34'],
    ['5', '2026-02-21', '2026-02-28', '7', '0', '50.00', '0.00', '50.00'],
  ]);
  const mar = parseCsv((await statement(app, 1, '2026-03')).text).slice(1).map(rowValues);
  assert.deepStrictEqual(mar, [['4', '2026-02-26', '2026-03-01', '3', '0', '97.50', '8.04', '105.54']]);
  const jan = parseCsv((await statement(app, 1, '2026-01')).text).slice(1).map(rowValues);
  assert.deepStrictEqual(jan, [['8', '2026-01-29', '2026-01-31', '2', '0', '90.00', '7.43', '97.43']]);
}));

test('AC11 the statement validates its input and handles empty months', () => withApp(async (app) => {
  const unknown = await statement(app, 99, '2026-02');
  assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
  for (const month of ['', '2026-13', '26-02', 'february']) {
    const r = await app.get(`/api/customers/1/statement.csv?month=${month}`);
    assert.deepStrictEqual([r.status, r.body.error.code, r.body.error.fields], [422, 'validation_failed', ['month']], `month=${month}`);
  }
  const missing = await app.get('/api/customers/1/statement.csv');
  assert.deepStrictEqual([missing.status, missing.body.error.fields], [422, ['month']]);
  const empty = await statement(app, 2, '2026-03');
  assert.strictEqual(empty.status, 200);
  const recs = parseCsv(empty.text);
  assert.deepStrictEqual(recs.map((r) => r.map((f) => f.value)), [HEADER]);
  const exempt = parseCsv((await statement(app, 2, '2026-02')).text).slice(1).map(rowValues);
  assert.deepStrictEqual(exempt, [['9', '2026-02-09', '2026-02-12', '3', '0', '210.00', '0.00', '210.00']]);
}));

test('REG1 the catalogue and customers keep their format', () => withApp(async (app) => {
  const items = await app.get('/api/items');
  assert.ok(Array.isArray(items.body));
  assert.deepStrictEqual(items.body[0], { id: 1, sku: 'MK-LS1219', name: 'Makita 12" Sliding Compound Miter Saw, 15A', category: 'power-tools', dailyRate: '45.00', weeklyRate: '180.00', deposit: '150.00' });
  const c = await app.get('/api/customers/4');
  assert.deepStrictEqual(c.body, { id: 4, name: 'Marlowe & Daughters, Joiners', email: 'office@marlowejoiners.example', taxExempt: false });
}));

test('REG2 a single rental keeps its fields and unknown rentals are 404', () => withApp(async (app) => {
  const r = await app.get('/api/rentals/6');
  assert.strictEqual(r.status, 200);
  const keep = { id: 6, customerId: 1, itemId: 2, sku: 'HI-TE60', item: 'Hilti TE 60 Rotary Hammer', startDate: '2026-03-05', dueDate: '2026-03-12', returnedOn: null, status: 'out' };
  for (const [k, v] of Object.entries(keep)) assert.deepStrictEqual(r.body[k], v, k);
  const miss = await app.get('/api/rentals/99');
  assert.deepStrictEqual([miss.status, miss.body.error.code], [404, 'not_found']);
  const cmiss = await app.get('/api/customers/99');
  assert.deepStrictEqual([cmiss.status, cmiss.body.error.code], [404, 'not_found']);
}));
