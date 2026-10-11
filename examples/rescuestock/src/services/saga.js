// The payment saga with lease fencing (spec: Background Processing > Payment saga with lease fencing, ARCH-23, ARCH-26).
//
//   claimExecution(ctx, user, planId, { executorId })   POST /api/plans/:id/execute, step 1: the exclusive claim
//   createSaga(deps, { executorId, autoRun })           the in-process runner: begin/start (steps 2-4), idle, stop
//   releaseIfSettled(env, planId)                       step 5, release check: reconciling -> released with restock rows
//   queueRefundWhenCancelled(db, clock, opId)           the compensation hook for `captured`
//
// Step 1 is ONE `BEGIN IMMEDIATE` and makes no provider call: the execute check order on stored data only, then the
// conditional UPDATE approved -> executing (executor_id, lease_epoch + 1, lease_until), the reservation active -> consumed
// with `consume` ledger rows, and one queued so:<id>:capture:1 per order. Whoever loses answers 200 with the current state.
// Everything after the claim runs in the process that won, under the guard G(now):
//   G(now) = id = ? AND status = 'executing' AND executor_id = ? AND lease_epoch = ? AND lease_until > now
// Every provider-call START and every saga state write needs G and renews lease_until; a call RESULT needs only the epoch (the
// fence) plus the call's send_token. A takeover (reconciler) changes the epoch, so a stalled executor's late write is refused.
//
// Step 2 reads each authorization (no journal row); step 3 captures sequentially in supplier-code order and pauses (lease_until
// = now) without a send while the first operation that is not captured is capture_pending or unknown (F-TR-7); step 4 marks
// the plan executed; step 5 is the compensation. Step 6 (takeover) is the reconciler's: it calls saga.start() with the new epoch.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { isoFromMs } from '../clock.js';
import { TERMINAL_PAYMENT_STATES, assertTransition, canTransition } from '../domain/states.js';
import { AppError } from '../http/envelope.js';
import { unknown as unknownOutcome } from '../payments/provider.js';
import { recordAudit } from './audit.js';
import { loadOperation, moveOperation, queueCall, recordCall, runCall, startCall } from './calls.js';
import { expireDueReservations } from './reservations.js';
import { markNonExecutable } from './supersession.js';
import { findOwnedPlan } from './plans.js';

const ISSUE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LEASE_WHERE = "id = ? AND status = 'executing' AND executor_id = ? AND lease_epoch = ?";
const SETTLED_OPERATION_STATES = Object.freeze(['voided', 'authorization_failed', 'refunded']);

const PLAN_OPERATIONS =
  'SELECT po.*, so.total_cents AS order_total_cents, so.plan_version_id, so.fulfilment_status, s.code AS supplier_code ' +
  'FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN suppliers s ON s.id = so.supplier_id ' +
  'WHERE so.plan_version_id = ? AND po.archived_at IS NULL ORDER BY s.code';

// executor_id = <hostname>:<pid>:<8 random hex>, fixed per process (spec).
let cachedExecutorId = null;
export function processExecutorId() {
  if (cachedExecutorId === null) cachedExecutorId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  return cachedExecutorId;
}

const codeOf = (err) => (err && typeof err.code === 'string' && ISSUE.test(err.code) ? err.code : 'FAILED');
const safeIssue = (value, fallback) => (typeof value === 'string' && ISSUE.test(value) ? value : fallback);

export function loadPlanOperations(db, planVersionId) {
  return db.prepare(PLAN_OPERATIONS).all(planVersionId);
}

// ------------------------------------------------------------------ stock (consume at the claim, restock at the release)

