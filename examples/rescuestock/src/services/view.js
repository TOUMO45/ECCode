// The read side of a request: everything the customer's page shows, assembled on the server.
//
//   loadRequestData(db, requestRows, {full})   one query per table for ALL the given requests (FU-7 shapes: snake_case rows)
//   deriveForData(ctx, data)                   deriveRescueStatus on the persisted rows (RS-36: computed on every read, never stored)
//   buildRequestView(ctx, requestId, userId)   the RequestView of the spec (the six on-screen answers)
//   buildRequestList(ctx, userId)              GET /api/requests
//   render* helpers                            row -> API object (PlanVersion, PlanningRun, Order, ...), used by plans.js too
//
// The rescue status is not a column anywhere: this module reads plan_versions, reservations, supplier_orders,
// payment_operations, provider_calls, planning_runs, requirements and replan_queue and hands them to
// src/domain/derive.js. Texts (next step, message, plan explanations) come from src/domain/explain.js templates.
import { buildLabels } from '../config.js';
import { deriveRescueStatus } from '../domain/derive.js';
import { explainPlan, explainRescueStatus } from '../domain/explain.js';
import { AppError } from '../http/envelope.js';

export const LIVE_RESERVATION_STATES = Object.freeze(['active', 'consumed', 'reconciling']);
// Payment states of an old plan version that still need work (a void or a refund is outstanding).
const OUTSTANDING_PAYMENT_STATES = Object.freeze([
  'approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown', 'refund_requested', 'refund_pending',
]);
const MAX_LIST = 100;
const REPLAN_DRAINS_BEFORE_MANUAL = 5;

// ------------------------------------------------------------------ small helpers

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

export function parseJson(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const k = row[key];
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

// A consistent view over several SELECTs: one deferred read transaction (WAL snapshot). Inside db.tx() the
// caller already has one.
export function readSnapshot(db, fn) {
  if (db.inTx) return fn();
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A read-only transaction has nothing to undo; if the engine already closed it there is nothing to do.
    }
  }
}

