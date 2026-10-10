// Reservations (spec: Background Processing > Reservation, Interface Contracts > Idempotency).
//
//   reservePlan(ctx, user, planId, { key, fingerprint })   POST /api/plans/:id/reserve -> { status, body, replayed }
//   expireDueReservations(ctx, { limit })                  the expiry pass (the reconciler calls it every tick)
//   reservationFingerprint(pathname, body)                 sha256(method + ' ' + path + '\n' + canonical body)
//   reservationBundle(ctx, reservationId)                  { reservation, orders, approvalsNeeded } as the API shows it
//
// Reserve runs in ONE `BEGIN IMMEDIATE` (db.tx): idempotency lookup -> plan guards -> live-reservation cap (SEC-2) ->
// the reservation row -> a conditional stock UPDATE per product (reserved + q <= on_hand) with a `reserve` ledger row ->
// one supplier order and one `created` payment operation per supplier -> the stored response. Two processes cannot both
// pass the cap or take the last bundle, because the write lock is taken before the first read. A lost race is
// OUT_OF_STOCK (everything rolled back), never a lock error; a lock that outlasts busy_timeout is 503 DB_BUSY.
//
// After an OUT_OF_STOCK rollback a second transaction marks the plan non_executable (OUT_OF_STOCK), queues a re-plan and
// stores the 409 under the key. Stored under the key: 2xx and the business 4xx that end the plan's attempt (OUT_OF_STOCK,
// PLAN_*, MISSING_*). Not stored: 5xx and RESERVATION_LIMIT.
import { isoFromMs } from '../clock.js';
import { canonicalJson, sha256Hex } from '../domain/canonical.js';
import { AppError } from '../http/envelope.js';
import { DbConstraintError, mapDbError } from '../db/errors.js';
import { recordAudit } from './audit.js';
import { actorOf, closeReservation, reserveStock } from './ledger.js';
import { findOwnedPlan, revalidateStoredPlan } from './plans.js';
import { enqueueReplan, markNonExecutable } from './supersession.js';
import { LIVE_RESERVATION_STATES, labelsOf, loadRequestData, parseJson, readSnapshot, renderOrder, renderReservation } from './view.js';

const REPLAY_HEADER = Object.freeze({ 'Idempotent-Replayed': 'true' });
const STORED_ERRORS = /^(OUT_OF_STOCK|PLAN_[A-Z_]+|MISSING_BUDGET|MISSING_DEADLINE)$/;
const AUDITED_REFUSALS = /^(OUT_OF_STOCK|PLAN_[A-Z_]+|MISSING_BUDGET|MISSING_DEADLINE|ALREADY_RESERVED|RESERVATION_LIMIT|INVALID_STATE|IDEMPOTENCY_KEY_REUSED)$/;
const EXPIRY_BATCH = 100;

export function reservationFingerprint(pathname, body) {
  return sha256Hex(`POST ${pathname}\n${canonicalJson(body)}`);
}

// ------------------------------------------------------------------ the response

// { reservation, orders, approvalsNeeded } of one reservation, from the persisted rows.
export function reservationBundle(ctx, reservationId) {
  const { db } = ctx;
  return readSnapshot(db, () => {
    const res = db
      .prepare('SELECT r.id, r.plan_version_id, pv.request_id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE r.id = ?')
      .get(reservationId);
    const requestRow = db
      .prepare('SELECT id, customer_id, raw_text, language, intake_status, created_at FROM rescue_requests WHERE id = ?')
      .get(res.request_id);
    const data = loadRequestData(db, [requestRow], { full: true }).get(requestRow.id);
    const bodies = new Map(data.versions.map((v) => [v.id, parseJson(v.plan_json, null)]));
    const orders = data.orders.filter((o) => o.plan_version_id === res.plan_version_id).map((o) => renderOrder(ctx, data, o, bodies));
    return {
      reservation: renderReservation(data.reservations.find((r) => r.id === reservationId), data.reservationItems),
      orders,
      approvalsNeeded: orders.length,
    };
  });
}

