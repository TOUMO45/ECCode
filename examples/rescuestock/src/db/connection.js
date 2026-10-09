// Opens a node:sqlite connection with the project PRAGMAs and adds db.tx(fn).
//   journal_mode=WAL, foreign_keys=ON, busy_timeout=<RS_DB_BUSY_TIMEOUT_MS>, synchronous=NORMAL
// db.tx(fn) runs fn(db) synchronously inside BEGIN IMMEDIATE ... COMMIT.
// A returned promise aborts the transaction (no provider call or await may
// happen inside a transaction) and nested transactions are refused.
import { DatabaseSync } from 'node:sqlite';
import { isBusyError } from './errors.js';

export class TransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
  }
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
// Opening a connection may wait at least this long for a competing process, even with busy_timeout 0,
// because it happens once per process at startup (PB-1).
export const OPEN_RETRY_MIN_BUDGET_MS = 1000;
const BACKOFF_START_MS = 2;
const BACKOFF_CAP_MS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs fn(); on SQLITE_BUSY or SQLITE_LOCKED it sleeps with a growing, jittered back-off and tries
// again until budgetMs has passed, then rethrows the last error. Never loops without a deadline.
export function retryWhileBusy(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let delay = BACKOFF_START_MS;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(delay, Math.max(1, deadline - Date.now())) + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
    }
  }
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

export function openDb(file, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('openDb needs a database path');
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) {
    throw new RangeError('busyTimeoutMs must be an integer from 0 to 5000');
  }
  const db = new DatabaseSync(file);
  try {
    // busy_timeout first: it covers ordinary lock waits on this connection.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // It does not cover the journal-mode switch (PB-1). Converting a fresh file to WAL needs an
    // exclusive lock, and when another process holds or awaits a write lock while this connection
    // holds a shared one, waiting could deadlock, so SQLite answers SQLITE_BUSY at once and never
    // calls the busy handler. The switch is therefore retried by hand within a bounded budget.
    const budgetMs = Math.max(busyTimeoutMs, OPEN_RETRY_MIN_BUDGET_MS);
    retryWhileBusy(() => {
      // Reading the mode takes no exclusive lock; only a file that is not yet WAL needs the switch.
      const current = db.prepare('PRAGMA journal_mode').get();
      if (String(Object.values(current)[0]).toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL');
    }, budgetMs);
    retryWhileBusy(() => {
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
    }, budgetMs);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    throw err;
  }

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
