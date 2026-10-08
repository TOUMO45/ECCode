'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('the plan list is a plain array', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/plans');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.map((p) => [p.code, p.pricePerSeat, p.seatLimit]), [['starter', '9.00', 5], ['team', '24.99', 25], ['business', '49.50', 200]]);
  } finally {
    await app.close();
  }
});

test('a subscription shows its plan, cycle and balances', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/subscriptions/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      id: 1,
      account: { id: 1, name: 'Brightwater Studio' },
      plan: { code: 'team', name: 'Team', pricePerSeat: '24.99' },
      seats: 8,
      status: 'active',
      cycleStart: '2026-03-01',
      cycleEnd: '2026-04-01',
      daysLeft: 20,
      monthlyCost: '199.92',
      creditBalance: '0.00',
      pendingCharge: '0.00',
    });
  } finally {
    await app.close();
  }
});

test('days left are counted in the account time zone', async () => {
  const app = await start();
  try {
    const { body } = await app.get('/api/subscriptions/2');
    assert.strictEqual(body.daysLeft, 7);
  } finally {
    await app.close();
  }
});

test('unknown subscriptions are a 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/subscriptions/99');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
