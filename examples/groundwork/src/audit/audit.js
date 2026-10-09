// Append-only audit writer/reader (spec 3.3, 6.1). Never pass secrets or text bodies in `detail`.
const MAX_DETAIL = 2000;

export function createAudit({ db, clock = Date.now }) {
  const ins = db.prepare(`INSERT INTO audit_log (at, team_id, actor_user_id, actor_name, action, target_type, target_id,
      outcome, ip, request_id, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  function record({ teamId = null, actor = null, action, targetType = null, targetId = null, outcome = 'ok', ip = null, requestId = null, detail = {} }) {
    if (!['ok', 'denied', 'fail'].includes(outcome)) throw new TypeError('bad audit outcome');
    let d = JSON.stringify(detail ?? {});
    if (d.length > MAX_DETAIL) d = JSON.stringify({ truncated: true });
    const info = ins.run(
      new Date(clock()).toISOString(), teamId, actor?.id ?? null,
      actor?.name == null ? null : String(actor.name).slice(0, 64),
      action, targetType, targetId, outcome, ip ? String(ip).slice(0, 64) : null, requestId, d,
    );
    return Number(info.lastInsertRowid);
  }

  const selBase = 'SELECT id, at, actor_name, action, target_type, target_id, outcome, detail FROM audit_log WHERE team_id = ?';

  function list(teamId, { limit = 50, before } = {}) {
    const rows = before === undefined
      ? db.prepare(`${selBase} ORDER BY id DESC LIMIT ?`).all(teamId, limit + 1)
      : db.prepare(`${selBase} AND id < ? ORDER BY id DESC LIMIT ?`).all(teamId, before, limit + 1);
    const page = rows.slice(0, limit);
    const entries = page.map((r) => ({
      id: r.id, at: r.at, actor: r.actor_name, action: r.action, targetType: r.target_type,
      targetId: r.target_id, outcome: r.outcome, detail: safeParse(r.detail),
    }));
    return { entries, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
  }

  return { record, list };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
