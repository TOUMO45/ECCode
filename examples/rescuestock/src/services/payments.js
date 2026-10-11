// The customer-facing payment flow (spec: Interface Contracts > Customer routes; Return handler and authorization).
//
//   createPaymentForOrder(ctx, user, orderId)   POST /api/orders/:id/paypal/create  -> { payment, approvalUrl, approvalIndex, approvalsNeeded }
//   handlePaypalReturn(ctx, user, token)        GET  /api/paypal/return?token=      -> { location }   (303)
//   handlePaypalCancel(ctx, user, token)        GET  /api/paypal/cancel?token=      -> { location }   (303)
//   abandonPlan(ctx, user, planId)              POST /api/plans/:id/abandon         -> { plan, rescueStatus }
//
// The amount sent to the provider is always supplier_orders.total_cents (calls.js); nothing the client sends is read. Every
// provider call goes through the call protocol in calls.js: queued inside a transaction, started with a send_token CAS, sent
// outside any transaction, recorded with the token as the fence. A foreign or unknown PayPal token is 404 before any provider
// call and without a state change (RS-27).
import { isoFromMs } from '../clock.js';
import { AppError } from '../http/envelope.js';
import { takeFakePaypalFault } from '../payments/fake.js';
import { flushQueuedVoids, queueCall, runCall } from './calls.js';
import { recordAudit } from './audit.js';
import { findOwnedOrder } from './orders.js';
import { findOwnedPlan } from './plans.js';
import { markNonExecutable } from './supersession.js';
import { buildRescueStatus, renderPayment, renderPlanVersion } from './view.js';

// Order statuses from which the buyer can still approve the stored link (A13: anything else needs a new order).
const APPROVABLE = new Set(['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED']);
const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const WAIT_STEP_MS = 50;
const WAIT_MAX_MS = 3000;
const MAX_ROUNDS = 5;

const invalidState = (from, to) => new AppError(409, 'INVALID_STATE', { details: { from: String(from), to: String(to) } });
const unavailable = () => new AppError(503, 'PROVIDER_UNAVAILABLE');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A refused call is audited (outcome denied, code only) after the work rolled back, then rethrown.
async function audited(ctx, user, action, entityType, entityId, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.status === 409) {
      try {
        recordAudit(ctx.db, ctx.clock, {
          actorUserId: user.id, actorRole: user.role, action, entityType, entityId, outcome: 'denied', detail: { code: err.code }, requestId: ctx.requestId,
        });
      } catch {
        ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
      }
    }
    throw err;
  }
}

const operationOf = (db, supplierOrderId) => db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ? AND archived_at IS NULL').get(supplierOrderId) ?? null;

// ------------------------------------------------------------------ paypal/create

// plan approved, requirements with budget and deadline (RS-04: the budget first), reservation active and not expired.
function assertPayable(ctx, order) {
  const { db, clock } = ctx;
  if (order.plan_status === 'superseded') throw new AppError(409, 'PLAN_SUPERSEDED');
  if (order.plan_status === 'non_executable') throw new AppError(409, 'PLAN_NOT_EXECUTABLE', { details: { reason: order.non_executable_reason } });
  if (order.plan_status !== 'approved') throw invalidState(order.plan_status, 'payment');
  const run = db.prepare('SELECT requirements_version FROM planning_runs WHERE id = ?').get(order.planning_run_id);
  const requirements = db.prepare('SELECT budget_cents, deadline_at FROM requirements WHERE request_id = ? AND version = ?').get(order.request_id, run.requirements_version);
  if (!requirements || requirements.budget_cents === null) throw new AppError(409, 'MISSING_BUDGET');
  if (requirements.deadline_at === null) throw new AppError(409, 'MISSING_DEADLINE');
  const reservation = db.prepare('SELECT status, expires_at FROM reservations WHERE id = ?').get(order.reservation_id);
  if (!reservation || reservation.status !== 'active' || Date.parse(reservation.expires_at) <= clock.now()) throw new AppError(409, 'RESERVATION_EXPIRED');
}

function approvalPosition(db, order) {
  const codes = db
    .prepare('SELECT so.id FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE so.plan_version_id = ? ORDER BY s.code')
    .all(order.plan_version_id)
    .map((r) => r.id);
  return { approvalIndex: codes.indexOf(order.id) + 1, approvalsNeeded: codes.length };
}

