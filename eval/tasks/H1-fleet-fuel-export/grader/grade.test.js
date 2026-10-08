'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

const ACC2 = 'Acme accounting interface spec ACC-2: CSV files for accounting use CRLF (`\\r\\n`) line endings, start with a header row, wrap every text field in double quotes (doubling embedded quotes), and write amounts as plain decimals with two digits.';

async function withApp(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body, text };
  };
  try { await fn(get); } finally { await new Promise((r) => server.close(r)); }
}

/** Parse CSV text into records of { raw, value } fields. Accepts LF or CRLF. */
function parseCsv(text) {
  const records = [];
  let rec = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let raw;
    let value = '';
    if (text[i] === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { value += '"'; j++; continue; }
          break;
        }
        value += text[j];
      }
      raw = text.slice(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++;
      raw = value = text.slice(i, j);
      i = j;
    }
    rec.push({ raw, value });
    if (text[i] === ',') { i++; if (i === n) rec.push({ raw: '', value: '' }); continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    records.push(rec);
    rec = [];
  }
  if (rec.length) records.push(rec);
  return records;
}

const values = (records) => records.map((r) => r.map((f) => f.value));
const COLUMNS = ['purchase_id', 'date', 'plate', 'driver', 'station', 'net', 'vat', 'gross'];
const SEPTEMBER = [
  ['1', '2026-09-02', 'B-FL 1042', 'Marta Kowalski', 'Aral Kassel-Ost', '84.12', '15.98', '100.10'],
  ['2', '2026-09-03', 'B-FL 2177', "O'Neill, Sean", 'Shell "Autohof" Erfurt', '52.50', '9.98', '62.48'],
  ['3', '2026-09-05', 'B-FL 1042', 'Marta Kowalski', 'TotalEnergies Venlo', '40.50', '8.51', '49.01'],
  ['8', '2026-09-08', 'B-FL 2177', 'Bea Lindqvist', 'Agip Würzburg', '47.50', '9.03', '56.53'],
  ['5', '2026-09-12', 'B-FL 3310', 'Jonas Weber', 'OMV Salzburg Nord', '61.37', '12.27', '73.64'],
  ['9', '2026-09-20', 'B-FL 3310', 'Jonas Weber', 'Migrol Basel', '25.00', '2.03', '27.03'],
  ['6', '2026-09-30', 'B-FL 2177', "O'Neill, Sean", 'Esso Hannover, Messe', '15.50', '2.95', '18.45'],
];
const EXPORT = '/api/exports/fuel-purchases.csv?month=2026-09';

test('AC1 the export lists the purchases of the month, oldest first, with the requested columns', () => withApp(async (get) => {
  const r = await get(EXPORT);
  assert.strictEqual(r.status, 200);
  assert.match(String(r.headers.get('content-type')), /csv/i);
  const rows = values(parseCsv(r.text));
  assert.deepStrictEqual(rows[0], COLUMNS);
  assert.deepStrictEqual(rows.slice(1).map((x) => [x[0], x[1], x[2]]), SEPTEMBER.map((x) => [x[0], x[1], x[2]]));
  const oct = values(parseCsv((await get('/api/exports/fuel-purchases.csv?month=2026-10')).text));
  assert.deepStrictEqual(oct.slice(1).map((x) => x[0]), ['7']);
}));

test('AC2 [trap:decimal-float] net, VAT and gross are exact to the cent, half a cent rounds up', () => withApp(async (get) => {
  const rows = values(parseCsv((await get(EXPORT)).text));
  assert.deepStrictEqual(rows.slice(1).map((x) => [x[0], x[5], x[6], x[7]]), SEPTEMBER.map((x) => [x[0], x[5], x[6], x[7]]));
}));

test('AC3 driver and station names with commas or quotes come through unchanged', () => withApp(async (get) => {
  const rows = values(parseCsv((await get(EXPORT)).text));
  assert.ok(rows.slice(1).every((x) => x.length === COLUMNS.length), 'every row has exactly 8 fields');
  assert.deepStrictEqual(rows.slice(1).map((x) => [x[3], x[4]]), SEPTEMBER.map((x) => [x[3], x[4]]));
}));

test('AC4 a month without purchases gives only the header', () => withApp(async (get) => {
  const r = await get('/api/exports/fuel-purchases.csv?month=2026-07');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(values(parseCsv(r.text)), [COLUMNS]);
}));

test('AC5 a missing or malformed month is 422 validation_failed on month', () => withApp(async (get) => {
  for (const q of ['', '?month=', '?month=2026-9', '?month=September', '?month=2026-13']) {
    const r = await get(`/api/exports/fuel-purchases.csv${q}`);
    assert.strictEqual(r.status, 422, q);
    assert.strictEqual(r.body.error.code, 'validation_failed', q);
    assert.deepStrictEqual(r.body.error.fields, ['month'], q);
  }
}));

test('AC6 [org:csv-crlf] the export uses CRLF line endings', () => withApp(async (get) => {
  const r = await get(EXPORT);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('\r\n') && !/(^|[^\r])\n/.test(r.text), ACC2);
}));

test('AC7 [org:csv-crlf] text fields are quoted and amounts are plain two-digit decimals', () => withApp(async (get) => {
  const records = parseCsv((await get(EXPORT)).text);
  assert.deepStrictEqual(values(records)[0], COLUMNS, `${ACC2} (header row)`);
  const quoted = /^"(?:[^"]|"")*"$/;
  for (const rec of records.slice(1)) {
    for (const i of [2, 3, 4]) assert.match(rec[i].raw, quoted, `${ACC2} (${COLUMNS[i]}: ${rec[i].raw})`);
    for (const i of [5, 6, 7]) assert.match(rec[i].raw, /^-?\d+\.\d{2}$/, `${ACC2} (${COLUMNS[i]}: ${rec[i].raw})`);
  }
}));

test('REG1 the fuel purchase endpoint is unchanged', () => withApp(async (get) => {
  const r = await get('/api/fuel-purchases/2');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { id: 2, vehicleId: 2, plate: 'B-FL 2177', driver: "O'Neill, Sean", station: 'Shell "Autohof" Erfurt', purchasedAt: '2026-09-03T16:20:00.000Z', litres: '31.40', net: '52.50', vatRate: '19%' });
  const nf = await get('/api/fuel-purchases/99');
  assert.deepStrictEqual([nf.status, nf.body.error.code], [404, 'not_found']);
}));

test('REG2 monthly vehicle spend is unchanged', () => withApp(async (get) => {
  const a = await get('/api/vehicles/2/fuel-spend?month=2026-09');
  assert.deepStrictEqual(a.body, { vehicleId: 2, plate: 'B-FL 2177', month: '2026-09', purchases: 3, net: '115.50' });
  const b = await get('/api/vehicles/3/fuel-spend?month=2026-08');
  assert.deepStrictEqual(b.body, { vehicleId: 3, plate: 'B-FL 3310', month: '2026-08', purchases: 1, net: '96.30' });
  const c = await get('/api/vehicles/3/fuel-spend');
  assert.deepStrictEqual([c.status, c.body.error.code, c.body.error.fields], [422, 'validation_failed', ['month']]);
  const d = await get('/api/vehicles/9/fuel-spend?month=2026-09');
  assert.deepStrictEqual([d.status, d.body.error.code], [404, 'not_found']);
}));
