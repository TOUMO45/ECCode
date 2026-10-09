// Server-side sessions (spec 6.2): cookie holds a random id, the DB holds its
// SHA-256. Idle 30 min, absolute 8 h, last_seen refreshed at most once a minute.
import crypto from 'node:crypto';

export const IDLE_MS = 30 * 60 * 1000;
export const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const TOUCH_MS = 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

export function createSessions({ db, clock = Date.now, csrf }) {
  const q = {
    insert: db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?)'),
    get: db.prepare(`SELECT s.id_hash, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at,
        u.id AS user_id, u.username, u.display_name, u.role, u.team_id, u.disabled, t.name AS team_name
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN teams t ON t.id = u.team_id WHERE s.id_hash = ?`),
    del: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?'),
    delUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  };

  return {
    /** Always a fresh random id; returns { id (cookie value), csrfToken }. */
    create(userId) {
      const id = crypto.randomBytes(32).toString('base64url');
      const csrfToken = csrf.newSessionToken();
      const now = clock();
      q.insert.run(sha(id), userId, csrfToken, iso(now), iso(now), iso(now + ABSOLUTE_MS));
      return { id, csrfToken };
    },

    /** Returns { csrfToken, idHash, user } or null (expired rows are deleted). */
    lookup(cookieValue) {
      if (typeof cookieValue !== 'string' || cookieValue.length < 20 || cookieValue.length > 100) return null;
      const idHash = sha(cookieValue);
      const row = q.get.get(idHash);
      if (!row) return null;
      const now = clock();
      const last = Date.parse(row.last_seen_at);
      if (row.disabled || now >= Date.parse(row.expires_at) || now - last >= IDLE_MS) {
        q.del.run(idHash);
        return null;
      }
      if (now - last >= TOUCH_MS) q.touch.run(iso(now), idHash);
      return {
        idHash,
        csrfToken: row.csrf_token,
        user: {
          id: row.user_id, username: row.username, displayName: row.display_name,
          role: row.role, teamId: row.team_id, teamName: row.team_name,
        },
      };
    },

    destroyByCookie(cookieValue) {
      if (typeof cookieValue === 'string' && cookieValue) q.del.run(sha(cookieValue));
    },
    destroyByHash(idHash) { q.del.run(idHash); },
    destroyForUser(userId) { q.delUser.run(userId); },

    purgeExpired() {
      const now = clock();
      return Number(q.purge.run(iso(now), iso(now - IDLE_MS)).changes);
    },
  };
}