function createdAnswer(ctx, order) {
  const op = operationOf(ctx.db, order.id);
  if (!op || op.status !== 'created' || !op.approval_url) throw invalidState(op?.status ?? 'missing', 'created');
  return { payment: renderPayment(op, ctx.config), approvalUrl: op.approval_url, ...approvalPosition(ctx.db, order) };
}

// Waits (bounded) until another sender has recorded the call, so a double click answers with the link instead of an error.
async function settled(db, callId) {
  for (let waited = 0; waited <= WAIT_MAX_MS; waited += WAIT_STEP_MS) {
    const call = db.prepare('SELECT status, started_at FROM provider_calls WHERE id = ?').get(callId);
    if (!call || call.status !== 'intent' || call.started_at === null) return true;
    await sleep(WAIT_STEP_MS);
  }
  return false;
}

// Runs the protocol for one create_order call and answers; null = somebody else was sending, look again.
async function sendCreate(ctx, order, callId, resendUnknown) {
  const result = await runCall(ctx, callId, { resendUnknown });
  if (result.state === 'not_started') {
    if (!(await settled(ctx.db, callId))) throw unavailable();
    return null;
  }
  if (result.state !== 'recorded') throw unavailable();
  if (result.outcome.kind === 'ok') return createdAnswer(ctx, order);
  if (result.outcome.kind === 'rejected') {
    const issue = /^[A-Z][A-Z0-9_]{0,63}$/.test(result.outcome.issue ?? '') ? result.outcome.issue : 'REJECTED';
    throw new AppError(502, 'PROVIDER_ERROR', { details: { issue } });
  }
  throw unavailable();
}

export async function createPaymentForOrder(ctx, user, orderId) {
  return audited(ctx, user, 'payment.create', 'supplier_order', orderId, async () => {
    const { db, clock, config } = ctx;
    const order = findOwnedOrder(db, user.id, orderId); // 404 for a foreign order, before anything else
    assertPayable(ctx, order);
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const op = operationOf(db, orderId);
      if (!op) throw new AppError(404, 'NOT_FOUND');
      if (op.status !== 'created') throw invalidState(op.status, 'created');
      if (!ctx.payments) throw unavailable();
      const last = db.prepare("SELECT * FROM provider_calls WHERE payment_operation_id = ? AND kind = 'create_order' ORDER BY attempt DESC LIMIT 1").get(op.id);

      // Already created.
      if (last && last.status === 'succeeded' && op.provider_order_id && op.approval_url) {
        if (!op.buyer_cancelled_at) return createdAnswer(ctx, order); // the stored link, no provider call
        // "Try approval again": is the order still approvable?
        const read = await ctx.payments.getOrder({ merchantKey: op.merchant_key, orderId: op.provider_order_id });
        if (read.kind === 'ok' && APPROVABLE.has(read.value.status)) return createdAnswer(ctx, order);
        if (read.kind === 'retryable' || (read.kind === 'unknown')) throw unavailable();
        // Not approvable (A13, or the provider no longer knows it): a new order, attempt + 1. The new id replaces the old.
        const callId = db.tx(() => {
          const moved = db
            .prepare("UPDATE payment_operations SET create_attempt = ?, updated_at = ? WHERE id = ? AND status = 'created' AND create_attempt = ?")
            .run(last.attempt + 1, isoFromMs(clock.now()), op.id, op.create_attempt).changes;
          if (moved !== 1) return null;
          return queueCall(db, clock, { operationId: op.id, supplierOrderId: orderId, kind: 'create_order', attempt: last.attempt + 1, requestId: ctx.requestId }).call.id;
        });
        if (callId === null) continue;
        const done = await sendCreate(ctx, order, callId, false);
        if (done) return done;
        continue;
      }

      let callId;
      let resendUnknown = false;
      if (!last) {
        callId = db.tx(() => queueCall(db, clock, { operationId: op.id, supplierOrderId: orderId, kind: 'create_order', attempt: op.create_attempt, requestId: ctx.requestId }).call.id);
      } else if (last.status === 'intent' && last.started_at === null) {
        callId = last.id; // queued: never sent (a crash or a retryable answer)
      } else if (last.status === 'unknown') {
        callId = last.id;
        resendUnknown = true; // same key, same PayPal-Request-Id
      } else if (last.status === 'failed') {
        callId = db.tx(() => {
          const moved = db
            .prepare("UPDATE payment_operations SET create_attempt = ?, updated_at = ? WHERE id = ? AND status = 'created' AND create_attempt = ?")
            .run(last.attempt + 1, isoFromMs(clock.now()), op.id, op.create_attempt).changes;
          if (moved !== 1) return null;
          return queueCall(db, clock, { operationId: op.id, supplierOrderId: orderId, kind: 'create_order', attempt: last.attempt + 1, requestId: ctx.requestId }).call.id;
        });
        if (callId === null) continue;
      } else if (last.status === 'intent') {
        // another request is sending it right now
        if (!(await settled(db, last.id))) throw unavailable();
        continue;
      } else {
        throw invalidState(op.status, 'created');
      }
      const done = await sendCreate(ctx, order, callId, resendUnknown);
      if (done) return done;
    }
    throw unavailable();
  });
}

