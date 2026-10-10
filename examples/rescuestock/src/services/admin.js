// Admin tools (spec: Interface Contracts > Admin routes; Reset; Forced reset). Every function here is reached only
// through routes with policy 'admin' (RS-30: anonymous 401, customer and supplier 403).
//
//   resetDemo(ctx, user, { force, reason })   POST /api/admin/reset
//   applyFault(ctx, user, input)              POST /api/admin/faults
//   buildTimeline(ctx, query)                 GET  /api/admin/timeline
//   buildMetrics(ctx)                         GET  /api/admin/metrics
//
// Reset never deletes payment_operations or provider_calls rows: it archives them (archived_at). Without `force` it is
// refused (409 RESET_BLOCKED) while any non-archived operation is in a state that holds or moves money. Providers are
// reached only through the void rule's provider port: with the default no-op port nothing is sent, so a forced reset
// lists every operation that is still not terminal in `stranded` and in its audit event, for manual clean-up.
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { isoFromMs } from '../clock.js';
import { localDay } from '../domain/time.js';
import { TERMINAL_PAYMENT_STATES, assertTransition } from '../domain/states.js';
import { AppError } from '../http/envelope.js';
import { enumOf, int, str, validateObject } from '../http/validate.js';
import { recordAudit } from './audit.js';
import { actorOf, closeReservation, resetInventory } from './ledger.js';
import { openOrderIdsOfSupplier, refuseSupplierOrder } from './orders.js';
import { markNonExecutable, supersedeForOfferChange } from './supersession.js';
import { parseJson } from './view.js';

export const RESET_BLOCKING_STATES = Object.freeze([
  'approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'refund_requested', 'refund_pending', 'unknown',
]);
const PAYPAL_KINDS = ['create_order', 'authorize', 'capture', 'void', 'refund'];
const PAYPAL_FAULTS = Object.freeze([
  'authorize_denied', 'authorize_pending', 'capture_declined', 'capture_pending', 'refund_pending', 'refund_failed', 'void_fail',
  'auth_expire', 'order_not_approvable',
]);
const PAYPAL_KIND_FAULTS = Object.freeze(['lost_response', 'timeout', 'http_500']);
// Accepted only with RS_TEST_HOOKS=1 (spec: fake_paypal.fault).
const PAYPAL_TEST_FAULTS = Object.freeze([
  'freeze_after_capture_apply', 'freeze_before_capture_apply', 'crash_after_return_commit', 'capture_lands_after_void_intent',
]);
const MODEL_FAULTS = Object.freeze(['timeout', 'invalid_json', 'schema_invalid', 'error']);
const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp']);

// ------------------------------------------------------------------ audit with the operator's note

// The operator's reason is admin-typed text (10-500 characters), not request data or a secret. recordAudit() keeps only
// short identifiers, so the reset writes its own row to keep the reason with the actor (spec: Reset).
function auditReset(db, clock, user, outcome, detail, requestId) {
  db.prepare(
    'INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) ' +
      "VALUES (?, ?, ?, 'admin.reset', 'demo', NULL, ?, ?, ?)",
  ).run(isoFromMs(clock.now()), user.id, user.role, outcome, JSON.stringify(detail), typeof requestId === 'string' ? requestId : null);
}

// ------------------------------------------------------------------ reset

export function checkResetBody(body) {
  const input = validateObject(body, {
    force: { check: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, rule: 'boolean' }), optional: true },
    reason: { check: str(10, 500), optional: true },
  });
  if (input.force === true && input.reason === undefined) {
    throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'reason', rule: 'required_with_force' }] } });
  }
  return { force: input.force === true, reason: input.reason ?? null };
}

function removeImageFiles(ctx, fileNames) {
  let dir;
  try {
    dir = resolve(ctx.config.uploadDir);
  } catch {
    return;
  }
  for (const name of fileNames) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    for (const ext of IMAGE_EXTENSIONS) {
      try {
        unlinkSync(resolve(dir, `${name}.${ext}`));
      } catch {
        // Not there (or already removed): the startup/hourly sweep removes orphans.
      }
    }
  }
}

