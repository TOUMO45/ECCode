// The reconciler (spec: Background Processing > Reconciler, Provider call protocol §5-7). It runs once at startup and then every
// RS_RECONCILE_INTERVAL_MS in every process. Each step selects candidates and claims every work item with a compare-and-set,
// so reconcilers of several processes never double-act. A failure in one item is logged and never stops the tick.
//
// Order per tick:
//   1. stale started intents -> unknown (started_at <= now - 2 x RS_PAYPAL_TIMEOUT_MS; their late writes are fenced by send_token)
//   2. resolve unknown calls by READING first (protocol §6); only a call the provider shows does not exist is sent again
//   3. poll authorization_pending (getAuthorization), capture_pending (getCapture), refund_pending (getRefund); every tick for
//      5 minutes, then every 5 minutes
//   4. expire reservations (in-process, RISK-20) and send the voids that queued
//   5. take over executing plans whose lease lapsed and resume them (a paused plan with a capture_pending or unknown operation
//      is NOT taken over: F-TR-7) -- the resumed saga runs in the background of this process (saga.idle() waits for it)
//   6. send the queued authorize, void and refund calls per the Sender table (captures only via the saga)
//   7. release check for reconciling reservations, escalation
//   8. drain the re-plan queue
//   9. housekeeping: sessions, login failures, idempotency keys, invalid/unverified webhook rows older than 7 days (SEC-6),
//      stale reserved model-spend rows
// The resolution paths run the void rule's resolution hook (voidRule.onAuthorized) in the same transaction as every move into
// `authorized`, and the compensation hook (queueRefundWhenCancelled) in the same transaction as every move into `captured`.
// An operation that a webhook already moved past the state of an open call makes that call resolved (CAS on the status, no error).
import { IDLE_MS } from '../auth/sessions.js';
import { isoFromMs } from '../clock.js';
import { setMeta } from '../db/meta.js';
import { TERMINAL_PAYMENT_STATES, assertTransition, canTransition } from '../domain/states.js';
import { flushQueuedVoids, loadOperation, moveOperation, queueCall, restoreFromUnknown, resolveRejectedVoid, runCall, sendDueCalls } from './calls.js';
import { recordAudit } from './audit.js';
import { runPlanningFor } from './plans.js';
import { expireDueReservations } from './reservations.js';
import { queueRefundWhenCancelled, releaseIfSettled } from './saga.js';
import { markNonExecutable } from './supersession.js';

export const POLL_EVERY_TICK_MS = 5 * 60_000;
export const WEBHOOK_ROW_KEEP_MS = 7 * 24 * 3600 * 1000;
export const LOGIN_FAILURE_KEEP_MS = 24 * 3600 * 1000;
export const IDEMPOTENCY_KEEP_MS = 24 * 3600 * 1000;
export const REPLAN_BACKOFF_CAP_MS = 5 * 60_000;
export const REPLAN_BACKOFF_BASE_MS = 15_000;
const BATCH = 100;
const ISSUE = /^[A-Z][A-Z0-9_]{0,63}$/;

const codeOf = (err) => (err && typeof err.code === 'string' && ISSUE.test(err.code) ? err.code : 'FAILED');
// The operation state a started call leaves behind when it becomes unknown (the state the call belongs to).
const STATE_OF_CALL = Object.freeze({ authorize: 'approved', capture: 'authorized', void: 'authorized', refund: 'refund_pending' });

// ------------------------------------------------------------------ helpers

// Marks an unknown call resolved (CAS: only while it is still unknown and unsent).
function setCall(db, clock, callId, status, { providerStatus = null, resourceId = null, errorCode = null } = {}) {
  return (
    db
      .prepare(
        "UPDATE provider_calls SET status = ?, provider_status = COALESCE(?, provider_status), provider_resource_id = COALESCE(?, provider_resource_id), " +
          "error_code = COALESCE(?, error_code), finished_at = ? WHERE id = ? AND status = 'unknown' AND send_token IS NULL",
      )
      .run(status, providerStatus, resourceId, errorCode, isoFromMs(clock.now()), callId).changes === 1
  );
}

