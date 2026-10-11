// The provider call protocol (spec: Background Processing > Provider call protocol; every mutating PayPal call).
//
//   1. queueCall      INSERT OR IGNORE INTO provider_calls, key so:<supplierOrderId>:<kind>:<attempt>, status intent,
//                     started_at NULL (= queued, provably never sent). Runs inside the caller's business transaction.
//   2. startCall      its own transaction: UPDATE ... SET send_token, started_at, send_count+1 WHERE status='intent' AND
//                     started_at IS NULL (re-send after resolution: WHERE status='unknown' AND send_token IS NULL).
//                     1 row = this process is the only sender, 0 rows = stop.
//   3. send           OUTSIDE any transaction, PayPal-Request-Id = operation_key, bounded by RS_PAYPAL_TIMEOUT_MS.
//   4. recordCall     its own transaction: UPDATE ... WHERE id = ? AND send_token = ? (0 rows = the call was taken over,
//                     the result is discarded and logged provider.result_fenced) plus the mapped operation transition:
//                       ok        -> succeeded + mapped transition
//                       rejected  -> failed + mapped transition
//                       retryable -> back to queued, next_attempt_at = now + 5 s / 30 s / 2 min / 5 min
//                       unknown   -> status unknown, send_token NULL, operation -> unknown (prev_status saved)
//
// Sender table (who sends a queued call):
//   create_order  the paypal/create handler, synchronously; after a crash or a retryable answer the buyer's next paypal/create
//                 call. The reconciler never sends it.
//   authorize     the return handler right after its commit; afterwards sendDueCalls (reconciler step 6) while the operation
//                 is `approved` and cancel_requested_at is NULL
//   void          the caller of the void rule right after commit (the app flushes the void port before it answers);
//                 afterwards sendDueCalls
//   refund        the compensation caller or the refund_order handler right after commit; afterwards sendDueCalls
//   capture       the saga lease holder only (e4); runCall takes a `guard` and a `fence` for the lease checks
//
// The mapped transitions below cover create_order, authorize, void and refund. Capture results are mapped by e4 with
// recordCall(env, { ..., apply, fence }).
import { randomBytes } from 'node:crypto';
import { isoFromMs } from '../clock.js';
import { assertTransition, TERMINAL_PAYMENT_STATES } from '../domain/states.js';
import { unknown as unknownOutcome } from '../payments/provider.js';
import { markNonExecutable } from './supersession.js';

export const BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 300_000]);
const DEFAULT_TIMEOUT_MS = 20_000;
const ISSUE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATION_COLUMNS = new Set([
  'provider_order_id', 'approval_url', 'provider_authorization_id', 'provider_capture_id', 'provider_refund_id',
  'authorization_expires_at', 'pending_since', 'last_error_code', 'prev_status', 'unknown_since', 'void_failed', 'create_attempt',
]);

export const operationKey = (supplierOrderId, kind, attempt) => `so:${supplierOrderId}:${kind}:${attempt}`;
export const backoffMs = (sendCount) => BACKOFF_MS[Math.min(Math.max(Number(sendCount) || 1, 1), BACKOFF_MS.length) - 1];
const safeCode = (value, fallback) => (typeof value === 'string' && ISSUE.test(value) ? value : fallback);
const resourceId = (value) => {
  const id = value?.orderId ?? value?.authorizationId ?? value?.captureId ?? value?.refundId ?? null;
  return typeof id === 'string' && id.length <= 64 ? id : null;
};

const OP_SELECT =
  'SELECT po.*, so.total_cents AS order_total_cents, so.plan_version_id, so.fulfilment_status, s.code AS supplier_code ' +
  'FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN suppliers s ON s.id = so.supplier_id ';

export function loadOperation(db, operationId) {
  return db.prepare(`${OP_SELECT} WHERE po.id = ?`).get(operationId) ?? null;
}

// ------------------------------------------------------------------ operation transitions

// Compare-and-set on the status. `set` names columns from OPERATION_COLUMNS only (never input). Returns true when the row moved.
export function moveOperation(db, clock, op, to, set = {}) {
  assertTransition('payment', op.status, to);
  const names = Object.keys(set);
  for (const name of names) if (!OPERATION_COLUMNS.has(name)) throw new TypeError(`unknown operation column ${name}`);
  const assignments = ['status = ?', ...names.map((n) => `${n} = ?`), 'updated_at = ?'].join(', ');
  const moved = db
    .prepare(`UPDATE payment_operations SET ${assignments} WHERE id = ? AND status = ?`)
    .run(to, ...names.map((n) => set[n] ?? null), isoFromMs(clock.now()), op.id, op.status).changes;
  return moved === 1;
}

