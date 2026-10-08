'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('a technician sees a work order at their site', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/work-orders/1', 'dana.ruiz');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, siteId: 1, site: 'Riverside Campus', title: 'Replace chiller pump seal', status: 'open', priority: 'high', openedAt: '2026-10-01T07:12:00.000Z' });
  } finally {
    await app.close();
  }
});

test('work orders at other sites are not found', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/work-orders/2', 'dana.ruiz');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('a supervisor sees the cost breakdown', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/work-orders/1/costs', 'priya.shah');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.total, '446.05');
  } finally {
    await app.close();
  }
});

test('a technician may not see costs', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/work-orders/1/costs', 'dana.ruiz');
    assert.strictEqual(status, 403);
    assert.strictEqual(body.error.code, 'forbidden');
  } finally {
    await app.close();
  }
});

test('requests without a user are 401', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/work-orders/1');
    assert.strictEqual(status, 401);
    assert.strictEqual(body.error.code, 'unauthorized');
  } finally {
    await app.close();
  }
});

test('the current user with role and sites', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/me', 'priya.shah');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { username: 'priya.shah', name: 'Priya Shah', role: 'supervisor', sites: [{ id: 1, name: 'Riverside Campus' }, { id: 2, name: 'Northgate Depot' }] });
  } finally {
    await app.close();
  }
});
