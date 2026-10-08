'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('the catalogue is a plain array with rates as decimal strings', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/items');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.length, 5);
    assert.deepStrictEqual(body[1], { id: 2, sku: 'HI-TE60', name: 'Hilti TE 60 Rotary Hammer', category: 'power-tools', dailyRate: '65.00', weeklyRate: '260.00', deposit: '250.00' });
  } finally {
    await app.close();
  }
});

test('a customer account shows its tax status', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/customers/2');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 2, name: 'Sunnyvale Public Schools', email: 'facilities@sunnyvale-schools.example', taxExempt: true });
  } finally {
    await app.close();
  }
});

test('a rental shows its dates and status', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/rentals/6');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      id: 6,
      customerId: 1,
      itemId: 2,
      sku: 'HI-TE60',
      item: 'Hilti TE 60 Rotary Hammer',
      startDate: '2026-03-05',
      dueDate: '2026-03-12',
      returnedOn: null,
      status: 'out',
    });
  } finally {
    await app.close();
  }
});

test('unknown rentals and customers are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const p of ['/api/rentals/99', '/api/customers/99']) {
      const { status, body } = await app.get(p);
      assert.strictEqual(status, 404);
      assert.strictEqual(body.error.code, 'not_found');
    }
  } finally {
    await app.close();
  }
});
