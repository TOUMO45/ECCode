'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('courier balance is earnings minus payouts', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/couriers/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, name: 'Amara Okafor', city: 'Leeds', balance: '30.00' });
  } finally {
    await app.close();
  }
});

test('a weekly payout', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/payouts/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, courierId: 1, kind: 'weekly', amount: '38.00', fee: '0.00', net: '38.00', createdAt: '2026-09-28T02:00:00.000Z' });
  } finally {
    await app.close();
  }
});

test('unknown courier and payout are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const p of ['/api/couriers/42', '/api/payouts/42']) {
      const { status, body } = await app.get(p);
      assert.strictEqual(status, 404, p);
      assert.strictEqual(body.error.code, 'not_found', p);
    }
  } finally {
    await app.close();
  }
});
