'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('invoice without shipping or discount has correct totals', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/invoices/1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.number, 'INV-1041');
    assert.strictEqual(body.lines[0].lineTotal, '50.00');
    assert.strictEqual(body.total, '50.00');
  } finally {
    await app.close();
  }
});

test('lists all invoices', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/invoices');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.map((i) => i.number), ['INV-1041', 'INV-1042', 'INV-1043', 'INV-1044']);
  } finally {
    await app.close();
  }
});

test('unknown invoice is a 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/invoices/99');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('CSV export has a header and a TOTAL row', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/invoices/1/export.csv');
    assert.strictEqual(status, 200);
    const lines = body.trim().split('\n');
    assert.strictEqual(lines[0], 'description,unit_price,quantity,line_total');
    assert.strictEqual(lines[lines.length - 1], 'TOTAL,,,50.00');
  } finally {
    await app.close();
  }
});
