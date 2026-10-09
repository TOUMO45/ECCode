import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, startTestApp } from './app-fixture.js';

// Layout:  <base>/public/{index.html, css/app.css, .hidden, link-out -> ../outside, link-in -> css}
//          <base>/outside/secret.txt   and   <base>/secret.txt
function makeSite() {
  const base = tempDir('rs-static-');
  const pub = join(base, 'public');
  mkdirSync(join(pub, 'css'), { recursive: true });
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>home</title>');
  writeFileSync(join(pub, 'css', 'app.css'), 'body{margin:0}');
  writeFileSync(join(pub, '.hidden'), 'dotfile');
  writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET-ROOT');
  writeFileSync(join(base, 'outside', 'secret.txt'), 'TOP-SECRET-OUTSIDE');
  symlinkSync(join(base, 'outside'), join(pub, 'link-out'));
  symlinkSync(join(base, 'secret.txt'), join(pub, 'file-link-out.txt'));
  symlinkSync(join(pub, 'css'), join(pub, 'link-in'));
  return pub;
}

async function withSite(fn) {
  const publicDir = makeSite();
  const t = await startTestApp({ publicDir });
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test('static files are served with their type, no-cache and an ETag', async () => {
  await withSite(async (t) => {
    const home = await t.request({ path: '/' });
    assert.equal(home.status, 200);
    assert.match(home.text, /<title>home<\/title>/);
    assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(home.headers['cache-control'], 'no-cache');
    assert.ok(home.headers.etag);

    const css = await t.request({ path: '/css/app.css' });
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.text, 'body{margin:0}');
    // Static responses carry the app security headers (CSP, nosniff) but not no-store.
    assert.match(css.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
  });
});

test('static files answer 304 for a matching If-None-Match, and HEAD sends no body', async () => {
  await withSite(async (t) => {
    const first = await t.request({ path: '/css/app.css' });
    const again = await t.request({ path: '/css/app.css', headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    const head = await t.request({ method: 'HEAD', path: '/css/app.css' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], String(Buffer.byteLength('body{margin:0}')));
  });
});

test('T26: path traversal cannot leave public/ (dot segments, encodings, backslashes, NUL)', async () => {
  await withSite(async (t) => {
    const attempts = [
      '/../secret.txt',
      '/css/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/..%2fsecret.txt',
      '/..%2Fsecret.txt',
      '/css/..%2f..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..\\secret.txt',
      '/..%5csecret.txt',
      '/%00',
      '/index.html%00.png',
      '/....//secret.txt',
      '//secret.txt',
      '/css/%2e%2e/%2e%2e/secret.txt',
    ];
    for (const path of attempts) {
      const res = await t.request({ path });
      assert.ok(res.status === 404 || res.status === 400, `${path} -> ${res.status}`);
      assert.doesNotMatch(res.text, /TOP-SECRET/, path);
    }
  });
});

test('T26: a symbolic link inside public/ that points outside it is not followed', async () => {
  await withSite(async (t) => {
    for (const path of ['/link-out/secret.txt', '/file-link-out.txt', '/link-out/', '/link-out']) {
      const res = await t.request({ path });
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.text, /TOP-SECRET/, path);
    }
    // A link that stays inside public/ still works.
    const inside = await t.request({ path: '/link-in/app.css' });
    assert.equal(inside.status, 200);
    assert.equal(inside.text, 'body{margin:0}');
  });
});

test('dotfiles and directories without an index are not served', async () => {
  await withSite(async (t) => {
    assert.equal((await t.request({ path: '/.hidden' })).status, 404);
    assert.equal((await t.request({ path: '/css/' })).status, 404);
    assert.equal((await t.request({ path: '/css' })).status, 404);
    assert.equal((await t.request({ path: '/missing.js' })).status, 404);
  });
});

test('unknown static paths answer the JSON NOT_FOUND envelope, and POST to a static path is not served', async () => {
  await withSite(async (t) => {
    const miss = await t.request({ path: '/missing.js' });
    assert.equal(miss.json.error.code, 'NOT_FOUND');
    assert.ok(miss.json.error.requestId);
    const post = await t.request({ method: 'POST', path: '/index.html', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 404);
    assert.doesNotMatch(post.text, /<title>/);
  });
});

test('API paths are never served from public/, even if a file of that name exists', async () => {
  const base = tempDir('rs-static-');
  const pub = join(base, 'public');
  mkdirSync(join(pub, 'api'), { recursive: true });
  writeFileSync(join(pub, 'api', 'health'), 'static-impostor');
  const t = await startTestApp({ publicDir: pub });
  try {
    const res = await t.request({ path: '/api/health' });
    assert.equal(res.json.status, 'ok');
    const other = await t.request({ path: '/api/other' });
    assert.equal(other.status, 404);
    assert.doesNotMatch(other.text, /impostor/);
  } finally {
    await t.close();
  }
});

test('a missing public/ directory is a plain 404, not an error', async () => {
  const t = await startTestApp({ publicDir: join(tempDir('rs-static-'), 'does-not-exist') });
  try {
    const res = await t.request({ path: '/' });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  } finally {
    await t.close();
  }
});