// op -> unknown with prev_status saved. Only from the state the call belongs to.
function operationToUnknown(db, clock, op, expectedFrom) {
  if (op.status !== expectedFrom) return false;
  return moveOperation(db, clock, op, 'unknown', { prev_status: op.status, unknown_since: isoFromMs(clock.now()) });
}

// unknown -> the state it had before (the provider showed no effect). Exported for the reconciler's resolution (e4).
export function restoreFromUnknown(db, clock, op) {
  if (op.status !== 'unknown' || !op.prev_status) return false;
  return moveOperation(db, clock, op, op.prev_status, { unknown_since: null });
}

// ------------------------------------------------------------------ 1. queue

// Inside the caller's transaction. { call, inserted }: inserted false = the call already existed (exactly-once by UNIQUE).
export function queueCall(db, clock, { operationId, supplierOrderId, kind, attempt = 1, requestId = null }) {
  const key = operationKey(supplierOrderId, kind, attempt);
  const now = isoFromMs(clock.now());
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, send_count, started_at, next_attempt_at, request_id, created_at) " +
        "VALUES (?, ?, ?, ?, 'intent', 0, NULL, ?, ?, ?)",
    )
    .run(operationId, kind, attempt, key, now, typeof requestId === 'string' && requestId.length <= 64 ? requestId : null, now);
  const call = db.prepare('SELECT * FROM provider_calls WHERE operation_key = ?').get(key);
  return { call, inserted: result.changes === 1 };
}

// The provider PORT of the void rule (src/services/void-rule.js): queueVoid inserts the provider_calls row, sends nothing and
// opens no transaction. `queued` remembers the newest intents (a test can see them); `pending` holds the keys the app must
// send after the request that queued them (takePending).
export function createVoidPort({ clock }) {
  const queued = [];
  const pending = new Set();
  return {
    name: 'provider_calls',
    queued,
    pending,
    queueVoid(db, intent) {
      queueCall(db, clock, { operationId: intent.operationId, supplierOrderId: intent.supplierOrderId, kind: 'void', attempt: intent.attempt ?? 1 });
      queued.push(intent);
      if (queued.length > 1000) queued.shift();
      pending.add(intent.operationKey);
    },
    takePending() {
      const keys = [...pending];
      pending.clear();
      return keys;
    },
  };
}

// ------------------------------------------------------------------ 2. start

// opts.guard(db, call, op) runs inside the start transaction (capture: the lease check); false = do not start.
// opts.resendUnknown: the caller already resolved the call, so an `unknown` call may be sent again with the same key; an
// operation in `unknown` goes back to prev_status first.
// Returns { token, call, op } or null (somebody else sends, or the call is no longer sendable).
export function startCall(db, clock, callId, { guard = null, resendUnknown = false } = {}) {
  const token = randomBytes(16).toString('hex');
  return db.tx(() => {
    const now = isoFromMs(clock.now());
    const call = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(callId);
    if (!call || call.archived_at !== null) return null;
    let op = loadOperation(db, call.payment_operation_id);
    if (!op || op.archived_at !== null) return null;
    if (guard && guard(db, call, op) === false) return null;
    let moved = db
      .prepare("UPDATE provider_calls SET send_token = ?, started_at = ?, send_count = send_count + 1 WHERE id = ? AND status = 'intent' AND started_at IS NULL")
      .run(token, now, callId).changes;
    let resent = false;
    if (moved === 0 && resendUnknown) {
      moved = db
        .prepare("UPDATE provider_calls SET status = 'intent', send_token = ?, started_at = ?, send_count = send_count + 1 WHERE id = ? AND status = 'unknown' AND send_token IS NULL")
        .run(token, now, callId).changes;
      resent = moved === 1;
    }
    if (moved !== 1) return null;
    if (resent && op.status === 'unknown') restoreFromUnknown(db, clock, op);
    // refund: "refund call sent" puts the operation in refund_pending
    if (call.kind === 'refund' && op.status === 'refund_requested') moveOperation(db, clock, op, 'refund_pending');
    op = loadOperation(db, call.payment_operation_id);
    return { token, call: { ...call, send_count: call.send_count + 1, started_at: now }, op };
  });
}

// ------------------------------------------------------------------ 4. record

