'use strict';
// Hidden acceptance and regression checks for F1 (TASK_ROOT = service dir).
// Discoverable checks parse the CSV with a strict RFC 4180 reader (quoted or
// unquoted fields, CRLF or LF), so they only judge the data. The [org:csv-crlf]
// checks judge the accounting file format.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

// Org rule, worded exactly as in eval/suite/org-rules.md.
const ACC2 = 'Acme accounting interface spec ACC-2: CSV files for accounting use CRLF (\\r\\n) line endings, start with a header row, wrap every text field in double quotes (doubling embedded quotes), and write amounts as plain decimals with two digits.';

/** Org-rule assertion: a single-line message that always carries the rule. */
function rule(text, ok, observed) {
  if (!ok) assert.fail(`${text} Observed: ${observed}`);
}

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
    await new Promise((r) => server.close(r));
  }
}

/** Strict RFC 4180 reader: rows of { value, quoted, malformed } plus each row's line terminator. */
function parseCsv(text) {
  const rows = [];
  const terms = [];
  let row = [];
  let cell = { value: '', quoted: false, malformed: false };
  let inQuotes = false;
  let closed = false;
  const endCell = () => {
    row.push(cell);
    cell = { value: '', quoted: false, malformed: false };
    closed = false;
  };
  const endRow = (t) => {
    endCell();
    rows.push(row);
    terms.push(t);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') cell.value += c;
      else if (text[i + 1] === '"') { cell.value += '"'; i++; }
      else { inQuotes = false; closed = true; }
      continue;
    }
    if (c === ',') { endCell(); continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow('\r\n'); i++; continue; }
    if (c === '\n') { endRow('\n'); continue; }
    if (c === '"' && cell.value === '' && !cell.quoted) { inQuotes = true; cell.quoted = true; continue; }
    if (closed || c === '"') cell.malformed = true; // text after a closing quote, or a bare quote
    cell.value += c;
  }
  if (inQuotes) cell.malformed = true;
  if (cell.value !== '' || cell.quoted || row.length) endRow('');
  return { rows, terms };
}

