// API tests for authentication and RBAC (task c1-auth-rbac). Every case name starts with the id of the
// criterion it proves: ARCH-25 (routes, sessions, CSRF), SEC-1 / SEC-9 (sign-in throttle, T8, T24),
// SEC-B-9 (forwarded IP), F-TR-17 (register limit), RS-30 (401/403 split), SEC-13 (Host), SEC-20
// (fixation, no CORS), FU-6 (seeded hash), T6 (CSRF). Runs the real app in-process through
// test/helpers/app-harness.js; every response is checked for the absence of Access-Control-Allow-*.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { hashPassword } from '../../src/auth/password.js';
import { createCustomer, ensureAdmin } from '../../src/services/users.js';

const PASSWORD = 'correct-horse-staple-1';
const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Wraps a harness: every response is asserted to carry no Access-Control-Allow-* header (SEC-20).
function client(h) {
  let nextIp = 10;
  const ip = () => `198.51.100.${nextIp++}`;

  async function call(options) {
    const res = await h.request(options);
    for (const name of Object.keys(res.headers)) {
      assert.ok(!name.toLowerCase().startsWith('access-control-allow-'), `unexpected ${name} on ${options.method ?? 'GET'} ${options.path}`);
    }
    return res;
  }
  const sidOf = (res) => {
    const raw = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rs_sid='));
    return raw ? raw.split(';')[0].slice('rs_sid='.length) : null;
  };
  const cookieHeader = (sid) => (sid ? { Cookie: `rs_sid=${sid}` } : {});

  async function preLoginToken() {
    const res = await call({ path: '/api/auth/csrf' });
    assert.equal(res.status, 200);
    return res.json.csrfToken;
  }

  // post(path, body, { token, sid, ip, origin, record, headers }); token defaults to a fresh pre-login token
  async function post(path, body, { token, sid, from, origin, record, headers = {} } = {}) {
    const h2 = { ...cookieHeader(sid), ...headers };
    const useToken = token === undefined ? await preLoginToken() : token;
    if (useToken !== null) h2['X-CSRF-Token'] = useToken;
    if (from) h2['X-Forwarded-For'] = from;
    if (origin !== undefined) h2.Origin = origin;
    return call({ method: 'POST', path, jsonBody: body, headers: h2, ...(record === undefined ? {} : { record }) });
  }
  const signin = (username, password, options) => post('/api/auth/signin', { username, password }, options);
  const register = (body, options) => post('/api/auth/register', body, options);
  const session = (sid) => call({ path: '/api/auth/session', headers: cookieHeader(sid) });

  return { call, post, signin, register, session, sidOf, cookieHeader, preLoginToken, ip };
}

function makeUser(h, hash, username) {
  return createCustomer(h.db, h.clock, { username, passwordHash: hash, displayName: `User ${username}` });
}

