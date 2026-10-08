'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('payment without refunds is fully refundable', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/payments/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, orderRef: 'ORD-501', currency: 'USD', amount: '100.00', refunded: '0.00', refundable: '100.00' });
  } finally {
    await app.close();
  }
});

test('a small refund is accepted', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/payments/1/refunds', { amount: '10.00' });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.amount, '10.00');
  } finally {
    await app.close();
  }
});

test('malformed amounts are rejected in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/payments/1/refunds', { amount: 'ten' });
    assert.strictEqual(status, 422);
    assert.deepStrictEqual(body.error.fields, ['amount']);
  } finally {
    await app.close();
  }
});

test('unknown payment is a 404', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/payments/77');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