function restoreCatalog(db, clock, actor, now) {
  const products = db.prepare('SELECT product_id, supplier_id FROM inventory ORDER BY product_id').all();
  for (const { product_id: productId } of products) {
    const seeded = db
      .prepare("SELECT COALESCE(SUM(delta_on_hand), 0) AS n, COUNT(*) AS rows FROM inventory_ledger WHERE product_id = ? AND ref_type = 'seed'")
      .get(productId);
    if (seeded.rows > 0) resetInventory(db, clock, { productId, onHand: seeded.n, reserved: 0, actor });

    const first = db.prepare('SELECT * FROM offers WHERE product_id = ? AND version = 1').get(productId);
    const current = db.prepare("SELECT * FROM offers WHERE product_id = ? AND status IN ('active','withdrawn')").get(productId);
    if (!first || !current) continue;
    const same =
      current.status === 'active' && current.price_cents === first.price_cents && current.prep_fee_cents === first.prep_fee_cents && current.ready_at === first.ready_at;
    if (same) continue;
    const next = db.prepare('SELECT MAX(version) + 1 AS v FROM offers WHERE product_id = ?').get(productId).v;
    db.prepare("UPDATE offers SET status = 'replaced', valid_to = ? WHERE id = ?").run(now, current.id);
    db.prepare(
      "INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)",
    ).run(first.supplier_id, productId, first.price_cents, first.prep_fee_cents, first.ready_at, next, now, first.demo);
  }
}