// One resolution in ONE transaction, re-checking that the call is still unknown (another reconciler may have resolved it).
function resolveInTx(env, callId, fn) {
  const { db } = env;
  return db.tx(() => {
    const call = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(callId);
    if (!call || call.status !== 'unknown' || call.send_token !== null) return false;
    const op = loadOperation(db, call.payment_operation_id);
    if (!op) return false;
    fn(db, call, op);
    return true;
  });
}

// unknown -> the state it had before (provider showed no effect), then the resolution hook when that state is `authorized`.
function restoreOperation(env, db, op) {
  if (op.status !== 'unknown') return false;
  const restored = restoreFromUnknown(db, env.clock, op);
  if (restored && op.prev_status === 'authorized') env.voidRule?.onAuthorized?.(db, { operationId: op.id });
  return restored;
}

// A move that the state table allows; `unknown` may move to anything the provider reports.
function move(db, clock, op, to, set = {}) {
  if (op.status === to || !canTransition('payment', op.status, to)) return false;
  return moveOperation(db, clock, op, to, set);
}

// authorization read -> operation. For an operation in approved / authorization_pending / unknown(prev approved).
function applyAuthorizationRead(env, db, op, auth) {
  const { clock } = env;
  if (!['approved', 'authorization_pending', 'unknown'].includes(op.status)) return; // already past that state
  if (op.status === 'unknown' && op.prev_status !== 'approved' && op.prev_status !== 'authorization_pending') return;
  const base = { provider_authorization_id: auth.id ?? op.provider_authorization_id, authorization_expires_at: auth.expirationTime ?? op.authorization_expires_at, last_error_code: null };
  if (auth.status === 'CREATED') {
    if (move(db, clock, op, 'authorized', base)) env.voidRule?.onAuthorized?.(db, { operationId: op.id });
  } else if (auth.status === 'PENDING') {
    if (op.status !== 'authorization_pending') move(db, clock, op, 'authorization_pending', { ...base, pending_since: isoFromMs(clock.now()) });
  } else if (move(db, clock, op, 'authorization_failed', { ...base, last_error_code: 'AUTHORIZATION_DENIED' })) {
    // The void rule fires for the plan (AUTHORIZATION_FAILED, detail.supplierCode); a plan that is no longer approved is left alone.
    markNonExecutable(env, { planVersionId: op.plan_version_id, reason: 'AUTHORIZATION_FAILED', detail: { supplierCode: op.supplier_code }, actor: null });
  }
}

// ------------------------------------------------------------------ step 1: stale intents

function markStaleIntents(env) {
  const { db, clock, config } = env;
  const cutoff = isoFromMs(clock.now() - 2 * config.paypalTimeoutMs);
  const ids = db
    .prepare("SELECT id FROM provider_calls WHERE status = 'intent' AND started_at IS NOT NULL AND started_at <= ? AND archived_at IS NULL ORDER BY id LIMIT ?")
    .all(cutoff, BATCH)
    .map((r) => r.id);
  let marked = 0;
  for (const id of ids) {
    try {
      const done = db.tx(() => {
        const now = isoFromMs(clock.now());
        const moved = db
          .prepare(
            "UPDATE provider_calls SET status = 'unknown', send_token = NULL, unknown_since = ?, error_code = 'STALE_INTENT' " +
              "WHERE id = ? AND status = 'intent' AND started_at IS NOT NULL AND started_at <= ?",
          )
          .run(now, id, cutoff).changes;
        if (moved !== 1) return false;
        const call = db.prepare('SELECT kind, payment_operation_id FROM provider_calls WHERE id = ?').get(id);
        const op = loadOperation(db, call.payment_operation_id);
        const from = STATE_OF_CALL[call.kind];
        if (op && from && op.status === from) moveOperation(db, clock, op, 'unknown', { prev_status: op.status, unknown_since: now });
        return true;
      });
      if (done) marked += 1;
    } catch (err) {
      env.log.error('reconcile.item_failed', { providerCallId: id, kind: 'stale_intent', code: codeOf(err) });
    }
  }
  return marked;
}

// ------------------------------------------------------------------ step 2: resolve unknown calls by reading

