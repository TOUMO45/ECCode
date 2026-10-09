// API test harness: startApp({providers, clock, config, logStream, publicDir, dbPath})
// -> { url, db, app, clock, users, client(userKey), anon(), close() }.
// Seeds teams A and B (lead, responder, viewer each).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';

export const PASSWORD = 'correct-horse-1';
const NOW = '2026-10-08T00:00:00.000Z';

let sharedHash;
async function hash() {
  sharedHash ??= await hashPassword(PASSWORD);
  return sharedHash;
}

/** Users by key: aLead, aResponder, aViewer, bLead, bResponder, bViewer. */
export const USERS = {};
for (const [t, tn] of [['a', 'Team A'], ['b', 'Team B']]) {
  for (const role of ['lead', 'responder', 'viewer']) {
    USERS[`${t}${role[0].toUpperCase()}${role.slice(1)}`] = { username: `${t}-${role}`, role, team: tn };
  }
}

export function makeClock(start = Date.parse('2026-10-08T12:00:00.000Z')) {
  const c = () => c.now;
  c.now = start;
  c.advance = (ms) => { c.now += ms; };
  return c;
}

export function seedTeams(db, passwordHash) {
  const teamIds = {};
  for (const tn of ['Team A', 'Team B']) {
    teamIds[tn] = Number(db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(tn, NOW).lastInsertRowid);
  }
  for (const [key, u] of Object.entries(USERS)) {
    const id = Number(db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
      VALUES (?,?,?,?,?,?)`).run(teamIds[u.team], u.username, `${u.team} ${u.role}`, u.role, passwordHash, NOW).lastInsertRowid);
    u.id = id;
    u.teamId = teamIds[u.team];
    u.key = key;
  }
  return teamIds;
}

class Client {
  constructor(url) {
    this.url = url;
    this.jar = new Map();
    this.csrfToken = null;
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (gone) this.jar.delete(name); else this.jar.set(name, value);
    }
  }

  /** opts: { body (object -> JSON), rawBody, headers, csrf (false to omit, string to override) } */
  async request(method, p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const cookie = this.cookieHeader();
    if (cookie && !('cookie' in headers)) headers.cookie = cookie;
    if (opts.csrf !== false && method !== 'GET' && method !== 'HEAD') {
      const t = typeof opts.csrf === 'string' ? opts.csrf : (this.jar.get('gw_csrf') ?? this.csrfToken);
      if (t) headers['x-csrf-token'] = t;
    }
    let body;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
    }
    const res = await fetch(this.url + p, { method, headers, body, redirect: 'manual' });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }

  get(p, o) { return this.request('GET', p, o); }
  post(p, body, o = {}) { return this.request('POST', p, { ...o, body }); }
  put(p, body, o = {}) { return this.request('PUT', p, { ...o, body }); }
  patch(p, body, o = {}) { return this.request('PATCH', p, { ...o, body }); }
  delete(p, o) { return this.request('DELETE', p, o); }

  async primeCsrf() {
    const r = await this.get('/api/csrf');
    this.csrfToken = r.json.csrfToken;
    return r;
  }

  async login(username, password = PASSWORD) {
    await this.primeCsrf();
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status === 200) this.csrfToken = r.json.csrfToken;
    return r;
  }
}

export async function startApp({
  providers = {}, clock = makeClock(), config = {}, logStream, publicDir, dbPath, seedUsers = true, env = {},
} = {}) {
  let tmp;
  if (!dbPath) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
    dbPath = path.join(tmp, 'test.db');
  }
  const cfg = { ...loadConfig({ GW_DB_PATH: dbPath, PORT: '0', GW_LOG: logStream ? 'json' : 'off', ...env }), ...config };
  const db = openDb(dbPath);
  migrate(db);
  if (seedUsers) seedTeams(db, await hash());
  const app = await createApp({ config: cfg, db, providers, clock, logStream, publicDir });
  const { url } = await app.listen(0, '127.0.0.1');
  const clients = new Set();
  return {
    url, db, app, clock, config: cfg, users: USERS, dbPath,
    anon() { const c = new Client(url); clients.add(c); return c; },
    /** Logged-in client for a user key (e.g. 'aLead'). */
    async client(key) {
      const c = new Client(url);
      clients.add(c);
      const r = await c.login(USERS[key].username);
      if (r.status !== 200) throw new Error(`login failed for ${key}: ${r.status}`);
      return c;
    },
    async close({ keepDb = false } = {}) {
      await app.close();
      try { db.close(); } catch { /* already closed */ }
      if (tmp && !keepDb) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export { Client };