export function resetDemo(ctx, user, { force, reason }) {
  const { db, clock } = ctx;
  const actor = actorOf(user);

  const fileNames = [];
  const outcome = db.tx(() => {
    const now = isoFromMs(clock.now());
    // The guard is read inside the write transaction, so a payment that starts a moment later cannot slip past it.
    const blocking = db
      .prepare(`SELECT id, status FROM payment_operations WHERE archived_at IS NULL AND status IN (${RESET_BLOCKING_STATES.map(() => '?').join(',')}) ORDER BY id`)
      .all(...RESET_BLOCKING_STATES)
      .map((op) => ({ id: op.id, status: op.status }));
    if (blocking.length > 0 && !force) return { blocked: blocking };

    // Live plans end through the void rule (reservations released, orders cancelled, operations voided or void queued).
    const approved = db
      .prepare(
        "SELECT pv.id FROM plan_versions pv JOIN rescue_requests rr ON rr.id = pv.request_id WHERE pv.status = 'approved' AND rr.archived_at IS NULL ORDER BY pv.id",
      )
      .all();
    for (const { id } of approved) {
      markNonExecutable(ctx, { planVersionId: id, reason: 'DEMO_RESET', detail: {}, actor: user, requestId: ctx.requestId });
    }
    // Any reservation still active (its plan was not approved) is released as well.
    for (const { id } of db.prepare("SELECT id FROM reservations WHERE status = 'active' ORDER BY id").all()) {
      closeReservation(db, clock, { reservationId: id, to: 'released', actor, requestId: ctx.requestId });
    }

    const stranded = db
      .prepare(
        'SELECT id, status, provider_authorization_id, provider_capture_id FROM payment_operations WHERE archived_at IS NULL ORDER BY id',
      )
      .all()
      .filter((op) => !TERMINAL_PAYMENT_STATES.includes(op.status))
      .map((op) => ({
        id: op.id, status: op.status, providerAuthorizationId: op.provider_authorization_id ?? null, providerCaptureId: op.provider_capture_id ?? null,
      }));
    const archivedOperations = Number(db.prepare('UPDATE payment_operations SET archived_at = ?, updated_at = ? WHERE archived_at IS NULL').run(now, now).changes);
    db.prepare('UPDATE provider_calls SET archived_at = ? WHERE archived_at IS NULL').run(now);

    // Every request still visible is tombstoned (raw text nulled, extractions and images deleted, archived).
    const requests = db.prepare('SELECT id FROM rescue_requests WHERE archived_at IS NULL').all().map((r) => r.id);
    for (const row of db.prepare('SELECT file_name FROM images').all()) fileNames.push(row.file_name);
    db.prepare('DELETE FROM images').run();
    db.prepare('DELETE FROM extractions').run();
    db.prepare('DELETE FROM replan_queue').run();
    db.prepare('UPDATE rescue_requests SET raw_text = NULL, archived_at = ? WHERE archived_at IS NULL').run(now);
    for (const row of db.prepare('SELECT id, fields_json FROM requirements').all()) {
      const fields = parseJson(row.fields_json, null);
      if (!fields || typeof fields !== 'object') continue;
      let touched = false;
      for (const value of Object.values(fields)) {
        if (value && typeof value === 'object' && value.originalWording) {
          value.originalWording = null;
          touched = true;
        }
      }
      if (touched) db.prepare('UPDATE requirements SET fields_json = ? WHERE id = ?').run(JSON.stringify(fields), row.id);
    }

    restoreCatalog(db, clock, actor, now);

    // The fake payment provider's state, the fault flags, and the daily counters demo retakes depend on (F-TR-15).
    db.prepare('DELETE FROM fake_paypal_calls').run();
    db.prepare('DELETE FROM fake_paypal_requests').run();
    db.prepare('DELETE FROM fake_paypal_refunds').run();
    db.prepare('DELETE FROM fake_paypal_captures').run();
    db.prepare('DELETE FROM fake_paypal_authorizations').run();
    db.prepare('DELETE FROM fake_paypal_orders').run();
    db.prepare('DELETE FROM fault_flags').run();
    db.prepare("DELETE FROM rate_events WHERE kind = 'request_create' OR (kind = 'general' AND user_key LIKE 'plan:%')").run();

    auditReset(
      db, clock, user, 'ok',
      { force, reason, archivedOperations, requests: requests.length, stranded: stranded.map((s) => ({ id: s.id, status: s.status })) },
      ctx.requestId,
    );
    return { archivedOperations, stranded };
  });
  if (outcome.blocked) {
    auditReset(db, clock, user, 'denied', { code: 'RESET_BLOCKED', operations: outcome.blocked.length }, ctx.requestId);
    throw new AppError(409, 'RESET_BLOCKED', { details: { operations: outcome.blocked } });
  }
  removeImageFiles(ctx, fileNames);

  const body = { reset: true, archivedOperations: outcome.archivedOperations };
  if (outcome.stranded.length > 0) body.stranded = outcome.stranded;
  return body;
}

// ------------------------------------------------------------------ faults

const supplierCodeCheck = str(1, 1, /^[A-Z]$/);

function supplierByCode(db, code) {
  const supplier = db.prepare('SELECT id, code FROM suppliers WHERE code = ?').get(code);
  if (!supplier) throw new AppError(404, 'NOT_FOUND');
  return supplier;
}

function checkFaultName(config, fault) {
  const text = str(1, 64, /^[a-z0-9_]+(:[a-z_0-9]+)?$/)(fault);
  if (!text.ok) return text;
  const [head, tail] = fault.split(':');
  if (tail === undefined) {
    if (PAYPAL_FAULTS.includes(head)) return { ok: true, value: fault };
    if (PAYPAL_TEST_FAULTS.includes(head)) return config.testHooks ? { ok: true, value: fault } : { ok: false, rule: 'test_hooks_disabled' };
    return { ok: false, rule: 'enum' };
  }
  return PAYPAL_KIND_FAULTS.includes(head) && PAYPAL_KINDS.includes(tail) ? { ok: true, value: fault } : { ok: false, rule: 'enum' };
}

