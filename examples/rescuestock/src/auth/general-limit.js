// The general per-user limit (SEC-2, SEC-C-3 / FU-15): at most `limit` requests per `windowMs` for one
// signed-in user, over every non-public route. Called from the access hook after authentication.
//
// Counted in rate_events as kind 'general' under the key u:<userId>. Planning uses the same kind under
// plan:u:<userId> (src/services/plans.js); every statement here matches the exact key, so the two counts
// never include each other's rows. The delete of expired rows, the count and the insert run in one
// BEGIN IMMEDIATE (db.tx), so parallel requests, also from another process, cannot overshoot the limit.
// A refused call is not inserted, so a flood cannot grow the table past `limit` rows per user.
import { isoFromMs } from '../clock.js';
import { AppError } from '../http/envelope.js';

export function createGeneralLimiter({ db, clock, limit, windowMs }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('the general limit needs an integer limit >= 1 and an integer windowMs >= 1');
  }

  // Counts one call of the user, or throws 429 RATE_LIMITED { limit: 'general' } with Retry-After.
  function take(userId) {
    const nowMs = clock.now();
    const cutoff = isoFromMs(nowMs - windowMs);
    const key = `u:${userId}`;
    const decision = db.tx(() => {
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
    if (!decision.allowed) {
      throw new AppError(429, 'RATE_LIMITED', { details: { limit: 'general' }, headers: { 'Retry-After': String(decision.retryAfterS) } });
    }
  }

  return { take, limit, windowMs };
}
