// User persistence for auth routes and scripts (auth owns the users table writes).
import { hashPassword } from './password.js';

export const toUser = (r) => ({
  id: r.id, username: r.username, displayName: r.display_name, role: r.role, teamId: r.team_id, teamName: r.team_name,
});

const SEL = `SELECT u.id, u.username, u.display_name, u.role, u.team_id, u.password_hash, u.disabled, t.name AS team_name
  FROM users u JOIN teams t ON t.id = u.team_id`;

export function createUsers({ db, clock = Date.now }) {
  return {
    findByUsername: (username) => db.prepare(`${SEL} WHERE u.username = ?`).get(username),
    listByTeam: (teamId) => db.prepare(`${SEL} WHERE u.team_id = ? ORDER BY u.id`).all(teamId).map(toUser),
    getInTeam: (id, teamId) => {
      const r = db.prepare(`${SEL} WHERE u.id = ? AND u.team_id = ?`).get(id, teamId);
      return r ? toUser(r) : null;
    },
    /** Throws a UNIQUE constraint error when the username exists (caller maps to 409). */
    async create({ teamId, username, displayName, role, password }) {
      const hash = await hashPassword(password);
      const info = db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
        VALUES (?,?,?,?,?,?)`).run(teamId, username, displayName, role, hash, new Date(clock()).toISOString());
      return this.getInTeam(Number(info.lastInsertRowid), teamId);
    },
  };
}

export function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message));
}