function stockDepletion(ctx, user, supplierCode) {
  const { db, clock } = ctx;
  const supplier = supplierByCode(db, supplierCode);
  return db.tx(() => {
    const now = isoFromMs(clock.now());
    const changes = [];
    for (const offer of db.prepare("SELECT * FROM offers WHERE supplier_id = ? AND status = 'active' ORDER BY id").all(supplier.id)) {
      db.prepare("UPDATE offers SET status = 'replaced', valid_to = ? WHERE id = ?").run(now, offer.id);
      db.prepare(
        "INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, ?, ?, ?, ?, 'withdrawn', ?, NULL, ?)",
      ).run(offer.supplier_id, offer.product_id, offer.price_cents, offer.prep_fee_cents, offer.ready_at, offer.version + 1, now, offer.demo);
      changes.push({ offerId: offer.id, reason: 'OFFER_WITHDRAWN' });
    }
    const superseded = supersedeForOfferChange(ctx, { changes, actor: user, requestId: ctx.requestId });
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'fault', entityId: supplier.id,
      outcome: 'ok', detail: { kind: 'stock_depletion', supplierCode, withdrawn: changes.length, superseded: superseded.length }, requestId: ctx.requestId,
    });
    return {
      applied: { kind: 'stock_depletion', supplierCode },
      superseded: superseded.map((s) => s.planVersionId),
    };
  });
}

function supplierRefusal(ctx, user, supplierCode, reason) {
  const { db, clock } = ctx;
  const supplier = supplierByCode(db, supplierCode);
  const orderIds = openOrderIdsOfSupplier(db, supplier.id);
  const refused = [];
  for (const id of orderIds) {
    // The same service as the supplier's own route, one transaction per order.
    refuseSupplierOrder(ctx, user, id, reason, { supplierId: null });
    refused.push(id);
  }
  recordAudit(db, clock, {
    actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'fault', entityId: supplier.id,
    outcome: 'ok', detail: { kind: 'supplier_refusal', supplierCode, orders: refused.length }, requestId: ctx.requestId,
  });
  return { applied: { kind: 'supplier_refusal', supplierCode, supplierOrderIds: refused } };
}

function refundOrder(ctx, user, supplierOrderId) {
  const { db, clock } = ctx;
  return db.tx(() => {
    const row = db
      .prepare(
        'SELECT so.id, po.id AS operation_id, po.status AS operation_status, pv.status AS plan_status FROM supplier_orders so ' +
          'JOIN plan_versions pv ON pv.id = so.plan_version_id JOIN payment_operations po ON po.supplier_order_id = so.id WHERE so.id = ?',
      )
      .get(supplierOrderId);
    if (!row) throw new AppError(404, 'NOT_FOUND');
    if (row.operation_status !== 'captured' || row.plan_status !== 'executed') {
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'supplier_order', entityId: supplierOrderId,
        outcome: 'denied', detail: { kind: 'refund_order', code: 'INVALID_STATE' }, requestId: ctx.requestId,
      });
      throw new AppError(409, 'INVALID_STATE', { details: { from: row.operation_status, to: 'refund_requested' } });
    }
    const now = isoFromMs(clock.now());
    assertTransition('payment', 'captured', 'refund_requested');
    const moved = db.prepare("UPDATE payment_operations SET status = 'refund_requested', updated_at = ? WHERE id = ? AND status = 'captured'").run(now, row.operation_id).changes;
    if (moved !== 1) throw new AppError(409, 'INVALID_STATE', { details: { from: 'captured', to: 'refund_requested' } });
    // Queued, not sent: the saga and the reconciler send it (provider call protocol, Sender table).
    db.prepare(
      "INSERT OR IGNORE INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (?, 'refund', 1, ?, 'intent', ?)",
    ).run(row.operation_id, `so:${supplierOrderId}:refund:1`, now);
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'supplier_order', entityId: supplierOrderId,
      outcome: 'ok', detail: { kind: 'refund_order', supplierOrderId }, requestId: ctx.requestId,
    });
    return { applied: { kind: 'refund_order', supplierOrderId } };
  });
}

