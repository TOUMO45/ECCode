// Migration 006 (FU-23 / TR-D-3): rescue_requests, planning_runs, plan_versions and images are rebuilt with AUTOINCREMENT, and
// model_spend.request_id gets a foreign key (ON DELETE SET NULL). The tests migrate a database that is at version 005 and holds a
// seeded request tree, then compare it with what it held before: data, indexes, triggers, foreign keys, integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../../src/db/connection.js';
import { MIGRATIONS_DIR, migrate } from '../../../src/db/migrate.js';
import { tempDir } from '../http/app-fixture.js';

const AT = '2026-10-20T06:00:00.000Z';
const REBUILT = ['rescue_requests', 'planning_runs', 'plan_versions', 'images'];
const HASH = 'a'.repeat(64);
const FILE = (n) => String(n).padStart(32, 'a');

function migrationsUpTo(version, { extra = {} } = {}) {
  const dir = join(tempDir('rs-mig6-'), 'migrations');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (Number(name.slice(0, 3)) <= version) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  return dir;
}

// A database at version 005 with a full tree: three requests (ids 1, 2 and the highest, 7), their images, extractions,
// requirements, runs, plan versions (one superseded by the next), approvals, and the non-cascading children that hold
// references into plan_versions (reservation, supplier order, payment operation, provider call).
function seedAt005() {
  const db = openDb(':memory:');
  migrate(db, { dir: migrationsUpTo(5) });
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run("INSERT INTO suppliers (id, code, name, pickup_address, paypal_merchant_key, created_at) VALUES (1, 'A', 'S', 'addr', 'A', ?)", AT);
  run("INSERT INTO users (id, username, password_hash, role, supplier_id, display_name, created_at) VALUES (1, 'cust-one', 'x', 'customer', NULL, 'One', ?)", AT);
  run("INSERT INTO users (id, username, password_hash, role, supplier_id, display_name, created_at) VALUES (2, 'cust-two', 'x', 'customer', NULL, 'Two', ?)", AT);
  run("INSERT INTO products (id, supplier_id, kind, name, created_at) VALUES (1, 1, 'bundle', 'b', ?)", AT);
  run("INSERT INTO offers (id, supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from) VALUES (1, 1, 1, 100, 0, ?, 1, 'active', ?)", AT, AT);
  for (const [id, customer] of [[1, 1], [2, 2], [7, 1]]) {
    run("INSERT INTO rescue_requests (id, customer_id, raw_text, language, intake_status, created_at) VALUES (?, ?, ?, 'en', 'confirmed', ?)", id, customer, `text ${id}`, AT);
    run("INSERT INTO images (id, request_id, file_name, mime_detected, bytes, sha256, created_at) VALUES (?, ?, ?, 'image/png', 10, ?, ?)", id * 10, id, FILE(id), HASH, AT);
    run("INSERT INTO extractions (id, request_id, provider, prompt_version, schema_ok, degraded, simulated, fields_json, created_at) VALUES (?, ?, 'fake', 'p1', 1, 0, 1, '{}', ?)", id * 100, id, AT);
    run("INSERT INTO requirements (id, request_id, version, fields_json, product_type, cups, lids, capacity_ml, diameter_mm, max_pickups, confirmed_by, confirmed_at) VALUES (?, ?, 1, '{}', 'cups', 10, 0, 250, 90, 1, 1, ?)", id * 100, id, AT);
    run("INSERT INTO planning_runs (id, request_id, requirements_version, feasible, trace_json, rejections_json, offers_hash, created_at) VALUES (?, ?, 1, 1, '[]', '[]', 'h', ?)", id * 1000, id, AT);
  }
  const plan = (id, request, run_, version, status, extra = '') =>
    run(
      `INSERT INTO plan_versions (id, request_id, planning_run_id, version, status, plan_json, plan_hash, total_cents, pickup_count, ready_at, created_at, updated_at${extra ? ', supersede_reason' : ''})
       VALUES (?, ?, ?, ?, ?, '{}', ?, 100, 1, ?, ?, ?${extra ? `, ${extra}` : ''})`,
      id, request, run_, version, status, HASH, AT, AT, AT,
    );
  plan(30, 1, 1000, 1, 'approved');
  plan(31, 2, 2000, 1, 'approved');
  plan(32, 7, 7000, 1, 'superseded', "'REPLANNED'");
  plan(33, 7, 7000, 2, 'approved');
  run('UPDATE plan_versions SET superseded_by = 33 WHERE id = 32'); // a self-reference inside the rebuilt table
  for (const id of [30, 33]) run('INSERT INTO plan_approvals (plan_version_id, customer_id, approved_hash, approved_total_cents, at) VALUES (?, 1, ?, 100, ?)', id, HASH, AT);
  run("INSERT INTO reservations (id, plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (1, 30, 1, 'k1', 'res:1:30:k1', 'active', ?, ?)", AT, AT);
  run('INSERT INTO reservation_items (reservation_id, product_id, supplier_id, offer_id, qty) VALUES (1, 1, 1, 1, 5)');
  run("INSERT INTO supplier_orders (id, plan_version_id, supplier_id, reservation_id, lines_json, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, created_at) VALUES (1, 30, 1, 1, '[]', 90, 5, 5, 100, 'awaiting_supplier', ?)", AT);
  run("INSERT INTO payment_operations (id, supplier_order_id, status, provider, merchant_key, amount_cents, currency, created_at, updated_at) VALUES (1, 1, 'created', 'fake', 'A', 100, 'USD', ?, ?)", AT, AT);
  run("INSERT INTO provider_calls (id, payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (1, 1, 'create_order', 1, 'so:1:create_order:1', 'intent', ?)", AT);
  run("INSERT INTO replan_queue (request_id, reason, enqueued_at, next_attempt_at) VALUES (2, 'PRICE_CHANGED', ?, ?)", AT, AT);
  // The spend of a request that exists, of one that was deleted before the migration (dangling), and of none.
  for (const [id, request] of [[1, 1], [2, 99], [3, null]]) {
    run("INSERT INTO model_spend (id, day, customer_id, request_id, purpose, reserved_micro_usd, actual_micro_usd, status, created_at) VALUES (?, '2026-10-20', 1, ?, 'extract', 50000, 1200, 'settled', ?)", id, request, AT);
  }
  run("INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome) VALUES (?, 1, 'customer', 'request.create', 'request', 7, 'ok')", AT);
  run("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, at) VALUES (1, 1, 'adjust', 1, 0, 1, 0, 'seed', NULL, 'seed', ?)", AT);
  return db;
}