// apply({ db, clock, env, call, op, outcome, now }) maps the result onto the operation inside the record transaction and may
// return a follow-up object for the caller to run after the commit. fence(db, call) false = treat as taken over (captures).
export function recordCall(env, { callId, token, outcome, apply = null, fence = null }) {
  const { db, clock, log } = env;
  const result = db.tx(() => {
    const now = isoFromMs(clock.now());
    const call = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(callId);
    const httpStatus = Number.isInteger(outcome.httpStatus) ? outcome.httpStatus : null;
    const providerStatus = typeof outcome.value?.status === 'string' ? outcome.value.status.slice(0, 40) : null;
    const errorCode = outcome.kind === 'unknown' ? safeCode(String(outcome.reason ?? '').toUpperCase(), 'UNKNOWN') : safeCode(outcome.issue, null);
    let changes = 0;
    if (call && call.send_token === token && (!fence || fence(db, call))) {
      const where = "WHERE id = ? AND send_token = ? AND status = 'intent'";
      if (outcome.kind === 'ok' || outcome.kind === 'rejected') {
        changes = db
          .prepare(
            `UPDATE provider_calls SET status = ?, http_status = ?, provider_status = ?, provider_resource_id = ?, error_code = ?, finished_at = ? ${where}`,
          )
          .run(outcome.kind === 'ok' ? 'succeeded' : 'failed', httpStatus, providerStatus, resourceId(outcome.value), errorCode, now, callId, token).changes;
      } else if (outcome.kind === 'retryable') {
        changes = db
          .prepare(
            `UPDATE provider_calls SET status = 'intent', started_at = NULL, send_token = NULL, next_attempt_at = ?, http_status = ?, error_code = ? ${where}`,
          )
          .run(isoFromMs(clock.now() + backoffMs(call.send_count)), httpStatus, errorCode, callId, token).changes;
      } else {
        changes = db
          .prepare(`UPDATE provider_calls SET status = 'unknown', send_token = NULL, unknown_since = ?, error_code = ? ${where}`)
          .run(now, errorCode, callId, token).changes;
      }
    }
    if (changes !== 1) return { fenced: true };
    const op = loadOperation(db, call.payment_operation_id);
    const followUp = apply ? apply({ db, clock, env, call, op, outcome, now }) ?? null : null;
    return { fenced: false, followUp };
  });
  if (result.fenced) {
    log.warn('provider.result_fenced', { providerCallId: callId, code: 'RESULT_FENCED' });
  }
  return result;
}

// ------------------------------------------------------------------ mapped transitions

function resolutionHook(env, db, operationId) {
  const rule = env.voidRule;
  if (rule && typeof rule.onAuthorized === 'function') return rule.onAuthorized(db, { operationId, requestId: env.requestId ?? null });
  return null;
}

function failAuthorization(t, code) {
  const { db, clock, env, op } = t;
  if (!moveOperation(db, clock, op, 'authorization_failed', { last_error_code: code })) return null;
  // The void rule fires for the plan (AUTHORIZATION_FAILED, detail.supplierCode); other authorizations get a void queued.
  markNonExecutable(env, {
    planVersionId: op.plan_version_id, reason: 'AUTHORIZATION_FAILED', detail: { supplierCode: op.supplier_code }, actor: null, requestId: env.requestId ?? null,
  });
  return { planFailed: true };
}

