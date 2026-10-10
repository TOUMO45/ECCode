// Requests and requirements (spec: Customer routes > requests, confirm).
//
//   createRequest(ctx, user, text)       POST /api/requests: the daily count and the insert share one BEGIN IMMEDIATE (SEC-2)
//   confirmRequirements(ctx, user, id, body)   POST /api/requests/:id/confirm: values only, provenance derived here (SEC-8)
//   findOwnedRequest                     re-exported from view.js; every customer query is scoped by the session user
//
// A new requirements version supersedes proposed/approved plan versions (reason REQUIREMENTS_CHANGED) and queues a
// re-plan in replan_queue; src/services/plans.js owns that supersession so f1 extends one place.
import { isoFromMs } from '../clock.js';
import { AppError } from '../http/envelope.js';
import { enumOf, int, localDateTime, str } from '../http/validate.js';
import { localDay, localToUtc, localToUtcMs } from '../domain/time.js';
import { recordAudit } from './audit.js';
import { removeImageFiles } from './extraction.js';
import { supersedeOpenVersions } from './plans.js';
import { markNonExecutable } from './supersession.js';
import { findOwnedRequest, parseJson } from './view.js';

export { findOwnedRequest };

const FIELD_NAMES = Object.freeze([
  'productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups',
]);
// A confirmation without one of these is REQUIREMENTS_INCOMPLETE. Budget and deadline are optional here: without
// them the plan can be made but not approved (RS-04, MISSING_BUDGET / MISSING_DEADLINE at approve).
const CORE_FIELDS = Object.freeze(['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']);
const CHECKS = Object.freeze({
  productType: enumOf('cups_and_lids', 'cups', 'lids'),
  cupQuantity: int(0, 100000),
  lidQuantity: int(0, 100000),
  capacityMl: int(1, 5000),
  diameterMm: int(1, 500),
  material: enumOf('paper', 'plastic', 'other'),
  deadline: localDateTime(),
  budgetCents: int(1, 100000000),
  maxPickups: int(1, 5),
});
const PROVENANCE_KEPT = Object.freeze(['user_text', 'image', 'manual']);
const MAX_WORDING = 80;
const REQUEST_TEXT = str(1, 4000);
const HOUR_MS = 3600 * 1000;

// ------------------------------------------------------------------ create

// ar / en / mixed / unknown from the share of Arabic-script and Latin letters.
export function detectLanguage(text) {
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\p{Script=Arabic}/u.test(ch)) arabic += 1;
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
  }
  if (arabic === 0 && latin === 0) return 'unknown';
  const minor = Math.min(arabic, latin) / (arabic + latin);
  if (minor >= 0.15) return 'mixed';
  return arabic > latin ? 'ar' : 'en';
}

// Validates the request text: 1 to 4000 characters, not blank, no NUL.
export function checkRequestText(value) {
  const checked = REQUEST_TEXT(value);
  if (!checked.ok) return checked;
  if (checked.value.trim().length === 0) return { ok: false, rule: 'blank' };
  if (checked.value.includes('\u0000')) return { ok: false, rule: 'characters' };
  return checked;
}

// [start, end) of the Asia/Amman day that contains `nowMs`, as epoch milliseconds.
export function amanDayBounds(nowMs) {
  const day = localDay(nowMs);
  const start = localToUtcMs(`${day}T00:00`);
  const end = localToUtcMs(`${localDay(start + 36 * HOUR_MS)}T00:00`);
  return { day, start, end };
}

export function createRequest(ctx, user, text) {
  const { db, clock, config } = ctx;
  const nowMs = clock.now();
  const now = isoFromMs(nowMs);
  const { start, end } = amanDayBounds(nowMs);
  const key = `u:${user.id}`;
  const language = detectLanguage(text);

  const outcome = db.tx(() => {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'request_create' AND user_key = ? AND at >= ? AND at < ?")
      .get(key, isoFromMs(start), isoFromMs(end));
    if (row.n >= config.maxRequestsPerCustomerPerDay) return { limited: true };
    db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'request_create', ?)").run(key, now);
    const id = Number(
      db
        .prepare("INSERT INTO rescue_requests (customer_id, raw_text, language, intake_status, created_at) VALUES (?, ?, ?, 'draft', ?)")
        .run(user.id, text, language, now).lastInsertRowid,
    );
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'request.create', entityType: 'request', entityId: id, outcome: 'ok', requestId: ctx.requestId,
    });
    return { id };
  });

  if (outcome.limited) {
    throw new AppError(429, 'RATE_LIMITED', {
      details: { limit: 'requests_per_day' },
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((end - nowMs) / 1000))) },
    });
  }
  return { id: outcome.id, createdAt: now, language, intakeStatus: 'draft' };
}

