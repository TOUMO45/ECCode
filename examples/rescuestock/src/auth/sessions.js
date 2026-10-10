// Server-side sessions (ARCH-25). The cookie carries a random 256-bit id; the database keeps only
// sha256(id) (T7). Idle timeout 60 min (last_seen refreshed at most once a minute), absolute 12 h.
import { createHash, randomBytes } from 'node:crypto';
import { isoFromMs } from '../clock.js';
import { isBusyError } from '../db/errors.js';

export const IDLE_MS = 60 * 60 * 1000;
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 1000;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionId(id) {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

const SELECT_SESSION = `
  SELECT s.id_hash, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at,
         u.id AS user_id, u.username, u.display_name, u.role, u.supplier_id, u.disabled,
         sup.code AS supplier_code
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN suppliers sup ON sup.id = u.supplier_id
   WHERE s.id_hash = ?`;

export function createSessionStore({ db, clock }) {
  // Opportunistic clean-up of dead rows, run when a session is created.
  function purgeExpired() {
    const now = clock.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(isoFromMs(now), isoFromMs(now - IDLE_MS));
  }

  // Creates a session row for the user and returns the cookie value (shown once) and the CSRF token.
  // Call inside the caller's transaction when the session must commit together with other rows.
  function create(userId) {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = clock.now();
    db.prepare(
      'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(hashSessionId(id), userId, csrfToken, isoFromMs(now), isoFromMs(now), isoFromMs(now + ABSOLUTE_MS));
    return { id, csrfToken, expiresAt: isoFromMs(now + ABSOLUTE_MS) };
  }

  // Returns { user, session } for a live session, else null (expired, disabled or unknown rows are removed).
  function resolve(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return null;
    const idHash = hashSessionId(id);
    const row = db.prepare(SELECT_SESSION).get(idHash);
    if (!row) return null;
    const now = clock.now();
    const idleOk = now - Date.parse(row.last_seen_at) < IDLE_MS;
    const absoluteOk = now < Date.parse(row.expires_at);
    if (!idleOk || !absoluteOk || row.disabled === 1) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    if (now - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
      try {
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(isoFromMs(now), idHash);
      } catch (err) {
        // The refresh is a convenience; a busy database must not fail an otherwise valid request.
        if (!isBusyError(err)) throw err;
      }
    }
    return {
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        supplierId: row.supplier_id ?? null,
        supplierCode: row.supplier_code ?? null,
      },
      session: { idHash, csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at },
    };
  }

  function destroy(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return 0;
    return Number(db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(id)).changes);
  }

  function destroyForUser(userId) {
    return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
  }

  return { create, resolve, destroy, destroyForUser, purgeExpired };
}
