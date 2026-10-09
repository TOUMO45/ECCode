import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../../src/db/connection.js';
import { MIGRATIONS_DIR, MigrationError, checksum, loadMigrationFiles, migrate } from '../../../src/db/migrate.js';
import { fixedClock } from '../../../src/clock.js';
import { tempDir } from '../http/app-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'migrate-child.js');

function memoryDb() {
  return openDb(':memory:');
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function copyMigrations() {
  const dir = join(tempDir('rs-mig-'), 'migrations');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  return dir;
}

test('RS-38: migrations 001-005 apply to an empty database and create every table of the Data Design', () => {
  const db = memoryDb();
  const result = migrate(db, { clock: fixedClock(Date.UTC(2026, 9, 20)) });
  assert.deepEqual(result.applied, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.skipped, []);
  const expected = [
    'meta', 'suppliers', 'users', 'sessions', 'login_failures', 'products', 'bundle_items', 'compatibility', 'offers', 'inventory',
    'inventory_ledger', 'audit_events',
    'rescue_requests', 'images', 'extractions', 'requirements', 'rate_events', 'model_spend',
    'planning_runs', 'plan_versions', 'plan_approvals', 'reservations', 'reservation_items', 'supplier_orders', 'pickup_confirmations', 'replan_queue',
    'payment_operations', 'provider_calls', 'webhook_events', 'idempotency_keys',
    'fake_paypal_orders', 'fake_paypal_authorizations', 'fake_paypal_captures', 'fake_paypal_refunds', 'fake_paypal_requests', 'fake_paypal_calls', 'fault_flags',
    'schema_migrations',
  ];
  assert.deepEqual(tableNames(db), [...expected].sort());
  db.close();
});

test('migrations are recorded in schema_migrations with the sha256 of each file and the clock time', () => {
  const db = memoryDb();
  migrate(db, { clock: fixedClock(Date.UTC(2026, 9, 20, 7, 0, 0)) });
  const rows = db.prepare('SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((r) => [r.version, r.name]), [
    [1, 'core'], [2, 'requests'], [3, 'planning'], [4, 'payments'], [5, 'fake_paypal'],
  ]);
  for (const file of loadMigrationFiles()) {
    const row = rows.find((r) => r.version === file.version);
    assert.equal(row.sha256, file.sha256);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.sha256, checksum(readFileSync(join(MIGRATIONS_DIR, file.file), 'utf8')));
  }
  assert.ok(rows.every((r) => r.applied_at === '2026-10-20T07:00:00.000Z'));
  db.close();
});

test('migrate is idempotent: a second run skips every applied version', () => {
  const db = memoryDb();
  migrate(db);
  const again = migrate(db);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 3, 4, 5]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
  db.close();
});

test('migration file names are 001..005 with no gaps and no BEGIN/COMMIT of their own', () => {
  const files = loadMigrationFiles();
  assert.deepEqual(files.map((f) => f.file), [
    '001_core.sql', '002_requests.sql', '003_planning.sql', '004_payments.sql', '005_fake_paypal.sql',
  ]);
  for (const f of files) assert.doesNotMatch(f.sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\b/im, f.file);
});

