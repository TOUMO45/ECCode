'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');

async function start() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, user, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('a user creates, lists, reads and deletes their own note', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/notes', 'alice', { title: 'Plan', body: 'ship it' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.title, 'Plan');
    const list = await app.call('GET', '/notes', 'alice');
    assert.strictEqual(list.body.length, 1);
    const one = await app.call('GET', `/notes/${created.body.id}`, 'alice');
    assert.strictEqual(one.status, 200);
    const del = await app.call('DELETE', `/notes/${created.body.id}`, 'alice');
    assert.strictEqual(del.status, 204);
  } finally {
    await app.close();
  }
});

test('requests without X-User are rejected', async () => {
  const app = await start();
  try {
    const res = await app.call('GET', '/notes');
    assert.strictEqual(res.status, 401);
  } finally {
    await app.close();
  }
});