// ------------------------------------------------------------------ confirm

function bad(fields) {
  return new AppError(422, 'VALIDATION_FAILED', { details: { fields } });
}

const absent = (v) => v === undefined || v === null;

// Body -> checked values. A client-sent provenance or wording is ignored: only the nine values are read (SEC-8).
// Throws 422 VALIDATION_FAILED for a bad value and 422 REQUIREMENTS_INCOMPLETE for a missing core field.
export function parseConfirmBody(body) {
  const submitted = body !== null && typeof body === 'object' ? body.fields : undefined;
  if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) throw bad([{ field: 'fields', rule: 'object' }]);

  const values = {};
  const invalid = [];
  const missing = [];
  for (const name of FIELD_NAMES) {
    const raw = Object.hasOwn(submitted, name) ? submitted[name] : undefined;
    if (absent(raw)) {
      values[name] = null;
      if (CORE_FIELDS.includes(name)) missing.push(name);
      continue;
    }
    const checked = CHECKS[name](raw);
    if (checked.ok) values[name] = checked.value;
    else invalid.push({ field: name, rule: checked.rule });
  }
  let deadlineAt = null;
  if (values.deadline !== null && !invalid.some((f) => f.field === 'deadline')) {
    try {
      deadlineAt = localToUtc(values.deadline);
    } catch {
      invalid.push({ field: 'deadline', rule: 'localDateTime' });
    }
  }
  if (invalid.length === 0 && !missing.includes('productType')) {
    const { productType, cupQuantity, lidQuantity } = values;
    if (productType === 'cups' && lidQuantity !== null && lidQuantity !== 0) invalid.push({ field: 'lidQuantity', rule: 'zero_for_cups' });
    if (productType === 'lids' && cupQuantity !== null && cupQuantity !== 0) invalid.push({ field: 'cupQuantity', rule: 'zero_for_lids' });
    if (productType === 'cups_and_lids') {
      if (cupQuantity === 0) invalid.push({ field: 'cupQuantity', rule: 'range:1..100000' });
      if (lidQuantity === 0) invalid.push({ field: 'lidQuantity', rule: 'range:1..100000' });
    }
    if (productType === 'cups' && cupQuantity === 0) invalid.push({ field: 'cupQuantity', rule: 'range:1..100000' });
    if (productType === 'lids' && lidQuantity === 0) invalid.push({ field: 'lidQuantity', rule: 'range:1..100000' });
  }
  if (invalid.length > 0) throw bad(invalid);
  if (missing.length > 0) throw new AppError(422, 'REQUIREMENTS_INCOMPLETE', { details: { fields: missing } });
  return { values, deadlineAt };
}

// The server keeps an extracted field's provenance and wording only when the submitted value equals the extracted
// known value. Everything else the customer typed is `manual`; an empty field is unknown / none.
export function buildFields(values, extractionRow) {
  const usable = extractionRow && extractionRow.schema_ok === 1 && extractionRow.degraded === 0;
  const extracted = usable ? parseJson(extractionRow.fields_json, {}) : {};
  const fields = {};
  for (const name of FIELD_NAMES) {
    const value = values[name];
    if (value === null) {
      fields[name] = { value: null, status: 'unknown', provenance: 'none', originalWording: null };
      continue;
    }
    const found = extracted && typeof extracted === 'object' ? extracted[name] : undefined;
    if (found && found.status === 'known' && found.value === value && PROVENANCE_KEPT.includes(found.provenance)) {
      const wording = typeof found.originalWording === 'string' ? Array.from(found.originalWording).slice(0, MAX_WORDING).join('') : null;
      fields[name] = { value, status: 'known', provenance: found.provenance, originalWording: found.provenance === 'manual' ? null : wording };
    } else {
      fields[name] = { value, status: 'known', provenance: 'manual', originalWording: null };
    }
  }
  return fields;
}