test('the partial UNIQUE indexes hold: one current offer per product, one live reservation per plan', () => {
  const db = memoryDb();
  migrate(db);
  const now = '2026-10-20T06:00:00.000Z';
  db.exec(`INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, created_at) VALUES ('A', 'S', 'addr', 'A', '${now}')`);
  db.exec(`INSERT INTO products (supplier_id, kind, name, created_at) VALUES (1, 'bundle', 'b', '${now}')`);
  const offer = db.prepare(
    "INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from) VALUES (1, 1, 100, 0, ?, ?, ?, ?)",
  );
  offer.run(now, 1, 'replaced', now);
  offer.run(now, 2, 'active', now);
  assert.throws(() => offer.run(now, 3, 'active', now), /UNIQUE/);
  assert.throws(() => offer.run(now, 3, 'withdrawn', now), /UNIQUE/);
  offer.run(now, 3, 'replaced', now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM offers').get().n, 3);
  db.close();
});

test('CHECK constraints hold: reserved cannot exceed on_hand, role needs a matching supplier link', () => {
  const db = memoryDb();
  migrate(db);
  const now = '2026-10-20T06:00:00.000Z';
  db.exec(`INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, created_at) VALUES ('A', 'S', 'addr', 'A', '${now}')`);
  db.exec(`INSERT INTO products (supplier_id, kind, name, created_at) VALUES (1, 'bundle', 'b', '${now}')`);
  assert.throws(() => db.exec('INSERT INTO inventory (product_id, supplier_id, on_hand, reserved) VALUES (1, 1, 1, 2)'), /CHECK/);
  assert.throws(() => db.exec('INSERT INTO inventory (product_id, supplier_id, on_hand, reserved) VALUES (1, 1, -1, 0)'), /CHECK/);
  assert.throws(() => db.exec(`INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, created_at) VALUES ('a', 'S', 'addr', 'A', '${now}')`), /CHECK/);
  assert.throws(
    () => db.exec(`INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('sup-user', 'x', 'supplier', 'n', '${now}')`),
    /CHECK/,
  );
  db.exec(`INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('cust-user', 'x', 'customer', 'n', '${now}')`);
  assert.throws(
    () => db.exec(`INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('CUST-USER', 'x', 'customer', 'n', '${now}')`),
    /UNIQUE/,
    'usernames are unique case-insensitively',
  );
  db.close();
});

test('foreign keys are enforced on every connection', () => {
  const db = memoryDb();
  migrate(db);
  assert.throws(
    () => db.exec("INSERT INTO products (supplier_id, kind, name, created_at) VALUES (99, 'cup', 'x', '2026-10-20T06:00:00.000Z')"),
    /FOREIGN KEY/,
  );
  db.close();
});

test('NFR1: migrate refuses to start when an applied migration file was changed', () => {
  const dir = copyMigrations();
  const db = memoryDb();
  migrate(db, { dir });
  const target = join(dir, '003_planning.sql');
  writeFileSync(target, `${readFileSync(target, 'utf8')}-- edited after it was applied\n`);
  assert.throws(
    () => migrate(db, { dir }),
    (err) => err instanceof MigrationError && err.code === 'MIGRATION_CHECKSUM_MISMATCH' && err.version === 3 && /003|migration 3/.test(err.message),
  );
  // Nothing was applied or recorded by the refused run.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
  db.close();
});

test('NFR1: a changed applied file is refused before any new migration is applied', () => {
  const dir = copyMigrations();
  const db = memoryDb();
  migrate(db, { dir });
  // Add migration 006 and change 001; the change must be refused and 006 must stay unapplied.
  writeFileSync(join(dir, '006_extra.sql'), 'CREATE TABLE extra_table (id INTEGER PRIMARY KEY);\n');
  writeFileSync(join(dir, '001_core.sql'), `${readFileSync(join(dir, '001_core.sql'), 'utf8')}\n-- changed\n`);
  assert.throws(() => migrate(db, { dir }), (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH' && err.version === 1);
  assert.ok(!tableNames(db).includes('extra_table'));
  db.close();
});

test('a new migration file is applied on top of the existing ones (append-only)', () => {
  const dir = copyMigrations();
  const db = memoryDb();
  migrate(db, { dir });
  writeFileSync(join(dir, '006_extra.sql'), 'CREATE TABLE extra_table (id INTEGER PRIMARY KEY);\n');
  const result = migrate(db, { dir });
  assert.deepEqual(result.applied, [6]);
  assert.deepEqual(result.skipped, [1, 2, 3, 4, 5]);
  assert.ok(tableNames(db).includes('extra_table'));
  db.close();
});

test('a database that holds a migration without a file is refused', () => {
  const dir = copyMigrations();
  const db = memoryDb();
  migrate(db, { dir });
  db.prepare("INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (9, 'future', 'abc', 'x')").run();
  assert.throws(() => migrate(db, { dir }), (err) => err.code === 'MIGRATION_FILE_MISSING' && err.version === 9);
  db.close();
});

test('a migration that fails half-way is rolled back completely and not recorded', () => {
  const dir = copyMigrations();
  const db = memoryDb();
  migrate(db, { dir });
  writeFileSync(
    join(dir, '006_broken.sql'),
    'CREATE TABLE half_done (id INTEGER PRIMARY KEY);\nINSERT INTO half_done (id) VALUES (1);\nINSERT INTO no_such_table (id) VALUES (1);\n',
  );
  assert.throws(() => migrate(db, { dir }), /no_such_table|no such table/);
  assert.ok(!tableNames(db).includes('half_done'), 'the partial table must be rolled back');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
  db.close();
});

test('version gaps and badly named files are refused', () => {
  const dir = join(tempDir('rs-mig-'), 'migrations');
  mkdirSync(dir);
  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);\n');
  writeFileSync(join(dir, '003_c.sql'), 'CREATE TABLE c (id INTEGER);\n');
  assert.throws(() => migrate(memoryDb(), { dir }), (err) => err.code === 'MIGRATION_GAP');
  const dir2 = join(tempDir('rs-mig-'), 'migrations');
  mkdirSync(dir2);
  writeFileSync(join(dir2, 'one_core.sql'), 'SELECT 1;\n');
  assert.throws(() => migrate(memoryDb(), { dir: dir2 }), (err) => err.code === 'MIGRATION_BAD_NAME');
});

test('checksums ignore CRLF versus LF line endings', () => {
  assert.equal(checksum('a\r\nb\r\n'), checksum('a\nb\n'));
  assert.notEqual(checksum('a\nb\n'), checksum('a\nc\n'));
});

function runChild(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

test('NFR1: two processes starting at the same time apply each migration exactly once and both succeed', async () => {
  for (let round = 0; round < 4; round++) {
    const file = join(tempDir('rs-race-'), 'app.db');
    const results = await Promise.all([runChild(file), runChild(file), runChild(file)]);
    for (const r of results) assert.equal(r.code, 0, `child failed: ${r.err}`);
    const reports = results.map((r) => JSON.parse(r.out.trim()));
    const applied = reports.flatMap((r) => r.applied).sort((a, b) => a - b);
    assert.deepEqual(applied, [1, 2, 3, 4, 5], 'every version applied by exactly one process');
    for (const r of reports) assert.equal(r.applied.length + r.skipped.length, 5);
    const db = openDb(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
    db.close();
  }
});