const TABLES = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const rowsOf = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
const snapshot = (db) => Object.fromEntries(TABLES(db).map((t) => [t, rowsOf(db, t)]));
const objects = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
const fkList = (db, table) => db.prepare(`SELECT * FROM pragma_foreign_key_list('${table}')`).all().map((r) => ({ ...r }));
// sqlite_sequence exists only once a table with AUTOINCREMENT has been created.
const sequenceOf = (db, name) =>
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get()
    ? db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name)?.seq
    : undefined;

function assertHealthy(db) {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'PRAGMA foreign_key_check');
  assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map((r) => ({ ...r })), [{ integrity_check: 'ok' }], 'PRAGMA integrity_check');
  assert.equal(Object.values(db.prepare('PRAGMA foreign_keys').get())[0], 1, 'foreign_keys stays ON');
  assert.equal(Object.values(db.prepare('PRAGMA defer_foreign_keys').get())[0], 0, 'defer_foreign_keys is back to 0 after the commit');
}

test('RS-38: 006 on a seeded 005 database keeps every row, index, trigger and foreign key; only the four tables gain AUTOINCREMENT and model_spend gains its foreign key', () => {
  const db = seedAt005();
  const dataBefore = snapshot(db);
  const objectsBefore = objects(db);
  const fksBefore = Object.fromEntries(TABLES(db).map((t) => [t, fkList(db, t)]));
  assert.equal(sequenceOf(db, 'rescue_requests'), undefined, 'no AUTOINCREMENT at 005');

  const result = migrate(db);
  assert.deepEqual(result.applied, [6]);
  assertHealthy(db);

  // Data: identical, except that the dangling model_spend pointer (request 99) is now NULL.
  const dataAfter = snapshot(db);
  assert.equal(dataAfter.schema_migrations.pop().version, 6, 'the migration is recorded');
  const expected = structuredClone(dataBefore);
  expected.model_spend.find((r) => r.id === 2).request_id = null;
  assert.deepEqual(dataAfter, expected);
  assert.deepEqual(TABLES(db), Object.keys(dataBefore), 'no table appeared or vanished');
  for (const t of ['rescue_requests', 'images', 'planning_runs', 'plan_versions', 'extractions', 'requirements', 'plan_approvals', 'replan_queue', 'reservations', 'supplier_orders', 'payment_operations', 'provider_calls']) {
    assert.ok(dataAfter[t].length > 0, `${t} kept its rows`);
  }

  // Schema: every object is byte-identical, except the AUTOINCREMENT keyword on the four tables and the new model_spend text.
  const objectsAfter = objects(db);
  assert.deepEqual(objectsAfter.map((o) => `${o.type} ${o.name}`), objectsBefore.map((o) => `${o.type} ${o.name}`), 'same tables, indexes and triggers');
  for (const before of objectsBefore) {
    const after = objectsAfter.find((o) => o.type === before.type && o.name === before.name);
    if (REBUILT.includes(before.name)) {
      assert.equal(after.sql, before.sql.replace('id INTEGER PRIMARY KEY,', 'id INTEGER PRIMARY KEY AUTOINCREMENT,'), `${before.name}: only AUTOINCREMENT is added`);
    } else if (before.name === 'model_spend') {
      assert.equal(after.sql, before.sql.replace('request_id INTEGER,', 'request_id INTEGER REFERENCES rescue_requests(id) ON DELETE SET NULL,'), 'model_spend: only the foreign key is added');
    } else {
      assert.equal(after.sql, before.sql, `${before.type} ${before.name} is unchanged`);
    }
  }
  const triggers = objectsAfter.filter((o) => o.type === 'trigger').map((o) => o.name);
  assert.deepEqual(triggers, ['audit_no_delete', 'audit_no_update', 'inventory_ledger_no_delete', 'inventory_ledger_no_update']);

  // Foreign keys: the same lists, and model_spend has one more.
  for (const t of TABLES(db)) {
    const wanted = fksBefore[t];
    const got = fkList(db, t);
    if (t === 'model_spend') {
      assert.equal(got.length, wanted.length + 1);
      const added = got.find((fk) => fk.from === 'request_id');
      assert.deepEqual([added.table, added.to, added.on_delete], ['rescue_requests', 'id', 'SET NULL']);
    } else {
      assert.deepEqual(got.map(({ id, ...rest }) => rest), wanted.map(({ id, ...rest }) => rest), `${t}: foreign keys`);
    }
  }

  // The sequence starts at the highest id that exists.
  assert.deepEqual(
    ['rescue_requests', 'images', 'planning_runs', 'plan_versions'].map((t) => sequenceOf(db, t)),
    [7, 70, 7000, 33],
  );
  db.close();
});

