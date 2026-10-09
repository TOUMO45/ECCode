import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD, Client } from '../support/harness.js';

let h;
before(async () => { h = await startApp(); });
after(async () => { await h.close(); });

const code = (r) => r.json?.error?.code;

test('state-changing request without a token is 403 CSRF_FAILED', async () => {
  const c = await h.client('aLead');
  const r = await c.post('/api/users', { username: 'q1', displayName: 'Q', password: 'a-long-password', role: 'viewer' }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(code(r), 'CSRF_FAILED');
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM users WHERE username='q1'").get().c, 0);
});

test('header must equal cookie; cookie alone or header alone fails', async () => {
  const c = await h.client('aLead');
  const body = { username: 'q2', displayName: 'Q', password: 'a-long-password', role: 'viewer' };
  assert.equal(code(await c.post('/api/users', body, { csrf: 'something-else' })), 'CSRF_FAILED');
  const cookieOnly = await c.post('/api/users', body, { csrf: false, headers: {} });
  assert.equal(code(cookieOnly), 'CSRF_FAILED');
  const headerOnly = new Client(h.url);
  headerOnly.jar.set('gw_sid', c.jar.get('gw_sid'));
  const r = await headerOnly.post('/api/users', body, { csrf: c.csrfToken });
  assert.equal(code(r), 'CSRF_FAILED');
});

test('a token from another session (or a pre-login token) does not work on an authenticated route', async () => {
  const a = await h.client('aLead');
  const b = await h.client('bLead');
  const body = { username: 'q3', displayName: 'Q', password: 'a-long-password', role: 'viewer' };
  // attacker sets both cookie and header to their own valid session token
  const forged = new Client(h.url);
  forged.jar.set('gw_sid', a.jar.get('gw_sid'));
  forged.jar.set('gw_csrf', b.csrfToken);
  assert.equal(code(await forged.post('/api/users', body, { csrf: b.csrfToken })), 'CSRF_FAILED');

  const pre = await h.anon().primeCsrf();
  const forged2 = new Client(h.url);
  forged2.jar.set('gw_sid', a.jar.get('gw_sid'));
  forged2.jar.set('gw_csrf', pre.json.csrfToken);
  assert.equal(code(await forged2.post('/api/users', body, { csrf: pre.json.csrfToken })), 'CSRF_FAILED');
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM users WHERE username='q3'").get().c, 0);
});

test('Origin mismatch is rejected even with a valid token; matching or absent Origin passes', async () => {
  const c = await h.client('aLead');
  const body = { username: 'q4', displayName: 'Q', password: 'a-long-password', role: 'viewer' };
  const bad = await c.post('/api/users', body, { headers: { origin: 'http://evil.example' } });
  assert.equal(code(bad), 'CSRF_FAILED');
  const nul = await c.post('/api/users', body, { headers: { origin: 'null' } });
  assert.equal(code(nul), 'CSRF_FAILED');
  const good = await c.post('/api/users', body, { headers: { origin: h.url } });
  assert.equal(good.status, 201);
  const none = await c.post('/api/users', { ...body, username: 'q5' });
  assert.equal(none.status, 201);
});

test('login requires the pre-login token', async () => {
  const c = h.anon();
  assert.equal(code(await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD }, { csrf: false })), 'CSRF_FAILED');
  await c.primeCsrf();
  assert.equal(code(await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD }, { csrf: 'AAAA.BBBB' })), 'CSRF_FAILED');
  // forged token with a valid shape but wrong MAC, also set as cookie
  c.jar.set('gw_csrf', 'AAAAAAAAAAAAAAAAAAAAAA.BBBB');
  assert.equal(code(await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD }, { csrf: 'AAAAAAAAAAAAAAAAAAAAAA.BBBB' })), 'CSRF_FAILED');
  await c.primeCsrf();
  assert.equal((await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD })).status, 200);
});

test('logout without a token is rejected and the session stays valid', async () => {
  const c = await h.client('aResponder');
  assert.equal(code(await c.post('/api/auth/logout', {}, { csrf: false })), 'CSRF_FAILED');
  assert.equal((await c.get('/api/me')).status, 200);
});

test('GET and HEAD are not subject to CSRF checks', async () => {
  const c = await h.client('aLead');
  assert.equal((await c.get('/api/me', { headers: { origin: 'http://evil.example' } })).status, 200);
  assert.equal((await c.request('HEAD', '/api/me')).status, 200);
});

test('unauthenticated mutation on a session route is 401, not a CSRF leak', async () => {
  const r = await h.anon().post('/api/users', {}, { csrf: false });
  assert.equal(r.status, 401);
});
