// The general per-user limit (SEC-2, SEC-C-3 / FU-15): at most `limit` requests per `windowMs` for one
// signed-in user, over every non-public route. Called from the access hook after authentication.
//
// Counted in rate_events as kind 'general' under the key u:<userId>. Planning uses the same kind under
// plan:u:<userId> (src/services/plans.js); every statement here matches the exact key, so the two counts
// never include each other's rows. The delete of expired rows, the count and the insert run in one
// BEGIN IMMEDIATE (db.tx), so parallel requests, also from another process, cannot overshoot the limit.
// A refused call is not inserted, so a flood cannot grow the table past `limit` rows per user.
//
// SEC-R-1: BEGIN IMMEDIATE needs the write lock, so a long write elsewhere (the reconciler tick, a saga step) would hold
// every signed-in read behind it. For GET and HEAD, which change nothing, a busy error on this transaction therefore
// fails open: the call proceeds uncounted and one `rate_limit.busy_open` line is logged (the request id and nothing that
// names the user). Reads also wait only `readBusyWaitMs` for the lock instead of the connection's busy timeout (5 s by
// default); the connection's own timeout is restored afterwards. Every other method keeps failing closed: the busy error
// is thrown unchanged and the app answers 503 DB_BUSY. A caller that names no method is treated as state-changing.
import { isoFromMs } from '../clock.js';
import { isBusyError } from '../db/errors.js';
import { AppError } from '../http/envelope.js';

export const DEFAULT_READ_BUSY_WAIT_MS = 50;
const READ_METHODS = new Set(['GET', 'HEAD']);

export function createGeneralLimiter({ db, clock, limit, windowMs, readBusyWaitMs = DEFAULT_READ_BUSY_WAIT_MS }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('the general limit needs an integer limit >= 1 and an integer windowMs >= 1');
  }
  if (!Number.isInteger(readBusyWaitMs) || readBusyWaitMs < 0 || readBusyWaitMs > 5000) {
    throw new RangeError('readBusyWaitMs must be an integer from 0 to 5000');
  }

  function count(userId) {
    const nowMs = clock.now();
    const cutoff = isoFromMs(nowMs - windowMs);
    const key = `u:${userId}`;
    return db.tx(() => {
      db.prepare("DELETE FROM rate_events WHERE kind = 'general' AND user_key = ? AND at <= ?").run(key, cutoff);
      const row = db
        .prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = 'general' AND user_key = ? AND at > ?")
        .get(key, cutoff);
      if (row.n >= limit) {
        return { allowed: false, retryAfterS: Math.max(1, Math.ceil((Date.parse(row.oldest) + windowMs - nowMs) / 1000)) };
      }
      db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'general', ?)").run(key, isoFromMs(nowMs));
      return { allowed: true };
    });
  }

  // Runs fn with the connection's busy timeout lowered to readBusyWaitMs (only ever lowered), then restores it.
  function withShortBusyWait(fn) {
    const normal = db.busyTimeoutMs;
    if (!Number.isInteger(normal) || normal <= readBusyWaitMs || typeof db.exec !== 'function') return fn();
    db.exec(`PRAGMA busy_timeout = ${readBusyWaitMs}`);
    try {
      return fn();
    } finally {
      db.exec(`PRAGMA busy_timeout = ${normal}`);
    }
  }

  // Counts one call of the user, or throws 429 RATE_LIMITED { limit: 'general' } with Retry-After.
  // take(userId, { method, log, requestId }): `method` is the HTTP method; `log` the request's logger (optional).
  function take(userId, { method = null, log = null, requestId = null } = {}) {
    const readOnly = typeof method === 'string' && READ_METHODS.has(method.toUpperCase());
    let decision;
    try {
      decision = readOnly ? withShortBusyWait(() => count(userId)) : count(userId);
    } catch (err) {
      if (!readOnly || !isBusyError(err)) throw err;
      // Fail open: nothing is counted, the read goes on. No user id, name or key in the line.
      log?.warn?.('rate_limit.busy_open', requestId ? { requestId } : {});
      return;
    }
    if (!decision.allowed) {
      throw new AppError(429, 'RATE_LIMITED', { details: { limit: 'general' }, headers: { 'Retry-After': String(decision.retryAfterS) } });
    }
  }

  return { take, limit, windowMs };
}
