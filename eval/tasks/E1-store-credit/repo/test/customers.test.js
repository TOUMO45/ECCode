'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('shows a customer with their credit balance', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/customers/2');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 2, name: 'Okafor Hardware Ltd', creditBalance: '125.40' });
  } finally {
    await app.close();
  }
});

test('a customer without credit has a zero balance', async () => {
  const app = await start();
  try {
    const { body } = await app.get('/api/customers/1');
    assert.strictEqual(body.creditBalance, '0.00');
  } finally {
    await app.close();
  }
});

test('unknown customer is a 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/customers/404');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
