import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { seed, DEMO_PASSWORD } from '../../../scripts/seed.js';
import { setPassword } from '../../../scripts/set-password.js';
import { verifyPassword } from '../../../src/auth/password.js';
import { assertSafeApiUrl } from '../../../src/index.js';
import { Router } from '../../../src/http/router.js';
import { registerRoutes } from '../../../src/routes/index.js';
import { hashPassword } from '../../../src/auth/password.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('seed creates Platform and Payments with lead/responder/viewer and one sample incident; second run is a no-op', async () => {
  const db = fresh();
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const first = await seed(db, { passwordHash });
  assert.deepEqual(first, { teams: 2, users: 6, incidents: 1 });
  const second = await seed(db, { passwordHash });
  assert.deepEqual(second, { teams: 0, users: 0, incidents: 0 });
  const rows = db.prepare('SELECT t.name, u.role FROM users u JOIN teams t ON t.id = u.team_id ORDER BY t.name, u.role').all();
  assert.deepEqual(rows.map((r) => `${r.name}:${r.role}`), [
    'Payments:lead', 'Payments:responder', 'Payments:viewer', 'Platform:lead', 'Platform:responder', 'Platform:viewer']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM incidents').get().c, 1);
  const inc = db.prepare('SELECT i.id, i.notes_rev, t.name FROM incidents i JOIN teams t ON t.id = i.team_id').get();
  assert.equal(inc.name, 'Platform');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM note_lines WHERE incident_id = ?').get(inc.id).c, inc.notes_rev === 1 ? 6 : -1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM drafts').get().c, 0);
  const u = db.prepare("SELECT password_hash FROM users WHERE username = 'platform-lead'").get();
  assert.ok(u.password_hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword(DEMO_PASSWORD, u.password_hash), true);
});

test('set-password validates, updates the hash and revokes sessions', async () => {
  const db = fresh();
  await seed(db, { passwordHash: await hashPassword(DEMO_PASSWORD) });
  db.prepare("INSERT INTO sessions (id_hash,user_id,csrf_token,created_at,last_seen_at,expires_at) SELECT 'h',id,'c','x','x','x' FROM users WHERE username='platform-lead'").run();
  await assert.rejects(() => setPassword(db, 'platform-lead', 'short'), /10..128/);
  await assert.rejects(() => setPassword(db, 'nobody', 'long-enough-pw-1'), /no such user/);
  await setPassword(db, 'platform-lead', 'brand-new-password');
  const u = db.prepare("SELECT password_hash FROM users WHERE username = 'platform-lead'").get();
  assert.equal(await verifyPassword('brand-new-password', u.password_hash), true);
  assert.equal(await verifyPassword(DEMO_PASSWORD, u.password_hash), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0);
});

test('API URL must be https unless loopback', () => {
  assert.doesNotThrow(() => assertSafeApiUrl('https://api.anthropic.com'));
  assert.doesNotThrow(() => assertSafeApiUrl('http://127.0.0.1:9999'));
  assert.doesNotThrow(() => assertSafeApiUrl('http://localhost:9999'));
  assert.throws(() => assertSafeApiUrl('http://api.example.com'), /https/);
  assert.throws(() => assertSafeApiUrl('ftp://x'), /https/);
  assert.throws(() => assertSafeApiUrl('not a url'), /valid URL/);
});

test('routes/index.js auto-registers every route module and rejects modules without a register function', async () => {
  const router = new Router();
  const ctx = { config: { cookieSecure: false }, version: '1', db: null, csrf: null, sessions: null, audit: null, users: null, limiter: null, publicDir: '/x' };
  const files = await registerRoutes(router, ctx);
  for (const f of ['audit.js', 'auth.js', 'health.js', 'static.js', 'users.js']) assert.ok(files.includes(f), f);
  assert.ok(!files.includes('index.js'));
  assert.ok(router.match('GET', '/api/health').route);
  assert.ok(router.match('POST', '/api/auth/login').route);
  assert.ok(router.fallback);
});

test('router: every authenticated route must declare an RBAC action (default deny)', () => {
  const r = new Router();
  assert.throws(() => r.get('/api/x', {}, async () => {}), /RBAC action/);
  assert.doesNotThrow(() => r.get('/api/x', { auth: 'none' }, async () => {}));
});

test('process: src/index.js boots, serves /api/health, persists across restart, exits 0 on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-proc-'));
  const dbPath = path.join(dir, 'p.db');
  const root = path.resolve(import.meta.dirname, '../../..');
  const env = { PATH: process.env.PATH, PORT: '0', GW_DB_PATH: dbPath, HOST: '127.0.0.1' };
  async function run(fn) {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { out += d; const m = /"url":"([^"]+)"/.exec(out); if (m) resolve(m[1]); });
      child.on('exit', (c) => reject(new Error(`exited ${c}`)));
      setTimeout(() => reject(new Error('timeout')), 10000).unref();
    });
    try { await fn(url); } finally {
      const code = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGTERM'); });
      assert.equal(code, 0);
    }
  }
  try {
    await run(async (url) => {
      const r = await fetch(`${url}/api/health`);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).schemaVersion, 2);
      const db = openDb(dbPath);
      await seed(db, { passwordHash: await hashPassword(DEMO_PASSWORD) });
      db.close();
    });
    await run(async (url) => {
      const jar = (await fetch(`${url}/api/csrf`));
      const token = (await jar.json()).csrfToken;
      const login = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: `gw_csrf=${token}` },
        body: JSON.stringify({ username: 'platform-lead', password: DEMO_PASSWORD }),
      });
      assert.equal(login.status, 200); // data (and the CSRF key in meta) survived the restart
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('process: refuses to start with a non-https remote API URL', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src/index.js')], {
    env: { PATH: process.env.PATH, PORT: '0', GW_DB_PATH: ':memory:', GW_ANTHROPIC_URL: 'http://api.example.com' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /https/);
});