// An id owned by another customer, an archived or a deleted request all look the same: 404.
export function findOwnedRequest(db, userId, requestId) {
  const row = db
    .prepare(
      'SELECT id, customer_id, raw_text, language, intake_status, created_at FROM rescue_requests ' +
        'WHERE id = ? AND customer_id = ? AND archived_at IS NULL AND deleted_at IS NULL',
    )
    .get(requestId, userId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

// ------------------------------------------------------------------ loading (one query per table)

export function loadRequestData(db, requestRows, { full = false } = {}) {
  const ids = requestRows.map((r) => r.id);
  const data = new Map(
    requestRows.map((r) => [
      r.id,
      { request: r, image: null, extraction: null, requirements: null, runs: [], versions: [], reservations: [], reservationItems: [], orders: [], operations: [], providerCalls: [], pickups: [], queue: null },
    ]),
  );
  if (ids.length === 0) return data;
  const ph = placeholders(ids.length);

  if (full) {
    for (const row of db.prepare(`SELECT id, request_id, mime_detected, bytes FROM images WHERE request_id IN (${ph})`).all(...ids)) {
      data.get(row.request_id).image = row;
    }
    for (const row of db
      .prepare(`SELECT * FROM extractions WHERE id IN (SELECT MAX(id) FROM extractions WHERE request_id IN (${ph}) GROUP BY request_id)`)
      .all(...ids)) {
      data.get(row.request_id).extraction = row;
    }
  }

  for (const row of db
    .prepare(
      `SELECT r.* FROM requirements r WHERE r.request_id IN (${ph}) ` +
        'AND r.version = (SELECT MAX(version) FROM requirements WHERE request_id = r.request_id)',
    )
    .all(...ids)) {
    data.get(row.request_id).requirements = row;
  }

  const runColumns = full ? '*' : 'id, request_id, requirements_version, feasible';
  for (const row of db.prepare(`SELECT ${runColumns} FROM planning_runs WHERE request_id IN (${ph})`).all(...ids)) {
    data.get(row.request_id).runs.push(row);
  }

  const versionColumns = full
    ? '*'
    : 'id, request_id, planning_run_id, version, status, superseded_by, supersede_reason, non_executable_reason, reason_detail_json, total_cents';
  for (const row of db.prepare(`SELECT ${versionColumns} FROM plan_versions WHERE request_id IN (${ph})`).all(...ids)) {
    data.get(row.request_id).versions.push(row);
  }

  for (const row of db
    .prepare(
      'SELECT r.id, r.plan_version_id, r.status, r.expires_at, r.escalation, pv.request_id ' +
        `FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE pv.request_id IN (${ph})`,
    )
    .all(...ids)) {
    data.get(row.request_id).reservations.push(row);
  }

  if (full) {
    const items = db
      .prepare(
        'SELECT ri.reservation_id, ri.offer_id, ri.qty, s.code AS supplier_code, pv.request_id ' +
          'FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id ' +
          'JOIN plan_versions pv ON pv.id = r.plan_version_id JOIN suppliers s ON s.id = ri.supplier_id ' +
          `WHERE pv.request_id IN (${ph}) ORDER BY s.code, ri.offer_id`,
      )
      .all(...ids);
    for (const row of items) data.get(row.request_id).reservationItems.push(row);
  }

  for (const row of db
    .prepare(
      'SELECT so.id, so.plan_version_id, so.supplier_id, so.reservation_id, so.subtotal_cents, so.prep_fee_cents, so.tax_cents, so.total_cents, ' +
        'so.fulfilment_status, so.committed_qty_json, so.committed_ready_at, so.confirmed_at, so.refusal_reason, ' +
        's.code AS supplier_code, s.name AS supplier_name, s.demo AS supplier_demo, s.pickup_address, pv.request_id ' +
        'FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id JOIN suppliers s ON s.id = so.supplier_id ' +
        `WHERE pv.request_id IN (${ph}) ORDER BY s.code`,
    )
    .all(...ids)) {
    data.get(row.request_id).orders.push(row);
  }

  for (const row of db
    .prepare(
      'SELECT po.id, po.supplier_order_id, po.status, po.prev_status, po.provider, po.amount_cents, po.currency, po.approval_url, ' +
        'po.authorization_expires_at, po.buyer_cancelled_at, po.cancel_requested_at, po.voided_locally, po.void_failed, po.last_error_code, ' +
        'po.unknown_since, po.pending_since, po.created_at, po.updated_at, pv.request_id ' +
        'FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id ' +
        `JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE pv.request_id IN (${ph})`,
    )
    .all(...ids)) {
    data.get(row.request_id).operations.push(row);
  }

  for (const row of db
    .prepare(
      'SELECT pc.id, pc.payment_operation_id, pc.kind, pc.status, pc.created_at, pv.request_id ' +
        'FROM provider_calls pc JOIN payment_operations po ON po.id = pc.payment_operation_id ' +
        'JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
        `WHERE pc.kind = 'authorize' AND pv.request_id IN (${ph})`,
    )
    .all(...ids)) {
    data.get(row.request_id).providerCalls.push(row);
  }

  if (full) {
    for (const row of db
      .prepare(
        'SELECT pk.supplier_order_id, pk.kind, pv.request_id FROM pickup_confirmations pk ' +
          'JOIN supplier_orders so ON so.id = pk.supplier_order_id JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
          `WHERE pv.request_id IN (${ph})`,
      )
      .all(...ids)) {
      data.get(row.request_id).pickups.push(row);
    }
  }

  for (const row of db.prepare(`SELECT request_id, failed_drains FROM replan_queue WHERE request_id IN (${ph})`).all(...ids)) {
    data.get(row.request_id).queue = row;
  }
  return data;
}

// ------------------------------------------------------------------ the derivation (FU-7)

// The newest plan version that is not superseded (P of the derivation table).
export function currentVersionOf(versions) {
  let current = null;
  for (const v of versions) {
    if (v.status === 'superseded') continue;
    if (current === null || v.version > current.version) current = v;
  }
  return current;
}

function reservationOf(data, version) {
  if (!version) return null;
  const mine = data.reservations.filter((r) => r.plan_version_id === version.id);
  if (mine.length === 0) return null;
  return mine.find((r) => LIVE_RESERVATION_STATES.includes(r.status)) ?? mine.reduce((a, b) => (b.id > a.id ? b : a));
}

// deriveRescueStatus input exactly as documented in the header of src/domain/derive.js: snake_case persisted rows,
// camelCase limits.
export function deriveInput(ctx, data) {
  const { requirements } = data;
  let latestRun = null;
  if (requirements) {
    for (const run of data.runs) {
      if (run.requirements_version === requirements.version && (latestRun === null || run.id > latestRun.id)) latestRun = run;
    }
  }
  return {
    request: { id: data.request.id, intake_status: data.request.intake_status },
    requirements,
    latestRun: latestRun ? { id: latestRun.id, feasible: latestRun.feasible } : null,
    versions: data.versions,
    reservations: data.reservations,
    orders: data.orders,
    operations: data.operations,
    providerCalls: data.providerCalls,
    replanQueueEntry: data.queue ? { failed_drains: data.queue.failed_drains } : null,
    now: ctx.clock.now(),
    limits: {
      unknownEscalateMin: ctx.config.unknownEscalateMin,
      pendingEscalateMin: ctx.config.pendingEscalateMin,
      replanFailedDrainsBeforeManual: REPLAN_DRAINS_BEFORE_MANUAL,
    },
  };
}

export function deriveForData(ctx, data) {
  const derived = deriveRescueStatus(deriveInput(ctx, data));
  if (derived.fallback) {
    // Row 14 is a defensive row: reaching it is a bug in a state machine or in the derivation.
    ctx.log.warn('derive.fallback', {
      code: 'DERIVE_FALLBACK',
      requestRef: data.request.id,
      counts: { versions: data.versions.length, operations: data.operations.length, orders: data.orders.length },
    });
  }
  return derived;
}

export function rescueStatusOf(ctx, data) {
  const derived = deriveForData(ctx, data);
  const current = currentVersionOf(data.versions);
  const reservation = reservationOf(data, current);
  const orders = current ? data.orders.filter((o) => o.plan_version_id === current.id) : [];
  const orderIds = new Set(orders.map((o) => o.id));
  return {
    ...explainRescueStatus(derived),
    underlying: {
      plan: current ? current.status : null,
      reservation: reservation ? reservation.status : null,
      payments: data.operations.filter((op) => orderIds.has(op.supplier_order_id)).map((op) => ({ orderId: op.supplier_order_id, status: op.status })),
      fulfilment: orders.map((o) => ({ orderId: o.id, status: o.fulfilment_status })),
    },
  };
}

// ------------------------------------------------------------------ renderers

export function labelsOf(config) {
  return buildLabels(config);
}

export function renderRequirements(row) {
  if (!row) return null;
  return { version: row.version, fields: parseJson(row.fields_json, {}), confirmedAt: row.confirmed_at };
}

export function renderExtraction(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    model: row.model ?? null,
    simulated: row.simulated === 1,
    degraded: row.degraded === 1,
    schemaOk: row.schema_ok === 1,
    errorCode: row.error_code ?? null,
    fields: parseJson(row.fields_json, {}),
    questions: parseJson(row.questions_json, []),
    createdAt: row.created_at,
  };
}

// The explanation is rendered from the stored planner output by the fixed templates of explain.js; nothing free text.
export function explanationFor(run, version) {
  const trace = parseJson(run.trace_json, { inputs: {}, candidates: [], comparisons: [], enumerated: 0 });
  const rejections = parseJson(run.rejections_json, []);
  if (run.feasible === 1) {
    if (!version) return { lines: [], rephrased: null };
    return explainPlan({
      feasible: true,
      best: parseJson(version.plan_json, { lines: [], suppliers: [] }),
      alternatives: parseJson(version.alternatives_json, []),
      rejections,
      trace,
    });
  }
  return explainPlan({
    feasible: false,
    rejections,
    candidateCodes: parseJson(run.candidate_codes_json, []),
    relaxations: parseJson(run.relaxations_json, []),
    blocking: parseJson(run.blocking_json, []),
    trace,
  });
}

// `version` is the plan version stored by this run (null for an infeasible run).
export function renderPlanningRun(run, version) {
  return {
    id: run.id,
    requirementsVersion: run.requirements_version,
    feasible: run.feasible === 1,
    rejections: parseJson(run.rejections_json, []),
    candidateCodes: parseJson(run.candidate_codes_json, []),
    relaxations: parseJson(run.relaxations_json, []),
    blocking: parseJson(run.blocking_json, []),
    explanation: explanationFor(run, version),
    createdAt: run.created_at,
  };
}

export function renderPlanVersion(version, run) {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    planHash: version.plan_hash,
    body: parseJson(version.plan_json, null),
    alternatives: parseJson(version.alternatives_json, []),
    rejections: run ? parseJson(run.rejections_json, []) : [],
    trace: run ? parseJson(run.trace_json, null) : null,
    explanation: run ? explanationFor(run, version) : { lines: [], rephrased: null },
    nonExecutableReason: version.non_executable_reason ?? null,
    supersededBy: version.superseded_by ?? null,
    supersedeReason: version.supersede_reason ?? null,
    createdAt: version.created_at,
  };
}