// ------------------------------------------------------------------ return and cancel

// The return and cancel URLs are public routes, so the general per-user limit (access hook) never sees them, yet a hit on an
// unapproved order costs one provider getOrder (SEC-E-2). Hits of the identified customer are therefore counted here, before
// any lookup or provider call, in rate_events (kind 'general', key pp:u:<userId>; planning uses plan:u:<userId> the same way).
// RETURN_LIMIT per window (the general limit's window, RS_GENERAL_RATE_WINDOW_SEC, 60 s by default; never above the general
// limit itself). A buyer makes about two hits per supplier approval (return, refresh), at most five suppliers: 30 a minute is
// far above any real use and 30 provider reads a minute per account is bounded. A refused hit is not recorded, so a flood
// cannot grow the table; the answer is 429 RATE_LIMITED { limit: 'general' } with Retry-After, like every other limit.
export const RETURN_LIMIT = 30;

export function takeReturnSlot(ctx, userId) {
  const { db, clock, config } = ctx;
  const limit = Math.min(RETURN_LIMIT, config.generalRateLimit ?? RETURN_LIMIT);
  const windowMs = (config.generalRateWindowSec ?? 60) * 1000;
  const nowMs = clock.now();
  const key = `pp:u:${userId}`;
  const decision = db.tx(() => {
    db.prepare("DELETE FROM rate_events WHERE kind = 'general' AND user_key = ? AND at <= ?").run(key, isoFromMs(nowMs - windowMs));
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = 'general' AND user_key = ? AND at > ?").get(key, isoFromMs(nowMs - windowMs));
    if (row.n >= limit) return { allowed: false, retryAfterS: Math.max(1, Math.ceil((Date.parse(row.oldest) + windowMs - nowMs) / 1000)) };
    db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'general', ?)").run(key, isoFromMs(nowMs));
    return { allowed: true };
  });
  if (!decision.allowed) {
    throw new AppError(429, 'RATE_LIMITED', { details: { limit: 'general' }, headers: { 'Retry-After': String(decision.retryAfterS) } });
  }
}

