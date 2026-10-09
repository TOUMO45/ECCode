// node:sqlite wrapper: pragmas, version check, synchronous tx() helper.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export class DbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbError';
  }
}

function assertRuntime() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    throw new DbError(`Node >= 22.5 is required (found ${process.versions.node})`);
  }
}

async function loadSqlite() {
  assertRuntime();
  const mod = await import('node:sqlite');
  if (typeof mod.DatabaseSync !== 'function') {
    throw new DbError('node:sqlite DatabaseSync is not available in this Node build');
  }
  return mod.DatabaseSync;
}

// Synchronous load (ESM static import of node:sqlite would emit the warning at
// import time for modules that never open a DB).
const require_ = createRequire(import.meta.url);
function loadSqliteSync() {
  assertRuntime();
  const { DatabaseSync } = require_('node:sqlite');
  if (typeof DatabaseSync !== 'function') {
    throw new DbError('node:sqlite DatabaseSync is not available in this Node build');
  }
  return DatabaseSync;
}

/**
 * Open a database. `file` may be ':memory:'. Directory is created for files.
 * Returns the DatabaseSync instance augmented with `tx(fn)`.
 */
export function openDb(file) {
  const DatabaseSync = loadSqliteSync();
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
  db.tx = (fn) => tx(db, fn);
  return db;
}

export { loadSqlite };

/**
 * Run `fn(db)` inside BEGIN IMMEDIATE ... COMMIT. `fn` must be synchronous:
 * if it returns a thenable the transaction is rolled back and an error thrown,
 * so no await can sit between BEGIN and COMMIT. Nesting is refused.
 */
export function tx(db, fn) {
  if (typeof fn !== 'function') throw new TypeError('tx requires a function');
  if (db.isTransaction) throw new DbError('nested transaction refused');
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn(db);
    if (result && typeof result.then === 'function') {
      // Avoid an unhandled rejection from the abandoned promise.
      Promise.resolve(result).catch(() => {});
      throw new DbError('tx callback must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // connection is unusable; original error is the one worth surfacing
      }
    }
    throw err;
  }
}