export function renderReservation(reservation, items) {
  if (!reservation) return null;
  return {
    id: reservation.id,
    planVersionId: reservation.plan_version_id,
    status: reservation.status,
    expiresAt: reservation.expires_at,
    items: items.filter((i) => i.reservation_id === reservation.id).map((i) => ({ supplierCode: i.supplier_code, offerId: i.offer_id, bundles: i.qty })),
  };
}

export function renderPayment(op, config) {
  return {
    id: op.id,
    status: op.status,
    provider: op.provider,
    simulated: op.provider === 'fake',
    sandbox: op.provider === 'paypal-sandbox',
    amountCents: op.amount_cents,
    currency: op.currency,
    merchantMode: config.merchantMode,
    approvalUrl: op.approval_url ?? null,
    buyerCancelledAt: op.buyer_cancelled_at ?? null,
    authorizationExpiresAt: op.authorization_expires_at ?? null,
    cancelRequested: op.cancel_requested_at !== null && op.cancel_requested_at !== undefined,
    voidedLocally: op.voided_locally === 1,
    voidFailed: op.void_failed === 1,
    lastErrorCode: op.last_error_code ?? null,
  };
}

function committedBundles(order) {
  if (!order.confirmed_at) return null;
  const parsed = parseJson(order.committed_qty_json, null);
  if (Array.isArray(parsed)) {
    return parsed.reduce((n, e) => n + (Number.isSafeInteger(e?.committedBundles) ? e.committedBundles : Number.isSafeInteger(e?.bundles) ? e.bundles : 0), 0);
  }
  if (parsed && typeof parsed === 'object') return Object.values(parsed).reduce((n, v) => n + (Number.isSafeInteger(v) ? v : 0), 0);
  return null;
}

