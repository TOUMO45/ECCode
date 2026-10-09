import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startApp } from '../support/harness.js';
import { errorResponse } from '../../src/api/contract-schemas.js';
import { validate } from '../../src/lib/schema.js';
import { resolveStatic } from '../../src/routes/static.js';

let h; let tmp; let pub;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-static-'));
  pub = path.join(tmp, 'public');
  fs.mkdirSync(path.join(pub, 'js'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'empty'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>t</title><script src="/js/main.js"></script>');
  fs.writeFileSync(path.join(pub, 'js', 'main.js'), 'export {};');
  fs.writeFileSync(path.join(pub, '.secret.txt'), 'dotfile');
  fs.writeFileSync(path.join(pub, 'notes.exe'), 'bad ext');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'TOP-SECRET-OUTSIDE');
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(pub, 'link.txt'));
  h = await startApp({ publicDir: pub });
});
after(async () => { await h.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'x-request-id'];

function rawGet(p) {
  // node:http does not normalise the path, unlike fetch/URL
  return new Promise((resolve, reject) => {
    const u = new URL(h.url);
    http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    }).on('error', reject);
  });
}

test('index.html is served at / with security headers and a strict CSP', async () => {
  const r = await h.anon().get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  for (const k of HEADERS) assert.ok(r.headers.get(k), k);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

test('security headers are also on API responses, 404s and errors', async () => {
  for (const p of ['/api/health', '/api/nope', '/nope.html']) {
    const r = await h.anon().get(p);
    for (const k of HEADERS) assert.ok(r.headers.get(k), `${p} ${k}`);
  }
});

test('js assets get the right content type; HEAD has no body', async () => {
  const r = await h.anon().get('/js/main.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/javascript/);
  const hd = await h.anon().request('HEAD', '/js/main.js');
  assert.equal(hd.status, 200);
  assert.equal(hd.text, '');
});

test('traversal attempts return the 404 envelope and never file contents', async () => {
  const attempts = ['/..%2f..%2foutside.txt', '/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt', '/..%5coutside.txt', '/js/../../outside.txt',
    '/../outside.txt', '/%252e%252e/outside.txt', '/..%2f', '/%2e%2e/', '/js/%2e%2e/%2e%2e/outside.txt', '/%00', '/index.html%00.png',
    '/.secret.txt', '/%2esecret.txt', '/js/.%2e/x.txt', '/%ZZ', '/notes.exe', '/empty/', '/empty', '/js/', '/link.txt'];
  for (const p of attempts) {
    const r = await rawGet(p);
    assert.ok(!r.body.includes('TOP-SECRET-OUTSIDE') && !r.body.includes('dotfile') && !r.body.includes('bad ext'), p);
    assert.equal(r.status, 404, p);
    const j = JSON.parse(r.body);
    assert.deepEqual(validate(errorResponse, j).errors, [], p);
    assert.equal(j.error.code, 'NOT_FOUND');
    assert.equal(j.error.requestId, r.headers['x-request-id']);
  }
});

test('resolveStatic unit: stays under root', () => {
  const root = path.resolve(pub);
  assert.equal(resolveStatic(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStatic(root, '/js/main.js'), path.join(root, 'js', 'main.js'));
  assert.equal(resolveStatic(root, '/a/../../x.js'), null);
  assert.equal(resolveStatic(root, '/a\\b.js'), null);
  assert.equal(resolveStatic(root, '/%'), null);
});

test('non-GET on static paths is 405 with Allow', async () => {
  const r = await h.anon().request('POST', '/', { body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET, HEAD');
  assert.equal(r.json.error.code, 'METHOD_NOT_ALLOWED');
});

test('missing public dir yields 404 envelope, not a crash', async () => {
  const s = await startApp({ publicDir: path.join(tmp, 'does-not-exist') });
  try {
    const r = await s.anon().get('/');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'NOT_FOUND');
  } finally { await s.close(); }
});

test('the real public/index.html (when present) has no inline script', async (t) => {
  const real = path.join(path.dirname(path.dirname(import.meta.dirname)), 'public', 'index.html');
  if (!fs.existsSync(real)) return t.skip('public/index.html not built yet (frontend task)');
  const html = fs.readFileSync(real, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc=/, 'script must be external');
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});