// fake_paypal / fake_model: a row in fault_flags that the fake adapter reads. name = '<kind>:<fault>', value = the
// supplier code ('' for all), remaining = how many calls it affects (NULL = until cleared).
function setFlag(ctx, user, kind, fault, supplierCode, count) {
  const { db, clock } = ctx;
  return db.tx(() => {
    const now = isoFromMs(clock.now());
    db.prepare(
      'INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET value = excluded.value, remaining = excluded.remaining, created_at = excluded.created_at',
    ).run(`${kind}:${fault}`, supplierCode ?? '', count ?? null, now);
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'fault', entityId: null,
      outcome: 'ok', detail: { kind, fault, supplierCode: supplierCode ?? '', count: count ?? 0 }, requestId: ctx.requestId,
    });
    const applied = { kind, fault };
    if (supplierCode) applied.supplierCode = supplierCode;
    if (count) applied.count = count;
    return { applied };
  });
}

function clearFlags(ctx, user) {
  const { db, clock } = ctx;
  return db.tx(() => {
    const cleared = Number(db.prepare('DELETE FROM fault_flags').run().changes);
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'admin.fault', entityType: 'fault', entityId: null,
      outcome: 'ok', detail: { kind: 'clear', cleared }, requestId: ctx.requestId,
    });
    return { applied: { kind: 'clear' } };
  });
}

export function applyFault(ctx, user, body) {
  const { config } = ctx;
  const kind = enumOf('stock_depletion', 'supplier_refusal', 'refund_order', 'fake_paypal', 'fake_model', 'clear');
  const head = validateObject(body, { kind });
  switch (head.kind) {
    case 'stock_depletion': {
      const input = validateObject(body, { supplierCode: supplierCodeCheck });
      return stockDepletion(ctx, user, input.supplierCode);
    }
    case 'supplier_refusal': {
      const input = validateObject(body, { supplierCode: supplierCodeCheck, reason: { check: str(1, 300), optional: true } });
      return supplierRefusal(ctx, user, input.supplierCode, input.reason ?? 'Refused by the organiser (demo fault).');
    }
    case 'refund_order': {
      const input = validateObject(body, { supplierOrderId: int(1, 1e12) });
      return refundOrder(ctx, user, input.supplierOrderId);
    }
    case 'fake_paypal': {
      const input = validateObject(body, {
        fault: (v) => checkFaultName(config, v),
        supplierCode: { check: supplierCodeCheck, optional: true },
        count: { check: int(1, 10), optional: true },
      });
      if (config.paymentProvider !== 'fake') throw new AppError(409, 'FAULTS_UNAVAILABLE');
      if (input.supplierCode) supplierByCode(ctx.db, input.supplierCode);
      return setFlag(ctx, user, 'fake_paypal', input.fault, input.supplierCode, input.count);
    }
    case 'fake_model': {
      const input = validateObject(body, { fault: enumOf(...MODEL_FAULTS), count: { check: int(1, 10), optional: true } });
      if (config.extractionProvider !== 'fake') throw new AppError(409, 'FAULTS_UNAVAILABLE');
      return setFlag(ctx, user, 'fake_model', input.fault, null, input.count);
    }
    default:
      return clearFlags(ctx, user);
  }
}

// ------------------------------------------------------------------ timeline

const SOURCES = Object.freeze(['audit', 'ledger', 'provider_call', 'webhook']);
const CURSOR = /^(\d{1,15})\.([0-3])\.(\d{1,15})$/;
const DEFAULT_LIMIT = 200;

