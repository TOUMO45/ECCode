// Draft lifecycle: generate, edit, delete, publish (spec 3.6, brief R8).
// Provider calls happen outside any DB transaction; every write is one synchronous
// BEGIN IMMEDIATE transaction (db.tx refuses async callbacks), so verification and
// the state change cannot be interleaved with another request.
import crypto from 'node:crypto';
import { ApiError } from '../http/envelope.js';
import { buildContext, verifyStatement } from '../verify/index.js';
import { validateDraft, DRAFT_SECTIONS } from '../ai/schema.js';
import { ProviderError } from '../ai/provider.js';
import { toLine } from './incidents.js';

const DEFAULT_DEADLINE_MS = 150000;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u; // eslint-disable-line no-control-regex
const iso = (clock) => new Date(clock()).toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const fieldError = (path, message) => new ApiError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function createDraftService({ db, audit, clock, users, providers, log, config, locks = new Set() }) {
  const deadlineMs = config.generateTimeoutMs ?? DEFAULT_DEADLINE_MS;

  // ---- reads --------------------------------------------------------------
  function shape(row) {
    const stmts = db.prepare('SELECT id, section, text, cites, status, reasons, edited FROM statements WHERE draft_id = ? ORDER BY section, position, id').all(row.id);
    const sections = Object.fromEntries(DRAFT_SECTIONS.map((s) => [s, []]));
    let flagged = 0;
    for (const s of stmts) {
      if (s.status === 'flagged') flagged += 1;
      sections[s.section].push({
        id: s.id, text: s.text, cites: parseJson(s.cites, []), status: s.status,
        reasons: parseJson(s.reasons, []), edited: s.edited === 1,
      });
    }
    return {
      id: row.id, incidentId: row.incident_id, version: row.version, state: row.state, provider: row.provider,
      model: row.model, isFallback: row.is_fallback === 1, generatedAt: row.generated_at,
      publishedAt: row.published_at, publishedBy: row.published_by, flaggedCount: flagged, sections,
    };
  }
  const rowById = (id, teamId) => db.prepare('SELECT * FROM drafts WHERE id = ? AND team_id = ?').get(id, teamId);

  function ctxFor(incidentId, teamId) {
    const lines = db.prepare('SELECT n, time, ts, author, text FROM note_lines WHERE incident_id = ? ORDER BY n').all(incidentId).map(toLine);
    const names = [];
    for (const u of users.listByTeam(teamId)) names.push(u.username, u.displayName);
    return buildContext(lines, names);
  }

  function byIncident(incidentId, teamId) {
    const row = db.prepare('SELECT * FROM drafts WHERE incident_id = ? AND team_id = ?').get(incidentId, teamId);
    return row ? shape(row) : null;
  }
  function get(id, teamId) {
    const row = rowById(id, teamId);
    return row ? shape(row) : null;
  }

  // ---- generate -----------------------------------------------------------
  const unavailable = (provider) => new ApiError('PROVIDER_UNAVAILABLE', { details: { provider, fallbackAvailable: true } });

  function mapProviderError(err, providerId) {
    const code = err instanceof ProviderError ? err.code : 'PROVIDER_UNAVAILABLE';
    switch (code) {
      case 'PROVIDER_TIMEOUT':
        return new ApiError(code, { details: { provider: providerId, fallbackAvailable: true } });
      case 'PROVIDER_BAD_OUTPUT':
        return new ApiError(code, { details: { fallbackAvailable: true } });
      case 'PROVIDER_BUSY':
        return new ApiError(code, { details: { fallbackAvailable: true }, headers: { 'Retry-After': '5' } });
      default:
        return unavailable(providerId);
    }
  }

  async function callProvider(provider, input) {
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new ProviderError('PROVIDER_TIMEOUT', 'deadline')); }, deadlineMs);
    });
    const call = Promise.resolve().then(() => provider.generate({ ...input, signal: ctl.signal }));
    call.catch(() => {}); // a late rejection after the deadline must not be unhandled
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate({ incident, user, choice, ip, requestId }) {
    const teamId = user.teamId;
    const actor = { id: user.id, name: user.username };
    const base = { teamId, actor, action: 'draft.generate', targetType: 'incident', targetId: incident.id, ip, requestId };
    const existing = db.prepare('SELECT state FROM drafts WHERE incident_id = ?').get(incident.id);
    if (existing?.state === 'published') throw new ApiError('DRAFT_PUBLISHED');
    const rev = db.prepare('SELECT notes_rev FROM incidents WHERE id = ? AND team_id = ?').get(incident.id, teamId)?.notes_rev;
    const lines = db.prepare('SELECT n, time, ts, author, text FROM note_lines WHERE incident_id = ? ORDER BY n').all(incident.id).map(toLine);
    if (lines.length === 0) throw new ApiError('NO_NOTES');
    if (locks.has(incident.id)) throw new ApiError('GENERATION_IN_PROGRESS');
    locks.add(incident.id);
    try {
      const provider = await providers.resolve(choice);
      if (!provider) {
        audit.record({ ...base, outcome: 'fail', detail: { provider: choice, code: 'PROVIDER_UNAVAILABLE' } });
        throw unavailable(choice === 'auto' ? 'none' : choice);
      }
      let result;
      try {
        result = await callProvider(provider, {
          incident: { title: incident.title, severity: incident.severity, startedAt: incident.startedAt }, lines,
        });
      } catch (err) {
        const e = mapProviderError(err, provider.id);
        log?.({ level: 'error', event: 'draft.provider_failed', provider: provider.id, code: e.code, errorClass: String(err?.constructor?.name ?? 'Error').slice(0, 60) });
        audit.record({ ...base, outcome: 'fail', detail: { provider: provider.id, code: e.code } });
        throw e;
      }
      const v = validateDraft(result?.draft);
      if (!v.ok) {
        audit.record({ ...base, outcome: 'fail', detail: { provider: provider.id, code: 'PROVIDER_BAD_OUTPUT' } });
        throw new ApiError('PROVIDER_BAD_OUTPUT', { details: { fallbackAvailable: true } });
      }
      const u = result.usage ?? {};
      const int = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
      const usage = {
        provider: provider.id, model: typeof u.model === 'string' ? u.model : null,
        inputTokens: int(u.inputTokens), outputTokens: int(u.outputTokens),
        costUsd: Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : 0,
        durationMs: int(u.durationMs), attempts: Math.max(1, int(u.attempts)),
      };
      const draft = db.tx(() => {
        const cur = db.prepare('SELECT notes_rev FROM incidents WHERE id = ? AND team_id = ?').get(incident.id, teamId);
        if (!cur || cur.notes_rev !== rev) throw new ApiError('NOTES_CHANGED');
        const prev = db.prepare('SELECT id, state, version FROM drafts WHERE incident_id = ?').get(incident.id);
        if (prev?.state === 'published') throw new ApiError('DRAFT_PUBLISHED');
        const ctx = ctxFor(incident.id, teamId);
        const now = iso(clock);
        let draftId;
        if (prev) {
          draftId = prev.id;
          db.prepare('DELETE FROM statements WHERE draft_id = ?').run(draftId);
          db.prepare('UPDATE drafts SET version = version + 1, provider = ?, model = ?, is_fallback = ?, generated_at = ? WHERE id = ?')
            .run(provider.id, usage.model, provider.isFallback ? 1 : 0, now, draftId);
        } else {
          draftId = Number(db.prepare(`INSERT INTO drafts (incident_id, team_id, provider, model, is_fallback, generated_at)
            VALUES (?,?,?,?,?,?)`).run(incident.id, teamId, provider.id, usage.model, provider.isFallback ? 1 : 0, now).lastInsertRowid);
        }
        const ins = db.prepare('INSERT INTO statements (draft_id, section, position, text, cites, status, reasons) VALUES (?,?,?,?,?,?,?)');
        let count = 0;
        let flagged = 0;
        for (const section of DRAFT_SECTIONS) {
          v.draft[section].forEach((s, i) => {
            const r = verifyStatement(s, ctx);
            count += 1;
            if (r.status === 'flagged') flagged += 1;
            ins.run(draftId, section, i, s.text, JSON.stringify(s.cites), r.status, JSON.stringify(r.reasons));
          });
        }
        audit.record({ ...base, outcome: 'ok', detail: { provider: provider.id, statements: count, flagged, version: (prev?.version ?? 0) + 1 } });
        return get(draftId, teamId);
      });
      return { draft, usage };
    } finally {
      locks.delete(incident.id);
    }
  }

  // ---- edit / delete ------------------------------------------------------
  function loadForMutation(draftId, sid, teamId, expectedVersion) {
    const row = rowById(draftId, teamId);
    if (!row) throw new ApiError('NOT_FOUND');
    const st = db.prepare('SELECT * FROM statements WHERE id = ? AND draft_id = ?').get(sid, draftId);
    if (!st) throw new ApiError('NOT_FOUND');
    if (row.state === 'published') throw new ApiError('DRAFT_PUBLISHED');
    if (row.version !== expectedVersion) throw new ApiError('STALE_VERSION', { details: { currentVersion: row.version } });
    return { row, st };
  }

  function edit({ draftId, sid, user, body, ip, requestId }) {
    let text;
    if (body.text !== undefined) {
      text = body.text.trim();
      if (text === '') throw fieldError('text', 'must not be blank');
      if (CONTROL_RE.test(text)) throw fieldError('text', 'must not contain control characters');
    }
    if (text === undefined && body.cites === undefined) throw fieldError('', 'text or cites is required');
    return db.tx(() => {
      const { row, st } = loadForMutation(draftId, sid, user.teamId, body.expectedVersion);
      const newText = text ?? st.text;
      const cites = body.cites !== undefined ? [...new Set(body.cites)] : parseJson(st.cites, []);
      const r = verifyStatement({ text: newText, cites }, ctxFor(row.incident_id, user.teamId));
      db.prepare('UPDATE statements SET text = ?, cites = ?, status = ?, reasons = ?, edited = 1 WHERE id = ?')
        .run(newText, JSON.stringify(cites), r.status, JSON.stringify(r.reasons), sid);
      db.prepare('UPDATE drafts SET version = version + 1 WHERE id = ?').run(draftId);
      audit.record({
        teamId: user.teamId, actor: { id: user.id, name: user.username }, action: 'statement.edit', targetType: 'statement',
        targetId: sid, ip, requestId,
        detail: { draftId, oldLength: st.text.length, newLength: newText.length, oldHash: sha(st.text), newHash: sha(newText), cites: cites.length },
      });
      return get(draftId, user.teamId);
    });
  }

  function remove({ draftId, sid, user, expectedVersion, ip, requestId }) {
    return db.tx(() => {
      const { st } = loadForMutation(draftId, sid, user.teamId, expectedVersion);
      db.prepare('DELETE FROM statements WHERE id = ?').run(sid);
      db.prepare('UPDATE drafts SET version = version + 1 WHERE id = ?').run(draftId);
      audit.record({
        teamId: user.teamId, actor: { id: user.id, name: user.username }, action: 'statement.delete', targetType: 'statement',
        targetId: sid, ip, requestId, detail: { draftId, section: st.section, oldHash: sha(st.text) },
      });
      return get(draftId, user.teamId);
    });
  }

  // ---- publish ------------------------------------------------------------
  function publish({ draftId, user, expectedVersion, ip, requestId }) {
    const teamId = user.teamId;
    const base = { teamId, actor: { id: user.id, name: user.username }, targetType: 'draft', targetId: draftId, ip, requestId };
    try {
      return db.tx(() => {
        const row = rowById(draftId, teamId);
        if (!row) throw new ApiError('NOT_FOUND');
        if (row.state === 'published') throw new ApiError('DRAFT_PUBLISHED');
        if (row.version !== expectedVersion) throw new ApiError('STALE_VERSION', { details: { currentVersion: row.version } });
        const stmts = db.prepare('SELECT id, section, text, cites FROM statements WHERE draft_id = ? ORDER BY id').all(draftId);
        if (stmts.length === 0) throw fieldError('draft', 'has no statements to publish');
        const ctx = ctxFor(row.incident_id, teamId);
        const results = stmts.map((s) => ({ s, r: verifyStatement({ text: s.text, cites: parseJson(s.cites, []) }, ctx) }));
        const bad = results.filter((x) => x.r.status !== 'verified');
        if (bad.length > 0) {
          throw new ApiError('UNGROUNDED_STATEMENTS', {
            details: { statements: bad.slice(0, 20).map((x) => ({ id: x.s.id, section: x.s.section, reasons: x.r.reasons })) },
          });
        }
        const upd = db.prepare('UPDATE statements SET status = ?, reasons = ? WHERE id = ?');
        for (const x of results) upd.run(x.r.status, JSON.stringify(x.r.reasons), x.s.id);
        db.prepare("UPDATE drafts SET state = 'published', published_by = ?, published_at = ?, version = version + 1 WHERE id = ?")
          .run(user.id, iso(clock), draftId);
        audit.record({ ...base, action: 'draft.publish', detail: { statements: stmts.length, version: row.version + 1 } });
        return get(draftId, teamId);
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNGROUNDED_STATEMENTS') {
        audit.record({ ...base, action: 'draft.publish.refused', outcome: 'fail', detail: { flagged: err.details.statements.length } });
      }
      throw err;
    }
  }

  // ---- postmortems --------------------------------------------------------
  function listPublished(teamId) {
    return db.prepare(`SELECT d.id AS draft_id, d.incident_id, i.title, i.severity, i.started_at, d.published_at, d.is_fallback, u.display_name
      FROM drafts d JOIN incidents i ON i.id = d.incident_id JOIN users u ON u.id = d.published_by
      WHERE d.team_id = ? AND d.state = 'published' ORDER BY d.published_at DESC, d.id DESC`).all(teamId).map((r) => ({
      draftId: r.draft_id, incidentId: r.incident_id, title: r.title, severity: r.severity, startedAt: r.started_at,
      publishedAt: r.published_at, publishedBy: { displayName: r.display_name }, isFallback: r.is_fallback === 1,
    }));
  }

  function getPublished(draftId, teamId) {
    const row = db.prepare(`SELECT d.*, i.title, i.severity, i.started_at, i.description FROM drafts d
      JOIN incidents i ON i.id = d.incident_id WHERE d.id = ? AND d.team_id = ? AND d.state = 'published'`).get(draftId, teamId);
    if (!row) return null;
    const lines = db.prepare('SELECT n, time, ts, author, text FROM note_lines WHERE incident_id = ? ORDER BY n').all(row.incident_id).map(toLine);
    return {
      incident: { id: row.incident_id, title: row.title, severity: row.severity, startedAt: row.started_at, description: row.description },
      draft: shape(row), lines,
    };
  }

  return { get, byIncident, generate, edit, remove, publish, listPublished, getPublished };
}