async function resolveAuthorize(env, call, op) {
  if (!op.provider_order_id) return false;
  const read = await env.payments.getOrder({ merchantKey: op.merchant_key, orderId: op.provider_order_id });
  if (read.kind !== 'ok') return false;
  const auth = (read.value.authorizations ?? [])[0] ?? null;
  if (auth) {
    return resolveInTx(env, call.id, (db, fresh, fop) => {
      setCall(db, env.clock, fresh.id, 'succeeded', { providerStatus: auth.status, resourceId: auth.id });
      applyAuthorizationRead(env, db, fop, auth);
    });
  }
  if (read.value.status !== 'APPROVED') return false;
  // Approved and never authorized: restore `approved` and send the SAME key again (even when a cancellation was requested: the
  // answer then fires the resolution hook, so exactly one void follows).
  const restored = resolveInTx(env, call.id, (db, fresh, fop) => {
    if (fop.status === 'unknown' && fop.prev_status === 'approved') restoreFromUnknown(db, env.clock, fop);
  });
  if (!restored) return false;
  await runCall(env, call.id, { resendUnknown: true });
  return true;
}

async function resolveCapture(env, call, op) {
  if (!op.provider_authorization_id) return false;
  const auth = await env.payments.getAuthorization({ merchantKey: op.merchant_key, authorizationId: op.provider_authorization_id });
  if (auth.kind !== 'ok') return false;
  const status = auth.value.status;
  if (status === 'CAPTURED' || status === 'PARTIALLY_CAPTURED') {
    const order = await env.payments.getOrder({ merchantKey: op.merchant_key, orderId: op.provider_order_id });
    if (order.kind !== 'ok') return false;
    const found = (order.value.captures ?? []).filter((c) => c.authorizationId === op.provider_authorization_id);
    const capture = found.find((c) => c.status === 'COMPLETED') ?? found.find((c) => c.status === 'PENDING') ?? found[0] ?? null;
    if (!capture) return false;
    return resolveInTx(env, call.id, (db, fresh, fop) => {
      const { clock } = env;
      if (capture.status === 'COMPLETED') {
        setCall(db, clock, fresh.id, 'succeeded', { providerStatus: capture.status, resourceId: capture.id });
        if (['unknown', 'authorized', 'capture_pending'].includes(fop.status)) {
          move(db, clock, fop, 'captured', { provider_capture_id: capture.id, last_error_code: null });
          queueRefundWhenCancelled(db, clock, fop.id);
        }
      } else if (capture.status === 'PENDING') {
        setCall(db, clock, fresh.id, 'succeeded', { providerStatus: capture.status, resourceId: capture.id });
        if (['unknown', 'authorized'].includes(fop.status)) {
          move(db, clock, fop, 'capture_pending', { provider_capture_id: capture.id, pending_since: isoFromMs(clock.now()) });
        }
      } else {
        setCall(db, clock, fresh.id, 'failed', { providerStatus: capture.status, resourceId: capture.id, errorCode: 'CAPTURE_DECLINED' });
        if (fop.status === 'unknown') {
          restoreOperation(env, db, fop);
          db.prepare("UPDATE payment_operations SET last_error_code = 'CAPTURE_DECLINED', updated_at = ? WHERE id = ? AND status = 'authorized'").run(isoFromMs(clock.now()), fop.id);
        }
      }
    });
  }
  if (status === 'CREATED') {
    // The provider shows no capture: the operation goes back to `authorized`. The call stays unknown; ONLY the lease holder sends
    // it again (saga resume after a takeover, step 5). When the plan is being compensated it is cancelled instead.
    return resolveInTx(env, call.id, (db, fresh, fop) => {
      restoreOperation(env, db, fop);
      if (fop.cancel_requested_at !== null) setCall(db, env.clock, fresh.id, 'cancelled', { providerStatus: status });
    });
  }
  // VOIDED / EXPIRED / DENIED: the authorization is gone -> the capture call failed; the saga compensates
  return resolveInTx(env, call.id, (db, fresh, fop) => {
    const code = `AUTHORIZATION_${String(status).replace(/[^A-Z]/g, '').slice(0, 20) || 'GONE'}`;
    setCall(db, env.clock, fresh.id, 'failed', { providerStatus: status, errorCode: code });
    restoreOperation(env, db, fop);
    db.prepare("UPDATE payment_operations SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'authorized'").run(code, isoFromMs(env.clock.now()), fop.id);
  });
}

