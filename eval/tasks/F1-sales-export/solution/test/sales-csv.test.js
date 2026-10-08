'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('CSV export has quoted text fields, CRLF lines and a totals row', async () => {
  const app = await start();
  try {
    const r = await app.get('/api/reports/sales.csv?month=2026-08');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.strictEqual(r.headers.get('content-disposition'), 'attachment; filename="sales-2026-08.csv"');
    assert.strictEqual(
      r.text,
      '"order_number","customer","placed_on","total"\r\n' +
        '"SO-23990","Smith, Jones & Co","2026-08-12",1024.30\r\n' +
        '"SO-23998","Hooli","2026-08-31",87.45\r\n' +
        '"TOTAL","","",1111.75\r\n',
    );
  } finally {
    await app.close();
  }
});

test('embedded quotes are doubled', async () => {
  const app = await start();
  try {
    const r = await app.get('/api/reports/sales.csv?month=2026-09');
    assert.ok(r.text.includes('"SO-24003","Joe\'s ""Best"" Bikes","2026-09-05",19.99\r\n'));
    assert.ok(r.text.endsWith('"TOTAL","","",4774.67\r\n'));
  } finally {
    await app.close();
  }
});

test('a month without sales has only the header and a zero total', async () => {
  const app = await start();
  try {
    const r = await app.get('/api/reports/sales.csv?month=2026-07');
    assert.strictEqual(r.text, '"order_number","customer","placed_on","total"\r\n"TOTAL","","",0.00\r\n');
    const bad = await app.get('/api/reports/sales.csv?month=July');
    assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['month']]);
  } finally {
    await app.close();
  }
});
