// Sign-in and register throttles, counted in SQLite so they hold across processes (SEC-1, SEC-9).
//
// Sign-in (table login_failures, window 15 min):
//   * hard refusal 429 before the password check when the pair (username_key, IP) has >= 5 failures
//     (limit signin_pair) or the IP has >= 20 failures across all usernames (limit signin_ip);
//   * cross-IP pressure only delays: when the username_key has >= 10 failures from all IPs together
//     the caller waits min(10 s, (n - 9) s) before checking the password. It is never a refusal.
// An attempt is counted when it is admitted ("reserved"), in the same BEGIN IMMEDIATE as the check,
// so parallel requests cannot overshoot the limit. A successful sign-in deletes the pair's rows,
// including its own reservation. Unknown usernames are reserved the same way, so 429 versus 401
// reveals nothing.
//
// Register (table rate_events, kind 'register', key ip:<address>, window 1 h): at most
// RS_REGISTER_PER_IP_PER_HOUR admitted attempts per IP.
import { isoFromMs } from '../clock.js';

export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
export const SIGNIN_PAIR_LIMIT = 5;
export const SIGNIN_IP_LIMIT = 20;
export const CROSS_IP_DELAY_FROM = 10;
export const CROSS_IP_MAX_DELAY_S = 10;
export const REGISTER_WINDOW_MS = 60 * 60 * 1000;

// Delay before the password check, given the failures of the username across all IPs.
export function crossIpDelayMs(failuresForUsername) {
  if (failuresForUsername < CROSS_IP_DELAY_FROM) return 0;
  return Math.min(CROSS_IP_MAX_DELAY_S, failuresForUsername - 9) * 1000;
}

function retryAfterSeconds(oldestAt, windowMs, nowMs) {
  const seconds = Math.ceil((Date.parse(oldestAt) + windowMs - nowMs) / 1000);
  return Math.max(1, seconds);
}

// lower(NFC(trim(username))): the same normalisation the user lookup uses (SEC-9).
export function usernameKey(username) {
  return String(username).trim().normalize('NFC').toLowerCase();
}

export function createThrottle({ db, clock }) {
  // -> { allowed: true, delayMs } | { allowed: false, limit, retryAfterS }
  function reserveSignin({ usernameKey: key, ip }) {
    const nowMs = clock.now();
    const now = isoFromMs(nowMs);
    const cutoff = isoFromMs(nowMs - SIGNIN_WINDOW_MS);
    return db.tx(() => {
      db.prepare('DELETE FROM login_failures WHERE at <= ?').run(cutoff);
      const pair = db
        .prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE username_key = ? AND ip = ? AND at > ?')
        .get(key, ip, cutoff);
      if (pair.n >= SIGNIN_PAIR_LIMIT) {
        return { allowed: false, limit: 'signin_pair', retryAfterS: retryAfterSeconds(pair.oldest, SIGNIN_WINDOW_MS, nowMs) };
      }
      const perIp = db
        .prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE ip = ? AND at > ?')
        .get(ip, cutoff);
      if (perIp.n >= SIGNIN_IP_LIMIT) {
        return { allowed: false, limit: 'signin_ip', retryAfterS: retryAfterSeconds(perIp.oldest, SIGNIN_WINDOW_MS, nowMs) };
      }
      const all = db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username_key = ? AND at > ?').get(key, cutoff);
      db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?, ?, ?)').run(key, ip, now);
      return { allowed: true, delayMs: crossIpDelayMs(all.n) };
    });
  }

  // A success clears the failures of that (username_key, IP) pair only.
  function clearPair({ usernameKey: key, ip }) {
    db.prepare('DELETE FROM login_failures WHERE username_key = ? AND ip = ?').run(key, ip);
  }

  // -> { allowed: true } | { allowed: false, limit: 'register_ip', retryAfterS }
  function reserveRegister({ ip, limit }) {
    const nowMs = clock.now();
    const now = isoFromMs(nowMs);
    const cutoff = isoFromMs(nowMs - REGISTER_WINDOW_MS);
    const userKey = `ip:${ip}`;
    return db.tx(() => {
      db.prepare("DELETE FROM rate_events WHERE kind = 'register' AND at <= ?").run(cutoff);
      const row = db
        .prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = 'register' AND user_key = ? AND at > ?")
        .get(userKey, cutoff);
      if (row.n >= limit) {
        return { allowed: false, limit: 'register_ip', retryAfterS: retryAfterSeconds(row.oldest, REGISTER_WINDOW_MS, nowMs) };
      }
      db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'register', ?)").run(userKey, now);
      return { allowed: true };
    });
  }

  return { reserveSignin, clearPair, reserveRegister };
}
