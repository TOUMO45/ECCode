'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('the catalogue lists every title with copy counts', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/books');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.length, 6);
    assert.deepStrictEqual(body[1], { id: 2, title: 'Piranesi', author: 'Susanna Clarke', media: 'book', copies: 3, available: 2 });
  } finally {
    await app.close();
  }
});

test('a member shows their open loans', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/members/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 1, name: 'Marguerite Okafor', cardNo: 'L-1001', tier: 'adult', openLoans: 2 });
  } finally {
    await app.close();
  }
});

test('checking out a free copy creates a loan', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/loans', { memberId: 2, copyId: 13 });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.memberId, 2);
    assert.strictEqual(body.copyId, 13);
    assert.strictEqual(body.bookId, 5);
    assert.strictEqual(body.checkedOutOn, '2026-03-10');
    assert.strictEqual(body.returnedOn, null);
    assert.strictEqual(body.renewals, 0);
  } finally {
    await app.close();
  }
});

test('a copy that is already out cannot be checked out again', async () => {
  const app = await start();
  try {
    const { status, body } = await app.post('/api/loans', { memberId: 1, copyId: 1 });
    assert.strictEqual(status, 409);
    assert.strictEqual(body.error.code, 'conflict');
  } finally {
    await app.close();
  }
});

test('bad checkout requests use the Acme error envelope', async () => {
  const app = await start();
  try {
    const a = await app.post('/api/loans', { memberId: 'one', copyId: 9 });
    assert.strictEqual(a.status, 422);
    assert.deepStrictEqual(a.body.error.fields, ['memberId']);
    const b = await app.post('/api/loans', { memberId: 99, copyId: 9 });
    assert.strictEqual(b.status, 404);
    assert.strictEqual(b.body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
