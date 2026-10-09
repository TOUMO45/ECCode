// Incident and note persistence. All queries are team-scoped and parameterised.
import { ApiError } from '../http/envelope.js';
import { parseNotes } from '../notes/parser.js';

const iso = (clock) => new Date(clock()).toISOString();

const SEL = `SELECT i.id, i.title, i.severity, i.started_at, i.description, i.created_at, i.created_by, u.display_name AS creator,
    (SELECT COUNT(*) FROM note_lines n WHERE n.incident_id = i.id) AS note_count,
    d.id AS d_id, d.state AS d_state, d.version AS d_version, d.provider AS d_provider, d.is_fallback AS d_fb,
    (SELECT COUNT(*) FROM statements s WHERE s.draft_id = d.id AND s.status = 'flagged') AS d_flagged
  FROM incidents i JOIN users u ON u.id = i.created_by LEFT JOIN drafts d ON d.incident_id = i.id`;

function toIncident(r) {
  return {
    id: r.id, title: r.title, severity: r.severity, startedAt: r.started_at, description: r.description,
    createdBy: { id: r.created_by, displayName: r.creator }, createdAt: r.created_at, noteCount: r.note_count,
    draft: r.d_id === null ? null : {
      id: r.d_id, state: r.d_state, version: r.d_version, provider: r.d_provider,
      isFallback: r.d_fb === 1, flaggedCount: r.d_flagged,
    },
  };
}

export const toLine = (r) => ({ n: r.n, time: r.time, ts: r.ts, author: r.author, text: r.text });

export function createIncidentService({ db, audit, clock }) {
  function get(id, teamId) {
    const r = db.prepare(`${SEL} WHERE i.id = ? AND i.team_id = ?`).get(id, teamId);
    return r ? toIncident(r) : null;
  }
  function require(id, teamId) {
    const inc = get(id, teamId);
    if (!inc) throw new ApiError('NOT_FOUND');
    return inc;
  }
  const linesOf = (id) => db.prepare('SELECT n, time, ts, author, text FROM note_lines WHERE incident_id = ? ORDER BY n').all(id).map(toLine);

  return {
    get, require, linesOf,
    create({ user, body, ip, requestId }) {
      return db.tx(() => {
        const info = db.prepare(`INSERT INTO incidents (team_id, title, severity, started_at, description, created_by, created_at)
          VALUES (?,?,?,?,?,?,?)`).run(user.teamId, body.title.trim(), body.severity, body.startedAt, body.description ?? '', user.id, iso(clock));
        const id = Number(info.lastInsertRowid);
        audit.record({
          teamId: user.teamId, actor: { id: user.id, name: user.username }, action: 'incident.create',
          targetType: 'incident', targetId: id, ip, requestId, detail: { severity: body.severity },
        });
        return get(id, user.teamId);
      });
    },
    list(teamId) {
      return db.prepare(`${SEL} WHERE i.team_id = ? ORDER BY i.id DESC LIMIT 200`).all(teamId).map(toIncident);
    },
    notes(id, teamId) {
      require(id, teamId);
      return linesOf(id);
    },
    replaceNotes({ id, user, body, ip, requestId }) {
      const base = { teamId: user.teamId, actor: { id: user.id, name: user.username }, action: 'notes.import', targetType: 'incident', targetId: id, ip, requestId };
      const locked = () => db.prepare('SELECT 1 FROM drafts WHERE incident_id = ?').get(id) !== undefined;
      require(id, user.teamId);
      if (locked()) throw new ApiError('NOTES_LOCKED');
      const parsed = parseNotes(body);
      if (!parsed.ok) {
        audit.record({ ...base, outcome: 'fail', detail: { reason: 'invalid', errors: parsed.total } });
        throw new ApiError('NOTES_INVALID', {
          details: { lines: parsed.errors.map((e) => ({ line: Math.max(1, e.line), message: e.message })), total: parsed.total },
        });
      }
      return db.tx(() => {
        if (locked()) throw new ApiError('NOTES_LOCKED');
        db.prepare('DELETE FROM note_lines WHERE incident_id = ?').run(id);
        const ins = db.prepare('INSERT INTO note_lines (incident_id, n, time, ts, author, text) VALUES (?,?,?,?,?,?)');
        for (const l of parsed.lines) ins.run(id, l.n, l.time, l.ts, l.author, l.text);
        db.prepare('UPDATE incidents SET notes_rev = notes_rev + 1 WHERE id = ? AND team_id = ?').run(id, user.teamId);
        audit.record({ ...base, detail: { count: parsed.lines.length } });
        return { count: parsed.lines.length, lines: linesOf(id) };
      });
    },
  };
}
