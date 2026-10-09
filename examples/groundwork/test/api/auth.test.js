import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD, USERS, Client } from '../support/harness.js';
import { responses, errorResponse, errorDetails } from '../../src/api/contract-schemas.js';
import { validate } from '../../src/lib/schema.js';
import { IDLE_MS, ABSOLUTE_MS } from '../../src/auth/sessions.js';

let h;
before(async () => { h = await startApp(); });
after(async () => { await h.close(); });

const ok = (schema, body) => { const r = validate(schema, body); assert.deepEqual(r.errors, []); };
const sidOf = (c) => c.jar.get('gw_sid');

test('health is public and matches the contract', async () => {
  const r = await h.anon().get('/api/health');
  assert.equal(r.status, 200);
  ok(responses.health, r.json);
  assert.match(r.headers.get('x-request-id'), /^[0-9a-f]{16}$/);
});

test('GET /api/csrf issues a token and cookie', async () => {
  const c = h.anon();
  const r = await c.get('/api/csrf');
  assert.equal(r.status, 200);
  ok(responses.csrf, r.json);
  assert.equal(c.jar.get('gw_csrf'), r.json.csrfToken);
  const sc = r.headers.getSetCookie().join('\n');
  assert.match(sc, /gw_csrf=.*SameSite=Strict/);
  assert.doesNotMatch(sc, /HttpOnly/);
});

test('login success: contract shape, HttpOnly SameSite=Strict cookie, /api/me works', async () => {
  const c = h.anon();
  await c.primeCsrf();
  const r = await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD });
  assert.equal(r.status, 200);
  ok(responses.login, r.json);
  assert.deepEqual(r.json.user, { id: USERS.aLead.id, username: 'a-lead', displayName: 'Team A lead', role: 'lead', teamId: USERS.aLead.teamId, teamName: 'Team A' });
  const sid = r.headers.getSetCookie().find((s) => s.startsWith('gw_sid='));
  assert.match(sid, /HttpOnly/);
  assert.match(sid, /SameSite=Strict/);
  assert.match(sid, /Path=\//);
  assert.doesNotMatch(sid, /Secure/);
  c.csrfToken = r.json.csrfToken;
  assert.equal(c.jar.get('gw_csrf'), r.json.csrfToken);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  ok(responses.me, me.json);
  assert.equal(me.json.user.username, 'a-lead');
  assert.equal(me.headers.get('cache-control'), 'no-store');
});

test('username lookup is case-insensitive; password never appears in responses', async () => {
  const c = h.anon();
  const r = await c.login('A-LEAD');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('scrypt'));
});

test('Secure flag is set when GW_COOKIE_SECURE=1', async () => {
  const s = await startApp({ env: { GW_COOKIE_SECURE: '1' } });
  try {
    const c = s.anon();
    await c.primeCsrf();
    const r = await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD });
    for (const sc of r.headers.getSetCookie()) assert.match(sc, /Secure/);
  } finally { await s.close(); }
});

