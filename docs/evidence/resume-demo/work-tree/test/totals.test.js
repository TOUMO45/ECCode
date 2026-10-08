'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

const EXPECTED = {
  1: { subtotal: '50.00', discount: '0.00', shipping: '0.00', total: '50.00' },
  2: { subtotal: '120.00', discount: '0.00', shipping: '15.00', total: '135.00' },
  3: { subtotal: '2.01', discount: '1.01', shipping: '0.00', total: '1.00' },
  4: { subtotal: '60.47', discount: '6.05', shipping: '4.99', total: '59.41' },
};

async function withApp(fn) {
  const app = await start();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test('detail totals are exact for every fixture invoice', () =>
  withApp(async (app) => {
    for (const [id, want] of Object.entries(EXPECTED)) {
      const { status, body } = await app.get('/api/invoices/' + id);
      assert.strictEqual(status, 200);
      const { subtotal, discount, shipping, total } = body;
      assert.deepStrictEqual({ subtotal, discount, shipping, total }, want, 'invoice ' + id);
      for (const l of body.lines) {
        assert.match(l.unitPrice, /^\d+\.\d{2}$/);
        assert.match(l.lineTotal, /^\d+\.\d{2}$/);
      }
    }
  }));

test('list totals are exact', () =>
  withApp(async (app) => {
    const { body } = await app.get('/api/invoices');
    assert.deepStrictEqual(body.map((i) => i.total), ['50.00', '135.00', '1.00', '59.41']);
  }));

test('CSV equals JSON (lines and TOTAL) for every invoice', () =>
  withApp(async (app) => {
    for (const id of Object.keys(EXPECTED)) {
      const json = (await app.get('/api/invoices/' + id)).body;
      const csv = (await app.get('/api/invoices/' + id + '/export.csv')).body.trim().split('\n');
      const expectedRows = json.lines.map((l) => [l.description, l.unitPrice, l.quantity, l.lineTotal].join(','));
      assert.deepStrictEqual(csv.slice(1, -1), expectedRows, 'invoice ' + id);
      assert.strictEqual(csv[csv.length - 1], 'TOTAL,,,' + json.total, 'invoice ' + id);
    }
  }));
