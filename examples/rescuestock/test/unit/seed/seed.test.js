import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedClock, localDateInZone, zonedTimeToUtcMs } from '../../../src/clock.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { createLogger } from '../../../src/log.js';
import { RS_FIX_1, demoAccounts, hashPassword, seedDatabase } from '../../../scripts/seed.js';
import { tempDir } from '../http/app-fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLOCK = fixedClock(Date.UTC(2026, 9, 20, 6, 0, 0)); // 09:00 Asia/Amman
const SHARED = 'shared-demo-password-1';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db, { clock: CLOCK });
  return db;
}

function verifyHash(password, stored) {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  assert.equal(scheme, 'scrypt');
  const derived = scryptSync(password, Buffer.from(salt, 'base64url'), 64, { N: Number(n), r: Number(r), p: Number(p) });
  const expected = Buffer.from(key, 'base64url');
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}

function seeded(options = {}) {
  const db = freshDb();
  const result = seedDatabase(db, { clock: CLOCK, demoDate: '2026-10-20', ...options });
  return { db, result };
}

test('RS-FIX-1: suppliers A-E are loaded as demo suppliers with merchant keys A-E', () => {
  const { db, result } = seeded();
  assert.equal(result.seeded, true);
  const rows = db.prepare('SELECT code, name, pickup_address, paypal_merchant_key, demo FROM suppliers ORDER BY code').all();
  assert.deepEqual(rows.map((r) => r.code), ['A', 'B', 'C', 'D', 'E']);
  for (const r of rows) {
    assert.equal(r.demo, 1);
    assert.equal(r.paypal_merchant_key, r.code);
    assert.ok(r.name.length > 0 && r.pickup_address.length > 0);
  }
  db.close();
});

