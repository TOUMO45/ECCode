// NFR5 / NFR1 helpers: fixtures.js loads RS-FIX-1 and keeps cookies and the CSRF token for sign-in.
// The sign-in flow is exercised against a scripted stand-in for the server (the auth routes
// are built in a later task); the real flow is covered where those routes exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_USERS, createClient, loadRsFix1, uniqueUsername } from '../../helpers/fixtures.js';

test('NFR5: loadRsFix1 returns RS-FIX-1 as an independent copy each time', () => {
  const a = loadRsFix1();
  assert.equal(a.id, 'RS-FIX-1');
  assert.equal(a.offers.length >= 5, true);
  a.offers.length = 0;
  assert.equal(loadRsFix1().offers.length >= 5, true);
});

test('NFR5: the demo users are the seven seeded accounts', () => {
  assert.deepEqual(
    DEMO_USERS.map((u) => u.username),
    ['cafe1', 'cafe2', 'supplier-a', 'supplier-b', 'supplier-c', 'supplier-d', 'supplier-e'],
  );
});

test('NFR5: uniqueUsername is unique and valid for registration', () => {
  const names = new Set(Array.from({ length: 50 }, () => uniqueUsername()));
  assert.equal(names.size, 50);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_.-]{3,40}$/);
  assert.match(uniqueUsername('x'.repeat(60)), /^[A-Za-z0-9_.-]{3,40}$/);
});

function scriptedServer() {
  const seen = [];
  const request = async (req) => {
    seen.push(req);
    if (req.path === '/api/auth/csrf') return { status: 200, headers: {}, json: { csrfToken: 'pre-token' }, text: '' };
    if (req.path === '/api/auth/signin') {
      if (req.headers['X-CSRF-Token'] !== 'pre-token') return { status: 403, headers: {}, json: { error: { code: 'CSRF_FAILED' } }, text: '' };
      if (req.jsonBody.password !== 'right-password') return { status: 401, headers: {}, json: { error: { code: 'INVALID_CREDENTIALS' } }, text: '' };
      return {
        status: 200,
        headers: { 'set-cookie': ['rs_sid=abc123; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200'] },
        json: { user: { username: req.jsonBody.username, role: 'customer' }, csrfToken: 'session-token' },
        text: '',
      };
    }
    if (req.path === '/api/auth/signout') {
      return { status: 200, headers: { 'set-cookie': ['rs_sid=; Max-Age=0; Path=/'] }, json: {}, text: '' };
    }
    return { status: 200, headers: {}, json: {}, text: '' };
  };
  return { request, seen };
}

test('NFR5: createClient signs in with the pre-login token, then sends the cookie and the session token', async () => {
  const { request, seen } = scriptedServer();
  const client = createClient(request);
  await client.signIn('cafe1', 'right-password');
  assert.deepEqual(client.cookies(), { rs_sid: 'abc123' });
  assert.equal(client.csrfToken, 'session-token');
  assert.equal(client.user.username, 'cafe1');

  await client.get('/api/requests');
  const get = seen.at(-1);
  assert.equal(get.headers.Cookie, 'rs_sid=abc123');
  assert.equal(get.headers['X-CSRF-Token'], undefined, 'GET carries no CSRF header');

  await client.post('/api/requests', { text: 'x' });
  const post = seen.at(-1);
  assert.equal(post.headers['X-CSRF-Token'], 'session-token');
  assert.deepEqual(post.jsonBody, { text: 'x' });

  await client.signOut();
  assert.deepEqual(client.cookies(), {});
  assert.equal(client.csrfToken, null);
  assert.equal(client.user, null);
});

test('NFR5: createClient.signIn throws with the status and error code on refusal, without echoing the password', async () => {
  const { request } = scriptedServer();
  const client = createClient(request);
  await assert.rejects(
    () => client.signIn('cafe1', 'wrong-password'),
    (err) => /sign-in as cafe1 failed with 401 INVALID_CREDENTIALS/.test(err.message) && !/wrong-password/.test(err.message),
  );
});
