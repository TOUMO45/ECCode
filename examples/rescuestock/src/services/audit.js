// Audit events (append-only table audit_events). The detail object holds ids, codes and statuses only:
// keys and values that do not look like that are dropped, so free text, usernames, tokens and
// passwords cannot reach the table through this function.
import { isoFromMs } from '../clock.js';

const OUTCOMES = new Set(['ok', 'denied', 'failed']);
const DETAIL_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const DETAIL_TEXT = /^[A-Za-z0-9_.:-]{0,64}$/;
const MAX_DETAIL_KEYS = 12;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeDetail(detail) {
  const out = {};
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (kept >= MAX_DETAIL_KEYS) break;
    if (!DETAIL_KEY.test(key)) continue;
    const ok =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && DETAIL_TEXT.test(value));
    if (!ok) continue;
    out[key] = value;
    kept += 1;
  }
  return out;
}

// recordAudit(db, clock, { actorUserId, actorRole, action, entityType, entityId, outcome, detail, requestId })
// Returns the new row id. Call it inside the caller's transaction to commit with the change it describes.
export function recordAudit(db, clock, event) {
  const { actorUserId = null, actorRole = 'anonymous', action, entityType, entityId = null, outcome, detail, requestId = null } = event;
  if (!OUTCOMES.has(outcome)) throw new TypeError('Audit outcome must be ok, denied or failed.');
  if (typeof action !== 'string' || !/^[a-z][a-z0-9_.]{1,63}$/.test(action)) throw new TypeError('Invalid audit action.');
  if (typeof entityType !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(entityType)) throw new TypeError('Invalid audit entity type.');
  if (typeof actorRole !== 'string' || !/^[a-z]{1,16}$/.test(actorRole)) throw new TypeError('Invalid audit actor role.');
  const result = db
    .prepare(
      'INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      isoFromMs(clock.now()),
      Number.isSafeInteger(actorUserId) ? actorUserId : null,
      actorRole,
      action,
      entityType,
      Number.isSafeInteger(entityId) ? entityId : null,
      outcome,
      JSON.stringify(sanitizeDetail(detail)),
      typeof requestId === 'string' && REQUEST_ID.test(requestId) ? requestId : null,
    );
  return Number(result.lastInsertRowid);
}