const APPLY = {
  create_order({ db, clock, op, outcome }) {
    if (outcome.kind === 'ok') {
      // Only a still-`created` operation takes the order (the void rule may have voided it while the call was in flight).
      if (op.status === 'created') {
        db.prepare('UPDATE payment_operations SET provider_order_id = ?, approval_url = ?, last_error_code = NULL, updated_at = ? WHERE id = ? AND status = ?')
          .run(outcome.value.orderId, outcome.value.approvalUrl, isoFromMs(clock.now()), op.id, 'created');
      }
    } else if (outcome.kind === 'rejected' || outcome.kind === 'retryable') {
      db.prepare('UPDATE payment_operations SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = ?').run(
        safeCode(outcome.issue, 'PROVIDER_ERROR'), isoFromMs(clock.now()), op.id, 'created',
      );
    }
    // unknown: the payment machine has no created -> unknown edge; the call row alone is `unknown` and the buyer's next
    // paypal/create call sends it again with the same key.
    return null;
  },

  authorize(t) {
    const { db, clock, env, op, outcome, now } = t;
    if (op.status !== 'approved') return null;
    if (outcome.kind === 'ok') {
      const value = outcome.value;
      if (value.status === 'CREATED') {
        if (!moveOperation(db, clock, op, 'authorized', {
          provider_authorization_id: value.authorizationId, authorization_expires_at: value.expirationTime ?? null, last_error_code: null,
        })) return null;
        // Resolution hook: a cancellation requested while the authorize was in flight queues the void now.
        const intent = resolutionHook(env, db, op.id);
        return intent ? { voidQueued: true } : null;
      }
      if (value.status === 'PENDING') {
        moveOperation(db, clock, op, 'authorization_pending', {
          provider_authorization_id: value.authorizationId, authorization_expires_at: value.expirationTime ?? null, pending_since: now, last_error_code: null,
        });
        return null;
      }
      return failAuthorization(t, 'AUTHORIZATION_DENIED');
    }
    if (outcome.kind === 'rejected') return failAuthorization(t, safeCode(outcome.issue, 'AUTHORIZATION_REJECTED'));
    if (outcome.kind === 'retryable') {
      db.prepare('UPDATE payment_operations SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = ?').run(safeCode(outcome.issue, 'PROVIDER_RETRY'), now, op.id, 'approved');
      return null;
    }
    operationToUnknown(db, clock, op, 'approved');
    return null;
  },

  void(t) {
    const { db, clock, op, outcome, now } = t;
    if (outcome.kind === 'ok') {
      if (op.status === 'authorized' || op.status === 'unknown') moveOperation(db, clock, op, 'voided', { last_error_code: null });
      return null;
    }
    if (outcome.kind === 'rejected') return { resolveVoid: true };
    if (outcome.kind === 'retryable') {
      db.prepare('UPDATE payment_operations SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = ?').run(safeCode(outcome.issue, 'PROVIDER_RETRY'), now, op.id, 'authorized');
      return null;
    }
    operationToUnknown(db, clock, op, 'authorized');
    return null;
  },

  refund(t) {
    const { db, clock, op, outcome, now } = t;
    if (outcome.kind === 'ok') {
      const set = { provider_refund_id: outcome.value.refundId ?? null };
      if (outcome.value.status === 'COMPLETED' && (op.status === 'refund_pending' || op.status === 'unknown')) moveOperation(db, clock, op, 'refunded', set);
      else if (outcome.value.status === 'PENDING' && op.status === 'refund_pending') {
        db.prepare('UPDATE payment_operations SET provider_refund_id = ?, updated_at = ? WHERE id = ?').run(set.provider_refund_id, now, op.id);
      } else if ((outcome.value.status === 'FAILED' || outcome.value.status === 'CANCELLED') && (op.status === 'refund_pending' || op.status === 'unknown')) {
        moveOperation(db, clock, op, 'refund_failed', { ...set, last_error_code: `REFUND_${outcome.value.status}` });
      }
      return null;
    }
    if (outcome.kind === 'rejected') {
      if (op.status === 'refund_pending') moveOperation(db, clock, op, 'refund_failed', { last_error_code: safeCode(outcome.issue, 'REFUND_REJECTED') });
      return null;
    }
    if (outcome.kind === 'retryable') return null;
    operationToUnknown(db, clock, op, 'refund_pending');
    return null;
  },
};

// ------------------------------------------------------------------ 3. send (outside any transaction)

// What each kind needs to be sendable, evaluated inside the start transaction on the fresh operation row.
const GUARDS = {
  create_order: (db, call, op) => op.status === 'created',
  authorize: (db, call, op) => op.status === 'approved' && typeof op.provider_order_id === 'string',
  void: (db, call, op) => op.status === 'authorized' && typeof op.provider_authorization_id === 'string',
  refund: (db, call, op) => (op.status === 'refund_requested' || op.status === 'refund_pending') && typeof op.provider_capture_id === 'string',
};