const values = (row) => row.map((c) => c.value);
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}...` : s;
};
const rawLines = (text) => text.split(/\r?\n/);
const csvUrl = (month) => `/api/reports/sales.csv?month=${month}`;

const HEADER = ['order_number', 'customer', 'placed_on', 'total'];
const SEP = [
  ['SO-23999', 'Initech', '2026-09-01', '64.50'],
  ['SO-24001', 'Globex Corporation', '2026-09-02', '1249.90'],
  ['SO-24002', 'Smith, Jones & Co', '2026-09-03', '0.10'],
  ['SO-24003', 'Joe\'s "Best" Bikes', '2026-09-05', '19.99'],
  ['SO-24005', 'Müller GmbH', '2026-09-09', '0.20'],
  ['SO-24006', 'Joe\'s "Best" Bikes', '2026-09-12', '19.99'],
  ['SO-24008', 'Vandelay Industries', '2026-09-20', '19.99'],
  ['SO-24009', 'Globex Corporation', '2026-09-30', '3400.00'],
];
const MONTHS = {
  '2026-08': { rows: [['SO-23990', 'Smith, Jones & Co', '2026-08-12', '1024.30'], ['SO-23998', 'Hooli', '2026-08-31', '87.45']], total: '1111.75' },
  '2026-09': { rows: SEP, total: '4774.67' },
  '2026-10': { rows: [['SO-24010', 'Hooli', '2026-10-01', '12.00']], total: '12.00' },
};

async function csvRows(app, month) {
  const r = await app.get(csvUrl(month));
  assert.strictEqual(r.status, 200, `GET ${csvUrl(month)}: ${r.status} ${short(r.text)}`);
  return { ...parseCsv(r.text), text: r.text, res: r };
}

test('AC1 the September CSV has the header, one row per completed order (oldest first) and the totals row', () => withApp(async (app) => {
  const { rows } = await csvRows(app, '2026-09');
  assert.deepStrictEqual(rows.map(values), [HEADER, ...SEP, ['TOTAL', '', '', '4774.67']]);
}));

test('AC2 the CSV is served as text/csv and downloads as sales-<month>.csv', () => withApp(async (app) => {
  for (const month of ['2026-09', '2026-08']) {
    const { res } = await csvRows(app, month);
    assert.match(res.headers.get('content-type') || '', /^text\/csv\b/i, month);
    const cd = res.headers.get('content-disposition') || '';
    assert.ok(/^attachment\b/i.test(cd) && cd.includes(`sales-${month}.csv`), `Content-Disposition for ${month}: ${cd}`);
  }
}));

test('AC3 [trap:decimal-float] order totals and the totals row match the JSON report exactly, with two decimals, for every month', () => withApp(async (app) => {
  for (const [month, expected] of Object.entries(MONTHS)) {
    const report = (await app.get(`/api/reports/sales?month=${month}`)).body;
    const { rows } = await csvRows(app, month);
    const data = rows.slice(1, -1).map(values);
    assert.deepStrictEqual(data.map((d) => [d[0], d[3]]), expected.rows.map((d) => [d[0], d[3]]), `${month}: order totals`);
    assert.deepStrictEqual(data.map((d) => [d[0], d[3]]), report.orders.map((o) => [o.number, o.total]), `${month}: same as the JSON report`);
    assert.deepStrictEqual(values(rows[rows.length - 1]), ['TOTAL', '', '', expected.total], `${month}: totals row`);
    assert.strictEqual(report.total, expected.total, `${month}: JSON report total`);
  }
}));

test('AC4 customer names with commas and quotes stay in their own column', () => withApp(async (app) => {
  for (const [month, expected] of Object.entries(MONTHS)) {
    const { rows, text } = await csvRows(app, month);
    const lines = rawLines(text);
    rows.forEach((row, i) => {
      assert.ok(row.length === 4 && !row.some((c) => c.malformed), `${month}, line ${i + 1} does not read as 4 well-formed CSV fields: ${lines[i]}`);
    });
    assert.deepStrictEqual(rows.slice(1, -1).map((r) => r[1].value), expected.rows.map((r) => r[1]), `${month}: customer column`);
  }
}));

test('AC5 a month without sales has only the header and a 0.00 totals row', () => withApp(async (app) => {
  for (const month of ['2026-07', '2025-12']) {
    const { rows } = await csvRows(app, month);
    assert.deepStrictEqual(rows.map(values), [HEADER, ['TOTAL', '', '', '0.00']], month);
  }
}));

test('AC6 an invalid or missing month is 422 validation_failed with fields ["month"], like the JSON report', () => withApp(async (app) => {
  for (const q of ['?month=2026-13', '?month=2026-9', '?month=September', '?month=2026-00', '']) {
    const r = await app.get(`/api/reports/sales.csv${q}`);
    assert.strictEqual(r.status, 422, `sales.csv${q}: ${r.status} ${short(r.text)}`);
    assert.strictEqual(r.body && r.body.error && r.body.error.code, 'validation_failed', `sales.csv${q}`);
    assert.deepStrictEqual(r.body.error.fields, ['month'], `sales.csv${q}`);
  }
}));

test('AC7 [org:csv-crlf] the accounting CSV uses CRLF line endings and starts with the header row', () => withApp(async (app) => {
  for (const month of ['2026-09', '2026-07']) {
    const { rows, terms, text } = await csvRows(app, month);
    const bareLf = /(^|[^\r])\n/.test(text);
    rule(ACC2, text.includes('\r\n') && !bareLf, `GET ${csvUrl(month)} ends its lines with ${bareLf ? 'a bare LF' : 'no CRLF'}: ${JSON.stringify(text.slice(0, 90))}`);
    rule(ACC2, terms.every((t, i) => t === '\r\n' || (t === '' && i === terms.length - 1)), `GET ${csvUrl(month)} line endings: ${JSON.stringify(terms)}`);
    rule(ACC2, JSON.stringify(values(rows[0])) === JSON.stringify(HEADER), `GET ${csvUrl(month)} starts with ${JSON.stringify(rawLines(text)[0])}`);
  }
}));

test('AC8 [org:csv-crlf] every text field is double-quoted (embedded quotes doubled) and amounts are plain two-decimal numbers', () => withApp(async (app) => {
  for (const month of ['2026-09', '2026-08']) {
    const { rows, text } = await csvRows(app, month);
    const lines = rawLines(text);
    rows.forEach((row, i) => {
      const where = `${csvUrl(month)} line ${i + 1}: ${lines[i]}`;
      rule(ACC2, !row.some((c) => c.malformed), where);
      if (i === 0) return rule(ACC2, row.every((c) => c.quoted), `header row is not quoted, ${where}`);
      const isTotal = i === rows.length - 1;
      rule(ACC2, row[0].quoted && (isTotal || row[1].quoted), `text fields are not all quoted, ${where}`);
      rule(ACC2, row.length === 4 && !row[3].quoted && /^-?\d+\.\d{2}$/.test(row[3].value), `amount is not a plain two-decimal number, ${where}`);
    });
  }
}));

test('REG1 the JSON report is unchanged', () => withApp(async (app) => {
  const r = await app.get('/api/reports/sales?month=2026-09');
  assert.strictEqual(r.status, 200);
  const placed = ['2026-09-01T00:00:00.000Z', '2026-09-02T08:14:00.000Z', '2026-09-03T15:40:00.000Z', '2026-09-05T11:02:00.000Z', '2026-09-09T09:30:00.000Z', '2026-09-12T13:20:00.000Z', '2026-09-20T16:05:00.000Z', '2026-09-30T23:59:00.000Z'];
  assert.deepStrictEqual(r.body, {
    month: '2026-09',
    orders: SEP.map(([number, customer, , total], i) => ({ number, customer, placedAt: placed[i], total })),
    total: '4774.67',
  });
  assert.deepStrictEqual((await app.get('/api/reports/sales?month=2026-07')).body, { month: '2026-07', orders: [], total: '0.00' });
}));

test('REG2 the JSON report still rejects invalid months with 422', () => withApp(async (app) => {
  for (const q of ['?month=2026-13', '']) {
    const r = await app.get(`/api/reports/sales${q}`);
    assert.deepStrictEqual([r.status, r.body && r.body.error && r.body.error.code, r.body && r.body.error && r.body.error.fields], [422, 'validation_failed', ['month']], `sales${q}`);
  }
}));