function ledgerRow(db, clock, { productId, reason, deltaOnHand, deltaReserved, reservationId, actor, requestId }) {
  const row = db.prepare('SELECT supplier_id, on_hand, reserved FROM inventory WHERE product_id = ?').get(productId);
  db.prepare(
    'INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ' +
      'ref_type, ref_id, actor, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.supplier_id, productId, reason, deltaOnHand, deltaReserved, row.on_hand, row.reserved, 'reservation', reservationId, actor, requestId, isoFromMs(clock.now()));
}

// `consume`: on_hand - q and reserved - q, one ledger row per item (the invariant SUM(delta) = column keeps holding).
function consumeStock(db, clock, reservationId, actor, requestId) {
  const items = db.prepare('SELECT product_id, qty FROM reservation_items WHERE reservation_id = ? ORDER BY product_id').all(reservationId);
  for (const item of items) {
    const changed = db
      .prepare('UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, version = version + 1 WHERE product_id = ? AND reserved >= ? AND on_hand >= ?')
      .run(item.qty, item.qty, item.product_id, item.qty, item.qty).changes;
    if (changed !== 1) throw new Error('inventory invariant: consume of more than is reserved');
    ledgerRow(db, clock, { productId: item.product_id, reason: 'consume', deltaOnHand: -item.qty, deltaReserved: -item.qty, reservationId, actor, requestId });
  }
}

// `restock`: on_hand + q (the goods never left the supplier; the consume row is undone).
function restockStock(db, clock, reservationId, actor, requestId) {
  const items = db.prepare('SELECT product_id, qty FROM reservation_items WHERE reservation_id = ? ORDER BY product_id').all(reservationId);
  for (const item of items) {
    db.prepare('UPDATE inventory SET on_hand = on_hand + ?, version = version + 1 WHERE product_id = ?').run(item.qty, item.product_id);
    ledgerRow(db, clock, { productId: item.product_id, reason: 'restock', deltaOnHand: item.qty, deltaReserved: 0, reservationId, actor, requestId });
  }
}

// ------------------------------------------------------------------ the lease

// G(now): also renews lease_until. Inside the caller's transaction. true = this executor still holds the lease.
function guardLease(db, clock, config, lease) {
  const now = clock.now();
  return (
    db
      .prepare(`UPDATE plan_versions SET lease_until = ?, updated_at = ? WHERE ${LEASE_WHERE} AND lease_until > ?`)
      .run(isoFromMs(now + config.sagaLeaseMs), isoFromMs(now), lease.planId, lease.executorId, lease.epoch, isoFromMs(now)).changes === 1
  );
}

// The fence of a call RESULT: the epoch is unchanged. A lapsed lease that nobody took over still records its result.
function fenceLease(db, lease) {
  return db.prepare(`SELECT 1 AS held FROM plan_versions WHERE ${LEASE_WHERE}`).get(lease.planId, lease.executorId, lease.epoch) !== undefined;
}

// Pause: lease_until = now so the reconciler may take the plan over (it does so only when no operation is pending or unknown).
function pauseLease(env, lease) {
  const { db, clock } = env;
  const nowIso = isoFromMs(clock.now());
  db.tx(() => db.prepare(`UPDATE plan_versions SET lease_until = ?, updated_at = ? WHERE ${LEASE_WHERE}`).run(nowIso, nowIso, lease.planId, lease.executorId, lease.epoch));
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(unknownOutcome('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------ audit of refusals

function auditDenied(ctx, user, planId, code) {
  try {
    recordAudit(ctx.db, ctx.clock, {
      actorUserId: user.id, actorRole: user.role, action: 'plan.execute', entityType: 'plan_version', entityId: planId,
      outcome: 'denied', detail: { code }, requestId: ctx.requestId,
    });
  } catch {
    ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
  }
}

// ------------------------------------------------------------------ step 1: the claim

// The execute check order of the spec, on stored data only, then the claim. Returns
//   { claimed: true, epoch }              this caller won
//   { claimed: false, status }            executing or executed already (200, no provider call)
//   { refusal: AppError, expire?: true }  a named 409; the transaction COMMITS what the refusal needs (the void rule)
function claimInTx(ctx, user, planId, executorId) {
  const { db, clock, config } = ctx;
  const now = clock.now();
  const nowIso = isoFromMs(now);
  const plan = db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(planId);
  if (!plan) return { refusal: new AppError(404, 'NOT_FOUND') };
  if (plan.status === 'executing' || plan.status === 'executed') return { claimed: false, status: plan.status };
  if (plan.status === 'superseded') return { refusal: new AppError(409, 'PLAN_SUPERSEDED') };
  if (plan.status === 'non_executable') {
    return { refusal: new AppError(409, 'PLAN_NOT_EXECUTABLE', { details: { reason: plan.non_executable_reason } }) };
  }
  if (plan.status !== 'approved') return { refusal: new AppError(409, 'INVALID_STATE', { details: { from: plan.status, to: 'executing' } }) };

  // 1. the reservation: active and not past its expiry
  const reservation = db.prepare("SELECT * FROM reservations WHERE plan_version_id = ? AND status = 'active'").get(planId);
  if (!reservation) {
    const any = db.prepare('SELECT 1 AS present FROM reservations WHERE plan_version_id = ?').get(planId);
    return { refusal: any ? new AppError(409, 'RESERVATION_EXPIRED') : new AppError(409, 'INVALID_STATE', { details: { from: 'approved', to: 'executing' } }) };
  }
  if (Date.parse(reservation.expires_at) <= now) return { refusal: new AppError(409, 'RESERVATION_EXPIRED'), expire: true };

  const rows = db
    .prepare(
      'SELECT so.id AS order_id, so.fulfilment_status, s.code AS supplier_code, po.id AS operation_id, po.status AS operation_status, ' +
        'po.prev_status, po.authorization_expires_at FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id ' +
        'LEFT JOIN payment_operations po ON po.supplier_order_id = so.id AND po.archived_at IS NULL WHERE so.plan_version_id = ? ORDER BY s.code',
    )
    .all(planId);
  // 2. a pending authorization, or an authorize call that is still outstanding
  if (rows.some((r) => r.operation_status === 'authorization_pending' || r.operation_status === 'approved' || (r.operation_status === 'unknown' && r.prev_status === 'approved'))) {
    return { refusal: new AppError(409, 'AUTHORIZATION_PENDING') };
  }
  // 3. an operation that is not authorized (created, or anything the void rule and the provider left behind)
  if (rows.length === 0 || rows.some((r) => r.operation_status !== 'authorized')) return { refusal: new AppError(409, 'AUTHORIZATION_MISSING') };
  // 4. a supplier order that is not confirmed
  if (rows.some((r) => r.fulfilment_status !== 'confirmed')) return { refusal: new AppError(409, 'COMMITMENT_MISSING') };
  // 5. the stored expiry inside the margin: the void rule fires in this same transaction
  const margin = config.authExpiryMarginMin * 60_000;
  const expired = rows.find((r) => r.authorization_expires_at !== null && Date.parse(r.authorization_expires_at) <= now + margin);
  if (expired) {
    markNonExecutable(ctx, {
      planVersionId: planId, reason: 'AUTHORIZATION_EXPIRED', detail: { supplierCode: expired.supplier_code }, actor: user, requestId: ctx.requestId,
    });
    return { refusal: new AppError(409, 'AUTHORIZATION_EXPIRED') };
  }

  // the claim: conditional UPDATE, 0 rows = somebody else moved the plan first
  assertTransition('plan', 'approved', 'executing');
  const moved = db
    .prepare(
      "UPDATE plan_versions SET status = 'executing', executor_id = ?, lease_epoch = lease_epoch + 1, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'approved'",
    )
    .run(executorId, isoFromMs(now + config.sagaLeaseMs), nowIso, planId).changes;
  if (moved !== 1) {
    const current = db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(planId);
    return { claimed: false, status: current.status };
  }
  const epoch = db.prepare('SELECT lease_epoch FROM plan_versions WHERE id = ?').get(planId).lease_epoch;

  // the winner consumes the reservation and queues one capture per order
  assertTransition('reservation', 'active', 'consumed');
  const consumed = db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ? AND status = 'active'").run(reservation.id).changes;
  if (consumed !== 1) throw new Error('reservation moved during a transaction that holds the write lock');
  consumeStock(db, clock, reservation.id, `customer:${user.id}`, ctx.requestId ?? null);
  for (const row of rows) {
    queueCall(db, clock, { operationId: row.operation_id, supplierOrderId: row.order_id, kind: 'capture', attempt: 1, requestId: ctx.requestId });
  }
  recordAudit(db, clock, {
    actorUserId: user.id, actorRole: user.role, action: 'plan.execute', entityType: 'plan_version', entityId: planId, outcome: 'ok',
    detail: { orders: rows.length, epoch }, requestId: ctx.requestId,
  });
  return { claimed: true, epoch };
}

// POST /api/plans/:id/execute. 404 for a foreign plan. Throws the named 409 or returns { claimed, status, epoch? }.
export function claimExecution(ctx, user, planId, { executorId = processExecutorId() } = {}) {
  findOwnedPlan(ctx.db, user.id, planId);
  const outcome = ctx.db.tx(() => claimInTx(ctx, user, planId, executorId));
  if (outcome.refusal) {
    auditDenied(ctx, user, planId, outcome.refusal.code);
    if (outcome.expire) {
      // The expiry pass the reconciler would run, so the answer and the stored state agree (void rule, released stock).
      try {
        expireDueReservations(ctx);
      } catch {
        ctx.log.error('reservation.expire_failed', { code: 'EXPIRE_FAILED' });
      }
    }
    throw outcome.refusal;
  }
  if (!outcome.claimed) return { claimed: false, status: outcome.status };
  return { claimed: true, status: 'executing', epoch: outcome.epoch };
}

// ------------------------------------------------------------------ the compensation hook for `captured`

// A transition into `captured` of an operation whose cancellation was requested (a compensating plan, a late capture found by
// a void: F-TR-6) queues so:<id>:refund:1 in the SAME transaction. Returns the refund call id, or null.
export function queueRefundWhenCancelled(db, clock, operationId, requestId = null) {
  const op = loadOperation(db, operationId);
  if (!op || op.status !== 'captured' || op.cancel_requested_at === null) return null;
  moveOperation(db, clock, op, 'refund_requested');
  return queueCall(db, clock, { operationId, supplierOrderId: op.supplier_order_id, kind: 'refund', attempt: 1, requestId }).call.id;
}

// ------------------------------------------------------------------ step 5: release check and escalation

// reconciling -> released with restock rows once every operation is settled (voided, authorization_failed, refunded);
// otherwise the reservation stays reconciling and `escalation` names the first reason (refund_failed, void_failed, age limits).
// Returns 'released' | 'waiting' | 'none'.
export function releaseIfSettled(env, planVersionId) {
  const { db, clock, config } = env;
  return db.tx(() => {
    const reservation = db.prepare("SELECT * FROM reservations WHERE plan_version_id = ? AND status = 'reconciling'").get(planVersionId);
    if (!reservation) return 'none';
    const ops = loadPlanOperations(db, planVersionId);
    if (ops.every((op) => SETTLED_OPERATION_STATES.includes(op.status))) {
      assertTransition('reservation', 'reconciling', 'released');
      const moved = db.prepare("UPDATE reservations SET status = 'released', closed_at = ? WHERE id = ? AND status = 'reconciling'").run(isoFromMs(clock.now()), reservation.id).changes;
      if (moved !== 1) return 'none';
      restockStock(db, clock, reservation.id, 'system', null);
      recordAudit(db, clock, {
        actorRole: 'system', action: 'reservation.release', entityType: 'reservation', entityId: reservation.id, outcome: 'ok',
        detail: { planVersionId },
      });
      return 'released';
    }
    if (reservation.escalation === null) {
      const nowMs = clock.now();
      const ageMin = (ts) => (ts ? (nowMs - Date.parse(ts)) / 60_000 : -1);
      let escalation = null;
      if (ops.some((op) => op.status === 'refund_failed')) escalation = 'REFUND_FAILED';
      else if (ops.some((op) => op.void_failed === 1)) escalation = 'VOID_FAILED';
      else if (ops.some((op) => op.status === 'unknown' && ageMin(op.unknown_since) > config.unknownEscalateMin)) escalation = 'UNKNOWN_TOO_LONG';
      else if (
        ops.some(
          (op) => ['authorization_pending', 'capture_pending', 'refund_pending'].includes(op.status) && ageMin(op.pending_since ?? op.updated_at) > config.pendingEscalateMin,
        )
      ) {
        escalation = 'PENDING_TOO_LONG';
      }
      if (escalation) db.prepare("UPDATE reservations SET escalation = ? WHERE id = ? AND status = 'reconciling' AND escalation IS NULL").run(escalation, reservation.id);
    }
    return 'waiting';
  });
}

// ------------------------------------------------------------------ step 5: compensation

// One transaction under G: plan executing -> non_executable (CAPTURE_FAILED | AUTHORIZATION_EXPIRED), reservation consumed ->
// reconciling, every open operation gets cancel_requested_at, queued captures -> cancelled, `authorized` -> a void is queued,
// `captured` -> refund_requested + a refund is queued. capture_pending and unknown operations are left to the reconciler
// (their resolution runs the hooks). Returns { state: 'compensated', callIds } | { state: 'lost' }.
function compensateInTx(env, lease, reason, supplierCode) {
  const { db, clock, config } = env;
  return db.tx(() => {
    if (!guardLease(db, clock, config, lease)) return { state: 'lost' };
    const now = isoFromMs(clock.now());
    assertTransition('plan', 'executing', 'non_executable', reason);
    const moved = db
      .prepare(
        "UPDATE plan_versions SET status = 'non_executable', non_executable_reason = ?, reason_detail_json = ?, updated_at = ? WHERE id = ? AND status = 'executing'",
      )
      .run(reason, JSON.stringify(supplierCode ? { supplierCode } : {}), now, lease.planId).changes;
    if (moved !== 1) return { state: 'lost' };
    const reservation = db.prepare("SELECT id FROM reservations WHERE plan_version_id = ? AND status = 'consumed'").get(lease.planId);
    if (reservation) {
      assertTransition('reservation', 'consumed', 'reconciling');
      db.prepare("UPDATE reservations SET status = 'reconciling' WHERE id = ? AND status = 'consumed'").run(reservation.id);
    }
    const callIds = [];
    for (const op of loadPlanOperations(db, lease.planId)) {
      if (TERMINAL_PAYMENT_STATES.includes(op.status)) continue;
      db.prepare('UPDATE payment_operations SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_reason = COALESCE(cancel_reason, ?), updated_at = ? WHERE id = ?').run(now, reason, now, op.id);
      db.prepare("UPDATE provider_calls SET status = 'cancelled', finished_at = ? WHERE payment_operation_id = ? AND kind = 'capture' AND status = 'intent' AND started_at IS NULL").run(now, op.id);
      if (op.status === 'authorized') {
        callIds.push(queueCall(db, clock, { operationId: op.id, supplierOrderId: op.supplier_order_id, kind: 'void', attempt: 1 }).call.id);
      } else if (op.status === 'captured') {
        moveOperation(db, clock, op, 'refund_requested');
        callIds.push(queueCall(db, clock, { operationId: op.id, supplierOrderId: op.supplier_order_id, kind: 'refund', attempt: 1 }).call.id);
      }
    }
    recordAudit(db, clock, {
      actorRole: 'system', action: 'plan.compensate', entityType: 'plan_version', entityId: lease.planId, outcome: 'ok',
      detail: { reason, calls: callIds.length },
    });
    return { state: 'compensated', callIds };
  });
}

// Sends the queued voids and refunds a compensation produced (the compensation caller), then the release check.
export async function sendCompensationCalls(env, planVersionId, callIds) {
  for (const id of callIds) {
    try {
      await runCall(env, id);
    } catch {
      env.log.error('provider.send_failed', { providerCallId: id, code: 'SEND_FAILED' });
    }
  }
  try {
    releaseIfSettled(env, planVersionId);
  } catch {
    env.log.error('reservation.release_failed', { planVersionId, code: 'RELEASE_FAILED' });
  }
}

async function compensate(env, lease, reason, supplierCode) {
  const result = compensateInTx(env, lease, reason, supplierCode);
  if (result.state === 'lost') {
    env.log.warn('saga.lease_lost', { planVersionId: lease.planId, epoch: lease.epoch, executorId: lease.executorId });
    return 'lost';
  }
  await sendCompensationCalls(env, lease.planId, result.callIds);
  return 'compensated';
}

// The compensation reason of a failed capture call: an authorization that is gone is AUTHORIZATION_EXPIRED, the rest CAPTURE_FAILED.
function reasonOfCall(call) {
  return /^AUTHORIZATION_(VOIDED|EXPIRED|DENIED)/.test(call?.error_code ?? '') ? 'AUTHORIZATION_EXPIRED' : 'CAPTURE_FAILED';
}

// ------------------------------------------------------------------ step 3: the capture result onto the operation

// Runs inside recordCall's transaction. Returns { next: 'continue' | 'pause' | 'compensate', reason?, refundCallId? }.
function capturedNow(t, captureId) {
  const { db, clock, op, env } = t;
  if (op.status === 'captured') return { next: 'continue' }; // a webhook got there first: the saga accepts captured as done
  if (!canTransition('payment', op.status, 'captured')) return { next: 'compensate', reason: 'CAPTURE_FAILED' };
  moveOperation(db, clock, op, 'captured', { provider_capture_id: captureId ?? op.provider_capture_id, last_error_code: null });
  return { next: 'continue', refundCallId: queueRefundWhenCancelled(db, clock, op.id, env.requestId ?? null) };
}

function applyCapture(t) {
  const { db, clock, op, outcome, now, call } = t;
  const setOperationError = (code) =>
    db.prepare("UPDATE payment_operations SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'authorized'").run(code, now, op.id);
  if (outcome.kind === 'ok') {
    const value = outcome.value;
    if (value.status === 'COMPLETED') return capturedNow(t, value.captureId);
    if (value.status === 'PENDING') {
      if (op.status === 'authorized') {
        moveOperation(db, clock, op, 'capture_pending', { provider_capture_id: value.captureId ?? null, pending_since: now, last_error_code: null });
      }
      return { next: op.status === 'captured' ? 'continue' : 'pause' };
    }
    // DECLINED: the call failed, the operation stays authorized (its authorization is still CREATED) and the plan compensates.
    db.prepare("UPDATE provider_calls SET status = 'failed', error_code = 'CAPTURE_DECLINED' WHERE id = ? AND status = 'succeeded'").run(call.id);
    setOperationError('CAPTURE_DECLINED');
    return { next: 'compensate', reason: 'CAPTURE_FAILED' };
  }
  if (outcome.kind === 'rejected') {
    if (outcome.issue === 'AUTHORIZATION_ALREADY_CAPTURED') {
      // A capture exists although this call was refused: it may be our own earlier send. Resolve by reading, never by guessing.
      db.prepare("UPDATE provider_calls SET status = 'unknown', send_token = NULL, unknown_since = ? WHERE id = ? AND status = 'failed'").run(now, call.id);
      if (op.status === 'authorized') moveOperation(db, clock, op, 'unknown', { prev_status: 'authorized', unknown_since: now });
      return { next: 'pause' };
    }
    setOperationError('CAPTURE_DECLINED');
    return { next: 'compensate', reason: reasonOfCall({ error_code: safeIssue(outcome.issue, '') }) };
  }
  if (outcome.kind === 'retryable') return { next: 'pause' }; // recordCall re-queued the call with its back-off
  if (op.status === 'authorized') moveOperation(db, clock, op, 'unknown', { prev_status: 'authorized', unknown_since: now });
  return { next: 'pause' };
}

// Start (guarded by the lease and by the supplier-code order) -> send -> record (fenced by the epoch).
async function sendCapture(env, lease, call, resendUnknown) {
  const { db, clock, config, log } = env;
  const guard = (gdb, gcall, gop) => {
    if (!guardLease(gdb, clock, config, lease)) return false;
    if (gop.status !== 'authorized' || typeof gop.provider_authorization_id !== 'string') return false;
    const earlier = gdb
      .prepare(
        'SELECT COUNT(*) AS n FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN suppliers s ON s.id = so.supplier_id ' +
          "WHERE so.plan_version_id = ? AND po.archived_at IS NULL AND s.code < ? AND po.status <> 'captured'",
      )
      .get(gop.plan_version_id, gop.supplier_code).n;
    if (earlier > 0) return false;
    gdb.prepare('UPDATE provider_calls SET lease_epoch = ? WHERE id = ?').run(lease.epoch, gcall.id);
    return true;
  };
  const started = startCall(db, clock, call.id, { guard, resendUnknown });
  if (!started) return { next: fenceLease(db, lease) ? 'pause' : 'lost' };

  let outcome;
  try {
    outcome = await withDeadline(
      env.payments.captureAuthorization({
        merchantKey: started.op.merchant_key, requestId: started.call.operation_key, authorizationId: started.op.provider_authorization_id,
        amountCents: started.op.order_total_cents, currency: 'USD', invoiceId: `rs-so-${started.op.supplier_order_id}-cap`,
      }),
      (config.paypalTimeoutMs ?? 20_000) + 1000,
    );
  } catch {
    log.error('provider.send_threw', { providerCallId: call.id, kind: 'capture', code: 'SEND_THREW' });
    outcome = unknownOutcome('network');
  }
  if (!outcome || typeof outcome.kind !== 'string') outcome = unknownOutcome('bad_body');
  log.info('provider.call', {
    providerCallId: call.id, paymentOperationId: started.op.id, operationKey: call.operation_key, kind: 'capture', attempt: call.attempt,
    code: outcome.kind, httpStatus: outcome.httpStatus,
  });
  const recorded = recordCall(env, {
    callId: call.id, token: started.token, outcome, apply: applyCapture, fence: (fdb) => fenceLease(fdb, lease),
  });
  if (recorded.fenced) return { next: 'lost' };
  const followUp = recorded.followUp ?? { next: 'pause' };
  if (followUp.refundCallId) {
    try {
      await runCall(env, followUp.refundCallId);
    } catch {
      log.error('provider.send_failed', { providerCallId: followUp.refundCallId, code: 'SEND_FAILED' });
    }
  }
  return { ...followUp, supplierCode: started.op.supplier_code };
}

// ------------------------------------------------------------------ steps 2-4: one run of the saga in this process

// Step 2: the post-claim authorization read under the fence. 'ok' | 'paused' | 'lost' | 'compensated'.
async function checkAuthorizations(env, lease) {
  const { db, clock, config, log } = env;
  const margin = config.authExpiryMarginMin * 60_000;
  for (const op of loadPlanOperations(db, lease.planId)) {
    if (op.status === 'captured') continue;
    const renewed = db.tx(() => guardLease(db, clock, config, lease));
    if (!renewed) return 'lost';
    if (op.status !== 'authorized' || typeof op.provider_authorization_id !== 'string') {
      return (await compensate(env, lease, 'AUTHORIZATION_EXPIRED', op.supplier_code)) === 'lost' ? 'lost' : 'compensated';
    }
    const read = await withDeadline(
      env.payments.getAuthorization({ merchantKey: op.merchant_key, authorizationId: op.provider_authorization_id }),
      (config.paypalTimeoutMs ?? 20_000) + 1000,
    );
    if (read.kind !== 'ok') {
      // A failed read leaves the plan executing and releases the lease; a later holder repeats step 2 before any capture.
      log.warn('saga.authorization_read_failed', { planVersionId: lease.planId, code: read.kind });
      pauseLease(env, lease);
      return 'paused';
    }
    const expiresMs = Date.parse(read.value.expirationTime);
    if (read.value.status !== 'CREATED' || !Number.isFinite(expiresMs) || expiresMs <= clock.now() + margin) {
      return (await compensate(env, lease, 'AUTHORIZATION_EXPIRED', op.supplier_code)) === 'lost' ? 'lost' : 'compensated';
    }
    const stored = db.tx(() => {
      if (!guardLease(db, clock, config, lease)) return false;
      db.prepare("UPDATE payment_operations SET authorization_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'authorized'").run(
        read.value.expirationTime, isoFromMs(clock.now()), op.id,
      );
      return true;
    });
    if (!stored) return 'lost';
  }
  return 'ok';
}

// Step 4: every operation captured -> the plan is executed (under G), the lease is cleared.
function finishExecution(env, lease) {
  const { db, clock, config } = env;
  return db.tx(() => {
    if (!guardLease(db, clock, config, lease)) return 'lost';
    const open = db
      .prepare(
        "SELECT COUNT(*) AS n FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ? AND po.archived_at IS NULL AND po.status <> 'captured'",
      )
      .get(lease.planId).n;
    if (open > 0) return 'continue';
    assertTransition('plan', 'executing', 'executed');
    const moved = db
      .prepare(`UPDATE plan_versions SET status = 'executed', lease_until = NULL, updated_at = ? WHERE ${LEASE_WHERE}`)
      .run(isoFromMs(clock.now()), lease.planId, lease.executorId, lease.epoch).changes;
    if (moved !== 1) return 'lost';
    recordAudit(db, clock, { actorRole: 'system', action: 'plan.executed', entityType: 'plan_version', entityId: lease.planId, outcome: 'ok', detail: { epoch: lease.epoch } });
    return 'executed';
  });
}

// Step 3 (and 4): sequential captures in supplier-code order.
async function captureLoop(env, lease, isStopped) {
  const { db, clock } = env;
  for (;;) {
    if (isStopped()) {
      pauseLease(env, lease);
      return 'stopped';
    }
    if (!fenceLease(db, lease)) return 'lost';
    const ops = loadPlanOperations(db, lease.planId);
    const next = ops.find((op) => op.status !== 'captured');
    if (!next) {
      const done = finishExecution(env, lease);
      if (done === 'continue') continue;
      return done;
    }
    // F-TR-7: a capture that is pending or unknown is resolved by reading (the reconciler); this step sends nothing.
    if (next.status === 'capture_pending' || next.status === 'unknown') {
      pauseLease(env, lease);
      return 'paused';
    }
    if (next.status !== 'authorized') return compensate(env, lease, 'CAPTURE_FAILED', next.supplier_code);

    let call = db.prepare("SELECT * FROM provider_calls WHERE payment_operation_id = ? AND kind = 'capture' AND archived_at IS NULL ORDER BY attempt DESC, id DESC LIMIT 1").get(next.id);
    if (!call) {
      const queued = db.tx(() => {
        if (!guardLease(db, clock, env.config, lease)) return false;
        queueCall(db, clock, { operationId: next.id, supplierOrderId: next.supplier_order_id, kind: 'capture', attempt: 1 });
        return true;
      });
      if (!queued) return 'lost';
      continue;
    }
    if (call.status === 'failed' || call.status === 'cancelled' || call.status === 'succeeded') {
      return compensate(env, lease, reasonOfCall(call), next.supplier_code);
    }
    const nowIso = isoFromMs(clock.now());
    const queuedCall = call.status === 'intent' && call.started_at === null;
    const resendable = call.status === 'unknown' && call.send_token === null;
    if ((!queuedCall && !resendable) || (queuedCall && call.next_attempt_at && call.next_attempt_at > nowIso)) {
      // in flight somewhere else, or backing off after a retryable answer: the lease holder pauses; the reconciler resumes it
      pauseLease(env, lease);
      return 'paused';
    }
    call = { ...call };
    const sent = await sendCapture(env, lease, call, resendable);
    if (sent.next === 'continue') continue;
    if (sent.next === 'lost') {
      env.log.warn('saga.lease_lost', { planVersionId: lease.planId, epoch: lease.epoch, executorId: lease.executorId });
      return 'lost';
    }
    if (sent.next === 'compensate') return compensate(env, lease, sent.reason ?? 'CAPTURE_FAILED', sent.supplierCode ?? next.supplier_code);
    pauseLease(env, lease);
    return 'paused';
  }
}

// One run: step 2 when no capture was ever sent, then step 3/4. Resolves with a word for tests and logs.
async function runSaga(env, lease, isStopped) {
  const { db, log } = env;
  const plan = db.prepare('SELECT status, executor_id, lease_epoch FROM plan_versions WHERE id = ?').get(lease.planId);
  if (!plan || plan.status !== 'executing' || plan.executor_id !== lease.executorId || plan.lease_epoch !== lease.epoch) return 'lost';
  if (!env.payments) {
    log.warn('saga.no_provider', { planVersionId: lease.planId, code: 'NO_PROVIDER' });
    pauseLease(env, lease);
    return 'paused';
  }
  const sent = db.prepare("SELECT COUNT(*) AS n FROM provider_calls pc JOIN payment_operations po ON po.id = pc.payment_operation_id JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ? AND pc.kind = 'capture' AND pc.send_count > 0").get(lease.planId).n;
  if (sent === 0) {
    const checked = await checkAuthorizations(env, lease);
    if (checked !== 'ok') return checked;
  }
  return captureLoop(env, lease, isStopped);
}

// The in-process runner. `deps` is the live dependency object of the app (payments and the void rule are read at call time).
//   begin(planId, epoch)   what the execute route calls after the claim (does nothing when autoRun is false)
//   start(planId, epoch)   runs the saga for that lease in the background; resolves with the run's result
//   idle()                 resolves when no run is in flight (tests, shutdown)
//   stop()                 no step starts after this; runs in flight pause their lease and finish
export function createSaga(deps, { executorId = processExecutorId(), autoRun = true } = {}) {
  const running = new Map();
  const state = { stopped: false };
  const saga = {
    executorId,
    autoRun,
    claim: (ctx, user, planId) => claimExecution(ctx, user, planId, { executorId }),
    start(planVersionId, epoch) {
      const key = `${planVersionId}:${epoch}`;
      if (running.has(key)) return running.get(key);
      const lease = { planId: planVersionId, executorId, epoch };
      const run = new Promise((resolve) => setImmediate(resolve))
        .then(() => (state.stopped ? 'stopped' : runSaga(deps, lease, () => state.stopped)))
        .catch((err) => {
          deps.log.error('saga.failed', { planVersionId, epoch, code: codeOf(err) });
          try {
            pauseLease(deps, lease);
          } catch {
            // The database may be closed already; the lease lapses and the reconciler takes over.
          }
          return 'failed';
        })
        .finally(() => running.delete(key));
      running.set(key, run);
      return run;
    },
    begin(planVersionId, epoch) {
      if (saga.autoRun) saga.start(planVersionId, epoch);
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
    async stop() {
      state.stopped = true;
      await saga.idle();
    },
  };
  return saga;
}