export function checkTimelineQuery(query) {
  const fields = [];
  let requestId = null;
  let after = null;
  let limit = DEFAULT_LIMIT;
  if (query.requestId !== undefined) {
    if (!/^[1-9]\d{0,14}$/.test(query.requestId)) fields.push({ field: 'requestId', rule: 'id' });
    else requestId = Number(query.requestId);
  }
  if (query.afterId !== undefined) {
    const m = CURSOR.exec(query.afterId);
    if (!m) fields.push({ field: 'afterId', rule: 'cursor' });
    else after = { at: isoFromMs(Number(m[1])), source: Number(m[2]), id: Number(m[3]) };
  }
  if (query.limit !== undefined) {
    if (!/^\d{1,4}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 500) fields.push({ field: 'limit', rule: 'range:1..500' });
    else limit = Number(query.limit);
  }
  if (fields.length > 0) throw new AppError(422, 'VALIDATION_FAILED', { details: { fields } });
  return { requestId, after, limit };
}

// Rows after the cursor for source k: (at, k, id) > (after.at, after.source, after.id).
function afterClause(k, after, column = 'at') {
  if (!after) return { sql: '1 = 1', args: [] };
  if (k > after.source) return { sql: `${column} >= ?`, args: [after.at] };
  if (k < after.source) return { sql: `${column} > ?`, args: [after.at] };
  return { sql: `(${column} > ? OR (${column} = ? AND id > ?))`, args: [after.at, after.at, after.id] };
}

const inList = (ids) => `(${ids.map(() => '?').join(',')})`;

function requestScope(db, requestId) {
  const ids = (sql) => db.prepare(sql).all(requestId).map((r) => r.id);
  const planIds = ids('SELECT id FROM plan_versions WHERE request_id = ?');
  const reservationIds = ids('SELECT r.id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE pv.request_id = ?');
  const orderIds = ids('SELECT so.id FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE pv.request_id = ?');
  const operationIds = ids(
    'SELECT po.id FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE pv.request_id = ?',
  );
  return { planIds, reservationIds, orderIds, operationIds };
}