function sameRequirements(previous, next) {
  return (
    previous.product_type === next.product_type && previous.cups === next.cups && previous.lids === next.lids &&
    previous.capacity_ml === next.capacity_ml && previous.diameter_mm === next.diameter_mm && (previous.material ?? null) === next.material &&
    (previous.budget_cents ?? null) === next.budget_cents && (previous.deadline_at ?? null) === next.deadline_at &&
    previous.max_pickups === next.max_pickups
  );
}

// Returns { requirements: {version, fields, confirmedAt}, supersededVersionIds }.
export function confirmRequirements(ctx, user, requestId, body) {
  const { db, clock } = ctx;
  findOwnedRequest(db, user.id, requestId); // 404 before the body is looked at
  const { values, deadlineAt } = parseConfirmBody(body);
  const now = isoFromMs(clock.now());

  return db.tx(() => {
    findOwnedRequest(db, user.id, requestId);
    const inProgress = db
      .prepare("SELECT id FROM plan_versions WHERE request_id = ? AND status IN ('executing','executed') LIMIT 1")
      .get(requestId);
    if (inProgress) throw new AppError(409, 'PLAN_IN_PROGRESS', { details: { planVersionId: inProgress.id } });

    const extraction = db.prepare('SELECT * FROM extractions WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId) ?? null;
    const fields = buildFields(values, extraction);
    const cups = values.productType === 'lids' ? 0 : values.cupQuantity;
    const lids = values.productType === 'cups' ? 0 : values.lidQuantity;
    const next = {
      product_type: values.productType, cups, lids, capacity_ml: values.capacityMl, diameter_mm: values.diameterMm,
      material: values.material, budget_cents: values.budgetCents, deadline_at: deadlineAt, max_pickups: values.maxPickups,
    };

    const previous = db.prepare('SELECT * FROM requirements WHERE request_id = ? ORDER BY version DESC LIMIT 1').get(requestId) ?? null;

    // SEC-C-3: a confirm that changes nothing (same values, same derived provenance) returns the latest version and
    // writes no requirements row, no audit row and no re-plan, so a loop of identical confirms cannot grow the tables.
    if (previous && sameRequirements(previous, next) && previous.fields_json === JSON.stringify(fields)) {
      db.prepare("UPDATE rescue_requests SET intake_status = 'confirmed' WHERE id = ?").run(requestId);
      return {
        requirements: { version: previous.version, fields: parseJson(previous.fields_json, fields), confirmedAt: previous.confirmed_at },
        supersededVersionIds: [],
      };
    }

    const version = previous ? previous.version + 1 : 1;
    db.prepare(
      'INSERT INTO requirements (request_id, version, fields_json, product_type, cups, lids, capacity_ml, diameter_mm, material, ' +
        'budget_cents, deadline_at, max_pickups, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      requestId, version, JSON.stringify(fields), next.product_type, next.cups, next.lids, next.capacity_ml, next.diameter_mm,
      next.material, next.budget_cents, next.deadline_at, next.max_pickups, user.id, now,
    );
    db.prepare("UPDATE rescue_requests SET intake_status = 'confirmed' WHERE id = ?").run(requestId);

    // A change of what the customer needs voids the open plan versions and queues a re-plan.
    let superseded = [];
    if (previous && !sameRequirements(previous, next)) {
      superseded = supersedeOpenVersions(ctx, requestId, 'REQUIREMENTS_CHANGED', now);
      if (superseded.length > 0) {
        db.prepare(
          'INSERT INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (?, ?, ?, 0, ?) ' +
            'ON CONFLICT(request_id) DO UPDATE SET reason = excluded.reason',
        ).run(requestId, 'REQUIREMENTS_CHANGED', now, now);
      }
    }
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'requirements.confirm', entityType: 'request', entityId: requestId,
      outcome: 'ok', detail: { version, superseded: superseded.length }, requestId: ctx.requestId,
    });
    return { requirements: { version, fields, confirmedAt: now }, supersededVersionIds: superseded };
  });
}

// ------------------------------------------------------------------ delete (RS-39, T23)

