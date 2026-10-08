'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');

async function withServer(fn, opts) {
  const server = createApp(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = async (method, path, user, payload) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-user'] = user;
    const res = await fetch(base + path, { method, headers, body: payload });
    return { status: res.status, text: await res.text() };
  };
  try {
    await fn(req);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const note = JSON.stringify({ title: 'secret', body: 'x' });

test('F1: another user cannot read or delete a note (404, note survives)', async () => {
  await withServer(async (req) => {
    const c = JSON.parse((await req('POST', '/notes', 'alice', note)).text);
    const get = await req('GET', '/notes/' + c.id, 'mallory');
    assert.strictEqual(get.status, 404);
    assert.ok(!get.text.includes('secret'));
    assert.strictEqual((await req('DELETE', '/notes/' + c.id, 'mallory')).status, 404);
    assert.strictEqual((await req('GET', '/notes/' + c.id, 'alice')).status, 200);
    assert.deepStrictEqual(JSON.parse((await req('GET', '/notes', 'mallory')).text), []);
  });
});

test('F2: malformed JSON gives 400 without stack traces', async () => {
  await withServer(async (req) => {
    const r = await req('POST', '/notes', 'alice', '{not json');
    assert.strictEqual(r.status, 400);
    assert.ok(!/SyntaxError|\.js|\bat /.test(r.text), r.text);
  });
});

test('F2: invalid field types give 400 validation_error', async () => {
  await withServer(async (req) => {
    for (const p of ['null', '[]', '{"title":1,"body":"x"}', '{"title":"t","body":{}}', '{"title":"","body":"x"}', '{"title":"t"}']) {
      const r = await req('POST', '/notes', 'alice', p);
      assert.strictEqual(r.status, 400, p);
      assert.strictEqual(JSON.parse(r.text).error.code, 'validation_error', p);
    }
  });
});

test('F2: unexpected errors return a generic 500 with no stack', async () => {
  const store = {
    create() { throw new Error('boom /secret/path.js'); },
    listByOwner() { return []; },
    get() { return null; },
    remove() {},
  };
  const orig = console.error;
  console.error = () => {};
  try {
    await withServer(async (req) => {
      const r = await req('POST', '/notes', 'a', note);
      assert.strictEqual(r.status, 500);
      assert.ok(!r.text.includes('boom') && !r.text.includes('.js'), r.text);
      assert.strictEqual(JSON.parse(r.text).error.code, 'internal_error');
    }, { store });
  } finally {
    console.error = orig;
  }
});

test('F3: oversized body is rejected', async () => {
  await withServer(async (req) => {
    const big = JSON.stringify({ title: 't', body: 'x'.repeat(1024 * 1024 + 10) });
    let r;
    try {
      r = await req('POST', '/notes', 'a', big);
    } catch (e) {
      return; // server closing the connection is also a rejection
    }
    assert.strictEqual(r.status, 413);
  });
});
