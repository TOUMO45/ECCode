// Opens a node:sqlite connection with the project PRAGMAs and adds db.tx(fn).
//   journal_mode=WAL, foreign_keys=ON, busy_timeout=<RS_DB_BUSY_TIMEOUT_MS>, synchronous=NORMAL
// db.tx(fn) runs fn(db) synchronously inside BEGIN IMMEDIATE ... COMMIT.
// A returned promise aborts the transaction (no provider call or await may
// happen inside a transaction) and nested transactions are refused.
import { DatabaseSync } from 'node:sqlite';

export class TransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
  }
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

export function openDb(file, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('openDb needs a database path');
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) {
    throw new RangeError('busyTimeoutMs must be an integer from 0 to 5000');
  }
  const db = new DatabaseSync(file);
  // busy_timeout first, so the journal_mode switch below also waits on a competing process.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  let active = false;
  function tx(fn) {
    if (typeof fn !== 'function') throw new TypeError('db.tx needs a function');
    if (active) {
      throw new TransactionError('TX_NESTED', 'Nested transactions are not allowed.');
    }
    db.exec('BEGIN IMMEDIATE');
    active = true;
    let result;
    try {
      result = fn(db);
      if (isThenable(result)) {
        // The work behind the promise cannot be undone, but it must not leak an unhandled rejection.
        result.then(undefined, () => {});
        throw new TransactionError('TX_ASYNC', 'A transaction function must be synchronous; it returned a promise.');
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Nothing to roll back when COMMIT itself failed and the engine already closed the transaction.
      }
      throw err;
    } finally {
      active = false;
    }
    return result;
  }

  Object.defineProperty(db, 'tx', { value: tx, enumerable: false });
  Object.defineProperty(db, 'inTx', { get: () => active, enumerable: false });
  Object.defineProperty(db, 'busyTimeoutMs', { value: busyTimeoutMs, enumerable: false });
  return db;
}