async function resolveVoid(env, call, op) {
  if (!op.provider_authorization_id) return false;
  const auth = await env.payments.getAuthorization({ merchantKey: op.merchant_key, authorizationId: op.provider_authorization_id });
  if (auth.kind !== 'ok') return false;
  const status = auth.value.status;
  if (status === 'VOIDED') {
    return resolveInTx(env, call.id, (db, fresh, fop) => {
      setCall(db, env.clock, fresh.id, 'succeeded', { providerStatus: status });
      if (['unknown', 'authorized'].includes(fop.status)) move(db, env.clock, fop, 'voided', { last_error_code: null });
    });
  }
  const resend = status === 'CREATED' || status === 'PENDING';
  const resolved = resolveInTx(env, call.id, (db, fresh, fop) => {
    if (!resend) setCall(db, env.clock, fresh.id, 'failed', { providerStatus: status, errorCode: status === 'CAPTURED' || status === 'PARTIALLY_CAPTURED' ? 'AUTHORIZATION_CAPTURED' : 'VOID_REJECTED' });
    if (fop.status === 'unknown' && fop.prev_status === 'authorized') restoreFromUnknown(db, env.clock, fop); // no hook: a void is queued already
  });
  if (!resolved) return false;
  if (resend) await runCall(env, call.id, { resendUnknown: true });
  else await resolveRejectedVoid(env, op.id); // CAPTURED -> captured (+ refund, F-TR-6); anything else -> void_failed
  return true;
}

async function resolveRefund(env, call, op) {
  if (!op.provider_capture_id) return false;
  const capture = await env.payments.getCapture({ merchantKey: op.merchant_key, captureId: op.provider_capture_id });
  if (capture.kind !== 'ok') return false;
  const order = await env.payments.getOrder({ merchantKey: op.merchant_key, orderId: op.provider_order_id });
  if (order.kind !== 'ok') return false;
  const refunds = (order.value.refunds ?? []).filter((r) => r.captureId === op.provider_capture_id);
  const refund = refunds.find((r) => r.status === 'COMPLETED') ?? refunds.find((r) => r.status === 'PENDING') ?? refunds[0] ?? null;
  if (refund) {
    return resolveInTx(env, call.id, (db, fresh, fop) => {
      const { clock } = env;
      setCall(db, clock, fresh.id, 'succeeded', { providerStatus: refund.status, resourceId: refund.id });
      if (!['unknown', 'refund_pending', 'refund_requested'].includes(fop.status)) return; // past that state (webhook)
      let current = fop;
      if (current.status === 'refund_requested') {
        moveOperation(db, clock, current, 'refund_pending');
        current = loadOperation(db, fop.id);
      }
      if (refund.status === 'COMPLETED') move(db, clock, current, 'refunded', { provider_refund_id: refund.id });
      else if (refund.status === 'PENDING') move(db, clock, current, 'refund_pending', { provider_refund_id: refund.id });
      else move(db, clock, current, 'refund_failed', { provider_refund_id: refund.id, last_error_code: `REFUND_${String(refund.status).replace(/[^A-Z]/g, '').slice(0, 20)}` });
    });
  }
  if (capture.value.status !== 'COMPLETED') return false;
  // A completed capture with no refund: restore the operation and send the same key again.
  const restored = resolveInTx(env, call.id, (db, fresh, fop) => {
    if (fop.status === 'unknown') restoreFromUnknown(db, env.clock, fop);
  });
  if (!restored) return false;
  await runCall(env, call.id, { resendUnknown: true });
  return true;
}

async function resolveUnknownCalls(env) {
  const { db } = env;
  const ids = db
    .prepare("SELECT id FROM provider_calls WHERE status = 'unknown' AND send_token IS NULL AND archived_at IS NULL ORDER BY id LIMIT ?")
    .all(BATCH)
    .map((r) => r.id);
  let resolved = 0;
  for (const id of ids) {
    try {
      const call = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(id);
      const op = call ? loadOperation(db, call.payment_operation_id) : null;
      if (!call || !op || call.status !== 'unknown') continue;
      let done = false;
      if (call.kind === 'create_order') {
        // Nothing to read (no id yet) and the reconciler never sends it: the buyer's next paypal/create does. A call whose operation
        // is already closed has nothing left to send.
        if (TERMINAL_PAYMENT_STATES.includes(op.status)) done = resolveInTx(env, id, (d, c) => setCall(d, env.clock, c.id, 'cancelled'));
      } else if (!env.payments) {
        done = false;
      } else if (call.kind === 'authorize') done = await resolveAuthorize(env, call, op);
      else if (call.kind === 'capture') done = await resolveCapture(env, call, op);
      else if (call.kind === 'void') done = await resolveVoid(env, call, op);
      else if (call.kind === 'refund') done = await resolveRefund(env, call, op);
      if (done) resolved += 1;
    } catch (err) {
      env.log.error('reconcile.item_failed', { providerCallId: id, kind: 'resolve', code: codeOf(err) });
    }
  }
  return resolved;
}