describe('ARCH-25: routes, cookie, sessions and CSRF', () => {
  let h;
  let c;
  let hash;
  before(async () => {
    hash = await hashPassword(PASSWORD);
    h = await startHarness({ env: { RS_TRUST_PROXY: '1' } });
    c = client(h);
  });
  after(() => h.close());

  test('ARCH-25: GET /api/auth/csrf returns {csrfToken, requestId} as nonce.hmac', async () => {
    const res = await c.call({ path: '/api/auth/csrf' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['csrfToken', 'requestId']);
    assert.match(res.json.csrfToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('ARCH-25: GET /api/auth/session without a session is {user: null, csrfToken: null, requestId}', async () => {
    const res = await c.session(null);
    assert.equal(res.status, 200);
    assert.deepEqual({ user: res.json.user, csrfToken: res.json.csrfToken }, { user: null, csrfToken: null });
    const stale = await c.session('A'.repeat(43));
    assert.deepEqual({ user: stale.json.user, csrfToken: stale.json.csrfToken }, { user: null, csrfToken: null });
  });

  test('ARCH-25: sign-in sets rs_sid HttpOnly, SameSite=Lax, Path=/, Max-Age=43200 (no Secure on http) and returns user and csrfToken', async () => {
    makeUser(h, hash, 'cookie-user');
    const res = await c.signin('cookie-user', PASSWORD);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['csrfToken', 'requestId', 'user']);
    assert.deepEqual(Object.keys(res.json.user).sort(), ['displayName', 'id', 'role', 'supplierCode', 'username']);
    assert.equal(res.json.user.role, 'customer');
    assert.equal(res.json.user.username, 'cookie-user');
    assert.equal(res.json.user.supplierCode, null);
    const cookies = [].concat(res.headers['set-cookie']);
    assert.equal(cookies.length, 1);
    const sid = c.sidOf(res);
    assert.match(sid, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(cookies[0], `rs_sid=${sid}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`);
    assert.ok(!res.text.includes('scrypt'), 'no hash in the response');
    const who = await c.session(sid);
    assert.deepEqual(who.json.user, res.json.user);
    assert.equal(who.json.csrfToken, res.json.csrfToken);
  });

  test('ARCH-25: only sha256(id) is stored; the cookie value and the CSRF token are not in the database', async () => {
    makeUser(h, hash, 'hash-user');
    const res = await c.signin('hash-user', PASSWORD);
    const sid = c.sidOf(res);
    const rows = h.db.prepare('SELECT * FROM sessions').all();
    assert.ok(rows.some((r) => r.id_hash === sha256(sid)));
    for (const row of rows) assert.ok(!Object.values(row).includes(sid), 'the raw id is never stored');
  });

  test('ARCH-25: the cookie gets Secure when RS_PUBLIC_URL is https', async () => {
    const secure = await startHarness({ env: { RS_PUBLIC_URL: 'https://rescue.example.test' } });
    try {
      const sc = client(secure);
      makeUser(secure, hash, 'secure-user');
      const res = await sc.signin('secure-user', PASSWORD);
      assert.equal(res.status, 200);
      assert.match([].concat(res.headers['set-cookie'])[0], /; HttpOnly; SameSite=Lax; Secure$/);
      const out = await sc.post('/api/auth/signout', {}, { token: res.json.csrfToken, sid: sc.sidOf(res), origin: 'https://rescue.example.test' });
      assert.equal(out.status, 200);
      assert.match([].concat(out.headers['set-cookie'])[0], /Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
    } finally {
      await secure.close();
    }
  });

  test('ARCH-25: sign-out deletes the row, clears the cookie (Max-Age=0) and the old cookie stops working', async () => {
    makeUser(h, hash, 'out-user');
    const inRes = await c.signin('out-user', PASSWORD);
    const sid = c.sidOf(inRes);
    const out = await c.post('/api/auth/signout', {}, { token: inRes.json.csrfToken, sid });
    assert.equal(out.status, 200);
    assert.deepEqual(Object.keys(out.json), ['requestId']);
    assert.equal([].concat(out.headers['set-cookie'])[0], 'rs_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(sha256(sid)).n, 0);
    assert.equal((await c.session(sid)).json.user, null);
    const again = await c.post('/api/auth/signout', {}, { token: inRes.json.csrfToken, sid });
    assert.equal(again.status, 401);
    assert.equal(again.json.error.code, 'UNAUTHENTICATED');
  });

  test('ARCH-25: sign-out needs the session CSRF token (403 CSRF_FAILED) and a session (401)', async () => {
    makeUser(h, hash, 'out2-user');
    const inRes = await c.signin('out2-user', PASSWORD);
    const sid = c.sidOf(inRes);
    for (const token of [null, 'wrong', await c.preLoginToken()]) {
      const res = await c.post('/api/auth/signout', {}, { token, sid });
      assert.equal(res.status, 403, String(token));
      assert.equal(res.json.error.code, 'CSRF_FAILED');
    }
    assert.equal((await c.session(sid)).json.user.username, 'out2-user', 'still signed in');
    const anon = await c.post('/api/auth/signout', {});
    assert.equal(anon.status, 401);
  });

  test('ARCH-25: idle timeout 60 minutes (activity inside the hour keeps the session alive)', async () => {
    makeUser(h, hash, 'idle-user');
    const sid = c.sidOf(await c.signin('idle-user', PASSWORD));
    h.clock.advance(59 * 60_000);
    assert.equal((await c.session(sid)).json.user.username, 'idle-user');
    h.clock.advance(59 * 60_000);
    assert.equal((await c.session(sid)).json.user.username, 'idle-user', 'last_seen was refreshed');
    h.clock.advance(60 * 60_000);
    assert.equal((await c.session(sid)).json.user, null, 'idle for 60 minutes');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(sha256(sid)).n, 0);
  });

  test('ARCH-25: absolute lifetime 12 hours even for a session that is used all the time', async () => {
    makeUser(h, hash, 'abs-user');
    const sid = c.sidOf(await c.signin('abs-user', PASSWORD));
    for (let i = 0; i < 13; i++) {
      h.clock.advance(55 * 60_000);
      assert.equal((await c.session(sid)).json.user.username, 'abs-user', `alive at ${(i + 1) * 55} minutes`);
    }
    h.clock.advance(10 * 60_000);
    assert.equal((await c.session(sid)).json.user, null, 'dead after 12 hours');
  });

  test('ARCH-25: register creates a customer (201, cookie, csrfToken) and ignores a role field', async () => {
    const res = await c.register({ username: 'new.cafe-1', password: 'a long enough password', displayName: '  New Cafe  ', role: 'admin', supplierId: 1, disabled: false }, { from: c.ip() });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.user, { id: res.json.user.id, username: 'new.cafe-1', displayName: 'New Cafe', role: 'customer', supplierCode: null });
    assert.match(c.sidOf(res), /^[A-Za-z0-9_-]{43}$/);
    const row = h.db.prepare('SELECT role, supplier_id, disabled, password_hash FROM users WHERE username = ?').get('new.cafe-1');
    assert.deepEqual({ role: row.role, supplier_id: row.supplier_id, disabled: row.disabled }, { role: 'customer', supplier_id: null, disabled: 0 });
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
    const who = await c.session(c.sidOf(res));
    assert.equal(who.json.user.role, 'customer');
    const back = await c.signin('NEW.CAFE-1', 'a long enough password');
    assert.equal(back.status, 200, 'sign-in is case-insensitive on the username');
  });

  test('ARCH-25: register validation is 422 VALIDATION_FAILED with details.fields, and nothing is created', async () => {
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const budgetBefore = h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'register'").get().n;
    const from = c.ip();
    const cases = [
      [{ username: 'ab', password: 'a long enough password', displayName: 'X' }, 'username'],
      [{ username: 'bad name!', password: 'a long enough password', displayName: 'X' }, 'username'],
      [{ username: 'x'.repeat(41), password: 'a long enough password', displayName: 'X' }, 'username'],
      [{ username: 'okname', password: 'short', displayName: 'X' }, 'password'],
      [{ username: 'okname', password: 'p'.repeat(201), displayName: 'X' }, 'password'],
      [{ username: 'okname', password: 'a long enough password', displayName: '   ' }, 'displayName'],
      [{ username: 'okname', password: 'a long enough password', displayName: 'a\u0007b' }, 'displayName'],
      [{ username: 'okname', password: 'a long enough password', displayName: 'x'.repeat(81) }, 'displayName'],
      [{ username: 'okname', password: 12345678901, displayName: 'X' }, 'password'],
      [{}, 'username'],
    ];
    for (const [body, field] of cases) {
      const res = await c.register(body, { from });
      assert.equal(res.status, 422, JSON.stringify(body).slice(0, 60));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.ok(res.json.error.details.fields.some((f) => f.field === field), field);
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'register'").get().n, budgetBefore, 'validation failures use no registration budget');
  });

  test('ARCH-25: a taken username (any case) is 409 USERNAME_TAKEN; so is "admin"', async () => {
    const from = c.ip();
    makeUser(h, hash, 'taken-name');
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
    for (const username of ['taken-name', 'TAKEN-NAME', 'admin', 'Admin']) {
      const res = await c.register({ username, password: 'a long enough password', displayName: 'X' }, { from });
      assert.equal(res.status, 409, username);
      assert.equal(res.json.error.code, 'USERNAME_TAKEN');
    }
  });

  test('ARCH-25: non-JSON and malformed bodies on the auth routes are typed 4xx errors, not 500s', async () => {
    const token = await c.preLoginToken();
    const wrongType = await c.call({ method: 'POST', path: '/api/auth/signin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'text/plain' }, body: '{"username":"a","password":"b"}' });
    assert.equal(wrongType.status, 415);
    const broken = await c.call({ method: 'POST', path: '/api/auth/signin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{"username":' });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, 'INVALID_JSON');
    const array = await c.signin('x', 'y', { token });
    assert.equal(array.status, 401);
    for (const body of [[], 'text', 7, null]) {
      const res = await c.call({ method: 'POST', path: '/api/auth/signin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    const missing = await c.signin(undefined, undefined, { token });
    assert.equal(missing.status, 422);
    const types = await c.post('/api/auth/signin', { username: { $ne: 1 }, password: ['x'] }, { token });
    assert.equal(types.status, 422);
    const huge = await c.call({ method: 'POST', path: '/api/auth/signin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b'.repeat(70000) }) });
    assert.equal(huge.status, 413);
    assert.equal(huge.json.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('T6: CSRF and Origin on the pre-login routes (ARCH-25)', () => {
  let h;
  let c;
  before(async () => {
    h = await startHarness({ env: { RS_TRUST_PROXY: '1' } });
    c = client(h);
    makeUser(h, await hashPassword(PASSWORD), 'csrf-user');
  });
  after(() => h.close());

  const failed = (res) => {
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'CSRF_FAILED');
    assert.equal(res.headers['set-cookie'], undefined);
  };

  test('T6: sign-in and register without a token, or with a wrong, tampered or foreign token -> 403 CSRF_FAILED', async () => {
    const good = await c.preLoginToken();
    const [nonce, mac] = good.split('.');
    const tampered = `${nonce}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    for (const token of [null, 'x', '.', `${nonce}`, tampered, `${good}.x`]) {
      failed(await c.signin('csrf-user', PASSWORD, { token }));
      failed(await c.register({ username: 'csrf-new', password: 'a long enough password', displayName: 'X' }, { token }));
    }
    assert.equal((await c.signin('csrf-user', PASSWORD, { token: good })).status, 200);
  });

  test('T6: a pre-login token is valid for 2 hours and not longer', async () => {
    const token = await c.preLoginToken();
    h.clock.advance(2 * 60 * 60_000);
    assert.equal((await c.signin('csrf-user', PASSWORD, { token })).status, 200);
    h.clock.advance(1);
    failed(await c.signin('csrf-user', PASSWORD, { token }));
  });

  test('T6: a present Origin must be the public origin or http(s)://<Host>; a foreign or "null" Origin -> 403 CSRF_FAILED', async () => {
    const own = `http://127.0.0.1:${h.port}`;
    assert.equal((await c.signin('csrf-user', PASSWORD, { origin: own })).status, 200);
    assert.equal((await c.signin('csrf-user', PASSWORD, { origin: `http://localhost:${h.port}` })).status, 200);
    for (const origin of ['http://evil.example', 'null', `${own}.evil.example`, 'https://127.0.0.1', '']) {
      failed(await c.signin('csrf-user', PASSWORD, { origin }));
    }
    failed(await c.register({ username: 'csrf-new', password: 'a long enough password', displayName: 'X' }, { origin: 'http://evil.example' }));
  });

  test('T6: a signed-in browser can sign in again with its session token instead of a pre-login token', async () => {
    const first = await c.signin('csrf-user', PASSWORD);
    const sid = c.sidOf(first);
    const again = await c.signin('csrf-user', PASSWORD, { token: first.json.csrfToken, sid });
    assert.equal(again.status, 200);
    assert.notEqual(c.sidOf(again), sid);
  });
});

describe('SEC-20: session fixation, rotation and CORS', () => {
  let h;
  let c;
  let hash;
  before(async () => {
    hash = await hashPassword(PASSWORD);
    h = await startHarness({ env: { RS_TRUST_PROXY: '1' } });
    c = client(h);
  });
  after(() => h.close());
  const rowCount = (sid) => h.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(sha256(sid)).n;

  test('SEC-20: sign-in destroys the incoming session and issues a new id', async () => {
    makeUser(h, hash, 'rot-user');
    makeUser(h, hash, 'rot-other');
    const first = await c.signin('rot-user', PASSWORD);
    const oldSid = c.sidOf(first);
    assert.equal(rowCount(oldSid), 1);
    const second = await c.signin('rot-other', PASSWORD, { sid: oldSid });
    const newSid = c.sidOf(second);
    assert.notEqual(newSid, oldSid);
    assert.equal(rowCount(oldSid), 0, 'the old session row is gone');
    assert.equal((await c.session(oldSid)).json.user, null, 'the old cookie no longer works');
    assert.equal((await c.session(newSid)).json.user.username, 'rot-other');
  });

  test('SEC-20: an attacker-chosen session id is never adopted by sign-in', async () => {
    makeUser(h, hash, 'fix-user');
    const planted = 'P'.repeat(43);
    const res = await c.signin('fix-user', PASSWORD, { sid: planted });
    assert.equal(res.status, 200);
    assert.notEqual(c.sidOf(res), planted);
    assert.equal((await c.session(planted)).json.user, null);
    assert.equal(rowCount(planted), 0);
  });

  test('SEC-20: a failed sign-in does not touch the incoming session; a successful register destroys it', async () => {
    makeUser(h, hash, 'keep-user');
    const first = await c.signin('keep-user', PASSWORD);
    const sid = c.sidOf(first);
    const bad = await c.signin('keep-user', 'wrong-password-here', { sid, from: c.ip() });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['set-cookie'], undefined);
    assert.equal(rowCount(sid), 1, 'a failure keeps the session');
    const reg = await c.register({ username: 'fresh-after-session', password: 'a long enough password', displayName: 'Fresh' }, { sid, from: c.ip() });
    assert.equal(reg.status, 201);
    assert.notEqual(c.sidOf(reg), sid);
    assert.equal(rowCount(sid), 0, 'registration rotates the session (SEC-20)');
    assert.equal((await c.session(c.sidOf(reg))).json.user.username, 'fresh-after-session');
  });

  test('SEC-20: the session cookie is rotated on each sign-in even for the same user', async () => {
    makeUser(h, hash, 'same-user');
    const a = await c.signin('same-user', PASSWORD);
    const b = await c.signin('same-user', PASSWORD, { sid: c.sidOf(a) });
    assert.notEqual(c.sidOf(a), c.sidOf(b));
    assert.notEqual(a.json.csrfToken, b.json.csrfToken, 'a new CSRF token per session');
  });

  test('SEC-20: no response carries an Access-Control-Allow-* header, including a cross-origin preflight', async () => {
    const preflight = await c.call({
      method: 'OPTIONS',
      path: '/api/auth/signin',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-csrf-token' },
    });
    assert.ok([404, 405].includes(preflight.status), `preflight status ${preflight.status}`);
    const cross = await c.call({ path: '/api/auth/session', headers: { Origin: 'http://evil.example' } });
    assert.equal(cross.status, 200);
    const refused = await c.signin('rot-user', PASSWORD, { origin: 'http://evil.example' });
    assert.equal(refused.status, 403);
    const missing = await c.call({ path: '/api/nope', headers: { Origin: 'http://evil.example' } });
    assert.equal(missing.status, 404);
    // client().call asserts the absence of Access-Control-Allow-* on every response above and in every other test.
  });
});

describe('SEC-13: Host allow-list on the auth routes', () => {
  let h;
  let c;
  before(async () => {
    h = await startHarness();
    c = client(h);
  });
  after(() => h.close());

  test('SEC-13: an unlisted Host header is 421 MISDIRECTED_REQUEST on csrf, session, sign-in and register; no session is created', async () => {
    for (const host of ['evil.example', 'localhost:1', 'rebind.test:80']) {
      const csrf = await c.call({ path: '/api/auth/csrf', host });
      assert.equal(csrf.status, 421, host);
      assert.equal(csrf.json.error.code, 'MISDIRECTED_REQUEST');
      assert.equal((await c.call({ path: '/api/auth/session', host })).status, 421);
      const token = await c.preLoginToken();
      for (const path of ['/api/auth/signin', '/api/auth/register']) {
        const res = await c.call({ method: 'POST', path, host, headers: { 'X-CSRF-Token': token }, jsonBody: { username: 'x', password: 'y' } });
        assert.equal(res.status, 421, `${path} ${host}`);
        assert.equal(res.headers['set-cookie'], undefined);
      }
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM login_failures').get().n, 0, 'a misdirected request records nothing');
    assert.equal((await c.call({ path: '/api/auth/csrf', host: `localhost:${h.port}` })).status, 200);
    assert.equal((await c.call({ path: '/api/auth/csrf', host: `127.0.0.1:${h.port}` })).status, 200);
  });
});

describe('SEC-1: sign-in throttle (T8, SEC-9, T24)', () => {
  let h;
  let c;
  let hash;
  before(async () => {
    hash = await hashPassword(PASSWORD);
    h = await startHarness({ env: { RS_TRUST_PROXY: '1', RS_ADMIN_PASSWORD: ADMIN_PASSWORD } });
    c = client(h);
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  });
  after(() => h.close());
  const code = (res) => res.json?.error?.code;

  test('SEC-1: T8 the 6th attempt from the same IP is 429 RATE_LIMITED (signin_pair) with Retry-After, even with the correct password', async () => {
    makeUser(h, hash, 't8-user');
    const from = c.ip();
    for (let i = 1; i <= 5; i++) {
      const res = await c.signin('t8-user', `wrong-password-${i}`, { from });
      assert.equal(res.status, 401, `attempt ${i}`);
      assert.equal(code(res), 'INVALID_CREDENTIALS');
    }
    const sixth = await c.signin('t8-user', PASSWORD, { from });
    assert.equal(sixth.status, 429);
    assert.equal(code(sixth), 'RATE_LIMITED');
    assert.equal(sixth.json.error.details.limit, 'signin_pair');
    assert.match(sixth.headers['retry-after'], /^[1-9]\d*$/);
    assert.ok(Number(sixth.headers['retry-after']) <= 900);
    assert.equal(sixth.headers['set-cookie'], undefined, 'no session for a refused attempt');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 't8-user'").get().n, 0);
  });

  test('SEC-1: T8 a correct password from another IP is 200 (cross-IP is never a lockout)', async () => {
    makeUser(h, hash, 't8b-user');
    const attacker = c.ip();
    for (let i = 0; i < 5; i++) await c.signin('t8b-user', `nope-${i}`, { from: attacker });
    assert.equal((await c.signin('t8b-user', PASSWORD, { from: attacker })).status, 429);
    const owner = await c.signin('t8b-user', PASSWORD, { from: c.ip() });
    assert.equal(owner.status, 200);
    assert.equal(owner.json.user.username, 't8b-user');
  });

  test('SEC-1: with >= 10 failures from other IPs the sign-in is delayed ~1 s, then the correct password still gets 200', async () => {
    makeUser(h, hash, 'delay-user');
    const at = new Date(h.clock.now()).toISOString();
    for (let i = 1; i <= 10; i++) h.db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?, ?, ?)').run('delay-user', `192.0.2.${i}`, at);
    const started = Date.now();
    const res = await c.signin('delay-user', PASSWORD, { from: c.ip(), record: false });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200, 'a delay, never a refusal');
    assert.ok(elapsed >= 950, `expected a delay of about 1 s, took ${elapsed} ms`);
    assert.ok(elapsed < 5000, `delay is bounded, took ${elapsed} ms`);
  });

  test('SEC-1: during the cross-IP delay the password is still checked (a wrong one is 401)', async () => {
    makeUser(h, hash, 'delay2-user');
    const at = new Date(h.clock.now()).toISOString();
    for (let i = 1; i <= 10; i++) h.db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?, ?, ?)').run('delay2-user', `192.0.2.${i}`, at);
    const started = Date.now();
    const res = await c.signin('delay2-user', 'not-the-password', { from: c.ip(), record: false });
    assert.equal(res.status, 401);
    assert.equal(code(res), 'INVALID_CREDENTIALS');
    assert.ok(Date.now() - started >= 950);
  });

  test('SEC-1: an IP is refused after 20 failures across usernames (signin_ip), before the password check', async () => {
    const from = c.ip();
    makeUser(h, hash, 'ip20-user');
    for (let i = 0; i < 20; i++) {
      const res = await c.signin(`spray-${i}`, 'whatever-password', { from });
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    const next = await c.signin('ip20-user', PASSWORD, { from });
    assert.equal(next.status, 429);
    assert.equal(next.json.error.details.limit, 'signin_ip');
    assert.ok(next.headers['retry-after']);
    assert.equal((await c.signin('ip20-user', PASSWORD, { from: c.ip() })).status, 200, 'another IP is unaffected');
  });

  test('SEC-9: Admin and " admin " share one key (lower(NFC(trim))): the 6th attempt for the admin account is 429 even with the right password', async () => {
    const from = c.ip();
    for (const name of ['Admin', ' admin ', 'ADMIN', '\tadmin', 'admin\n']) {
      const res = await c.signin(name, 'guess-guess-guess-guess', { from });
      assert.equal(res.status, 401, JSON.stringify(name));
    }
    const sixth = await c.signin('admin', ADMIN_PASSWORD, { from });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error.details.limit, 'signin_pair');
    const keys = h.db.prepare("SELECT DISTINCT username_key FROM login_failures WHERE ip = ?").all(from).map((r) => r.username_key);
    assert.deepEqual(keys, ['admin']);
    const other = await c.signin(' ADMIN ', ADMIN_PASSWORD, { from: c.ip() });
    assert.equal(other.status, 200, 'the right password from another IP signs in');
    assert.equal(other.json.user.role, 'admin');
  });

  test('SEC-9: an unknown username is counted and refused at the same count (429 versus 401 reveals nothing)', async () => {
    const from = c.ip();
    for (let i = 0; i < 5; i++) assert.equal((await c.signin('no-such-user-zz', 'guess-guess-guess', { from })).status, 401);
    const sixth = await c.signin('no-such-user-zz', 'guess-guess-guess', { from });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error.details.limit, 'signin_pair');
  });

  test('SEC-9: T24 identical 401 for an unknown user, a wrong password and a disabled account', async () => {
    makeUser(h, hash, 'known-user');
    const disabledId = makeUser(h, hash, 'disabled-user');
    h.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(disabledId);
    const unknown = await c.signin('nobody-here', 'some-password', { from: c.ip() });
    const wrong = await c.signin('known-user', 'some-password', { from: c.ip() });
    const disabled = await c.signin('disabled-user', PASSWORD, { from: c.ip() });
    for (const res of [unknown, wrong, disabled]) {
      assert.equal(res.status, 401);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    const shape = (res) => JSON.stringify({ ...res.json.error, requestId: 'x' });
    assert.equal(shape(unknown), shape(wrong));
    assert.equal(shape(unknown), shape(disabled));
    assert.equal(unknown.json.error.code, 'INVALID_CREDENTIALS');
  });

  test('SEC-1: failures are recorded for every wrong attempt, and a success clears that pair only', async () => {
    makeUser(h, hash, 'clear-user');
    const mine = c.ip();
    const theirs = c.ip();
    for (let i = 0; i < 3; i++) await c.signin('clear-user', `bad-${i}`, { from: mine });
    await c.signin('clear-user', 'bad-other', { from: theirs });
    const count = (ip) => h.db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username_key = ? AND ip = ?').get('clear-user', ip).n;
    assert.equal(count(mine), 3);
    assert.equal((await c.signin('clear-user', PASSWORD, { from: mine })).status, 200);
    assert.equal(count(mine), 0, 'the success cleared the pair');
    assert.equal(count(theirs), 1, 'another IP keeps its failure');
  });

  test('SEC-1: failures leave the window after 15 minutes', async () => {
    makeUser(h, hash, 'window-user');
    const from = c.ip();
    for (let i = 0; i < 5; i++) await c.signin('window-user', `bad-${i}`, { from });
    assert.equal((await c.signin('window-user', PASSWORD, { from })).status, 429);
    h.clock.advance(15 * 60_000);
    assert.equal((await c.signin('window-user', PASSWORD, { from })).status, 200);
  });

  test('SEC-1: audit events record sign-in success, failure (unknown and wrong alike) and throttle denial without usernames or passwords', async () => {
    makeUser(h, hash, 'audit-user');
    const from = c.ip();
    const secretName = 'audit-probe-name-xyz';
    await c.signin(secretName, 'password-probe-text-1', { from });
    await c.signin('audit-user', 'password-probe-text-2', { from });
    for (let i = 0; i < 4; i++) await c.signin('audit-user', 'password-probe-text-3', { from });
    const denied = await c.signin('audit-user', PASSWORD, { from });
    assert.equal(denied.status, 429);
    const ok = await c.signin('audit-user', PASSWORD, { from: c.ip() });
    assert.equal(ok.status, 200);
    const rows = h.db.prepare("SELECT * FROM audit_events WHERE action = 'auth.signin' ORDER BY id").all();
    const byRequest = (res) => rows.find((r) => r.request_id === res.json.requestId || r.request_id === res.headers['x-request-id']);
    assert.equal(byRequest(denied).outcome, 'denied');
    assert.deepEqual(JSON.parse(byRequest(denied).detail_json), { limit: 'signin_pair' });
    const success = byRequest(ok);
    assert.equal(success.outcome, 'ok');
    assert.equal(success.actor_user_id, ok.json.user.id);
    assert.equal(success.actor_role, 'customer');
    assert.ok(rows.filter((r) => r.outcome === 'failed').length >= 6);
    const failedUnknown = rows.find((r) => r.outcome === 'failed' && r.entity_id === null);
    assert.ok(failedUnknown, 'an unknown username is audited without a user id');
    const everything = JSON.stringify(rows) + h.lines.join('\n');
    for (const secret of [secretName, 'password-probe-text-1', 'password-probe-text-2', 'password-probe-text-3', PASSWORD]) {
      assert.ok(!everything.includes(secret), `${secret} must not appear in audit rows or logs`);
    }
  });
});

describe('SEC-B-9: forwarded client IP (FU-11)', () => {
  test('SEC-B-9: with RS_TRUST_PROXY=1 only a valid last X-Forwarded-For hop is a throttle key; invalid values fall back to the socket address', async () => {
    const h = await startHarness({ env: { RS_TRUST_PROXY: '1' } });
    try {
      const c = client(h);
      makeUser(h, await hashPassword(PASSWORD), 'fwd-user');
      // Five values: the pair limit is 5 failures, and all of them must land on the socket address.
      const garbage = ['not-an-ip', 'a'.repeat(300), '1.2.3.4, <script>alert(1)</script>', "9.9.9.9'; DROP TABLE login_failures;--", ''];
      for (const value of garbage) {
        const res = await c.signin('fwd-user', 'wrong-password-x', { headers: { 'X-Forwarded-For': value } });
        assert.equal(res.status, 401, JSON.stringify(value).slice(0, 40));
      }
      const stored = h.db.prepare('SELECT DISTINCT ip FROM login_failures').all().map((r) => r.ip);
      assert.deepEqual(stored, ['127.0.0.1'], 'every invalid value fell back to the socket address');
      for (const ip of stored) assert.notEqual(net.isIP(ip), 0);
      // The fallback key is shared: the 6th attempt is refused whatever the header says.
      const sixth = await c.signin('fwd-user', PASSWORD, { headers: { 'X-Forwarded-For': 'still-not-an-ip' } });
      assert.equal(sixth.status, 429);
      // A valid hop is a separate key, and so is its IPv6 form.
      assert.equal((await c.signin('fwd-user', PASSWORD, { from: '203.0.113.50' })).status, 200);
      assert.equal((await c.signin('fwd-user', 'bad', { from: '2001:DB8::7' })).status, 401);
      assert.ok(h.db.prepare('SELECT 1 FROM login_failures WHERE ip = ?').get('2001:db8::7'));
    } finally {
      await h.close();
    }
  });

  test('SEC-B-9: without RS_TRUST_PROXY a forged X-Forwarded-For cannot escape the limit or fill the table with keys', async () => {
    const h = await startHarness();
    try {
      const c = client(h);
      assert.equal(h.config.trustProxy, false);
      makeUser(h, await hashPassword(PASSWORD), 'plain-user');
      for (let i = 0; i < 5; i++) {
        const res = await c.signin('plain-user', `bad-${i}`, { from: `203.0.113.${i + 1}` });
        assert.equal(res.status, 401);
      }
      const sixth = await c.signin('plain-user', PASSWORD, { from: '203.0.113.99' });
      assert.equal(sixth.status, 429, 'the header was ignored: same socket address');
      assert.deepEqual(h.db.prepare('SELECT DISTINCT ip FROM login_failures').all().map((r) => r.ip), ['127.0.0.1']);
    } finally {
      await h.close();
    }
  });

  test('SEC-1: T8 holds on the socket address alone (no proxy): 6th attempt 429 with the correct password', async () => {
    const h = await startHarness();
    try {
      const c = client(h);
      makeUser(h, await hashPassword(PASSWORD), 'sock-user');
      for (let i = 0; i < 5; i++) assert.equal((await c.signin('sock-user', `bad-${i}`)).status, 401);
      const sixth = await c.signin('sock-user', PASSWORD);
      assert.equal(sixth.status, 429);
      assert.equal(sixth.json.error.details.limit, 'signin_pair');
    } finally {
      await h.close();
    }
  });
});

describe('F-TR-17: registration limit per IP per hour', () => {
  let h;
  let c;
  before(async () => {
    h = await startHarness();
    c = client(h);
  });
  after(() => h.close());

  test('F-TR-17: with the default RS_REGISTER_PER_IP_PER_HOUR (5) the 6th registration from one IP is 429 RATE_LIMITED, details.limit register_ip', async () => {
    assert.equal(h.config.registerPerIpPerHour, 5);
    for (let i = 1; i <= 5; i++) {
      const res = await c.register({ username: `reg-user-${i}`, password: 'a long enough password', displayName: `Reg ${i}` });
      assert.equal(res.status, 201, `registration ${i}`);
    }
    const sixth = await c.register({ username: 'reg-user-6', password: 'a long enough password', displayName: 'Reg 6' });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error.code, 'RATE_LIMITED');
    assert.equal(sixth.json.error.details.limit, 'register_ip');
    assert.match(sixth.headers['retry-after'], /^[1-9]\d*$/);
    assert.equal(sixth.headers['set-cookie'], undefined);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'reg-user-6'").get().n, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'register'").get().n, 5);
    const audit = h.db.prepare("SELECT outcome, detail_json FROM audit_events WHERE action = 'auth.register' AND outcome = 'denied'").get();
    assert.deepEqual(JSON.parse(audit.detail_json), { limit: 'register_ip' });
  });

  test('F-TR-17: the budget returns after an hour', async () => {
    h.clock.advance(60 * 60_000 + 1000);
    const res = await c.register({ username: 'reg-user-7', password: 'a long enough password', displayName: 'Reg 7' });
    assert.equal(res.status, 201);
  });

  test('F-TR-17: RS_REGISTER_PER_IP_PER_HOUR changes the limit (test mode allows more than 5)', async () => {
    const wide = await startHarness({ env: { RS_REGISTER_PER_IP_PER_HOUR: '7' } });
    try {
      const wc = client(wide);
      for (let i = 1; i <= 7; i++) assert.equal((await wc.register({ username: `wide-${i}`, password: 'a long enough password', displayName: 'W' })).status, 201);
      assert.equal((await wc.register({ username: 'wide-8', password: 'a long enough password', displayName: 'W' })).status, 429);
    } finally {
      await wide.close();
    }
  });

  test('ARCH-25: RS_ALLOW_SIGNUP=0 -> 403 SIGNUP_DISABLED and no user is created', async () => {
    const closed = await startHarness({ env: { RS_ALLOW_SIGNUP: '0' } });
    try {
      const cc = client(closed);
      const cfg = await cc.call({ path: '/api/config' });
      assert.equal(cfg.json.signupEnabled, false);
      const res = await cc.register({ username: 'closed-user', password: 'a long enough password', displayName: 'Closed' });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'SIGNUP_DISABLED');
      assert.equal(closed.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'closed-user'").get().n, 0);
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal(closed.db.prepare("SELECT outcome FROM audit_events WHERE action = 'auth.register'").get().outcome, 'denied');
    } finally {
      await closed.close();
    }
  });
});

describe('FU-6: a seeded account signs in with the seed hash', () => {
  test('FU-6: cafe1 and supplier-a (hashes written by scripts/seed.js) sign in with the shared demo password; supplierCode is set', async () => {
    const h = await startHarness({ seed: true });
    try {
      const c = client(h);
      const stored = h.db.prepare("SELECT password_hash FROM users WHERE username = 'cafe1'").get().password_hash;
      assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
      const cafe = await c.signin('cafe1', DEMO_PASSWORD);
      assert.equal(cafe.status, 200);
      assert.equal(cafe.json.user.role, 'customer');
      const supplier = await c.signin('Supplier-A', DEMO_PASSWORD);
      assert.equal(supplier.status, 200);
      assert.deepEqual({ role: supplier.json.user.role, supplierCode: supplier.json.user.supplierCode }, { role: 'supplier', supplierCode: 'A' });
      assert.equal((await c.signin('cafe2', 'not-the-demo-password')).status, 401);
    } finally {
      await h.close();
    }
  });
});

describe('RS-30: role policies end to end (anonymous 401, wrong role 403)', () => {
  let h;
  let c;
  const sids = {};
  const probes = (router) => {
    for (const policy of ['session', 'customer', 'supplier', 'admin']) {
      router.add('GET', `/api/probe/${policy}`, (ctx) => ({ status: 200, body: { id: ctx.user.id, role: ctx.user.role } }), { policy });
      router.add('POST', `/api/probe/${policy}`, (ctx) => ({ status: 200, body: { id: ctx.user.id } }), { policy });
    }
    router.add('GET', '/api/probe/public-me', (ctx) => ({ status: 200, body: { role: ctx.auth.identify(ctx)?.role ?? null } }), { policy: 'public' });
    router.add('GET', '/api/probe/public-customer-only', (ctx) => ({ status: 200, body: { id: ctx.auth.requireRole(ctx, 'customer').id } }), { policy: 'public' });
  };
  before(async () => {
    h = await startHarness({ seed: true, routes: [probes], env: { RS_TRUST_PROXY: '1', RS_ADMIN_PASSWORD: ADMIN_PASSWORD } });
    c = client(h);
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
    const login = async (role, username, password) => {
      const res = await c.signin(username, password, { from: c.ip() });
      assert.equal(res.status, 200, username);
      sids[role] = { sid: c.sidOf(res), token: res.json.csrfToken };
    };
    await login('customer', 'cafe1', DEMO_PASSWORD);
    await login('supplier', 'supplier-b', DEMO_PASSWORD);
    await login('admin', 'admin', ADMIN_PASSWORD);
  });
  after(() => h.close());

  const get = (path, who) => c.call({ path, headers: who ? c.cookieHeader(sids[who].sid) : {} });
  const post = (path, who, token) =>
    c.call({
      method: 'POST',
      path,
      jsonBody: {},
      headers: { ...(who ? c.cookieHeader(sids[who].sid) : {}), ...(token === undefined ? (who ? { 'X-CSRF-Token': sids[who].token } : {}) : token ? { 'X-CSRF-Token': token } : {}) },
    });

  test('RS-30: admin routes: anonymous 401 UNAUTHENTICATED; customer and supplier 403 FORBIDDEN; admin 200', async () => {
    const anon = await get('/api/probe/admin');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'UNAUTHENTICATED');
    for (const who of ['customer', 'supplier']) {
      const res = await get('/api/probe/admin', who);
      assert.equal(res.status, 403, who);
      assert.equal(res.json.error.code, 'FORBIDDEN');
      assert.equal((await post('/api/probe/admin', who)).status, 403, `${who} POST`);
    }
    const admin = await get('/api/probe/admin', 'admin');
    assert.equal(admin.status, 200);
    assert.equal(admin.json.role, 'admin');
    assert.equal((await post('/api/probe/admin', 'admin')).status, 200);
  });

  test('RS-30: customer routes: supplier and admin 403, anonymous 401; supplier routes: customer and admin 403', async () => {
    assert.deepEqual([(await get('/api/probe/customer')).status, (await get('/api/probe/customer', 'customer')).status, (await get('/api/probe/customer', 'supplier')).status, (await get('/api/probe/customer', 'admin')).status], [401, 200, 403, 403]);
    assert.deepEqual([(await get('/api/probe/supplier')).status, (await get('/api/probe/supplier', 'customer')).status, (await get('/api/probe/supplier', 'supplier')).status, (await get('/api/probe/supplier', 'admin')).status], [401, 403, 200, 403]);
    assert.deepEqual([(await get('/api/probe/session')).status, (await get('/api/probe/session', 'customer')).status, (await get('/api/probe/session', 'supplier')).status, (await get('/api/probe/session', 'admin')).status], [401, 200, 200, 200]);
  });

  test('T6: every state-changing route needs X-CSRF-Token equal to the session token (403 CSRF_FAILED); GET does not', async () => {
    for (const who of ['customer', 'supplier', 'admin']) {
      const path = `/api/probe/${who}`;
      for (const token of [null, 'wrong-token', sids[who === 'customer' ? 'supplier' : 'customer'].token]) {
        const res = await post(path, who, token);
        assert.equal(res.status, 403, `${who} ${token}`);
        assert.equal(res.json.error.code, 'CSRF_FAILED');
      }
      assert.equal((await post(path, who)).status, 200);
    }
    const foreign = await c.call({ method: 'POST', path: '/api/probe/customer', jsonBody: {}, headers: { ...c.cookieHeader(sids.customer.sid), 'X-CSRF-Token': sids.customer.token, Origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, 'CSRF_FAILED');
  });

  test('RS-30: a wrong-role caller without a CSRF token gets 403 FORBIDDEN (role judged before the token)', async () => {
    const res = await post('/api/probe/admin', 'customer', null);
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'FORBIDDEN');
  });

  test('RS-30: public routes can read the user (identify) or gate by role (requireRole) themselves', async () => {
    assert.equal((await get('/api/probe/public-me')).json.role, null);
    assert.equal((await get('/api/probe/public-me', 'supplier')).json.role, 'supplier');
    assert.equal((await get('/api/probe/public-customer-only')).status, 401);
    assert.equal((await get('/api/probe/public-customer-only', 'admin')).status, 403);
    assert.equal((await get('/api/probe/public-customer-only', 'customer')).status, 200);
  });

  test('RS-30: a disabled user loses the session at once (admin routes included)', async () => {
    const res = await c.signin('supplier-c', DEMO_PASSWORD, { from: c.ip() });
    const sid = c.sidOf(res);
    assert.equal((await c.call({ path: '/api/probe/supplier', headers: c.cookieHeader(sid) })).status, 200);
    h.db.prepare("UPDATE users SET disabled = 1 WHERE username = 'supplier-c'").run();
    const after403 = await c.call({ path: '/api/probe/supplier', headers: c.cookieHeader(sid) });
    assert.equal(after403.status, 401);
  });

  test('RS-30: role comes from the database row each request, never from the cookie or a request field', async () => {
    const reg = await c.register({ username: 'sneaky', password: 'a long enough password', displayName: 'S', role: 'admin' }, { from: c.ip() });
    const sid = c.sidOf(reg);
    assert.equal((await c.call({ path: '/api/probe/admin', headers: { ...c.cookieHeader(sid), 'X-Role': 'admin' } })).status, 403);
    assert.equal((await c.call({ path: '/api/probe/admin?role=admin', headers: c.cookieHeader(sid) })).status, 403);
  });
});

describe('RS-30: the admin account follows RS_ADMIN_PASSWORD (SEC-5)', () => {
  test('RS-30: with RS_ADMIN_PASSWORD unset the admin account is disabled: sign-in is 401 and no session exists', async () => {
    const h = await startHarness();
    try {
      const c = client(h);
      assert.equal(h.config.adminPassword, null);
      assert.equal(await ensureAdmin({ db: h.db, config: h.config, clock: h.clock }), 'disabled');
      for (const password of [ADMIN_PASSWORD, 'admin', '']) {
        const res = await c.signin('admin', password || 'x', { from: undefined });
        assert.ok([401, 429].includes(res.status));
        assert.notEqual(res.status, 200);
      }
      assert.equal(h.db.prepare("SELECT disabled FROM users WHERE username = 'admin'").get().disabled, 1);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    } finally {
      await h.close();
    }
  });

  test('RS-30: with RS_ADMIN_PASSWORD set the admin signs in with role admin; the value is a scrypt hash and not in logs', async () => {
    const h = await startHarness({ env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD } });
    try {
      const c = client(h);
      assert.equal(await ensureAdmin({ db: h.db, config: h.config, clock: h.clock }), 'created');
      const res = await c.signin('admin', ADMIN_PASSWORD);
      assert.equal(res.status, 200);
      assert.equal(res.json.user.role, 'admin');
      const row = h.db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
      assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
      assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
      assert.ok(!h.lines.join('\n').includes(ADMIN_PASSWORD));
      assert.ok(!res.text.includes(ADMIN_PASSWORD));
    } finally {
      await h.close();
    }
  });
});

describe('ARCH-25: audit events for sign-out and register', () => {
  test('ARCH-25: sign-out and register write audit rows with ids and codes only', async () => {
    const h = await startHarness();
    try {
      const c = client(h);
      const reg = await c.register({ username: 'audited-cafe', password: 'a long enough password', displayName: 'Audited Cafe' });
      assert.equal(reg.status, 201);
      const out = await c.post('/api/auth/signout', {}, { token: reg.json.csrfToken, sid: c.sidOf(reg) });
      assert.equal(out.status, 200);
      const taken = await c.register({ username: 'AUDITED-CAFE', password: 'a long enough password', displayName: 'Again' });
      assert.equal(taken.status, 409);
      const rows = h.db.prepare("SELECT action, outcome, actor_role, entity_type, entity_id, detail_json FROM audit_events ORDER BY id").all();
      assert.deepEqual(rows.map((r) => `${r.action}:${r.outcome}`), ['auth.register:ok', 'auth.signout:ok', 'auth.register:failed']);
      assert.equal(rows[0].entity_id, reg.json.user.id);
      assert.equal(rows[0].actor_role, 'customer');
      assert.deepEqual(JSON.parse(rows[2].detail_json), { reason: 'username_taken' });
      assert.ok(!JSON.stringify(rows).toLowerCase().includes('audited-cafe'), 'no username in audit rows');
      assert.ok(!JSON.stringify(rows).includes('a long enough password'));
    } finally {
      await h.close();
    }
  });
});
