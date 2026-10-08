'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('an event counts its valid tickets', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/events/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, name: 'Harbourfront Jazz Night', venue: 'Pier 4 Hall', startsAt: '2026-11-14T19:30:00.000Z', ticketsSold: 7 });
  } finally {
    await app.close();
  }
});

test('a ticket by code', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/tickets/VIP-0007');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { code: 'VIP-0007', eventId: 1, holderName: 'Okafor, Chidi', tier: 'vip', status: 'valid', checkedIn: true, price: '120.00' });
  } finally {
    await app.close();
  }
});

test('unknown event and ticket are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const p of ['/api/events/42', '/api/tickets/GA-9999']) {
      const { status, body } = await app.get(p);
      assert.strictEqual(status, 404, p);
      assert.strictEqual(body.error.code, 'not_found', p);
    }
  } finally {
    await app.close();
  }
});