function responseBody(ctx, reservationId) {
  return { ...reservationBundle(ctx, reservationId), labels: labelsOf(ctx.config) };
}

// ------------------------------------------------------------------ idempotency (F-TR-1)

function replayStored(row) {
  const stored = parseJson(row.response_json, {});
  if (row.status_code >= 400) {
    const error = stored.error ?? {};
    throw new AppError(row.status_code, error.code, { details: error.details, headers: REPLAY_HEADER });
  }
  return { status: row.status_code, body: stored, replayed: true };
}

// Step 1 of the reservation: the key row by (user, key), then the reservation row by (customer, key) when the key row
// is gone. Returns a replay, throws 422 IDEMPOTENCY_KEY_REUSED, or returns null when the key is new.
function resolveExisting(ctx, user, planId, key, fingerprint) {
  const { db } = ctx;
  const row = db.prepare('SELECT fingerprint, status_code, response_json FROM idempotency_keys WHERE user_id = ? AND key = ?').get(user.id, key);
  if (row) {
    if (row.fingerprint !== fingerprint) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED');
    return replayStored(row);
  }
  const reservation = db.prepare('SELECT id, plan_version_id FROM reservations WHERE customer_id = ? AND idempotency_key = ?').get(user.id, key);
  if (reservation) {
    if (reservation.plan_version_id !== planId) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED');
    return { status: 200, body: responseBody(ctx, reservation.id), replayed: true };
  }
  return null;
}

