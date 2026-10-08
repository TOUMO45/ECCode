'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const { loadDb } = require('../src/db');

test('lists notes newest first with the collection envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/notes');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.total, 7);
    assert.deepStrictEqual(body.items.map((n) => n.id), [6, 3, 7, 2, 1, 4, 5]);
    const tagged = await app.get('/api/notes?tag=billing&limit=2');
    assert.deepStrictEqual([tagged.body.items.map((n) => n.id), tagged.body.total], [[3, 7], 3]);
    const bad = await app.get('/api/notes?limit=101');
    assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['limit']]);
  } finally {
    await app.close();
  }
});

test('creates a note, audits it and lists it first', async () => {
  const db = loadDb();
  const app = await start({ db });
  try {
    const created = await app.post('/api/notes', { title: '  Weekly sync ', tags: ['meetings'] }, { 'content-type': 'application/json', 'x-acme-actor': 'priya.n' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.title, 'Weekly sync');
    assert.deepStrictEqual((await app.get(`/api/notes/${created.body.id}`)).body, created.body);
    assert.strictEqual((await app.get('/api/notes')).body.items[0].id, created.body.id);
    const audit = db.all('audit_log');
    assert.deepStrictEqual(audit.map((a) => [a.actor, a.action, a.entity, a.entity_id]), [['priya.n', 'create', 'notes', created.body.id]]);
  } finally {
    await app.close();
  }
});

test('invalid notes are rejected with 422 and nothing is saved', async () => {
  const db = loadDb();
  const app = await start({ db });
  try {
    const r = await app.post('/api/notes', { title: ' ', tags: 'billing' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.error.code, 'validation_failed');
    assert.deepStrictEqual(r.body.error.fields, ['title', 'tags']);
    assert.strictEqual(db.all('notes').length, 7);
    assert.strictEqual(db.all('audit_log').length, 0);
  } finally {
    await app.close();
  }
});