// ------------------------------------------------------------------ step 3: poll pending operations

async function pollOne(env, op) {
  const { db, clock } = env;
  if (op.status === 'authorization_pending') {
    if (!op.provider_authorization_id) return false;
    const read = await env.payments.getAuthorization({ merchantKey: op.merchant_key, authorizationId: op.provider_authorization_id });
    if (read.kind !== 'ok' || read.value.status === 'PENDING') return false;
    return db.tx(() => {
      const fresh = loadOperation(db, op.id);
      if (!fresh || fresh.status !== 'authorization_pending') return false;
      applyAuthorizationRead(env, db, fresh, { id: fresh.provider_authorization_id, status: read.value.status, expirationTime: read.value.expirationTime });
      return true;
    });
  }
  if (op.status === 'capture_pending') {
    if (!op.provider_capture_id) return false;
    const read = await env.payments.getCapture({ merchantKey: op.merchant_key, captureId: op.provider_capture_id });
    if (read.kind !== 'ok' || read.value.status === 'PENDING') return false;
    return db.tx(() => {
      const fresh = loadOperation(db, op.id);
      if (!fresh || fresh.status !== 'capture_pending') return false;
      if (read.value.status === 'COMPLETED') {
        moveOperation(db, clock, fresh, 'captured', { last_error_code: null });
        queueRefundWhenCancelled(db, clock, fresh.id);
      } else {
        // DECLINED: back to authorized; the saga (lease holder) compensates, and a cancellation fires the void hook now
        db.prepare("UPDATE provider_calls SET status = 'failed', error_code = 'CAPTURE_DECLINED' WHERE payment_operation_id = ? AND kind = 'capture' AND status = 'succeeded'").run(fresh.id);
        moveOperation(db, clock, fresh, 'authorized', { last_error_code: 'CAPTURE_DECLINED' });
        env.voidRule?.onAuthorized?.(db, { operationId: fresh.id });
      }
      return true;
    });
  }
  if (op.status === 'refund_pending') {
    if (!op.provider_refund_id) return false;
    const read = await env.payments.getRefund({ merchantKey: op.merchant_key, refundId: op.provider_refund_id });
    if (read.kind !== 'ok' || read.value.status === 'PENDING') return false;
    return db.tx(() => {
      const fresh = loadOperation(db, op.id);
      if (!fresh || fresh.status !== 'refund_pending') return false;
      if (read.value.status === 'COMPLETED') moveOperation(db, clock, fresh, 'refunded');
      else moveOperation(db, clock, fresh, 'refund_failed', { last_error_code: `REFUND_${String(read.value.status).replace(/[^A-Z]/g, '').slice(0, 20)}` });
      return true;
    });
  }
  return false;
}

async function pollPending(env, lastPoll) {
  const { db, clock } = env;
  const ops = db
    .prepare("SELECT id FROM payment_operations WHERE status IN ('authorization_pending','capture_pending','refund_pending') AND archived_at IS NULL ORDER BY id LIMIT ?")
    .all(BATCH);
  let moved = 0;
  for (const { id } of ops) {
    try {
      const op = loadOperation(db, id);
      if (!op || !env.payments) continue;
      // every tick for the first 5 minutes of a pending state, then every 5 minutes
      const since = Date.parse(op.pending_since ?? op.updated_at);
      const key = `${op.status}:${id}`;
      const last = lastPoll.get(key) ?? 0;
      if (clock.now() - since > POLL_EVERY_TICK_MS && clock.now() - last < POLL_EVERY_TICK_MS) continue;
      lastPoll.set(key, clock.now());
      if (await pollOne(env, op)) moved += 1;
    } catch (err) {
      env.log.error('reconcile.item_failed', { paymentOperationId: id, kind: 'poll', code: codeOf(err) });
    }
  }
  return moved;
}

// ------------------------------------------------------------------ step 5: takeover