function storeResponse(db, { userId, key, fingerprint, status, body, nowIso }) {
  db.prepare(
    'INSERT OR IGNORE INTO idempotency_keys (user_id, key, fingerprint, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, key, fingerprint, status, JSON.stringify(body), nowIso);
}

// ------------------------------------------------------------------ reserve

function merchantKeyFor(config, supplierRow) {
  return config.merchantMode === 'single-credential' ? 'DEFAULT' : supplierRow.paypal_merchant_key;
}

function reserveInTx(ctx, user, planId, key, fingerprint) {
  const { db, clock, config } = ctx;
  const now = isoFromMs(clock.now());

  // 1. idempotency
  const existing = resolveExisting(ctx, user, planId, key, fingerprint);
  if (existing) return existing;

  // 2. the plan must be approved, with budget and deadline (RS-04) and still sound (RS-12)
  const plan = findOwnedPlan(db, user.id, planId);
  if (plan.status === 'superseded') throw new AppError(409, 'PLAN_SUPERSEDED');
  if (plan.status === 'non_executable') throw new AppError(409, 'PLAN_NOT_EXECUTABLE', { details: { reason: plan.non_executable_reason } });
  const live = db
    .prepare(`SELECT id FROM reservations WHERE plan_version_id = ? AND status IN (${LIVE_RESERVATION_STATES.map(() => '?').join(',')}) LIMIT 1`)
    .get(planId, ...LIVE_RESERVATION_STATES);
  if (live) throw new AppError(409, 'ALREADY_RESERVED', { details: { reservationId: live.id } });
  if (plan.status !== 'approved') throw new AppError(409, 'INVALID_STATE', { details: { from: plan.status, to: 'reserved' } });
  const run = db.prepare('SELECT requirements_version FROM planning_runs WHERE id = ?').get(plan.planning_run_id);
  const requirements = db.prepare('SELECT * FROM requirements WHERE request_id = ? AND version = ?').get(plan.request_id, run.requirements_version);
  if (requirements.budget_cents === null) throw new AppError(409, 'MISSING_BUDGET');
  if (requirements.deadline_at === null) throw new AppError(409, 'MISSING_DEADLINE');
  const invalid = revalidateStoredPlan(plan, requirements);
  if (invalid) throw new AppError(409, 'PLAN_INVALID', { details: { reason: invalid } });

  // 3. the live-reservation cap (SEC-2): inside this write transaction, so no other process can pass it as well
  const active = db.prepare("SELECT id FROM reservations WHERE customer_id = ? AND status = 'active' ORDER BY id").all(user.id);
  if (active.length >= config.maxLiveReservationsPerCustomer) {
    throw new AppError(409, 'RESERVATION_LIMIT', { details: { reservationIds: active.map((r) => r.id) } });
  }

  // 4. what the plan needs, per product; a withdrawn or replaced offer counts as no stock
  const body = parseJson(plan.plan_json, null);
  const needs = new Map(); // productId -> { productId, supplierId, offerId, qty }
  const short = new Set();
  for (const line of body.lines) {
    const offer = db
      .prepare('SELECT o.id, o.version, o.status, o.product_id, o.supplier_id FROM offers o WHERE o.id = ?')
      .get(line.offerId);
    if (!offer || offer.status !== 'active' || offer.version !== line.offerVersion) {
      short.add(line.supplierCode);
      continue;
    }
    const entry = needs.get(offer.product_id);
    if (entry) entry.qty += line.bundles;
    else needs.set(offer.product_id, { productId: offer.product_id, supplierId: offer.supplier_id, offerId: offer.id, qty: line.bundles, supplierCode: line.supplierCode });
  }
  if (short.size > 0) throw new AppError(409, 'OUT_OF_STOCK', { details: { supplierCodes: [...short].sort(), newPlanVersionId: null } });

  // 5. the reservation, then the stock (conditional UPDATE per product), the orders and the payment operations
  const expiresAt = isoFromMs(clock.now() + config.reservationTtlMin * 60 * 1000);
  const reservationId = Number(
    db
      .prepare(
        "INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(planId, user.id, key, `res:${user.id}:${planId}:${key}`, expiresAt, now).lastInsertRowid,
  );
  const actor = actorOf(user);
  const lost = new Set();
  for (const need of [...needs.values()].sort((a, b) => a.productId - b.productId)) {
    if (!reserveStock(db, clock, { productId: need.productId, qty: need.qty, reservationId, actor, requestId: ctx.requestId })) lost.add(need.supplierCode);
    else {
      db.prepare('INSERT INTO reservation_items (reservation_id, product_id, supplier_id, offer_id, qty) VALUES (?, ?, ?, ?, ?)').run(
        reservationId, need.productId, need.supplierId, need.offerId, need.qty,
      );
    }
  }
  if (lost.size > 0) throw new AppError(409, 'OUT_OF_STOCK', { details: { supplierCodes: [...lost].sort(), newPlanVersionId: null } });

  const insertOrder = db.prepare(
    'INSERT INTO supplier_orders (plan_version_id, supplier_id, reservation_id, lines_json, subtotal_cents, prep_fee_cents, tax_cents, total_cents, ' +
      "fulfilment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_supplier', ?)",
  );
  const insertOperation = db.prepare(
    'INSERT INTO payment_operations (supplier_order_id, status, provider, merchant_key, amount_cents, currency, created_at, updated_at) ' +
      "VALUES (?, 'created', ?, ?, ?, 'USD', ?, ?)",
  );
  const suppliers = [...body.suppliers].sort((a, b) => (a.supplierCode < b.supplierCode ? -1 : 1));
  for (const entry of suppliers) {
    const supplier = db.prepare('SELECT id, paypal_merchant_key FROM suppliers WHERE code = ?').get(entry.supplierCode);
    const lines = body.lines
      .filter((l) => l.supplierCode === entry.supplierCode)
      .map((l) => ({ offerId: l.offerId, productName: l.productName, bundles: l.bundles, cups: l.cups, lids: l.lids }));
    const orderId = Number(
      insertOrder.run(planId, supplier.id, reservationId, JSON.stringify(lines), entry.subtotalCents, entry.prepFeeCents, entry.taxCents, entry.totalCents, now)
        .lastInsertRowid,
    );
    insertOperation.run(orderId, config.paymentProvider, merchantKeyFor(config, supplier), entry.totalCents, now, now);
  }

  recordAudit(db, clock, {
    actorUserId: user.id, actorRole: user.role, action: 'reservation.create', entityType: 'reservation', entityId: reservationId,
    outcome: 'ok', detail: { planVersionId: planId, orders: suppliers.length }, requestId: ctx.requestId,
  });

  // 6. the stored response
  const response = responseBody(ctx, reservationId);
  storeResponse(db, { userId: user.id, key, fingerprint, status: 201, body: response, nowIso: now });
  return { status: 201, body: response, replayed: false };
}

// The business refusal that ended the attempt is stored under the key (after the rollback, in its own transaction).
// A lost race also ends the plan: non_executable (OUT_OF_STOCK) and a queued re-plan.
function recordRefusal(ctx, user, planId, key, fingerprint, err) {
  const { db, clock } = ctx;
  const now = isoFromMs(clock.now());
  db.tx(() => {
    if (err.code === 'OUT_OF_STOCK') {
      const plan = db.prepare('SELECT request_id FROM plan_versions WHERE id = ?').get(planId);
      const marked = markNonExecutable(ctx, {
        planVersionId: planId, reason: 'OUT_OF_STOCK', detail: { supplierCodes: err.details?.supplierCodes ?? [] }, actor: user, requestId: ctx.requestId,
      });
      if (marked) enqueueReplan(db, plan.request_id, 'OUT_OF_STOCK', now);
    }
    storeResponse(db, {
      userId: user.id, key, fingerprint, status: err.status, body: { error: { code: err.code, details: err.details } }, nowIso: now,
    });
  });
}

function auditRefusal(ctx, user, planId, err) {
  try {
    recordAudit(ctx.db, ctx.clock, {
      actorUserId: user.id, actorRole: user.role, action: 'reservation.create', entityType: 'plan_version', entityId: planId,
      outcome: 'denied', detail: { code: err.code }, requestId: ctx.requestId,
    });
  } catch {
    ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
  }
}

export function reservePlan(ctx, user, planId, { key, fingerprint }) {
  const { db } = ctx;
  try {
    return db.tx(() => reserveInTx(ctx, user, planId, key, fingerprint));
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped instanceof DbConstraintError && mapped.kind === 'unique') {
      // A concurrent request with the same key won (revision 2, F-TR-1): resolve against what it committed.
      const settled = db.tx(() => resolveExisting(ctx, user, planId, key, fingerprint));
      if (settled) return settled;
    }
    if (err instanceof AppError && !err.headers?.['Idempotent-Replayed']) {
      if (STORED_ERRORS.test(err.code)) recordRefusal(ctx, user, planId, key, fingerprint, err);
      if (AUDITED_REFUSALS.test(err.code)) auditRefusal(ctx, user, planId, err);
    }
    throw err;
  }
}

// ------------------------------------------------------------------ expiry (RS-15)

// One reservation: active -> expired exactly once (compare-and-set on status and expires_at), `expire` ledger rows,
// the plan -> non_executable (RESERVATION_EXPIRED) and the void rule (supplier orders cancelled, operations still
// `created` voided locally; the rule leaves the expired reservation as it is). A second pass finds nothing.
function expireOne(ctx, reservationId, nowIso) {
  const { db, clock } = ctx;
  const row = db.prepare('SELECT r.plan_version_id, pv.request_id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE r.id = ?').get(reservationId);
  if (!row) return null;
  if (!closeReservation(db, clock, { reservationId, to: 'expired', dueBy: nowIso, actor: 'system' })) return null;
  const marked = markNonExecutable(ctx, { planVersionId: row.plan_version_id, reason: 'RESERVATION_EXPIRED', detail: { reservationId }, actor: null });
  recordAudit(db, clock, {
    actorRole: 'system', action: 'reservation.expire', entityType: 'reservation', entityId: reservationId, outcome: 'ok',
    detail: { planVersionId: row.plan_version_id, planMarked: marked },
  });
  return { reservationId, planVersionId: row.plan_version_id, requestId: row.request_id };
}

export function expireDueReservations(ctx, { limit = EXPIRY_BATCH } = {}) {
  const { db, clock } = ctx;
  const nowIso = isoFromMs(clock.now());
  const due = db
    .prepare("SELECT id FROM reservations WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?")
    .all(nowIso, limit);
  const expired = [];
  for (const { id } of due) {
    const done = db.tx(() => expireOne(ctx, id, nowIso));
    if (done) expired.push(done);
  }
  return { expired };
}