export function buildTimeline(ctx, query) {
  const { db } = ctx;
  const { requestId, after, limit } = checkTimelineQuery(query);
  const scope = requestId === null ? null : requestScope(db, requestId);
  const events = [];
  const push = (k, row, event) => events.push({ k, id: row.id, at: row.at, event });
  const cursorOf = (k, row) => `${Date.parse(row.at)}.${k}.${row.id}`;

  // audit_events
  {
    const a = afterClause(0, after);
    let where = a.sql;
    const args = [...a.args];
    if (scope) {
      const parts = ["(entity_type = 'request' AND entity_id = ?)"];
      args.push(requestId);
      for (const [type, ids] of [['plan_version', scope.planIds], ['reservation', scope.reservationIds], ['supplier_order', scope.orderIds], ['payment_operation', scope.operationIds]]) {
        if (ids.length === 0) continue;
        parts.push(`(entity_type = '${type}' AND entity_id IN ${inList(ids)})`);
        args.push(...ids);
      }
      where += ` AND (${parts.join(' OR ')})`;
    }
    for (const row of db.prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY at, id LIMIT ?`).all(...args, limit)) {
      push(0, row, {
        cursor: cursorOf(0, row), at: row.at, source: 'audit', type: row.action, entityType: row.entity_type, entityId: row.entity_id,
        detail: { ...parseJson(row.detail_json, {}), outcome: row.outcome },
      });
    }
  }
  // inventory_ledger
  if (!scope || scope.reservationIds.length > 0) {
    const a = afterClause(1, after);
    let where = a.sql;
    const args = [...a.args];
    if (scope) {
      where += ` AND ref_type = 'reservation' AND ref_id IN ${inList(scope.reservationIds)}`;
      args.push(...scope.reservationIds);
    }
    for (const row of db.prepare(`SELECT * FROM inventory_ledger WHERE ${where} ORDER BY at, id LIMIT ?`).all(...args, limit)) {
      push(1, row, {
        cursor: cursorOf(1, row), at: row.at, source: 'ledger', type: row.reason, entityType: 'inventory', entityId: row.product_id,
        detail: { deltaOnHand: row.delta_on_hand, deltaReserved: row.delta_reserved, onHandAfter: row.on_hand_after, reservedAfter: row.reserved_after, refType: row.ref_type, refId: row.ref_id },
      });
    }
  }
  // provider_calls
  if (!scope || scope.operationIds.length > 0) {
    const a = afterClause(2, after, 'created_at');
    const args = [...a.args];
    let where = a.sql;
    if (scope) {
      where += ` AND payment_operation_id IN ${inList(scope.operationIds)}`;
      args.push(...scope.operationIds);
    }
    for (const row of db.prepare(`SELECT *, created_at AS at FROM provider_calls WHERE ${where} ORDER BY created_at, id LIMIT ?`).all(...args, limit)) {
      push(2, row, {
        cursor: cursorOf(2, row), at: row.at, source: 'provider_call', type: row.kind, entityType: 'payment_operation', entityId: row.payment_operation_id,
        detail: { status: row.status, attempt: row.attempt, errorCode: row.error_code ?? null },
      });
    }
  }
  // webhook_events
  if (!scope) {
    const a = afterClause(3, after, 'received_at');
    for (const row of db.prepare(`SELECT *, received_at AS at FROM webhook_events WHERE ${a.sql} ORDER BY received_at, id LIMIT ?`).all(...a.args, limit)) {
      push(3, row, {
        cursor: cursorOf(3, row), at: row.at, source: 'webhook', type: row.event_type ?? 'unknown', entityType: 'webhook_event', entityId: row.id,
        detail: { outcome: row.outcome, signatureStatus: row.signature_status, flagged: row.flagged === 1 },
      });
    }
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.k - y.k || x.id - y.id));
  return { events: events.slice(0, limit).map((e) => e.event) };
}

// ------------------------------------------------------------------ metrics

function tally(rows) {
  const out = {};
  for (const row of rows) out[row.key] = row.n;
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function buildMetrics(ctx) {
  const { db, config, clock } = ctx;
  const latencies = new Map();
  for (const row of db
    .prepare('SELECT kind, started_at, finished_at FROM provider_calls WHERE started_at IS NOT NULL AND finished_at IS NOT NULL AND archived_at IS NULL ORDER BY id DESC LIMIT 5000')
    .all()) {
    const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
    if (!Number.isFinite(ms) || ms < 0) continue;
    if (!latencies.has(row.kind)) latencies.set(row.kind, []);
    latencies.get(row.kind).push(ms);
  }
  const providerLatencyMs = {};
  for (const [kind, list] of [...latencies].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a - b);
    providerLatencyMs[kind] = { p50: percentile(list, 0.5), p95: percentile(list, 0.95), n: list.length };
  }
  const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const unresolved = db
    .prepare(
      "SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NULL AND (status IN ('unknown','authorization_pending','capture_pending','refund_pending') OR void_failed = 1)",
    )
    .get().n;
  const spent = db
    .prepare('SELECT COALESCE(SUM(COALESCE(actual_micro_usd, reserved_micro_usd)), 0) AS micro FROM model_spend WHERE day = ?')
    .get(localDay(clock.now())).micro;
  const lastTickMs = meta('reconciler_last_tick_ms');
  return {
    counts: {
      operationsByStatus: tally(db.prepare('SELECT status AS key, COUNT(*) AS n FROM payment_operations WHERE archived_at IS NULL GROUP BY status ORDER BY status').all()),
      plansByStatus: tally(db.prepare('SELECT status AS key, COUNT(*) AS n FROM plan_versions GROUP BY status ORDER BY status').all()),
      reservationsByStatus: tally(db.prepare('SELECT status AS key, COUNT(*) AS n FROM reservations GROUP BY status ORDER BY status').all()),
    },
    reconciler: { lastTickAt: meta('reconciler_last_tick_at'), lastTickMs: lastTickMs === null ? null : Number(lastTickMs), unresolved },
    providerLatencyMs,
    model: { spentTodayUsd: spent / 1_000_000, budgetUsd: config.modelDailyBudgetUsd },
  };
}
