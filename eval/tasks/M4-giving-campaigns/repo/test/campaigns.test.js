'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('the campaign list is a plain array', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/campaigns');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.map((c) => [c.id, c.slug, c.status, c.goal]), [
      [1, 'river-cleanup', 'live', '5000.00'],
      [2, 'library-roof', 'live', '20000.00'],
      [3, 'winter-coats', 'closed', '1500.00'],
      [4, 'community-garden', 'draft', '2500.00'],
      [5, 'youth-kit', 'live', '3000.00'],
    ]);
  } finally {
    await app.close();
  }
});

test('a campaign shows its goal, dates and number of donors', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/campaigns/3');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.title, 'Winter Coats Drive');
    assert.strictEqual(body.goal, '1500.00');
    assert.strictEqual(body.endsOn, '2026-01-31');
    assert.strictEqual(body.donorCount, 4);
  } finally {
    await app.close();
  }
});

test('a campaign without donations has nothing raised', async () => {
  const app = await start();
  try {
    const { body } = await app.get('/api/campaigns/4');
    assert.strictEqual(body.raised, '0.00');
    assert.strictEqual(body.percent, 0);
  } finally {
    await app.close();
  }
});

test('unknown campaigns are a 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/campaigns/99');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