function takeOverLapsedPlans(env, saga) {
  const { db, clock, config } = env;
  const nowIso = isoFromMs(clock.now());
  // F-TR-7: never while an operation is capture_pending or unknown; not while the next capture is backing off after a retryable answer
  const plans = db
    .prepare(
      "SELECT pv.id FROM plan_versions pv WHERE pv.status = 'executing' AND pv.lease_until IS NOT NULL AND pv.lease_until <= ? " +
        "AND NOT EXISTS (SELECT 1 FROM supplier_orders so JOIN payment_operations po ON po.supplier_order_id = so.id " +
        "WHERE so.plan_version_id = pv.id AND po.archived_at IS NULL AND po.status IN ('capture_pending','unknown')) " +
        "AND NOT EXISTS (SELECT 1 FROM supplier_orders so JOIN payment_operations po ON po.supplier_order_id = so.id " +
        "JOIN provider_calls pc ON pc.payment_operation_id = po.id WHERE so.plan_version_id = pv.id AND pc.kind = 'capture' " +
        "AND pc.status = 'intent' AND pc.started_at IS NULL AND pc.next_attempt_at > ?) ORDER BY pv.id LIMIT ?",
    )
    .all(nowIso, nowIso, BATCH);
  let taken = 0;
  for (const { id } of plans) {
    try {
      const epoch = db.tx(() => {
        const moved = db
          .prepare(
            "UPDATE plan_versions SET executor_id = ?, lease_epoch = lease_epoch + 1, lease_until = ?, updated_at = ? " +
              "WHERE id = ? AND status = 'executing' AND lease_until IS NOT NULL AND lease_until <= ?",
          )
          .run(saga.executorId, isoFromMs(clock.now() + config.sagaLeaseMs), nowIso, id, nowIso).changes;
        if (moved !== 1) return null;
        const row = db.prepare('SELECT lease_epoch FROM plan_versions WHERE id = ?').get(id);
        recordAudit(db, clock, {
          actorRole: 'system', action: 'saga.takeover', entityType: 'plan_version', entityId: id, outcome: 'ok', detail: { epoch: row.lease_epoch },
        });
        return row.lease_epoch;
      });
      if (epoch === null) continue;
      taken += 1;
      env.log.info('saga.takeover', { planVersionId: id, epoch, executorId: saga.executorId });
      saga.start(id, epoch);
    } catch (err) {
      env.log.error('reconcile.item_failed', { planVersionId: id, kind: 'takeover', code: codeOf(err) });
    }
  }
  return taken;
}

// ------------------------------------------------------------------ step 6: send what is queued

// Backstops for transitions the hooks cannot see (the webhook route moves operations without running the compensation hook), and
// the queued authorize of an operation whose cancellation was requested while the call was in flight (nothing is sent: void locally).
function backstops(env) {
  const { db, clock } = env;
  let fixed = 0;
  const guarded = (label, id, fn) => {
    try {
      if (db.tx(fn)) fixed += 1;
    } catch (err) {
      env.log.error('reconcile.item_failed', { paymentOperationId: id, kind: label, code: codeOf(err) });
    }
  };
  const cancelledAuthorizes = db
    .prepare(
      "SELECT pc.id AS call_id, po.id AS op_id FROM provider_calls pc JOIN payment_operations po ON po.id = pc.payment_operation_id " +
        "WHERE pc.kind = 'authorize' AND pc.status = 'intent' AND pc.started_at IS NULL AND pc.archived_at IS NULL AND po.status = 'approved' " +
        'AND po.cancel_requested_at IS NOT NULL AND po.archived_at IS NULL LIMIT ?',
    )
    .all(BATCH);
  for (const row of cancelledAuthorizes) {
    guarded('cancel_authorize', row.op_id, () => {
      const now = isoFromMs(clock.now());
      const cancelled = db.prepare("UPDATE provider_calls SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'intent' AND started_at IS NULL").run(now, row.call_id).changes;
      if (cancelled !== 1) return false;
      assertTransition('payment', 'approved', 'voided');
      return db.prepare("UPDATE payment_operations SET status = 'voided', voided_locally = 1, updated_at = ? WHERE id = ? AND status = 'approved'").run(now, row.op_id).changes === 1;
    });
  }
  const captured = db
    .prepare("SELECT id FROM payment_operations WHERE status = 'captured' AND cancel_requested_at IS NOT NULL AND archived_at IS NULL ORDER BY id LIMIT ?")
    .all(BATCH);
  for (const { id } of captured) guarded('refund_hook', id, () => queueRefundWhenCancelled(db, clock, id) !== null);
  const authorized = db
    .prepare(
      "SELECT po.id, po.supplier_order_id FROM payment_operations po WHERE po.status = 'authorized' AND po.cancel_requested_at IS NOT NULL AND po.archived_at IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM provider_calls pc WHERE pc.payment_operation_id = po.id AND pc.kind = 'void') ORDER BY po.id LIMIT ?",
    )
    .all(BATCH);
  for (const row of authorized) {
    guarded('void_hook', row.id, () => queueCall(db, clock, { operationId: row.id, supplierOrderId: row.supplier_order_id, kind: 'void', attempt: 1 }).inserted);
  }
  return fixed;
}