test('RS-FIX-1: each supplier has one bundle with the fixture quantities, 250 ml cups and the fixture diameters (C lid 95 mm)', () => {
  const { db } = seeded();
  const bundles = db
    .prepare(
      "SELECT s.code, p.id, p.capacity_ml, p.diameter_mm, p.demo FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.kind = 'bundle' ORDER BY s.code",
    )
    .all();
  assert.deepEqual(bundles.map((b) => b.code), ['A', 'B', 'C', 'D', 'E']);
  const expected = { A: [100, 90], B: [100, 90], C: [200, 95], D: [200, 90], E: [100, 90] };
  for (const bundle of bundles) {
    assert.equal(bundle.capacity_ml, 250);
    assert.equal(bundle.demo, 1);
    const items = db
      .prepare(
        'SELECT p.kind, p.diameter_mm, p.capacity_ml, bi.qty FROM bundle_items bi JOIN products p ON p.id = bi.item_product_id WHERE bi.bundle_product_id = ? ORDER BY p.kind',
      )
      .all(bundle.id);
    assert.deepEqual(items.map((i) => i.kind), ['cup', 'lid']);
    const [cup, lid] = items;
    assert.equal(cup.qty, expected[bundle.code][0]);
    assert.equal(lid.qty, expected[bundle.code][0]);
    assert.equal(cup.diameter_mm, 90);
    assert.equal(cup.capacity_ml, 250);
    assert.equal(lid.diameter_mm, expected[bundle.code][1], `lid diameter of ${bundle.code}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE kind = 'bundle'").get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compatibility').get().n, 0, 'no confirmed compatibility row, so C stays incompatible');
  db.close();
});

test('RS-FIX-1: one active demo offer per bundle with the fixture price, prep fee and ready time', () => {
  const { db } = seeded();
  const offers = db
    .prepare(
      "SELECT s.code, o.price_cents, o.prep_fee_cents, o.ready_at, o.version, o.status, o.demo FROM offers o JOIN suppliers s ON s.id = o.supplier_id ORDER BY s.code",
    )
    .all();
  const expected = {
    A: [3000, 1000, '2026-10-20T07:00:00.000Z'],
    B: [3600, 800, '2026-10-20T07:30:00.000Z'],
    C: [4800, 500, '2026-10-20T07:00:00.000Z'],
    D: [6800, 1200, '2026-10-20T08:20:00.000Z'],
    E: [4500, 1000, '2026-10-20T07:40:00.000Z'],
  };
  assert.equal(offers.length, 5);
  for (const o of offers) {
    assert.deepEqual([o.price_cents, o.prep_fee_cents, o.ready_at], expected[o.code], o.code);
    assert.equal(o.version, 1);
    assert.equal(o.status, 'active');
    assert.equal(o.demo, 1);
  }
  // Supplier order totals with the prep fee (brief): A 4000, B 4400, C 5300, D 8000, E 5500.
  const totals = Object.fromEntries(offers.map((o) => [o.code, o.price_cents + o.prep_fee_cents]));
  assert.deepEqual(totals, { A: 4000, B: 4400, C: 5300, D: 8000, E: 5500 });
  db.close();
});

test('RS-FIX-1: inventory is on_hand 1, reserved 0 for every bundle, with a matching adjust/seed ledger row', () => {
  const { db } = seeded();
  const stock = db.prepare('SELECT product_id, supplier_id, on_hand, reserved, demo FROM inventory ORDER BY product_id').all();
  assert.equal(stock.length, 5);
  for (const s of stock) {
    assert.equal(s.on_hand, 1);
    assert.equal(s.reserved, 0);
    assert.equal(s.demo, 1);
  }
  const ledger = db.prepare('SELECT * FROM inventory_ledger ORDER BY id').all();
  assert.equal(ledger.length, 5);
  for (const row of ledger) {
    assert.equal(row.reason, 'adjust');
    assert.equal(row.ref_type, 'seed');
    assert.equal(row.delta_on_hand, 1);
    assert.equal(row.delta_reserved, 0);
    assert.equal(row.on_hand_after, 1);
    assert.equal(row.reserved_after, 0);
    assert.equal(row.at, '2026-10-20T06:00:00.000Z');
  }
  // Invariant: sum of ledger deltas equals the stock row, per product.
  const mismatches = db
    .prepare(
      'SELECT i.product_id FROM inventory i WHERE i.on_hand <> (SELECT SUM(delta_on_hand) FROM inventory_ledger l WHERE l.product_id = i.product_id) ' +
        'OR i.reserved <> (SELECT SUM(delta_reserved) FROM inventory_ledger l WHERE l.product_id = i.product_id)',
    )
    .all();
  assert.deepEqual(mismatches, []);
  db.close();
});

test('RS-FIX-1: ready times use the Asia/Amman offset from Intl for the demo date, not a constant', () => {
  const winter = seeded({ demoDate: '2020-01-15' });
  // Amman was UTC+2 in January 2020, so 10:00 local is 08:00Z (it is 07:00Z in October 2026).
  assert.equal(winter.db.prepare("SELECT ready_at FROM offers o JOIN suppliers s ON s.id = o.supplier_id WHERE s.code = 'A'").get().ready_at, '2020-01-15T08:00:00.000Z');
  winter.db.close();
  const summer = seeded({ demoDate: '2020-07-15' });
  assert.equal(summer.db.prepare("SELECT ready_at FROM offers o JOIN suppliers s ON s.id = o.supplier_id WHERE s.code = 'A'").get().ready_at, '2020-07-15T07:00:00.000Z');
  summer.db.close();
  assert.equal(new Date(zonedTimeToUtcMs('2026-10-20', '10:00')).toISOString(), '2026-10-20T07:00:00.000Z');
  assert.equal(new Date(zonedTimeToUtcMs('2026-10-20', '11:20')).toISOString(), '2026-10-20T08:20:00.000Z');
  assert.equal(localDateInZone(Date.UTC(2026, 9, 19, 21, 30)), '2026-10-20');
});

test('RS-FIX-1: the demo date is stored in meta and the seed writes one audit event', () => {
  const { db } = seeded();
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'demo_date'").get().value, '2026-10-20');
  const audit = db.prepare('SELECT action, actor_role, outcome, detail_json FROM audit_events').all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'seed.load');
  assert.equal(audit[0].actor_role, 'system');
  assert.deepEqual(JSON.parse(audit[0].detail_json), { suppliers: 5, users: 7 });
  db.close();
});

test('RS-FIX-1: demo accounts are supplier-a..e (linked to their supplier) and customers cafe1 and cafe2', () => {
  const { db } = seeded();
  const users = db.prepare('SELECT u.username, u.role, u.demo, u.disabled, s.code AS supplier FROM users u LEFT JOIN suppliers s ON s.id = u.supplier_id ORDER BY u.id').all();
  assert.deepEqual(
    users.map((u) => [u.username, u.role, u.supplier]),
    [
      ['supplier-a', 'supplier', 'A'],
      ['supplier-b', 'supplier', 'B'],
      ['supplier-c', 'supplier', 'C'],
      ['supplier-d', 'supplier', 'D'],
      ['supplier-e', 'supplier', 'E'],
      ['cafe1', 'customer', null],
      ['cafe2', 'customer', null],
    ],
  );
  for (const u of users) {
    assert.equal(u.demo, 1);
    assert.equal(u.disabled, 0);
  }
  assert.deepEqual(demoAccounts().map((a) => a.username), users.map((u) => u.username));
  db.close();
});

test('SEC-5: with RS_DEMO_PASSWORD set all seven accounts share that password (each hash has its own salt)', () => {
  const { db, result } = seeded({ demoPassword: SHARED });
  assert.equal(result.credentials.length, 7);
  for (const c of result.credentials) {
    assert.equal(c.password, SHARED);
    assert.equal(c.shared, true);
  }
  const hashes = db.prepare('SELECT username, password_hash FROM users ORDER BY id').all();
  for (const h of hashes) {
    assert.ok(verifyHash(SHARED, h.password_hash), `${h.username} accepts the shared password`);
    assert.ok(!verifyHash('wrong-password-123', h.password_hash));
    assert.doesNotMatch(h.password_hash, new RegExp(SHARED));
  }
  assert.equal(new Set(hashes.map((h) => h.password_hash)).size, 7, 'salts differ, so no two hashes are equal');
  db.close();
});

test('SEC-5: without RS_DEMO_PASSWORD each account gets its own distinct random password', () => {
  const { db, result } = seeded();
  const passwords = result.credentials.map((c) => c.password);
  assert.equal(new Set(passwords).size, 7, 'passwords are distinct');
  for (const p of passwords) {
    assert.ok(p.length >= 16, 'random passwords have at least 16 characters');
    assert.match(p, /^[A-Za-z0-9_-]+$/);
  }
  const hashes = db.prepare('SELECT username, password_hash FROM users ORDER BY id').all();
  result.credentials.forEach((c, i) => {
    assert.equal(c.username, hashes[i].username);
    assert.equal(c.shared, false);
    assert.ok(verifyHash(c.password, hashes[i].password_hash));
    // No other account accepts this password.
    hashes.forEach((h, j) => {
      if (j !== i) assert.ok(!verifyHash(c.password, h.password_hash));
    });
  });
  // Two runs never produce the same passwords.
  const again = seeded();
  assert.notDeepEqual(again.result.credentials.map((c) => c.password), passwords);
  again.db.close();
  db.close();
});

test('SEC-5: password hashes are scrypt N=16384 r=8 p=1 with a 64-byte key and no plain text in the database', () => {
  const stored = hashPassword('some password value');
  const [scheme, n, r, p, salt, key] = stored.split('$');
  assert.deepEqual([scheme, n, r, p], ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(salt, 'base64url').length, 16);
  assert.equal(Buffer.from(key, 'base64url').length, 64);
  assert.notEqual(hashPassword('some password value'), stored, 'a fresh salt each time');

  const { db, result } = seeded();
  const dump = JSON.stringify(db.prepare('SELECT * FROM users').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
  for (const c of result.credentials) assert.ok(!dump.includes(c.password), 'a password is stored in plain text');
  db.close();
});

test('SEC-5: seeding writes no password to the log', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  const db = freshDb();
  const result = seedDatabase(db, { clock: CLOCK, demoDate: '2026-10-20' });
  log.info('seed.done', { counts: { users: result.credentials.length } });
  for (const c of result.credentials) assert.ok(!lines.join('').includes(c.password));
  db.close();
});

test('seeding twice changes nothing the second time', () => {
  const { db, result } = seeded({ demoPassword: SHARED });
  assert.equal(result.seeded, true);
  const before = JSON.stringify(db.prepare('SELECT * FROM users ORDER BY id').all());
  const second = seedDatabase(db, { clock: CLOCK, demoDate: '2026-10-21', demoPassword: SHARED });
  assert.equal(second.seeded, false);
  assert.deepEqual(second.credentials, []);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY id').all()), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n, 5);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'demo_date'").get().value, '2026-10-20');
  db.close();
});

test('the seed is one transaction: a failure part-way leaves the database empty', () => {
  const db = freshDb();
  db.exec("INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('cafe2', 'x', 'customer', 'Existing', '2026-10-20T06:00:00.000Z')");
  assert.throws(() => seedDatabase(db, { clock: CLOCK, demoDate: '2026-10-20' }), /UNIQUE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get().n, 0);
  db.close();
});

test('seedDatabase validates its arguments', () => {
  const db = freshDb();
  assert.throws(() => seedDatabase(db, { clock: CLOCK, demoDate: 'tomorrow' }), TypeError);
  assert.throws(() => seedDatabase(db, { clock: CLOCK, demoDate: '2026-10-20', demoPassword: '' }), TypeError);
  db.close();
});

test('RS-FIX-1: the fixture constant is frozen and matches the brief table', () => {
  assert.ok(Object.isFrozen(RS_FIX_1));
  assert.deepEqual(
    RS_FIX_1.suppliers.map((s) => [s.code, s.cups, s.lidDiameterMm, s.priceCents, s.prepFeeCents, s.ready]),
    [
      ['A', 100, 90, 3000, 1000, '10:00'],
      ['B', 100, 90, 3600, 800, '10:30'],
      ['C', 200, 95, 4800, 500, '10:00'],
      ['D', 200, 90, 6800, 1200, '11:20'],
      ['E', 100, 90, 4500, 1000, '10:40'],
    ],
  );
});

function runSeed(env) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'seed.js')], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('SEC-5: npm run seed without RS_DEMO_PASSWORD prints distinct passwords once and a second run prints none', () => {
  const dir = tempDir('rs-seedcli-');
  const env = { RS_DB_PATH: join(dir, 'data', 'app.db'), RS_UPLOAD_DIR: join(dir, 'data', 'uploads'), RS_DEMO_DATE: '2026-10-20' };
  const first = runSeed(env);
  assert.equal(first.status, 0, first.stderr);
  const rows = first.stdout.split('\n').filter((l) => /^ {2}\S+ +\S{16,}$/.test(l));
  assert.equal(rows.length, 7);
  const passwords = rows.map((l) => l.trim().split(/\s+/)[1]);
  assert.equal(new Set(passwords).size, 7);
  assert.deepEqual(rows.map((l) => l.trim().split(/\s+/)[0]), ['supplier-a', 'supplier-b', 'supplier-c', 'supplier-d', 'supplier-e', 'cafe1', 'cafe2']);

  const second = runSeed(env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already loaded/);
  for (const p of passwords) assert.ok(!second.stdout.includes(p) && !second.stderr.includes(p));
});

test('SEC-5: npm run seed with RS_DEMO_PASSWORD does not print the password', () => {
  const dir = tempDir('rs-seedcli-');
  const result = runSeed({
    RS_DB_PATH: join(dir, 'app.db'),
    RS_UPLOAD_DIR: join(dir, 'uploads'),
    RS_DEMO_DATE: '2026-10-20',
    RS_DEMO_PASSWORD: SHARED,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /share the password in RS_DEMO_PASSWORD/);
  assert.ok(!result.stdout.includes(SHARED) && !result.stderr.includes(SHARED));
  for (const name of ['supplier-a', 'supplier-e', 'cafe1', 'cafe2']) assert.match(result.stdout, new RegExp(name));
});

test('SEC-5: the seed refuses a placeholder or short RS_DEMO_PASSWORD, naming the variable only', () => {
  for (const value of ['<placeholder>', 'changeme', 'tiny-marker']) {
    const dir = tempDir('rs-seedcli-');
    const result = runSeed({ RS_DB_PATH: join(dir, 'app.db'), RS_UPLOAD_DIR: join(dir, 'uploads'), RS_DEMO_PASSWORD: value });
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /RS_DEMO_PASSWORD/);
    assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value), `the value ${value} must not be echoed`);
  }
});

test('SEC-14: npm run seed creates the data directories with mode 0700 and the database with 0600', async () => {
  const { statSync } = await import('node:fs');
  const dir = tempDir('rs-seedcli-');
  const result = runSeed({ RS_DB_PATH: join(dir, 'data', 'app.db'), RS_UPLOAD_DIR: join(dir, 'data', 'uploads'), RS_DEMO_DATE: '2026-10-20' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'data', 'uploads')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'data', 'app.db')).mode & 0o777, 0o600);
});