// The operation behind a PayPal token of THIS customer, or 404. Nothing else is read first.
function findByToken(db, userId, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new AppError(400, 'BAD_REQUEST');
  const row = db
    .prepare(
      'SELECT po.id AS op_id, po.status, po.merchant_key, po.supplier_order_id, so.plan_version_id, pv.request_id ' +
        'FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
        'JOIN rescue_requests rr ON rr.id = pv.request_id ' +
        'WHERE po.provider_order_id = ? AND rr.customer_id = ? AND rr.archived_at IS NULL AND rr.deleted_at IS NULL AND po.archived_at IS NULL',
    )
    .get(token, userId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

const redirectTo = (row, outcome) => ({ location: `/#/requests/${row.request_id}?paypal=${outcome}&order=${row.supplier_order_id}` });

// Return handler, steps 1-6 (spec).
export async function handlePaypalReturn(ctx, user, token) {
  const { db, clock, config, log } = ctx;
  const row = findByToken(db, user.id, token); // 1. unknown token or another customer's: 404, no call
  if (row.status !== 'created') return redirectTo(row, 'returned'); // 2. refresh and back-navigation: no provider call
  if (!ctx.payments) throw unavailable();

  const got = await ctx.payments.getOrder({ merchantKey: row.merchant_key, orderId: token }); // 3.
  if (got.kind !== 'ok') {
    log.warn('payment.return_check_failed', { paymentOperationId: row.op_id, code: got.kind });
    return redirectTo(row, got.kind === 'rejected' ? 'not_approved' : 'check_failed');
  }
  if (got.value.status !== 'APPROVED') return redirectTo(row, 'not_approved');

  // 4. created -> approved (compare-and-set) and the authorize call queued, in one transaction. Only the winner queues it.
  const callId = db.tx(() => {
    const now = isoFromMs(clock.now());
    const moved = db.prepare("UPDATE payment_operations SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'created'").run(now, row.op_id).changes;
    if (moved !== 1) return null;
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'payment.return', entityType: 'payment_operation', entityId: row.op_id, outcome: 'ok',
      detail: { supplierOrderId: row.supplier_order_id }, requestId: ctx.requestId,
    });
    return queueCall(db, clock, { operationId: row.op_id, supplierOrderId: row.supplier_order_id, kind: 'authorize', attempt: 1, requestId: ctx.requestId }).call.id;
  });
  if (callId === null) return redirectTo(row, 'returned');

  // Test hook (F-TR-3): die between the commit and the send. The queued authorize is then sent by the reconciler (sendDueCalls).
  if (config.testHooks && takeFakePaypalFault(db, 'crash_after_return_commit', { merchantKey: row.merchant_key, testHooks: true })) {
    ctx.killProcess();
  }

  // 5. the call protocol. A failed start or send leaves the call queued for the reconciler.
  try {
    await runCall(ctx, callId);
    await flushQueuedVoids(ctx, ctx.voidRule?.provider);
  } catch (err) {
    log.error('payment.authorize_failed', { paymentOperationId: row.op_id, code: err?.code ? String(err.code).slice(0, 40) : 'AUTHORIZE_FAILED' });
  }
  return redirectTo(row, 'returned'); // 6.
}

export async function handlePaypalCancel(ctx, user, token) {
  const { db, clock } = ctx;
  const row = findByToken(db, user.id, token);
  db.tx(() => {
    const now = isoFromMs(clock.now());
    const moved = db
      .prepare("UPDATE payment_operations SET buyer_cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'created'")
      .run(now, now, row.op_id).changes;
    if (moved === 1) {
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'payment.cancel', entityType: 'payment_operation', entityId: row.op_id, outcome: 'ok',
        detail: { supplierOrderId: row.supplier_order_id }, requestId: ctx.requestId,
      });
    }
  });
  return redirectTo(row, 'cancelled');
}

// ------------------------------------------------------------------ abandon

// approved -> non_executable (PAYMENT_CANCELLED) and the void rule, in one transaction. A plan already abandoned answers 200 with
// its current state; any other state is 409 INVALID_STATE. Queued voids are sent before the answer is built.
export async function abandonPlan(ctx, user, planId) {
  return audited(ctx, user, 'plan.abandon', 'plan_version', planId, async () => {
    const { db } = ctx;
    findOwnedPlan(db, user.id, planId);
    db.tx(() => {
      const plan = db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(planId);
      if (plan.status === 'non_executable' && plan.non_executable_reason === 'PAYMENT_CANCELLED') return;
      if (plan.status !== 'approved') throw invalidState(plan.status, 'non_executable');
      markNonExecutable(ctx, { planVersionId: planId, reason: 'PAYMENT_CANCELLED', detail: {}, actor: user, requestId: ctx.requestId });
    });
    try {
      await flushQueuedVoids(ctx, ctx.voidRule?.provider);
    } catch (err) {
      ctx.log.error('payment.void_flush_failed', { planVersionId: planId, code: err?.code ? String(err.code).slice(0, 40) : 'FLUSH_FAILED' });
    }
    const version = db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(planId);
    const run = db.prepare('SELECT * FROM planning_runs WHERE id = ?').get(version.planning_run_id) ?? null;
    return { plan: renderPlanVersion(version, run), rescueStatus: buildRescueStatus(ctx, version.request_id, user.id) };
  });
}