// ------------------------------------------------------------------ step 7: release check

function releaseCheck(env) {
  const { db } = env;
  const plans = db.prepare("SELECT plan_version_id FROM reservations WHERE status = 'reconciling' ORDER BY id LIMIT ?").all(BATCH);
  let released = 0;
  for (const { plan_version_id: planId } of plans) {
    try {
      if (releaseIfSettled(env, planId) === 'released') released += 1;
    } catch (err) {
      env.log.error('reconcile.item_failed', { planVersionId: planId, kind: 'release', code: codeOf(err) });
    }
  }
  return released;
}

// ------------------------------------------------------------------ step 8: the re-plan queue (F-TR-2)

// An entry is removed only in the transaction that stores the new planning run (runPlanningFor), or when the request is deleted or
// archived. A failed drain (offers_hash kept changing, DB_BUSY, no requirements, a plan in progress) leaves the entry with
// failed_drains + 1 and next_attempt_at = now + min(5 min, 15 s x 2^failed_drains) (failed_drains read before the increment).
export function drainReplanQueue(env, { limit = 5 } = {}) {
  const { db, clock } = env;
  const nowIso = isoFromMs(clock.now());
  const due = db
    .prepare(
      'SELECT rq.request_id, rq.failed_drains, rr.archived_at, rr.deleted_at FROM replan_queue rq JOIN rescue_requests rr ON rr.id = rq.request_id ' +
        'WHERE rq.next_attempt_at <= ? ORDER BY rq.next_attempt_at, rq.request_id LIMIT ?',
    )
    .all(nowIso, limit);
  const summary = { drained: 0, failed: 0, dropped: 0 };
  for (const entry of due) {
    if (entry.archived_at !== null || entry.deleted_at !== null) {
      db.tx(() => db.prepare('DELETE FROM replan_queue WHERE request_id = ?').run(entry.request_id));
      summary.dropped += 1;
      continue;
    }
    try {
      runPlanningFor(env, entry.request_id, null);
      summary.drained += 1;
    } catch (err) {
      summary.failed += 1;
      const code = codeOf(err);
      env.log.warn('replan.drain_failed', { code });
      db.tx(() =>
        db
          .prepare('UPDATE replan_queue SET failed_drains = failed_drains + 1, next_attempt_at = ?, last_error = ? WHERE request_id = ?')
          .run(isoFromMs(clock.now() + Math.min(REPLAN_BACKOFF_CAP_MS, REPLAN_BACKOFF_BASE_MS * 2 ** Math.min(entry.failed_drains, 20))), code, entry.request_id),
      );
    }
  }
  return summary;
}

// ------------------------------------------------------------------ step 9: housekeeping