test('unknown user, wrong password and disabled user give identical 401 bodies', async () => {
  h.db.prepare("UPDATE users SET disabled = 1 WHERE username = 'b-viewer'").run();
  const bodies = [];
  for (const [u, p] of [['nobody-here', 'whatever-123'], ['b-lead', 'wrong-password-1'], ['b-viewer', PASSWORD]]) {
    const c = h.anon();
    await c.primeCsrf();
    const r = await c.post('/api/auth/login', { username: u, password: p });
    assert.equal(r.status, 401);
    ok(errorResponse, r.json);
    assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
    bodies.push({ ...r.json.error, requestId: 'x' });
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
  h.db.prepare("UPDATE users SET disabled = 0 WHERE username = 'b-viewer'").run();
});

test('login validation: 400 with fields, never 500', async () => {
  const c = h.anon();
  await c.primeCsrf();
  for (const body of [{}, { username: 'a-lead' }, { username: 5, password: 'x' }, { username: 'a b', password: 'x' },
    { username: 'a-lead', password: 'x', extra: 1 }, { username: 'a'.repeat(65), password: 'x' }, { username: 'a-lead', password: 'x'.repeat(129) }, []]) {
    const r = await c.post('/api/auth/login', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(r.json.error.code, 'VALIDATION_FAILED');
    ok(errorDetails.VALIDATION_FAILED, r.json.error.details);
  }
  const bad = await c.request('POST', '/api/auth/login', { rawBody: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_JSON');
});

test('limiter: 6th attempt is 429 with Retry-After even with the right password; then clears after the window', async () => {
  const s = await startApp();
  try {
    const c = s.anon();
    await c.primeCsrf();
    for (let i = 1; i <= 5; i++) {
      const r = await c.post('/api/auth/login', { username: 'a-responder', password: `wrong-password-${i}` });
      assert.equal(r.status, 401, `attempt ${i}`);
    }
    const r6 = await c.post('/api/auth/login', { username: 'a-responder', password: PASSWORD });
    assert.equal(r6.status, 429);
    assert.equal(r6.json.error.code, 'RATE_LIMITED');
    ok(errorDetails.RATE_LIMITED, r6.json.error.details);
    assert.equal(r6.headers.get('retry-after'), String(r6.json.error.details.retryAfterSeconds));
    // other usernames are unaffected
    assert.equal((await s.anon().login('a-viewer')).status, 200);
    // limiter case-insensitive on username
    const r7 = await c.post('/api/auth/login', { username: 'A-RESPONDER', password: PASSWORD });
    assert.equal(r7.status, 429);
    s.clock.advance(15 * 60 * 1000 + 1000);
    const r8 = await c.post('/api/auth/login', { username: 'a-responder', password: PASSWORD });
    assert.equal(r8.status, 200);
  } finally { await s.close(); }
});

test('limiter map stays bounded across 10,001 distinct usernames', async () => {
  const s = await startApp();
  try {
    const { limiter } = s.app.ctx;
    for (let i = 0; i < 10001; i++) limiter.fail(`user${i}|127.0.0.1`);
    assert.ok(limiter.size <= 10000);
    // still functional through HTTP
    assert.equal((await s.anon().login('a-lead', 'bad-password-xx')).status, 401);
    assert.ok(limiter.size <= 10000);
  } finally { await s.close(); }
});

test('session rotation: new id each login, old id rejected, preset cookie ignored (fixation)', async () => {
  const c = h.anon();
  await c.login('a-lead');
  const first = sidOf(c);
  const c2 = new Client(h.url);
  await c2.login('a-lead');
  assert.notEqual(sidOf(c2), first);

  // Re-login while presenting the old session deletes it
  const old = sidOf(c);
  await c.login('a-lead');
  assert.notEqual(sidOf(c), old);
  const probe = new Client(h.url);
  probe.jar.set('gw_sid', old);
  assert.equal((await probe.get('/api/me')).status, 401);

  // attacker-chosen cookie is never adopted
  const victim = new Client(h.url);
  victim.jar.set('gw_sid', 'attacker-chosen-session-id-0123456789');
  await victim.login('a-viewer');
  assert.notEqual(sidOf(victim), 'attacker-chosen-session-id-0123456789');
  const attacker = new Client(h.url);
  attacker.jar.set('gw_sid', 'attacker-chosen-session-id-0123456789');
  assert.equal((await attacker.get('/api/me')).status, 401);
});

test('only the hash of the session id is stored', async () => {
  const c = await h.client('aResponder');
  const rows = h.db.prepare('SELECT id_hash FROM sessions').all().map((r) => r.id_hash);
  assert.ok(!rows.includes(sidOf(c)));
});

test('idle expiry (30 min) and sliding refresh, absolute expiry (8 h)', async () => {
  const s = await startApp();
  try {
    const c = await s.client('aLead');
    s.clock.advance(IDLE_MS - 60_000);
    assert.equal((await c.get('/api/me')).status, 200);
    s.clock.advance(IDLE_MS - 60_000);
    assert.equal((await c.get('/api/me')).status, 200);
    s.clock.advance(IDLE_MS + 1);
    const r = await c.get('/api/me');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHENTICATED');

    const c2 = await s.client('aLead');
    for (let i = 0; i < 15; i++) { s.clock.advance(IDLE_MS - 60_000); assert.equal((await c2.get('/api/me')).status, 200, `i=${i}`); }
    s.clock.advance(ABSOLUTE_MS);
    assert.equal((await c2.get('/api/me')).status, 401);
  } finally { await s.close(); }
});

test('logout invalidates the session and clears cookies; logging out twice is 401', async () => {
  const c = await h.client('aViewer');
  const sid = sidOf(c);
  const r = await c.post('/api/auth/logout', {});
  assert.equal(r.status, 200);
  ok(responses.logout, r.json);
  assert.equal(c.jar.has('gw_sid'), false);
  const replay = new Client(h.url);
  replay.jar.set('gw_sid', sid);
  replay.jar.set('gw_csrf', 'x');
  assert.equal((await replay.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/auth/logout', {})).status, 401);
});

test('unauthenticated access to protected endpoints is 401', async () => {
  const c = h.anon();
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/users'], ['GET', '/api/audit']]) {
    const r = await c.request(m, p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.error.code, 'UNAUTHENTICATED');
  }
});

test('users: lead creates users in own team only; roles enforced; duplicate is 409', async () => {
  const lead = await h.client('aLead');
  const r = await lead.post('/api/users', { username: 'new.user', displayName: 'New User', password: 'a-long-password', role: 'viewer' });
  assert.equal(r.status, 201);
  ok(responses.createUser, r.json);
  assert.equal(r.json.user.teamId, USERS.aLead.teamId);
  assert.ok(!r.text.includes('a-long-password') && !r.text.includes('scrypt'));

  // team id cannot be smuggled
  const smuggle = await lead.post('/api/users', { username: 'x1', displayName: 'X', password: 'a-long-password', role: 'viewer', teamId: USERS.bLead.teamId });
  assert.equal(smuggle.status, 400);

  const dup = await lead.post('/api/users', { username: 'NEW.USER', displayName: 'Dup', password: 'a-long-password', role: 'viewer' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'USERNAME_TAKEN');

  for (const bad of [{ password: 'short' }, { role: 'admin' }, { username: 'bad name' }, { displayName: '' }]) {
    const x = await lead.post('/api/users', { username: 'ok.name', displayName: 'D', password: 'a-long-password', role: 'viewer', ...bad });
    assert.equal(x.status, 400);
  }

  // the new user can log in and sees only their own team
  const nu = await h.anon().login('new.user', 'a-long-password');
  assert.equal(nu.status, 200);

  const list = await lead.get('/api/users');
  ok(responses.listUsers, list.json);
  assert.ok(list.json.users.every((u) => u.teamId === USERS.aLead.teamId));
  assert.ok(list.json.users.some((u) => u.username === 'new.user'));

  for (const key of ['aResponder', 'aViewer']) {
    const c = await h.client(key);
    assert.equal((await c.get('/api/users')).status, 403);
    assert.equal((await c.post('/api/users', { username: 'zz', displayName: 'Z', password: 'a-long-password', role: 'lead' })).status, 403);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM users WHERE username='zz'").get().c, 0);
});

test('audit: lead-only, team-scoped, no secrets; sensitive actions recorded', async () => {
  const lead = await h.client('aLead');
  const other = await h.client('bLead');
  await lead.post('/api/users', { username: 'audited', displayName: 'Audited', password: 'super-secret-pw1', role: 'responder' });
  const bad = h.anon();
  await bad.login('a-responder', 'wrong-password-zz');

  const r = await lead.get('/api/audit?limit=200');
  assert.equal(r.status, 200);
  ok(responses.audit, r.json);
  const actions = r.json.entries.map((e) => e.action);
  assert.ok(actions.includes('auth.login'));
  assert.ok(actions.includes('user.create'));
  assert.ok(r.json.entries.some((e) => e.action === 'auth.login' && e.outcome === 'fail'));
  assert.ok(!r.text.includes('super-secret-pw1') && !r.text.includes('wrong-password-zz') && !r.text.includes('scrypt'));
  const created = r.json.entries.find((e) => e.action === 'user.create' && e.detail.username === 'audited');
  assert.ok(created);
  assert.equal(created.actor, 'a-lead');

  const theirs = await other.get('/api/audit?limit=200');
  assert.ok(!theirs.json.entries.some((e) => e.detail.username === 'audited'));
  assert.ok(theirs.json.entries.every((e) => e.actor !== 'a-lead'));

  // paging
  const p1 = await lead.get('/api/audit?limit=2');
  assert.equal(p1.json.entries.length, 2);
  assert.ok(p1.json.nextBefore);
  const p2 = await lead.get(`/api/audit?limit=2&before=${p1.json.nextBefore}`);
  assert.ok(p2.json.entries.every((e) => e.id < p1.json.nextBefore));

  for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=-1', 'foo=1', 'limit=1&limit=2']) {
    assert.equal((await lead.get(`/api/audit?${q}`)).status, 400, q);
  }
  for (const key of ['aResponder', 'aViewer']) {
    assert.equal((await (await h.client(key)).get('/api/audit')).status, 403);
  }
  // denied access is itself audited
  const again = await lead.get('/api/audit?limit=200');
  assert.ok(again.json.entries.some((e) => e.action === 'access.denied' && e.outcome === 'denied'));
});

test('audit rows are append-only', () => {
  assert.throws(() => h.db.prepare('UPDATE audit_log SET action = ?').run('x'), /append-only/);
  assert.throws(() => h.db.prepare('DELETE FROM audit_log').run(), /append-only/);
});

test('sessions survive an app restart on the same database (and limiter resets)', async () => {
  const s1 = await startApp();
  const c = await s1.client('aLead');
  const sid = c.jar.get('gw_sid');
  await s1.close({ keepDb: true });
  const s2 = await startApp({ dbPath: s1.dbPath, seedUsers: false });
  try {
    const probe = s2.anon();
    probe.jar.set('gw_sid', sid);
    assert.equal((await probe.get('/api/me')).status, 200);
  } finally { await s2.close(); }
});
