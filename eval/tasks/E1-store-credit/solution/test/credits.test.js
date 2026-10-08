'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

const issue = (app, id, amount, headers) => app.post(`/api/customers/${id}/credits`, { amount, reason: 'Late delivery, order SO-88213' }, headers);

test('a credit is returned with 201 and added to the balance exactly', async () => {
  const app = await start();
  try {
    for (const amount of ['19.99', '19.99', '19.99']) assert.strictEqual((await issue(app, 4, amount)).status, 201);
    const r = await issue(app, 4, '0.3');
    assert.deepStrictEqual([r.status, r.body.amount, r.body.customerId], [201, '0.30', 4]);
    assert.strictEqual((await app.get('/api/customers/4')).body.creditBalance, '79.02');
  } finally {
    await app.close();
  }
});

test('invalid amounts are 422 and leave the balance alone', async () => {
  const app = await start();
  try {
    for (const amount of ['0.00', '500.01', '1.234', 'ten']) {
      const r = await issue(app, 2, amount);
      assert.deepStrictEqual([r.status, r.body.error.fields], [422, ['amount']], amount);
    }
    assert.strictEqual((await issue(app, 2, '500.00')).status, 201);
    assert.strictEqual((await app.get('/api/customers/2')).body.creditBalance, '625.40');
  } finally {
    await app.close();
  }
});

test('a retried request with the same Idempotency-Key issues the credit once', async () => {
  const app = await start();
  try {
    const h = { 'content-type': 'application/json', 'idempotency-key': 'console-42' };
    const first = await issue(app, 1, '10.00', h);
    const again = await issue(app, 1, '10.00', h);
    assert.deepStrictEqual([again.status, again.body], [first.status, first.body]);
    assert.strictEqual((await app.get('/api/customers/1')).body.creditBalance, '10.00');
  } finally {
    await app.close();
  }
});