export function housekeeping(env) {
  const { db, clock, config } = env;
  const now = clock.now();
  const nowIso = isoFromMs(now);
  const summary = { sessions: 0, loginFailures: 0, idempotencyKeys: 0, webhookRows: 0, staleSpend: 0 };
  const count = (r) => Number(r.changes);
  summary.sessions = count(db.tx(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(nowIso, isoFromMs(now - IDLE_MS))));
  summary.loginFailures = count(db.tx(() => db.prepare('DELETE FROM login_failures WHERE at < ?').run(isoFromMs(now - LOGIN_FAILURE_KEEP_MS))));
  summary.idempotencyKeys = count(db.tx(() => db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(isoFromMs(now - IDEMPOTENCY_KEEP_MS))));
  // SEC-6: rows for requests that never verified are junk after 7 days; valid rows are the dedupe record and stay
  summary.webhookRows = count(
    db.tx(() => db.prepare("DELETE FROM webhook_events WHERE signature_status IN ('invalid','unverified') AND received_at < ?").run(isoFromMs(now - WEBHOOK_ROW_KEEP_MS))),
  );
  // FU-22: a model call that crashed stays `reserved`; the same compare-and-set as the retention sweep settles it at its cap, so
  // whichever of the two runs first settles it and the other finds nothing.
  const gate = env.ai?.gate;
  if (gate && typeof gate.settleStale === 'function') summary.staleSpend = gate.settleStale({ olderThanMs: 2 * config.modelTimeoutMs });
  return summary;
}

// ------------------------------------------------------------------ the tick

/**
 * createReconciler(deps, { intervalMs, saga }) -> { tick(), start(), stop(), lastSummary, started }
 * `deps` is the app's live dependency object (db, clock, config, log, payments, voidRule, planner, ai, saga).
 */
export function createReconciler(deps, { intervalMs = deps.config.reconcileIntervalMs, saga = deps.saga } = {}) {
  if (!saga) throw new TypeError('createReconciler needs the saga (deps.saga)');
  const lastPoll = new Map();
  const handle = { lastSummary: null, started: null };
  let running = null;
  let timer = null;
  let stopped = false;

  async function run() {
    const startedAt = performance.now();
    const counts = {};
    const failed = [];
    const step = async (name, fn) => {
      try {
        counts[name] = await fn();
      } catch (err) {
        failed.push(name);
        deps.log.error('reconcile.step_failed', { kind: name, code: codeOf(err) });
      }
    };
    await step('stale', () => markStaleIntents(deps));
    await step('resolved', () => resolveUnknownCalls(deps));
    await step('polled', () => pollPending(deps, lastPoll));
    await step('expired', async () => {
      const result = expireDueReservations(deps);
      try {
        await flushQueuedVoids(deps, deps.voidRule?.provider);
      } catch {
        deps.log.error('provider.flush_failed', { code: 'FLUSH_FAILED' });
      }
      return result.expired.length;
    });
    await step('takenOver', () => takeOverLapsedPlans(deps, saga));
    await step('sent', async () => {
      backstops(deps);
      const sent = await sendDueCalls(deps);
      deps.voidRule?.provider?.takePending?.(); // the queued voids are sent (or backing off); the port's list starts over
      return sent.length;
    });
    await step('released', () => releaseCheck(deps));
    await step('replanned', () => drainReplanQueue(deps).drained);
    await step('housekeeping', () => {
      const h = housekeeping(deps);
      return h.sessions + h.loginFailures + h.idempotencyKeys + h.webhookRows + h.staleSpend;
    });
    const durationMs = Math.round(performance.now() - startedAt);
    try {
      deps.db.tx(() => {
        setMeta(deps.db, 'reconciler_last_tick_at', isoFromMs(deps.clock.now()));
        setMeta(deps.db, 'reconciler_last_tick_ms', String(durationMs));
      });
    } catch (err) {
      deps.log.error('reconcile.meta_failed', { code: codeOf(err) });
    }
    deps.log.info('reconcile.tick', { durationMs, counts: { ...counts, failed: failed.length } });
    handle.lastSummary = { ...counts, failed, durationMs };
    return handle.lastSummary;
  }

  // One tick at a time per reconciler; a call during a running tick joins it.
  handle.tick = () => {
    if (running) return running;
    running = run().finally(() => {
      running = null;
    });
    return running;
  };

  // Now (startup), then RS_RECONCILE_INTERVAL_MS after each tick finished. The timer never keeps the process alive.
  handle.start = () => {
    if (handle.started || stopped) return handle.started;
    const loop = async () => {
      try {
        await handle.tick();
      } catch (err) {
        deps.log.error('reconcile.failed', { code: codeOf(err) });
      }
      if (!stopped) {
        timer = setTimeout(loop, intervalMs);
        timer.unref?.();
      }
    };
    handle.started = loop();
    return handle.started;
  };

  handle.stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (running) await running.catch(() => {});
    if (handle.started) await handle.started.catch(() => {});
  };

  return handle;
}
