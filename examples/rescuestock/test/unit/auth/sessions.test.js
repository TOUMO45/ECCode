// Unit tests for src/auth/sessions.js (ARCH-25, T7).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ABSOLUTE_MS, IDLE_MS, TOUCH_INTERVAL_MS, createSessionStore } from '../../../src/auth/sessions.js';
import { insertUser, openTestDb } from './helpers.js';

describe('ARCH-25: session store', () => {
  let t;
  let store;
  let userId;
  before(() => {
    t = openTestDb();
    store = createSessionStore({ db: t.db, clock: t.clock });
    userId = insertUser(t.db, { username: 'cafe9' });
  });
  after(() => t.close());

  test('ARCH-25: the id is 43 base64url characters and only sha256(id) is stored (T7)', () => {
    const { id, csrfToken } = store.create(userId);
    assert.match(id, /^[A-Za-z0-9_-]{43}$/);
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const rows = t.db.prepare('SELECT * FROM sessions').all();
    const mine = rows.find((r) => r.id_hash === createHash('sha256').update(id).digest('hex'));
    assert.ok(mine, 'the row is keyed by sha256(id)');
    for (const row of rows) for (const value of Object.values(row)) assert.notEqual(value, id, 'the raw id is not stored anywhere');
    assert.equal(mine.expires_at, new Date(t.clock.now() + ABSOLUTE_MS).toISOString());
    const found = store.resolve(id);
    assert.equal(found.user.id, userId);
    assert.equal(found.user.role, 'customer');
    assert.equal(found.session.csrfToken, csrfToken);
    store.destroy(id);
  });

  test('ARCH-25: ids differ between sessions and a malformed or unknown id resolves to nothing', () => {
    const a = store.create(userId);
    const b = store.create(userId);
    assert.notEqual(a.id, b.id);
    for (const bad of [undefined, null, '', 'short', `${a.id}x`, 'é'.repeat(43), `${a.id.slice(0, 42)}!`, 'A'.repeat(43)]) {
      assert.equal(store.resolve(bad), null, String(bad));
    }
    store.destroy(a.id);
    store.destroy(b.id);
  });

  test('ARCH-25: idle timeout is 60 minutes and last_seen is refreshed at most once per minute', () => {
    const { id } = store.create(userId);
    const seen = () => t.db.prepare('SELECT last_seen_at FROM sessions WHERE id_hash = ?').get(createHash('sha256').update(id).digest('hex')).last_seen_at;
    const first = seen();
    t.clock.advance(TOUCH_INTERVAL_MS - 1000);
    assert.ok(store.resolve(id));
    assert.equal(seen(), first, 'not refreshed inside a minute');
    t.clock.advance(1000);
    assert.ok(store.resolve(id));
    assert.notEqual(seen(), first, 'refreshed after a minute');
    // Stay active for longer than the idle limit in total: each step is below the limit.
    for (let i = 0; i < 4; i++) {
      t.clock.advance(IDLE_MS - 60_000);
      assert.ok(store.resolve(id), `still valid after step ${i}`);
    }
    t.clock.advance(IDLE_MS);
    assert.equal(store.resolve(id), null, 'idle for 60 minutes ends the session');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(createHash('sha256').update(id).digest('hex')).n, 0, 'the dead row is removed');
  });

  test('ARCH-25: the absolute lifetime is 12 hours however active the session is', () => {
    const { id } = store.create(userId);
    const start = t.clock.now();
    while (t.clock.now() - start < ABSOLUTE_MS - 30 * 60_000) {
      t.clock.advance(30 * 60_000);
      assert.ok(store.resolve(id), 'active within 12 h');
    }
    t.clock.set(start + ABSOLUTE_MS - 1);
    assert.ok(store.resolve(id), 'one millisecond before the limit');
    t.clock.set(start + ABSOLUTE_MS);
    assert.equal(store.resolve(id), null, 'dead at 12 h');
  });

  test('ARCH-25: disabling a user (sessions deleted) and a disabled flag both end the session', () => {
    const other = insertUser(t.db, { username: 'cafe10' });
    const { id } = store.create(other);
    assert.ok(store.resolve(id));
    t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(other);
    assert.equal(store.resolve(id), null, 'a session of a disabled user does not resolve');
    const again = store.create(other);
    assert.equal(store.destroyForUser(other), 1);
    assert.equal(store.resolve(again.id), null);
  });

  test('ARCH-25: purgeExpired removes dead rows only', () => {
    const live = store.create(userId);
    const old = store.create(userId);
    t.clock.advance(IDLE_MS + 1);
    const fresh = store.create(userId);
    store.resolve(live.id); // idle-expired, removed on lookup
    store.purgeExpired();
    assert.equal(store.resolve(old.id), null);
    assert.ok(store.resolve(fresh.id));
  });
});
