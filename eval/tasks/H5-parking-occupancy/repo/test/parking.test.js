'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('occupancy of a lot', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/lots/3/occupancy');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { lotId: 3, name: 'Market Square', capacity: 12, occupied: 5, free: 7, full: false });
  } finally {
    await app.close();
  }
});

test('a car enters a lot with free spaces', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/lots/3/entries', { plate: 'ab12 cde' });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual([body.lotId, body.plate, body.exitedAt], [3, 'AB12 CDE', null]);
  } finally {
    await app.close();
  }
});

test('a full lot refuses entry with 409', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/lots/1/entries', { plate: 'AB12 CDE' });
    assert.strictEqual(status, 409);
    assert.strictEqual(body.error.code, 'conflict');
  } finally {
    await app.close();
  }
});

test('a car leaves', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/sessions/2/exit');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.plate, 'YK70 HHD');
    assert.ok(body.exitedAt);
  } finally {
    await app.close();
  }
});

test('invalid plates are rejected in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/lots/3/entries', { plate: '' });
    assert.strictEqual(status, 422);
    assert.deepStrictEqual(body.error.fields, ['plate']);
  } finally {
    await app.close();
  }
});
