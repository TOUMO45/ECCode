// Unit tests for src/services/users.js and src/services/audit.js (SEC-5, RS-30, audit events).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Secret } from '../../../src/config.js';
import { verifyPassword } from '../../../src/auth/password.js';
import { createSessionStore } from '../../../src/auth/sessions.js';
import { AppError } from '../../../src/http/envelope.js';
import { recordAudit, sanitizeDetail } from '../../../src/services/audit.js';
import { createCustomer, disableUser, ensureAdmin, findByUsernameKey, toPublicUser } from '../../../src/services/users.js';
import { insertUser, openTestDb } from './helpers.js';

const ADMIN_PASSWORD = 'admin-password-0123456789';

describe('SEC-5: admin bootstrap from RS_ADMIN_PASSWORD', () => {
  const t = openTestDb();
  after(() => t.close());
  const row = () => t.db.prepare("SELECT * FROM users WHERE username = 'admin'").get();

  test('SEC-5: unset password -> a disabled admin row with an unusable hash (every admin route unreachable)', async () => {
    assert.equal(await ensureAdmin({ db: t.db, config: { adminPassword: null }, clock: t.clock }), 'disabled');
    assert.equal(row().disabled, 1);
    assert.equal(row().role, 'admin');
    assert.equal(await ensureAdmin({ db: t.db, config: { adminPassword: null }, clock: t.clock }), 'disabled', 'idempotent');
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'admin'").get().n, 1);
  });

  test('SEC-5: a password creates or re-enables the account as a scrypt hash, and never stores the text', async () => {
    const config = { adminPassword: new Secret(ADMIN_PASSWORD) };
    assert.equal(await ensureAdmin({ db: t.db, config, clock: t.clock }), 'updated');
    const stored = row();
    assert.equal(stored.disabled, 0);
    assert.match(stored.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!stored.password_hash.includes(ADMIN_PASSWORD));
    assert.equal(await verifyPassword(ADMIN_PASSWORD, stored.password_hash), true);
    assert.equal(await ensureAdmin({ db: t.db, config, clock: t.clock }), 'unchanged', 'same password: no rewrite');
    assert.equal(row().password_hash, stored.password_hash);
  });

  test('SEC-5: a changed password rewrites the hash and ends the admin sessions; unsetting it disables the account and ends them', async () => {
    const sessions = createSessionStore({ db: t.db, clock: t.clock });
    const first = sessions.create(row().id);
    const config = { adminPassword: new Secret('a-different-admin-password-1') };
    assert.equal(await ensureAdmin({ db: t.db, config, clock: t.clock }), 'updated');
    assert.equal(sessions.resolve(first.id), null, 'old sessions end with the old password');
    assert.equal(await verifyPassword('a-different-admin-password-1', row().password_hash), true);
    assert.equal(await verifyPassword(ADMIN_PASSWORD, row().password_hash), false);
    const second = sessions.create(row().id);
    assert.equal(await ensureAdmin({ db: t.db, config: { adminPassword: null }, clock: t.clock }), 'disabled');
    assert.equal(row().disabled, 1);
    assert.equal(sessions.resolve(second.id), null);
  });

  test('SEC-5: a non-admin account that owns the name stops startup rather than being promoted', async () => {
    const other = openTestDb();
    try {
      insertUser(other.db, { username: 'admin', role: 'customer' });
      await assert.rejects(() => ensureAdmin({ db: other.db, config: { adminPassword: new Secret(ADMIN_PASSWORD) }, clock: other.clock }), /non-admin/);
      assert.equal(other.db.prepare("SELECT role FROM users WHERE username = 'admin'").get().role, 'customer');
    } finally {
      other.close();
    }
  });
});

