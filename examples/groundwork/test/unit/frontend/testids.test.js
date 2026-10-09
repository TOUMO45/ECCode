import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockApi } from '../../support/mock-api.js';

const PUBLIC = path.resolve(import.meta.dirname, '../../../public');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const files = walk(PUBLIC);
const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const js = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// Spec 7.3. Templated ids appear in source as `statement-${id}` etc.
const STATIC_IDS = ['login-username', 'login-password', 'login-submit', 'incident-title', 'incident-severity', 'incident-started', 'incident-create',
  'notes-input', 'notes-import', 'provider-select', 'generate', 'edit-text', 'edit-cites', 'edit-save', 'publish', 'publish-note',
  'live-status', 'live-alert', 'signout', 'fallback-banner'];
const TEMPLATE_IDS = ['statement-', 'statement-flag-', 'chip-', 'source-line-', 'edit-', 'remove-'];

test('every static spec 7.3 data-testid exists in public/', () => {
  for (const id of STATIC_IDS) {
    assert.ok(all.includes(`data-testid="${id}"`) || js.includes(`testid: '${id}'`), `missing data-testid ${id}`);
  }
});

test('every templated spec 7.3 data-testid exists in public/ js', () => {
  for (const p of TEMPLATE_IDS) assert.ok(js.includes(`testid: \`${p}\${`), `missing templated data-testid ${p}<id>`);
});

test('index.html: no inline script/style/handlers, landmarks, skip link, live regions', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(attrs, /\bsrc=/);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  for (const re of [/<header\b/, /<nav\b/, /<main\b/, /class="skip-link"/, /role="status"/, /role="alert"/, /name="viewport"/]) assert.match(html, re);
});

test('client code never uses HTML-string sinks or eval', () => {
  assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(|\.style\.cssText|setAttribute\('style'/);
});

test('mock API serves the UI entry and speaks the login contract', async () => {
  const m = await startMockApi();
  try {
    assert.equal((await fetch(`${m.url}/`)).status, 200);
    assert.equal((await fetch(`${m.url}/app.js`)).status, 200);
    const bad = await fetch(`${m.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'mock-csrf' },
      body: JSON.stringify({ username: 'u', password: 'x' }),
    });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error.code, 'INVALID_CREDENTIALS');
  } finally { await m.close(); }
});
