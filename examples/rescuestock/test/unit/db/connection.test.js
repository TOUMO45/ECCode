import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, TransactionError } from '../../../src/db/connection.js';
import { DbConstraintError, dbBusyError, isBusyError, mapDbError } from '../../../src/db/errors.js';
import { migrate } from '../../../src/db/migrate.js';
import { AppError } from '../../../src/http/envelope.js';
import { getOrCreateMeta } from '../../../src/db/meta.js';
import { tempDir } from '../http/app-fixture.js';

function pragma(db, name) {
  return Object.values(db.prepare('PRAGMA ' + name).get())[0];
}

function fileDb(options) {
  const file = join(tempDir('rs-db-'), 'app.db');
  return { file, db: openDb(file, options) };
}

test('NFR1: every connection sets WAL, foreign_keys, busy_timeout and synchronous=NORMAL by PRAGMA', () => {
  const { db } = fileDb({ busyTimeoutMs: 1234 });
  assert.equal(pragma(db, 'journal_mode'), 'wal');
  assert.equal(pragma(db, 'foreign_keys'), 1);
  assert.equal(pragma(db, 'busy_timeout'), 1234);
  assert.equal(pragma(db, 'synchronous'), 1); // NORMAL
  db.close();
});

test('NFR1: busy_timeout comes from the option and defaults to 5000', () => {
  const a = fileDb();
  assert.equal(pragma(a.db, 'busy_timeout'), 5000);
  a.db.close();
  const b = fileDb({ busyTimeoutMs: 0 });
  assert.equal(pragma(b.db, 'busy_timeout'), 0);
  b.db.close();
});

test('openDb validates its arguments', () => {
  assert.throws(() => openDb(''), TypeError);
  for (const bad of [-1, 5001, 1.5, '100', NaN]) assert.throws(() => openDb(':memory:', { busyTimeoutMs: bad }), RangeError, String(bad));
});

test('two connections to one file both see WAL mode and the same data', () => {
  const { file, db: first } = fileDb();
  first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  first.prepare('INSERT INTO t (v) VALUES (?)').run('one');
  const second = openDb(file);
  assert.equal(pragma(second, 'journal_mode'), 'wal');
  assert.equal(second.prepare('SELECT v FROM t').get().v, 'one');
  first.close();
  second.close();
});

test('db.tx commits on success and returns the function result', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const out = db.tx((d) => {
    d.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  assert.equal(db.inTx, false);
  db.close();
});

test('db.tx rolls back and rethrows when the function throws', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const boom = new Error('boom');
  assert.throws(() => db.tx((d) => { d.prepare('INSERT INTO t (v) VALUES (?)').run('a'); throw boom; }), (e) => e === boom);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(db.inTx, false);
  // The connection is usable afterwards.
  db.tx((d) => d.prepare('INSERT INTO t (v) VALUES (?)').run('b'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  db.close();
});

test('db.tx refuses a function that returns a promise and rolls the work back', async () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  assert.throws(
    () => db.tx(async (d) => { d.prepare('INSERT INTO t (v) VALUES (?)').run('a'); }),
    (e) => e instanceof TransactionError && e.code === 'TX_ASYNC',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(db.inTx, false);
  // A thenable that is not a native promise is refused too.
  assert.throws(() => db.tx(() => ({ then() {} })), (e) => e.code === 'TX_ASYNC');
  // A rejecting promise must not become an unhandled rejection.
  assert.throws(() => db.tx(async () => { throw new Error('late'); }), (e) => e.code === 'TX_ASYNC');
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});

test('db.tx refuses a nested transaction and leaves the outer one to roll back', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  assert.throws(
    () =>
      db.tx((d) => {
        d.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
        d.tx(() => {});
      }),
    (e) => e instanceof TransactionError && e.code === 'TX_NESTED',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(db.inTx, false);
  db.close();
});

test('db.tx rejects a non-function', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.tx(null), TypeError);
  db.close();
});

test('SQLITE_BUSY after the busy timeout maps to 503 DB_BUSY with Retry-After: 1', () => {
  const { file, db: holder } = fileDb();
  holder.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const waiter = openDb(file, { busyTimeoutMs: 0 });
  holder.exec('BEGIN IMMEDIATE');
  try {
    let raised;
    try {
      waiter.tx(() => waiter.exec('INSERT INTO t DEFAULT VALUES'));
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, 'the second writer must fail while the first holds the lock');
    assert.equal(isBusyError(raised), true);
    const mapped = mapDbError(raised);
    assert.ok(mapped instanceof AppError);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.code, 'DB_BUSY');
    assert.equal(mapped.headers['Retry-After'], '1');
    assert.equal(waiter.inTx, false, 'the failed BEGIN leaves no transaction state behind');
  } finally {
    holder.exec('ROLLBACK');
  }
  // Once the lock is released the same connection works.
  waiter.tx(() => waiter.exec('INSERT INTO t DEFAULT VALUES'));
  assert.equal(waiter.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  holder.close();
  waiter.close();
});

test('a waiting writer succeeds when the lock is released inside the busy timeout window', () => {
  const { file, db: first } = fileDb({ busyTimeoutMs: 100 });
  first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const second = openDb(file, { busyTimeoutMs: 100 });
  first.tx(() => first.exec('INSERT INTO t DEFAULT VALUES'));
  second.tx(() => second.exec('INSERT INTO t DEFAULT VALUES'));
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM t').get().n, 2);
  first.close();
  second.close();
});

test('mapDbError maps constraint failures to typed errors without SQL text and passes other errors through', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cases = [
    ["INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, created_at) VALUES ('a','s','p','A','t')", 'check'],
    ["INSERT INTO products (supplier_id, kind, name, created_at) VALUES (99,'cup','x','t')", 'foreign_key'],
    ["INSERT INTO meta (key, value) VALUES ('k', NULL)", 'not_null'],
  ];
  for (const [sql, kind] of cases) {
    let raised;
    try {
      db.exec(sql);
    } catch (err) {
      raised = err;
    }
    const mapped = mapDbError(raised);
    assert.ok(mapped instanceof DbConstraintError, sql);
    assert.equal(mapped.kind, kind, sql);
    assert.doesNotMatch(mapped.message, /INSERT|suppliers|products/);
  }
  db.exec("INSERT INTO meta (key, value) VALUES ('k', 'v')");
  let dup;
  try {
    db.exec("INSERT INTO meta (key, value) VALUES ('k', 'v2')");
  } catch (err) {
    dup = err;
  }
  assert.equal(mapDbError(dup).kind, 'primary_key');
  let trig;
  try {
    db.exec('DELETE FROM audit_events');
    db.exec("INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES ('t','system','a','b','ok')");
    db.exec('DELETE FROM audit_events');
  } catch (err) {
    trig = err;
  }
  assert.equal(mapDbError(trig).kind, 'trigger');
  const plain = new Error('plain');
  assert.equal(mapDbError(plain), plain);
  const app = dbBusyError();
  assert.equal(mapDbError(app), app);
  db.close();
});

test('getOrCreateMeta returns the same value for every caller (INSERT OR IGNORE in one transaction)', () => {
  const { file, db } = fileDb();
  migrate(db);
  const other = openDb(file);
  const first = getOrCreateMeta(db, 'csrf_key', () => 'first-value');
  const second = getOrCreateMeta(other, 'csrf_key', () => 'second-value');
  assert.equal(first, 'first-value');
  assert.equal(second, 'first-value');
  db.close();
  other.close();
});
