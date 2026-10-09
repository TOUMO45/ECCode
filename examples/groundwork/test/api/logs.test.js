import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD } from '../support/harness.js';

function sink() {
  const lines = [];
  return { lines, write(s) { lines.push(...String(s).split('\n').filter(Boolean)); }, text: () => lines.join('\n') };
}

test('one JSON line per request with the documented fields; no secrets, bodies or cookies', async () => {
  const out = sink();
  const s = await startApp({ logStream: out });
  try {
    const secretNote = 'CANARY-NOTE-TEXT-93717';
    const c = s.anon();
    await c.primeCsrf();
    const login = await c.post('/api/auth/login', { username: 'a-lead', password: PASSWORD });
    c.csrfToken = login.json.csrfToken;
    const sid = c.jar.get('gw_sid');
    await c.get('/api/me');
    await c.post('/api/users', { username: 'logcheck', displayName: secretNote, password: 'CANARY-PASSWORD-55120', role: 'viewer' });
    await c.get('/api/audit?limit=5&before=99999');
    await c.get('/api/does-not-exist');
    await c.post('/api/auth/login', { username: 'a-lead', password: 'WRONG-CANARY-PW-77' });
    await s.anon().post('/api/auth/login', { username: 'a-lead', password: 'WRONG-CANARY-PW-78' }, { csrf: false });

    const all = out.text();
    for (const secret of [PASSWORD, 'CANARY-PASSWORD-55120', 'WRONG-CANARY-PW', secretNote, sid, login.json.csrfToken, 'scrypt$', 'gw_sid', 'cookie', 'before=99999']) {
      assert.ok(!all.includes(secret), `log leaked ${secret}`);
    }
    const recs = out.lines.map((l) => JSON.parse(l));
    const reqs = recs.filter((r) => r.method);
    assert.ok(reqs.length >= 8);
    for (const r of reqs) {
      for (const k of ['ts', 'requestId', 'method', 'route', 'status', 'durationMs', 'userId', 'errorCode']) assert.ok(k in r, `${k} missing`);
      assert.equal(typeof r.durationMs, 'number');
      assert.match(r.requestId, /^[A-Za-z0-9-]{8,64}$/);
    }
    const me = reqs.find((r) => r.route === '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.userId, s.users.aLead.id);
    assert.ok(reqs.find((r) => r.route === '/api/*' && r.status === 404 && r.errorCode === 'NOT_FOUND'));
    assert.ok(reqs.find((r) => r.route === '/api/auth/login' && r.status === 401 && r.errorCode === 'INVALID_CREDENTIALS'));
    assert.ok(reqs.find((r) => r.status === 403 && r.errorCode === 'CSRF_FAILED'));
    // templates, not concrete values
    assert.ok(reqs.every((r) => !/\d{4,}/.test(r.route)));
  } finally { await s.close(); }
});

test('internal faults give the generic envelope; the marker reaches neither response nor log', async () => {
  const out = sink();
  const s = await startApp({ logStream: out });
  try {
    const MARK = 'SECRET-MARKER-/etc/passwd-SELECT * FROM x';
    s.app.ctx.router.get('/api/boom', { action: 'me' }, async () => { throw new Error(MARK); });
    s.app.ctx.router.get('/api/boom-weird', { action: 'me' }, async () => { throw Object.assign(new TypeError(MARK), { code: 'ERR_X', stack: MARK }); });
    s.app.ctx.router.get('/api/boom-str', { action: 'me' }, async () => { throw MARK; }); // eslint-disable-line no-throw-literal
    const c = await s.client('aLead');
    for (const p of ['/api/boom', '/api/boom-weird', '/api/boom-str']) {
      const r = await c.get(p);
      assert.equal(r.status, 500, p);
      assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'message', 'requestId']);
      assert.equal(r.json.error.code, 'INTERNAL');
      assert.equal(r.json.error.message, 'Something went wrong');
      assert.equal(r.json.error.requestId, r.headers.get('x-request-id'));
      assert.ok(!r.text.includes('SECRET') && !/\bat \w|node_modules|\.js:/.test(r.text));
    }
    assert.ok(!out.text().includes('SECRET-MARKER') && !out.text().includes('/etc/passwd'));
    const errLines = out.lines.map((l) => JSON.parse(l)).filter((r) => r.level === 'error');
    assert.equal(errLines.length, 3);
    assert.equal(errLines[0].errorClass, 'Error');

    // DB closed mid-flight -> still the generic envelope
    s.db.close();
    const r = await s.anon().get('/api/health');
    assert.equal(r.status, 500);
    assert.equal(r.json.error.code, 'INTERNAL');
    assert.ok(!/sqlite|database|statement/i.test(r.text));
  } finally { await s.close(); }
});

test('GW_LOG=off writes nothing', async () => {
  const out = sink();
  const s = await startApp({ logStream: out, config: { log: 'off' } });
  try {
    await s.anon().get('/api/health');
    assert.equal(out.lines.length, 0);
  } finally { await s.close(); }
});
