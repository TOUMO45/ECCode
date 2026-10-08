'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('the class list is a plain array', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/classes');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, [{ id: 1, code: '7A', year: 7 }, { id: 2, code: '7B', year: 7 }, { id: 3, code: '8A', year: 8 }]);
  } finally {
    await app.close();
  }
});

test('a class shows how many lessons it has a week', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/classes/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, code: '7A', year: 7, lessonsPerWeek: 9 });
  } finally {
    await app.close();
  }
});

test('teachers, rooms and the bell schedule can be read', async () => {
  const app = await start();
  try {
    const t = await app.get('/api/teachers/3');
    assert.deepStrictEqual(t.body, { id: 3, name: "O'Neill, Declan", subject: 'English' });
    const r = await app.get('/api/rooms/5');
    assert.deepStrictEqual(r.body, { id: 5, code: 'D2', kind: 'workshop' });
    const p = await app.get('/api/periods');
    assert.deepStrictEqual(p.body[2], { number: 3, start: '10:50', end: '11:40' });
    assert.strictEqual(p.body.length, 6);
  } finally {
    await app.close();
  }
});

test('unknown classes, teachers and rooms are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const p of ['/api/classes/99', '/api/teachers/99', '/api/rooms/99']) {
      const { status, body } = await app.get(p);
      assert.strictEqual(status, 404);
      assert.strictEqual(body.error.code, 'not_found');
    }
  } finally {
    await app.close();
  }
});
