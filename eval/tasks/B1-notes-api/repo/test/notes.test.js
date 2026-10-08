'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('fetches a note by id', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/notes/2');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.title, 'On-call handover: payments');
    assert.deepStrictEqual(body.tags, ['oncall', 'payments']);
    assert.strictEqual(body.createdAt, '2026-08-02T16:40:00.000Z');
  } finally {
    await app.close();
  }
});

test('unknown note is a 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/notes/404');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('tag cloud counts notes per tag', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/tags');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0], { tag: 'billing', count: 3 });
    assert.deepStrictEqual(body.map((t) => t.tag), ['billing', 'docs', 'incident', 'oncall', 'payments', 'planning', 'release', 'support']);
  } finally {
    await app.close();
  }
});