function presentationOf(order, version, op) {
  if (order.fulfilment_status === 'refused') return 'refused';
  if (order.fulfilment_status === 'cancelled') return 'cancelled';
  if (op && op.status === 'refunded') return 'refunded';
  // F-TR-11: an order of a plan that can no longer be executed is "Cancelled — payment did not complete".
  if (version && version.status === 'non_executable') return 'cancelled_payment_incomplete';
  return 'active';
}

export function renderOrder(ctx, data, order, bodies) {
  const version = data.versions.find((v) => v.id === order.plan_version_id) ?? null;
  const body = version ? bodies.get(version.id) ?? null : null;
  const entry = body?.suppliers?.find((s) => s.supplierCode === order.supplier_code) ?? null;
  const catalogReadyAt = entry?.catalogReadyAt ?? body?.readyAt ?? null;
  const op = data.operations.find((o) => o.supplier_order_id === order.id) ?? null;
  const kinds = new Set(data.pickups.filter((p) => p.supplier_order_id === order.id).map((p) => p.kind));
  const bundles = (body?.lines ?? []).filter((l) => l.supplierCode === order.supplier_code).reduce((n, l) => n + l.bundles, 0);
  const bundlesCommitted = committedBundles(order);
  return {
    id: order.id,
    supplier: { code: order.supplier_code, name: order.supplier_name, demo: order.supplier_demo === 1 },
    totals: {
      supplierCode: order.supplier_code,
      supplierName: entry?.supplierName ?? `Supplier ${order.supplier_code}`,
      subtotalCents: order.subtotal_cents,
      prepFeeCents: order.prep_fee_cents,
      taxCents: order.tax_cents,
      totalCents: order.total_cents,
      catalogReadyAt,
      demo: order.supplier_demo === 1,
    },
    fulfilmentStatus: order.fulfilment_status,
    offer: { readyAt: catalogReadyAt, bundles },
    commitment: order.confirmed_at && bundlesCommitted !== null
      ? { bundles: bundlesCommitted, readyAt: order.committed_ready_at, confirmedAt: order.confirmed_at }
      : null,
    refusalReason: order.refusal_reason ?? null,
    pickup: version && version.status === 'executed' ? { address: order.pickup_address } : null,
    payment: op ? renderPayment(op, ctx.config) : null,
    receiptRecorded: kinds.has('receipt'),
    handoverRecorded: kinds.has('handover'),
    presentation: presentationOf(order, version, op),
  };
}