const SENDERS = {
  create_order: (env, op, call) =>
    env.payments.createOrder({
      merchantKey: op.merchant_key, requestId: call.operation_key,
      amountCents: op.order_total_cents, // always supplier_orders.total_cents, never anything the client sent
      currency: 'USD', referenceId: `so-${op.supplier_order_id}`, attempt: call.attempt,
      returnUrl: `${env.publicUrl()}/api/paypal/return`, cancelUrl: `${env.publicUrl()}/api/paypal/cancel`,
    }),
  authorize: (env, op, call) => env.payments.authorizeOrder({ merchantKey: op.merchant_key, requestId: call.operation_key, orderId: op.provider_order_id }),
  void: (env, op, call) => env.payments.voidAuthorization({ merchantKey: op.merchant_key, requestId: call.operation_key, authorizationId: op.provider_authorization_id }),
  refund: (env, op, call) =>
    env.payments.refundCapture({ merchantKey: op.merchant_key, requestId: call.operation_key, captureId: op.provider_capture_id, amountCents: op.amount_cents, currency: op.currency }),
};

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(unknownOutcome('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Cancels a queued call whose operation can no longer use it (a void for an operation that is already voided, ...).
function cancelObsolete(db, clock, call) {
  db.tx(() => {
    db.prepare("UPDATE provider_calls SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'intent' AND started_at IS NULL").run(isoFromMs(clock.now()), call.id);
  });
}

// Runs the protocol for one call of create_order, authorize, void or refund.
//   env: { db, clock, config, log, payments, voidRule, publicUrl, requestId? }
// -> { state: 'not_started' | 'no_provider' | 'provider_mismatch' | 'unsupported' | 'missing' | 'fenced' | 'recorded', outcome?, call? }
export async function runCall(env, callId, { resendUnknown = false } = {}) {
  const { db, clock, log, payments } = env;
  const call = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(callId);
  if (!call) return { state: 'missing' };
  const send = SENDERS[call.kind];
  if (!send) return { state: 'unsupported' };
  if (!payments) return { state: 'no_provider' };
  const op = loadOperation(db, call.payment_operation_id);
  if (!op) return { state: 'missing' };
  if (op.provider !== payments.id) {
    log.warn('provider.mismatch', { providerCallId: callId, provider: op.provider, code: 'PROVIDER_MISMATCH' });
    return { state: 'provider_mismatch' };
  }
  // A void or refund the operation no longer needs is cancelled instead of sent.
  if ((call.kind === 'void' || call.kind === 'authorize') && call.status === 'intent' && call.started_at === null) {
    if (TERMINAL_PAYMENT_STATES.includes(op.status) || op.status === 'captured') cancelObsolete(db, clock, call);
  }
  const started = startCall(db, clock, callId, { guard: GUARDS[call.kind], resendUnknown });
  if (!started) return { state: 'not_started' };

  let outcome;
  try {
    outcome = await withDeadline(send(env, started.op, started.call), (env.config?.paypalTimeoutMs ?? DEFAULT_TIMEOUT_MS) + 1000);
  } catch {
    log.error('provider.send_threw', { providerCallId: callId, kind: call.kind, code: 'SEND_THREW' });
    outcome = unknownOutcome('network');
  }
  if (!outcome || typeof outcome.kind !== 'string') outcome = unknownOutcome('bad_body');
  log.info('provider.call', {
    providerCallId: callId, paymentOperationId: op.id, operationKey: call.operation_key, kind: call.kind, attempt: call.attempt,
    code: outcome.kind, httpStatus: outcome.httpStatus,
  });
  const recorded = recordCall(env, { callId, token: started.token, outcome, apply: (t) => APPLY[call.kind](t) });
  if (recorded.fenced) return { state: 'fenced', outcome, call: started.call };
  if (recorded.followUp?.resolveVoid) {
    try {
      await resolveRejectedVoid(env, op.id);
    } catch {
      log.error('provider.void_resolution_failed', { paymentOperationId: op.id, code: 'VOID_RESOLUTION_FAILED' });
    }
  }
  return { state: 'recorded', outcome, call: started.call, followUp: recorded.followUp };
}

// ------------------------------------------------------------------ void results: rejected -> read the authorization

// A void the provider rejected: read the authorization and settle the operation (spec: Void rule step 6, F-TR-6).
//   VOIDED                        -> voided
//   CAPTURED / PARTIALLY_CAPTURED -> captured (capture id via getOrder); because a cancellation was requested the operation goes
//                                    on to refund_requested and so:<id>:refund:1 is queued and sent
//   anything else (or a failed read) -> stays authorized with void_failed = 1 (derivation row 2)
export async function resolveRejectedVoid(env, operationId) {
  const { db, clock, payments } = env;
  const op = loadOperation(db, operationId);
  if (!op || op.status !== 'authorized' || !op.provider_authorization_id) return { state: 'noop' };
  let decision = 'void_failed';
  let capture = null;
  const read = await payments.getAuthorization({ merchantKey: op.merchant_key, authorizationId: op.provider_authorization_id });
  if (read.kind === 'ok') {
    const status = read.value.status;
    if (status === 'VOIDED') decision = 'voided';
    else if (status === 'CAPTURED' || status === 'PARTIALLY_CAPTURED') {
      const order = await payments.getOrder({ merchantKey: op.merchant_key, orderId: op.provider_order_id });
      if (order.kind === 'ok') {
        capture = (order.value.captures ?? []).find((c) => c.authorizationId === op.provider_authorization_id && (c.status === 'COMPLETED' || c.status === 'PENDING')) ?? null;
      }
      decision = capture ? 'captured' : 'void_failed';
    }
  }
  const refundCall = db.tx(() => {
    const fresh = loadOperation(db, operationId);
    if (!fresh || fresh.status !== 'authorized') return null;
    if (decision === 'voided') {
      moveOperation(db, clock, fresh, 'voided', { last_error_code: null });
      return null;
    }
    if (decision === 'captured') {
      if (capture.status === 'PENDING') {
        moveOperation(db, clock, fresh, 'capture_pending', { provider_capture_id: capture.id, pending_since: isoFromMs(clock.now()) });
        return null;
      }
      if (!moveOperation(db, clock, fresh, 'captured', { provider_capture_id: capture.id })) return null;
      // Compensation hook: the cancellation was requested, so the captured money goes back.
      const captured = loadOperation(db, operationId);
      if (captured.cancel_requested_at === null) return null;
      moveOperation(db, clock, captured, 'refund_requested');
      return queueCall(db, clock, { operationId, supplierOrderId: fresh.supplier_order_id, kind: 'refund', attempt: 1 }).call.id;
    }
    db.prepare('UPDATE payment_operations SET void_failed = 1, last_error_code = ?, updated_at = ? WHERE id = ? AND status = ?').run(
      'VOID_REJECTED', isoFromMs(clock.now()), operationId, 'authorized',
    );
    return null;
  });
  if (refundCall !== null) await runCall(env, refundCall);
  return { state: decision };
}

// ------------------------------------------------------------------ queued calls: who sends them later

// Ids of queued calls that are due: intent, never started, back-off over. An authorize is sent only while its operation is
// `approved` and nobody asked for its cancellation (the void rule voids it locally instead).
export function dueCallIds(db, clock, { kinds = ['authorize', 'void', 'refund'], limit = 50 } = {}) {
  const wanted = kinds.filter((k) => k === 'authorize' || k === 'void' || k === 'refund' || k === 'create_order');
  if (wanted.length === 0) return [];
  const rows = db
    .prepare(
      'SELECT pc.id FROM provider_calls pc JOIN payment_operations po ON po.id = pc.payment_operation_id ' +
        "WHERE pc.status = 'intent' AND pc.started_at IS NULL AND pc.archived_at IS NULL AND po.archived_at IS NULL " +
        `AND pc.kind IN (${wanted.map(() => '?').join(',')}) AND (pc.next_attempt_at IS NULL OR pc.next_attempt_at <= ?) ` +
        "AND (pc.kind <> 'authorize' OR (po.status = 'approved' AND po.cancel_requested_at IS NULL)) ORDER BY pc.id LIMIT ?",
    )
    .all(...wanted, isoFromMs(clock.now()), limit);
  return rows.map((r) => r.id);
}

// Reconciler step 6 (e4): sends the queued authorize, void and refund calls that are due. create_order is never sent here.
export async function sendDueCalls(env, opts = {}) {
  const sent = [];
  for (const id of dueCallIds(env.db, env.clock, opts)) {
    try {
      sent.push({ id, ...(await runCall(env, id)) });
    } catch (err) {
      env.log.error('provider.send_due_failed', { providerCallId: id, code: err?.code ? String(err.code).slice(0, 40) : 'SEND_FAILED' });
    }
  }
  return sent;
}

// "After commit, the caller tries to send queued voids at once": the keys the void port collected while a request ran.
export async function flushQueuedVoids(env, port) {
  if (!port || typeof port.takePending !== 'function' || port.pending.size === 0) return [];
  const sent = [];
  for (const key of port.takePending()) {
    const row = env.db.prepare("SELECT id FROM provider_calls WHERE operation_key = ? AND status = 'intent' AND started_at IS NULL").get(key);
    if (!row) continue;
    try {
      sent.push({ key, ...(await runCall(env, row.id)) });
    } catch (err) {
      env.log.error('provider.flush_failed', { operationKey: key, code: err?.code ? String(err.code).slice(0, 40) : 'FLUSH_FAILED' });
    }
  }
  return sent;
}