// A request is refused while money is held: an operation of any version is in one of these states, a version is executing,
// or a reservation is reconciling (spec: Retention and deletion).
const HOLDING_SQL =
  'SELECT pv.id AS plan_version_id FROM plan_versions pv WHERE pv.request_id = ? AND (' +
  "pv.status = 'executing' " +
  "OR EXISTS (SELECT 1 FROM reservations r WHERE r.plan_version_id = pv.id AND r.status = 'reconciling') " +
  'OR EXISTS (SELECT 1 FROM supplier_orders so JOIN payment_operations po ON po.supplier_order_id = so.id WHERE so.plan_version_id = pv.id AND po.status IN ' +
  "('approved','authorization_pending','authorized','capture_pending','refund_requested','refund_pending','unknown'))) LIMIT 1";

// Every originalWording of a stored FieldValue map becomes null (the wording is the customer's text).
function scrubWording(fieldsJson) {
  const fields = parseJson(fieldsJson, null);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return fieldsJson;
  for (const value of Object.values(fields)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'originalWording')) value.originalWording = null;
  }
  return JSON.stringify(fields);
}

/**
 * DELETE /api/requests/:id -> { deleted: 'hard' | 'tombstoned' }.
 *   409 PAYMENT_IN_PROGRESS while money is held (nothing changes).
 *   Otherwise an approved plan version (and with it an active reservation, open supplier orders and unpaid operations) is ended by
 *   the void rule with reason REQUEST_DELETED.
 *   No supplier order or reservation ever existed -> hard delete (the cascade removes images, extractions, requirements, runs and
 *   versions). Otherwise a tombstone: deleted_at set, raw text, images and extractions gone, wording scrubbed from every
 *   requirements version; plan, order, payment and provider-call rows stay (ids, amounts and statuses only).
 * An audit event is written either way. The image files are unlinked after the commit; a file that cannot be removed is left
 * for the retention sweep (its row is gone, so it is an orphan).
 */
export async function deleteRequest(ctx, user, requestId) {
  const { db, clock, config } = ctx;
  const outcome = db.tx(() => {
    findOwnedRequest(db, user.id, requestId);
    const holding = db.prepare(HOLDING_SQL).get(requestId);
    if (holding) throw new AppError(409, 'PAYMENT_IN_PROGRESS', { details: { planVersionId: holding.plan_version_id } });

    for (const version of db.prepare("SELECT id FROM plan_versions WHERE request_id = ? AND status = 'approved' ORDER BY id").all(requestId)) {
      markNonExecutable(ctx, { planVersionId: version.id, reason: 'REQUEST_DELETED', detail: {}, actor: user, requestId: ctx.requestId });
    }

    const images = db.prepare('SELECT file_name, mime_detected FROM images WHERE request_id = ?').all(requestId).map((r) => ({ ...r }));
    const hadOrders =
      db.prepare('SELECT 1 AS x FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE pv.request_id = ? LIMIT 1').get(requestId) !== undefined ||
      db.prepare('SELECT 1 AS x FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE pv.request_id = ? LIMIT 1').get(requestId) !== undefined;

    let deleted;
    if (!hadOrders) {
      db.prepare('DELETE FROM rescue_requests WHERE id = ?').run(requestId);
      deleted = 'hard';
    } else {
      const now = isoFromMs(clock.now());
      db.prepare('UPDATE rescue_requests SET deleted_at = ?, raw_text = NULL WHERE id = ?').run(now, requestId);
      db.prepare('DELETE FROM images WHERE request_id = ?').run(requestId);
      db.prepare('DELETE FROM extractions WHERE request_id = ?').run(requestId);
      db.prepare('DELETE FROM replan_queue WHERE request_id = ?').run(requestId);
      for (const row of db.prepare('SELECT id, fields_json FROM requirements WHERE request_id = ?').all(requestId)) {
        db.prepare('UPDATE requirements SET fields_json = ? WHERE id = ?').run(scrubWording(row.fields_json), row.id);
      }
      deleted = 'tombstoned';
    }
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'request.delete', entityType: 'request', entityId: requestId, outcome: 'ok',
      detail: { mode: deleted, images: images.length }, requestId: ctx.requestId,
    });
    return { deleted, images };
  });
  const failed = await removeImageFiles(config, outcome.images);
  if (failed > 0) ctx.log?.warn?.('request.delete.files', { requestRef: requestId, counts: { leftForSweep: failed } });
  return { deleted: outcome.deleted };
}