// ------------------------------------------------------------------ the RequestView

export function assembleView(ctx, data) {
  const { request } = data;
  const runsById = new Map(data.runs.map((r) => [r.id, r]));
  const versionByRun = new Map(data.versions.map((v) => [v.planning_run_id, v]));
  const bodies = new Map(data.versions.map((v) => [v.id, parseJson(v.plan_json, null)]));
  const current = currentVersionOf(data.versions);

  let planning = null;
  if (data.requirements) {
    for (const run of data.runs) {
      if (run.requirements_version === data.requirements.version && (planning === null || run.id > planning.id)) planning = run;
    }
  }

  const plans = [...data.versions].sort((a, b) => b.version - a.version).map((v) => renderPlanVersion(v, runsById.get(v.planning_run_id) ?? null));
  const currentOrders = current ? data.orders.filter((o) => o.plan_version_id === current.id) : [];
  const cancelling = data.orders.filter((o) => {
    if (current && o.plan_version_id === current.id) return false;
    const op = data.operations.find((p) => p.supplier_order_id === o.id);
    return op !== undefined && OUTSTANDING_PAYMENT_STATES.includes(op.status);
  });

  return {
    request: {
      id: request.id,
      createdAt: request.created_at,
      language: request.language,
      rawText: request.raw_text ?? null,
      intakeStatus: request.intake_status,
      image: data.image ? { id: data.image.id, mime: data.image.mime_detected, bytes: data.image.bytes } : null,
    },
    extraction: renderExtraction(data.extraction),
    requirements: renderRequirements(data.requirements),
    planning: planning ? renderPlanningRun(planning, versionByRun.get(planning.id) ?? null) : null,
    plans,
    currentPlanId: current ? current.id : null,
    reservation: renderReservation(reservationOf(data, current), data.reservationItems),
    orders: currentOrders.map((o) => renderOrder(ctx, data, o, bodies)),
    cancellingOrders: cancelling.map((o) => renderOrder(ctx, data, o, bodies)),
    rescueStatus: rescueStatusOf(ctx, data),
    labels: labelsOf(ctx.config),
  };
}

// GET /api/requests/:id. A request that is not the caller's, or is archived or deleted, is 404.
export function buildRequestView(ctx, requestId, userId) {
  return readSnapshot(ctx.db, () => {
    const row = findOwnedRequest(ctx.db, userId, requestId);
    return assembleView(ctx, loadRequestData(ctx.db, [row], { full: true }).get(row.id));
  });
}

// The status block of one request (used by confirm and the other write routes after they commit).
export function buildRescueStatus(ctx, requestId, userId) {
  return readSnapshot(ctx.db, () => {
    const row = findOwnedRequest(ctx.db, userId, requestId);
    return rescueStatusOf(ctx, loadRequestData(ctx.db, [row]).get(row.id));
  });
}

// GET /api/requests: the caller's newest 100 requests, each with its derived status and the current plan's total.
export function buildRequestList(ctx, userId) {
  return readSnapshot(ctx.db, () => {
    const rows = ctx.db
      .prepare(
        'SELECT id, customer_id, raw_text, language, intake_status, created_at FROM rescue_requests ' +
          'WHERE customer_id = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT ?',
      )
      .all(userId, MAX_LIST);
    const all = loadRequestData(ctx.db, rows);
    const requests = rows.map((row) => {
      const data = all.get(row.id);
      const status = rescueStatusOf(ctx, data);
      const current = currentVersionOf(data.versions);
      return {
        id: row.id,
        createdAt: row.created_at,
        rescueStatus: { status: status.status, nextStep: status.nextStep },
        totalCents: current && current.status !== 'non_executable' ? current.total_cents : null,
      };
    });
    return { requests, labels: labelsOf(ctx.config) };
  });
}
