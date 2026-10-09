import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { createCsrf } from '../../../src/auth/csrf.js';
import { createSessions, IDLE_MS, ABSOLUTE_MS } from '../../../src/auth/sessions.js';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO teams (id,name,created_at) VALUES (1,'T','x')").run();
  db.prepare("INSERT INTO users (id,team_id,username,display_name,role,password_hash,created_at) VALUES (1,1,'u','U','lead','h','x')").run();
  const clock = { now: Date.parse('2026-10-08T00:00:00Z') };
  const sessions = createSessions({ db, clock: () => clock.now, csrf: createCsrf(crypto.randomBytes(32)) });
  return { db, clock, sessions };
}

test('create stores only a hash; lookup returns the user', () => {
  const { db, sessions } = setup();
  const s = sessions.create(1);
  const row = db.prepare('SELECT id_hash FROM sessions').get();
  assert.notEqual(row.id_hash, s.id);
  assert.equal(row.id_hash, crypto.createHash('sha256').update(s.id).digest('hex'));
  const found = sessions.lookup(s.id);
  assert.equal(found.user.username, 'u');
  assert.equal(found.csrfToken, s.csrfToken);
  assert.equal(sessions.lookup('not-a-session-id-not-a-session'), null);
});

test('every create yields a distinct id', () => {
  const { sessions } = setup();
  assert.notEqual(sessions.create(1).id, sessions.create(1).id);
});

test('idle expiry (30 min) with sliding refresh', () => {
  const { sessions, clock } = setup();
  const s = sessions.create(1);
  clock.now += IDLE_MS - 1000;
  assert.ok(sessions.lookup(s.id));
  clock.now += IDLE_MS - 1000; // refreshed above, still alive
  assert.ok(sessions.lookup(s.id));
  clock.now += IDLE_MS;
  assert.equal(sessions.lookup(s.id), null);
  assert.equal(sessions.lookup(s.id), null);
});

test('absolute expiry (8 h) even with constant activity', () => {
  const { sessions, clock, db } = setup();
  const s = sessions.create(1);
  for (let t = 0; t + 20 * 60_000 < ABSOLUTE_MS; t += 10 * 60_000) {
    clock.now += 10 * 60_000;
    assert.ok(sessions.lookup(s.id), `alive at +${t}`);
  }
  clock.now += 20 * 60_000;
  assert.equal(sessions.lookup(s.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0);
});

test('disabled user session is rejected; purge removes expired rows', () => {
  const { sessions, clock, db } = setup();
  const s = sessions.create(1);
  db.prepare('UPDATE users SET disabled = 1').run();
  assert.equal(sessions.lookup(s.id), null);
  db.prepare('UPDATE users SET disabled = 0').run();
  sessions.create(1);
  clock.now += ABSOLUTE_MS + 1;
  assert.equal(sessions.purgeExpired(), 1);
});

test('last_seen refreshed at most once a minute', () => {
  const { sessions, clock, db } = setup();
  const s = sessions.create(1);
  const before = db.prepare('SELECT last_seen_at l FROM sessions').get().l;
  clock.now += 30_000;
  sessions.lookup(s.id);
  assert.equal(db.prepare('SELECT last_seen_at l FROM sessions').get().l, before);
  clock.now += 31_000;
  sessions.lookup(s.id);
  assert.notEqual(db.prepare('SELECT last_seen_at l FROM sessions').get().l, before);
});