describe('RS-30: users service', () => {
  const t = openTestDb();
  after(() => t.close());

  test('RS-30: createCustomer always inserts role customer with no supplier, and a taken name (any case) is 409 USERNAME_TAKEN', () => {
    const id = createCustomer(t.db, t.clock, { username: 'Cafe42', passwordHash: 'scrypt$x', displayName: 'Cafe 42' });
    const row = t.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    assert.equal(row.role, 'customer');
    assert.equal(row.supplier_id, null);
    assert.equal(row.disabled, 0);
    for (const again of ['Cafe42', 'cafe42', 'CAFE42']) {
      assert.throws(
        () => createCustomer(t.db, t.clock, { username: again, passwordHash: 'scrypt$x', displayName: 'x' }),
        (err) => err instanceof AppError && err.status === 409 && err.code === 'USERNAME_TAKEN',
      );
    }
  });

  test('SEC-9: the lookup key is lower(NFC(trim)) and matches the NOCASE column', () => {
    assert.equal(findByUsernameKey(t.db, 'cafe42').username, 'Cafe42');
    assert.equal(findByUsernameKey(t.db, 'nobody'), null);
  });

  test('RS-30: toPublicUser exposes exactly the User contract fields', () => {
    const user = findByUsernameKey(t.db, 'cafe42');
    assert.deepEqual(Object.keys(toPublicUser(user)).sort(), ['displayName', 'id', 'role', 'supplierCode', 'username']);
    assert.equal(JSON.stringify(toPublicUser(user)).includes('scrypt'), false, 'no hash in the public object');
  });

  test('ARCH-25: disabling a user deletes their sessions', () => {
    const sessions = createSessionStore({ db: t.db, clock: t.clock });
    const id = findByUsernameKey(t.db, 'cafe42').id;
    const s = sessions.create(id);
    assert.equal(disableUser(t.db, id), 1);
    assert.equal(sessions.resolve(s.id), null);
  });
});

describe('ARCH-25: audit events', () => {
  const t = openTestDb();
  after(() => t.close());

  test('ARCH-25: recordAudit writes one append-only row with sanitised detail', () => {
    const id = recordAudit(t.db, t.clock, {
      actorUserId: 5,
      actorRole: 'customer',
      action: 'auth.signin',
      entityType: 'user',
      entityId: 5,
      outcome: 'ok',
      detail: { reason: 'x', n: 3, ok: true, secret: 'has spaces and symbols <>', nested: { a: 1 }, list: [1], big: 1e30, 'bad key': 1 },
      requestId: 'req-12345678',
    });
    const row = t.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id);
    assert.equal(row.action, 'auth.signin');
    assert.equal(row.outcome, 'ok');
    assert.equal(row.request_id, 'req-12345678');
    assert.deepEqual(JSON.parse(row.detail_json), { reason: 'x', n: 3, ok: true });
    assert.throws(() => t.db.prepare('UPDATE audit_events SET outcome = ? WHERE id = ?').run('failed', id), /append-only/);
    assert.throws(() => t.db.prepare('DELETE FROM audit_events WHERE id = ?').run(id), /append-only/);
  });

  test('ARCH-25: bad outcomes, actions and roles are programming errors, and a bad request id is dropped', () => {
    const base = { action: 'auth.signin', entityType: 'user', outcome: 'ok' };
    assert.throws(() => recordAudit(t.db, t.clock, { ...base, outcome: 'maybe' }), TypeError);
    assert.throws(() => recordAudit(t.db, t.clock, { ...base, action: 'Auth Signin' }), TypeError);
    assert.throws(() => recordAudit(t.db, t.clock, { ...base, actorRole: 'ADMIN; DROP' }), TypeError);
    const id = recordAudit(t.db, t.clock, { ...base, requestId: 'bad id with spaces' });
    assert.equal(t.db.prepare('SELECT request_id FROM audit_events WHERE id = ?').get(id).request_id, null);
    assert.deepEqual(sanitizeDetail(null), {});
    assert.deepEqual(sanitizeDetail([1, 2]), {});
  });
});