test('RS-38: after 006 the append-only triggers still refuse UPDATE and DELETE, and REPLACE cannot rewrite an audit row', () => {
  const db = seedAt005();
  migrate(db);
  assert.throws(() => db.exec("UPDATE audit_events SET outcome = 'failed'"), /audit_events is append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_events'), /audit_events is append-only/);
  assert.throws(() => db.exec('UPDATE inventory_ledger SET delta_on_hand = 9'), /inventory_ledger is append-only/);
  assert.throws(() => db.exec('DELETE FROM inventory_ledger'), /inventory_ledger is append-only/);
  assert.throws(
    () => db.exec("INSERT OR REPLACE INTO audit_events (id, at, actor_role, action, entity_type, outcome) VALUES (1, 'x', 'admin', 'forged', 'request', 'ok')"),
    /audit_events is append-only/,
  );
  db.close();
});

test('RS-39: after 006 a hard delete of the highest id does not free it: the next rescue request, run, plan version and image get larger ids', () => {
  const db = seedAt005();
  migrate(db);
  db.exec('DELETE FROM rescue_requests WHERE id = 7'); // the cascade removes its image, run and plan versions
  for (const t of ['images', 'planning_runs', 'plan_versions']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE request_id = 7`).get().n, 0, t);
  const request = Number(db.prepare("INSERT INTO rescue_requests (customer_id, language, intake_status, created_at) VALUES (2, 'en', 'draft', ?)").run(AT).lastInsertRowid);
  const image = Number(db.prepare("INSERT INTO images (request_id, file_name, mime_detected, bytes, sha256, created_at) VALUES (?, ?, 'image/png', 1, ?, ?)").run(request, FILE(99), HASH, AT).lastInsertRowid);
  const planRun = Number(db.prepare("INSERT INTO planning_runs (request_id, requirements_version, feasible, trace_json, rejections_json, offers_hash, created_at) VALUES (?, 1, 1, '[]', '[]', 'h', ?)").run(request, AT).lastInsertRowid);
  const version = Number(
    db.prepare("INSERT INTO plan_versions (request_id, planning_run_id, version, status, plan_json, plan_hash, total_cents, pickup_count, ready_at, created_at, updated_at) VALUES (?, ?, 1, 'draft', '{}', ?, 1, 1, ?, ?, ?)")
      .run(request, planRun, HASH, AT, AT, AT).lastInsertRowid,
  );
  assert.deepEqual([request, image, planRun, version], [8, 71, 7001, 34]);
  db.close();
});

test('RS-39: model_spend.request_id is ON DELETE SET NULL: the spend row of a hard-deleted request stays and names nothing; an unknown request id is refused', () => {
  const db = seedAt005();
  migrate(db);
  const spend = () => db.prepare('SELECT id, request_id, actual_micro_usd FROM model_spend ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(spend(), [{ id: 1, request_id: 1, actual_micro_usd: 1200 }, { id: 2, request_id: null, actual_micro_usd: 1200 }, { id: 3, request_id: null, actual_micro_usd: 1200 }]);
  // Request 1 owns a supplier order, so the app would only tombstone it; request 2 has none and is hard-deleted.
  db.prepare('UPDATE model_spend SET request_id = 2 WHERE id = 3').run();
  db.exec('DELETE FROM rescue_requests WHERE id = 2');
  assert.deepEqual(spend().find((r) => r.id === 3), { id: 3, request_id: null, actual_micro_usd: 1200 });
  assert.equal(spend().length, 3, 'no spend row is deleted with its request');
  assert.throws(
    () => db.prepare("INSERT INTO model_spend (day, customer_id, request_id, purpose, reserved_micro_usd, status, created_at) VALUES ('2026-10-20', 1, 12345, 'extract', 1, 'reserved', ?)").run(AT),
    /FOREIGN KEY/,
  );
  db.close();
});

test('RS-38: 006 is atomic: a statement that fails halfway leaves the 005 database exactly as it was', () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '006_autoincrement_ids.sql'), 'utf8');
  const dir = migrationsUpTo(5, { extra: { '006_autoincrement_ids.sql': `${sql}\nINSERT INTO no_such_table VALUES (1);\n` } });
  const db = seedAt005();
  const before = snapshot(db);
  const objectsBefore = objects(db);
  assert.throws(() => migrate(db, { dir }), /no_such_table/);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(objects(db), objectsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE 's\\_%' ESCAPE '\\'").get().n, 0, 'no staging table is left behind');
  assertHealthy(db);
  db.close();
});

test('RS-38: 006 cannot lose a parent row: if a plan version does not come back, the commit fails on the deferred foreign key and everything is rolled back', () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '006_autoincrement_ids.sql'), 'utf8');
  const broken = sql.replace('INSERT INTO plan_versions SELECT * FROM s_plan_versions ORDER BY id;', 'INSERT INTO plan_versions SELECT * FROM s_plan_versions WHERE id <> 30 ORDER BY id;');
  assert.notEqual(broken, sql, 'the mutation applied');
  const dir = migrationsUpTo(5, { extra: { '006_autoincrement_ids.sql': broken } });
  const db = seedAt005();
  const before = snapshot(db);
  assert.throws(() => migrate(db, { dir }), /FOREIGN KEY/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(sequenceOf(db, 'plan_versions'), undefined, 'still the 005 table');
  assertHealthy(db);
  db.close();
});

test('RS-38: 006 on an empty 005 database and on a fresh database gives the same schema', () => {
  const upgraded = openDb(':memory:');
  migrate(upgraded, { dir: migrationsUpTo(5) });
  migrate(upgraded);
  const fresh = openDb(':memory:');
  migrate(fresh);
  assert.deepEqual(objects(upgraded), objects(fresh));
  assertHealthy(upgraded);
  upgraded.close();
  fresh.close();
});
