'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('monthly report lists completed orders oldest first with the total', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/reports/sales?month=2026-09');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.month, '2026-09');
    assert.strictEqual(body.orders.length, 8);
    assert.deepStrictEqual(body.orders[0], { number: 'SO-23999', customer: 'Initech', placedAt: '2026-09-01T00:00:00.000Z', total: '64.50' });
    assert.strictEqual(body.total, '4774.67');
  } finally {
    await app.close();
  }
});

test('orders belong to the UTC month they were placed in', async () => {
  const app = await start();
  try {
    const { body } = await app.get('/api/reports/sales?month=2026-08');
    assert.deepStrictEqual(body.orders.map((o) => o.number), ['SO-23990', 'SO-23998']);
    assert.strictEqual(body.total, '1111.75');
  } finally {
    await app.close();
  }
});

test('invalid month is a 422 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/reports/sales?month=2026-13');
    assert.strictEqual(status, 422);
    assert.deepStrictEqual(body.error.fields, ['month']);
  } finally {
    await app.close();
  }
});
