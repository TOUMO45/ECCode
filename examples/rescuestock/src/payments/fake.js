// The DB-backed FAKE payment adapter (RS_PAYMENT_PROVIDER=fake; spec: 005_fake_paypal.sql, Admin routes > fake_paypal faults,
// Fake approval listener). Everything it returns is labelled simulated: it is a SIMULATION, not PayPal.
//
// State lives in the fake_paypal_* tables, so every process of the app (and a restarted one) sees the same orders,
// authorizations, captures and refunds. Each provider call is ONE `BEGIN IMMEDIATE` transaction that
//   1. takes the armed fault, if any, from fault_flags (rows `fake_paypal:<fault>`, value = supplier code or '', remaining =
//      count or NULL),
//   2. replays or applies the effect, and
//   3. writes one fake_paypal_calls row (reads included; replayed = 1 for a replay),
// so two processes can never both apply a capture and the call counts are exact (RS-20, ARCH-26, F-TR-8).
//
// Semantics (spec "Fake semantics"):
//   - a mutating call whose (merchant_key, request_id) was seen returns the stored answer, replayed = 1, applying nothing. Only
//     `ok` answers are stored (a rejected call applied nothing); the same request id on another kind is 422
//     REQUEST_ID_KIND_MISMATCH;
//   - a capture on an authorization already CAPTURED is 422 AUTHORIZATION_ALREADY_CAPTURED, a refund on a fully refunded capture
//     422 CAPTURE_FULLY_REFUNDED;
//   - an authorization expires 29 days after it was created (the injected clock), at once with the fault `auth_expire`.
//
// Faults (all consumed per call that they affect):
//   authorize_denied | authorize_pending | auth_expire            authorizeOrder
//   capture_declined | capture_pending                            captureAuthorization
//   refund_pending | refund_failed                                refundCapture
//   void_fail                                                     voidAuthorization (422 AUTHORIZATION_CANNOT_BE_VOIDED)
//   order_not_approvable                                          createOrder: the order can never be approved (409 page)
//   lost_response:<kind> | timeout:<kind> | http_500:<kind>       any call kind; also http_<4xx|5xx>:<kind> and bad_body:<kind>
//        timeout / http_*  nothing applied            lost_response / bad_body  the effect IS applied (and stored for replay)
//   RS_TEST_HOOKS only (ignored unless `testHooks`): freeze_after_capture_apply, freeze_before_capture_apply (the process sends
//        itself SIGSTOP), capture_lands_after_void_intent (the void finds the authorization captured), crash_after_return_commit
//        (consumed by the return handler through takeFakePaypalFault).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isoFromMs, systemClock } from '../clock.js';
import { isBusyError } from '../db/errors.js';
import { getOrCreateMeta } from '../db/meta.js';
import { silentLogger } from '../log.js';
import {
  CALL_KINDS, MUTATING_KINDS, checkArguments, ok, rejected, retryable, unknown, webhookInput,
} from './provider.js';

export const FAKE_PROVIDER_ID = 'fake';
export const AUTHORIZATION_TTL_MS = 29 * 24 * 60 * 60 * 1000;
export const APPROVAL_PATH_PREFIX = '/fake-paypal/checkout/';
export const FAKE_ORDER_ID = /^FAKE-[0-9a-f]{32}$/;
export const FAKE_PAYER_ID = 'FAKEPAYER';
export const FAULT_PREFIX = 'fake_paypal:';

// ---- fault vocabulary ---------------------------------------------------------------------------------------------------

const SCENARIO_FAULTS = Object.freeze({
  authorize_denied: 'authorize', authorize_pending: 'authorize', auth_expire: 'authorize',
  capture_declined: 'capture', capture_pending: 'capture',
  refund_pending: 'refund', refund_failed: 'refund',
  void_fail: 'void', order_not_approvable: 'create_order',
});
const HOOK_FAULTS = Object.freeze({
  freeze_after_capture_apply: 'capture', freeze_before_capture_apply: 'capture',
  capture_lands_after_void_intent: 'void', crash_after_return_commit: 'return',
});
export const FAKE_SCENARIO_FAULTS = Object.freeze(Object.keys(SCENARIO_FAULTS));
export const FAKE_HOOK_FAULTS = Object.freeze(Object.keys(HOOK_FAULTS));

// A fault name -> { name, family, kind?, type?, status? } or null when the fake cannot inject it.
export function parseFakeFault(name) {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(SCENARIO_FAULTS, name)) return { name, family: 'scenario', kind: SCENARIO_FAULTS[name] };
  if (Object.hasOwn(HOOK_FAULTS, name)) return { name, family: 'hook', kind: HOOK_FAULTS[name] };
  let m = /^(lost_response|timeout|bad_body):([a-z_]+)$/.exec(name);
  if (m && CALL_KINDS.includes(m[2])) return { name, family: 'transport', type: m[1] === 'lost_response' ? 'lost' : m[1], kind: m[2] };
  m = /^http_([45]\d\d):([a-z_]+)$/.exec(name);
  if (m && CALL_KINDS.includes(m[2])) return { name, family: 'transport', type: 'http', status: Number(m[1]), kind: m[2] };
  return null;
}

// Consumes the first armed fault accepted by `accept(parsed)` for this merchant. Must run where a write is allowed; runs its
// own transaction unless the caller is inside one. `testHooks` false hides the test-only faults.
function takeFlag(db, merchantKey, testHooks, accept) {
  const body = () => {
    const rows = db.prepare("SELECT name, value, remaining FROM fault_flags WHERE name GLOB 'fake_paypal:*' ORDER BY created_at, name").all();
    for (const row of rows) {
      if (row.remaining !== null && row.remaining <= 0) {
        db.prepare('DELETE FROM fault_flags WHERE name = ?').run(row.name);
        continue;
      }
      const parsed = parseFakeFault(row.name.slice(FAULT_PREFIX.length));
      if (!parsed || (parsed.family === 'hook' && !testHooks) || !accept(parsed)) continue;
      if (row.value !== '' && row.value !== merchantKey) continue;
      if (row.remaining !== null) {
        if (row.remaining <= 1) db.prepare('DELETE FROM fault_flags WHERE name = ?').run(row.name);
        else db.prepare('UPDATE fault_flags SET remaining = remaining - 1 WHERE name = ?').run(row.name);
      }
      return parsed;
    }
    return null;
  };
  return db.inTx ? body() : db.tx(body);
}

// For other modules (the return handler's crash hook): consume the named fault once, or return false.
export function takeFakePaypalFault(db, name, { merchantKey = '', testHooks = false } = {}) {
  return takeFlag(db, merchantKey, testHooks, (p) => p.name === name) !== null;
}

// ---- webhook signature (the scheme of test/helpers/webhook-signer.js; production code cannot import test helpers) --------------
//   signingString = `${transmissionId}|${transmissionTime}|${sha256hex(rawBody)}`, signature = base64(HMAC-SHA256(secret, signingString))
export function fakeWebhookSignature(secret, { transmissionId, transmissionTime, rawBody }) {
  const digest = createHash('sha256').update(rawBody).digest('hex');
  return createHmac('sha256', secret).update(`${transmissionId}|${transmissionTime}|${digest}`).digest('base64');
}

function signatureMatches(secret, parts, given) {
  if (typeof given !== 'string' || given === '') return false;
  const expected = Buffer.from(fakeWebhookSignature(secret, parts));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- the approval step (shared with the listener) ---------------------------------------------------------------------------

export function loadFakeOrder(db, orderId) {
  if (typeof orderId !== 'string' || !FAKE_ORDER_ID.test(orderId)) return null;
  return db.prepare('SELECT * FROM fake_paypal_orders WHERE id = ?').get(orderId) ?? null;
}

// CREATED -> APPROVED (compare-and-set). { result: 'approved'|'already_approved'|'not_approvable'|'invalid_state'|'not_found', order }
export function approveFakeOrder(db, orderId) {
  return db.tx(() => {
    const moved = typeof orderId === 'string' && FAKE_ORDER_ID.test(orderId)
      ? db.prepare("UPDATE fake_paypal_orders SET status = 'APPROVED' WHERE id = ? AND status = 'CREATED' AND approvable = 1").run(orderId).changes
      : 0;
    const order = loadFakeOrder(db, orderId);
    if (!order) return { result: 'not_found', order: null };
    if (moved === 1) return { result: 'approved', order };
    if (order.status === 'APPROVED') return { result: 'already_approved', order };
    if (order.status === 'CREATED' && order.approvable !== 1) return { result: 'not_approvable', order };
    return { result: 'invalid_state', order };
  });
}

// ---- the adapter -----------------------------------------------------------------------------------------------------------

const httpFaultOutcome = (status) => {
  if (status === 401) return retryable(401, 'AUTHENTICATION_FAILURE');
  if (status === 403) return retryable(403, 'PERMISSION_DENIED');
  if (status === 429) return retryable(429, 'RATE_LIMIT_REACHED');
  if (status >= 500) return unknown('http_5xx');
  const issues = { 400: 'INJECTED_BAD_REQUEST', 404: 'INVALID_RESOURCE_ID', 409: 'INJECTED_CONFLICT', 422: 'INJECTED_UNPROCESSABLE' };
  return rejected(status, issues[status] ?? 'INJECTED_ERROR');
};
const notFound = () => rejected(404, 'INVALID_RESOURCE_ID');
const refuse = (issue) => rejected(422, issue);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// The test-only freeze: the whole process stops until another process sends SIGCONT. POSIX only.
function sigstopSelf() {
  process.kill(process.pid, 'SIGSTOP');
  sleepSync(100); // the signal may be delivered to another thread a moment later; do not run on in the meantime
}

const AUTH_REFUSALS = Object.freeze({
  CAPTURED: 'AUTHORIZATION_ALREADY_CAPTURED', VOIDED: 'AUTHORIZATION_VOIDED', EXPIRED: 'AUTHORIZATION_EXPIRED',
  PENDING: 'AUTHORIZATION_PENDING', DENIED: 'AUTHORIZATION_DENIED',
});

// createFakeProvider({ db, clock, log, testHooks, webhookSecret, approvalOrigin, pid, freeze })
//   webhookSecret    string | Secret | () => string. When absent the key stored once in `meta` (SEC-5) is used, created if missing.
//   approvalOrigin   string | () => string: the origin of the approval listener, for the approvalUrl of createOrder.
export function createFakeProvider({
  db, clock = systemClock, log = silentLogger(), testHooks = false, webhookSecret, approvalOrigin, pid = process.pid, freeze = sigstopSelf,
} = {}) {
  if (!db || typeof db.tx !== 'function') throw new TypeError('createFakeProvider needs the database');
  if (approvalOrigin === undefined) throw new TypeError('createFakeProvider needs the approval listener origin');
  const hooks = testHooks === true;
  let secretCache = null;
  const secret = () => {
    if (secretCache) return secretCache;
    const given = typeof webhookSecret === 'function' ? webhookSecret() : webhookSecret;
    const text = given && typeof given.reveal === 'function' ? given.reveal() : given;
    secretCache = typeof text === 'string' && text !== '' ? text : getOrCreateMeta(db, 'fake_webhook_secret');
    return secretCache;
  };
  const origin = () => String(typeof approvalOrigin === 'function' ? approvalOrigin() : approvalOrigin).replace(/\/+$/, '');
  const hex = (bytes) => randomBytes(bytes).toString('hex');
  const labelled = (value, httpStatus) => ok({ ...value, provider: FAKE_PROVIDER_ID, simulated: true }, httpStatus);

  // ---- lookups, always scoped to the merchant through the order ------------------------------------------------------
  const loadOrder = (id, mk) => db.prepare('SELECT * FROM fake_paypal_orders WHERE id = ? AND merchant_key = ?').get(id, mk) ?? null;
  function settleExpiry(row, nowMs) {
    if (row && row.status === 'CREATED' && nowMs >= Date.parse(row.expiration_time)) {
      db.prepare("UPDATE fake_paypal_authorizations SET status = 'EXPIRED' WHERE id = ? AND status = 'CREATED'").run(row.id);
      return { ...row, status: 'EXPIRED' };
    }
    return row;
  }
  function loadAuthorization(id, mk, nowMs) {
    const row = db.prepare(
      'SELECT a.* FROM fake_paypal_authorizations a JOIN fake_paypal_orders o ON o.id = a.order_id WHERE a.id = ? AND o.merchant_key = ?',
    ).get(id, mk);
    return settleExpiry(row ?? null, nowMs);
  }
  const loadCapture = (id, mk) => db.prepare(
    'SELECT c.* FROM fake_paypal_captures c JOIN fake_paypal_authorizations a ON a.id = c.authorization_id ' +
      'JOIN fake_paypal_orders o ON o.id = a.order_id WHERE c.id = ? AND o.merchant_key = ?',
  ).get(id, mk) ?? null;
  const loadRefund = (id, mk) => db.prepare(
    'SELECT r.* FROM fake_paypal_refunds r JOIN fake_paypal_captures c ON c.id = r.capture_id JOIN fake_paypal_authorizations a ON a.id = c.authorization_id ' +
      'JOIN fake_paypal_orders o ON o.id = a.order_id WHERE r.id = ? AND o.merchant_key = ?',
  ).get(id, mk) ?? null;

  // ---- effects (run inside the transaction; each returns an Outcome) -------------------------------------------------------
  const effects = {
    create_order(ctx) {
      const { args, mk, now } = ctx;
      const notApprovable = takeFlag(db, mk, hooks, (p) => p.name === 'order_not_approvable');
      const id = `FAKE-${hex(16)}`;
      db.prepare(
        "INSERT INTO fake_paypal_orders (id, merchant_key, amount_cents, currency, status, return_url, cancel_url, approvable, simulated, created_at) " +
          "VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, 1, ?)",
      ).run(id, mk, args.amountCents, args.currency, args.returnUrl, args.cancelUrl, notApprovable ? 0 : 1, isoFromMs(now));
      ctx.rec.resourceId = id;
      return labelled({ orderId: id, approvalUrl: `${origin()}${APPROVAL_PATH_PREFIX}${id}`, status: 'CREATED' }, 201);
    },

    get_order(ctx) {
      const { args, mk, now } = ctx;
      const order = loadOrder(args.orderId, mk);
      if (!order) return notFound();
      ctx.rec.resourceId = order.id;
      const auths = db.prepare('SELECT * FROM fake_paypal_authorizations WHERE order_id = ? ORDER BY created_at, rowid').all(order.id)
        .map((row) => settleExpiry(row, now));
      const captures = db.prepare(
        'SELECT c.* FROM fake_paypal_captures c JOIN fake_paypal_authorizations a ON a.id = c.authorization_id WHERE a.order_id = ? ORDER BY c.created_at, c.rowid',
      ).all(order.id);
      const refunds = db.prepare(
        'SELECT r.* FROM fake_paypal_refunds r JOIN fake_paypal_captures c ON c.id = r.capture_id JOIN fake_paypal_authorizations a ON a.id = c.authorization_id ' +
          'WHERE a.order_id = ? ORDER BY r.created_at, r.rowid',
      ).all(order.id);
      return labelled({
        status: order.status,
        authorizations: auths.map((a) => ({ id: a.id, status: a.status, expirationTime: a.expiration_time })),
        captures: captures.map((c) => ({ id: c.id, status: c.status, authorizationId: c.authorization_id })),
        refunds: refunds.map((r) => ({ id: r.id, status: r.status, captureId: r.capture_id })),
      });
    },

    authorize(ctx) {
      const { args, mk, now } = ctx;
      const order = loadOrder(args.orderId, mk);
      if (!order) return notFound();
      ctx.rec.resourceId = order.id;
      const existing = db.prepare('SELECT 1 AS present FROM fake_paypal_authorizations WHERE order_id = ?').get(order.id);
      if (existing) return refuse('ORDER_ALREADY_AUTHORIZED');
      if (order.status !== 'APPROVED') return refuse('ORDER_NOT_APPROVED');
      const scenario = takeFlag(db, mk, hooks, (p) => p.name === 'authorize_denied' || p.name === 'authorize_pending');
      const expire = takeFlag(db, mk, hooks, (p) => p.name === 'auth_expire');
      const status = scenario ? (scenario.name === 'authorize_denied' ? 'DENIED' : 'PENDING') : 'CREATED';
      const id = `FAKEAUTH-${hex(8)}`;
      const expiration = isoFromMs(expire ? now : now + AUTHORIZATION_TTL_MS);
      db.prepare(
        'INSERT INTO fake_paypal_authorizations (id, order_id, status, amount_cents, expiration_time, simulated, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      ).run(id, order.id, status, order.amount_cents, expiration, isoFromMs(now));
      db.prepare("UPDATE fake_paypal_orders SET status = 'COMPLETED' WHERE id = ?").run(order.id);
      ctx.rec.resourceId = id;
      return labelled({ authorizationId: id, status, expirationTime: expiration }, 201);
    },

    get_authorization(ctx) {
      const auth = loadAuthorization(ctx.args.authorizationId, ctx.mk, ctx.now);
      if (!auth) return notFound();
      ctx.rec.resourceId = auth.id;
      return labelled({ status: auth.status, expirationTime: auth.expiration_time });
    },

    capture(ctx) {
      const { args, mk, now } = ctx;
      const auth = loadAuthorization(args.authorizationId, mk, now);
      if (!auth) return notFound();
      ctx.rec.resourceId = auth.id;
      if (AUTH_REFUSALS[auth.status]) return refuse(AUTH_REFUSALS[auth.status]);
      if (args.amountCents > auth.amount_cents) return refuse('AUTHORIZATION_AMOUNT_EXCEEDED');
      const scenario = takeFlag(db, mk, hooks, (p) => p.name === 'capture_declined' || p.name === 'capture_pending');
      const status = scenario ? (scenario.name === 'capture_declined' ? 'DECLINED' : 'PENDING') : 'COMPLETED';
      const id = `FAKECAP-${hex(8)}`;
      db.prepare(
        'INSERT INTO fake_paypal_captures (id, authorization_id, status, amount_cents, simulated, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ).run(id, auth.id, status, args.amountCents, isoFromMs(now));
      if (status !== 'DECLINED') db.prepare("UPDATE fake_paypal_authorizations SET status = 'CAPTURED' WHERE id = ?").run(auth.id);
      if (takeFlag(db, mk, hooks, (p) => p.name === 'freeze_after_capture_apply')) ctx.afterCommit.push(freeze);
      ctx.rec.resourceId = id;
      return labelled({ captureId: id, status }, 201);
    },

    get_capture(ctx) {
      const capture = loadCapture(ctx.args.captureId, ctx.mk);
      if (!capture) return notFound();
      ctx.rec.resourceId = capture.id;
      return labelled({ status: capture.status });
    },

    void(ctx) {
      const { args, mk, now } = ctx;
      const auth = loadAuthorization(args.authorizationId, mk, now);
      if (!auth) return notFound();
      ctx.rec.resourceId = auth.id;
      if (takeFlag(db, mk, hooks, (p) => p.name === 'void_fail')) return refuse('AUTHORIZATION_CANNOT_BE_VOIDED');
      if (auth.status === 'CREATED' && takeFlag(db, mk, hooks, (p) => p.name === 'capture_lands_after_void_intent')) {
        // F-TR-6: the capture reaches the provider before the void does.
        const id = `FAKECAP-${hex(8)}`;
        db.prepare(
          "INSERT INTO fake_paypal_captures (id, authorization_id, status, amount_cents, simulated, created_at) VALUES (?, ?, 'COMPLETED', ?, 1, ?)",
        ).run(id, auth.id, auth.amount_cents, isoFromMs(now));
        db.prepare("UPDATE fake_paypal_authorizations SET status = 'CAPTURED' WHERE id = ?").run(auth.id);
        return refuse('AUTHORIZATION_ALREADY_CAPTURED');
      }
      if (AUTH_REFUSALS[auth.status] && auth.status !== 'PENDING') return refuse(AUTH_REFUSALS[auth.status]);
      db.prepare("UPDATE fake_paypal_authorizations SET status = 'VOIDED' WHERE id = ?").run(auth.id);
      db.prepare("UPDATE fake_paypal_orders SET status = 'VOIDED' WHERE id = ?").run(auth.order_id);
      return labelled({ status: 'VOIDED' }, 204);
    },

    refund(ctx) {
      const { args, mk, now } = ctx;
      const capture = loadCapture(args.captureId, mk);
      if (!capture) return notFound();
      ctx.rec.resourceId = capture.id;
      if (capture.status === 'REFUNDED') return refuse('CAPTURE_FULLY_REFUNDED');
      if (capture.status !== 'COMPLETED') return refuse('CAPTURE_NOT_COMPLETED');
      const refunded = Number(db.prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM fake_paypal_refunds WHERE capture_id = ? AND status IN ('COMPLETED', 'PENDING')",
      ).get(capture.id).total);
      const remaining = capture.amount_cents - refunded;
      if (remaining <= 0) return refuse('CAPTURE_FULLY_REFUNDED');
      if (args.amountCents > remaining) return refuse('REFUND_AMOUNT_EXCEEDED');
      const scenario = takeFlag(db, mk, hooks, (p) => p.name === 'refund_pending' || p.name === 'refund_failed');
      const status = scenario ? (scenario.name === 'refund_pending' ? 'PENDING' : 'FAILED') : 'COMPLETED';
      const id = `FAKEREF-${hex(8)}`;
      db.prepare(
        'INSERT INTO fake_paypal_refunds (id, capture_id, status, amount_cents, simulated, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ).run(id, capture.id, status, args.amountCents, isoFromMs(now));
      if (status !== 'FAILED' && refunded + args.amountCents >= capture.amount_cents) {
        db.prepare("UPDATE fake_paypal_captures SET status = 'REFUNDED' WHERE id = ?").run(capture.id);
      }
      ctx.rec.resourceId = id;
      return labelled({ refundId: id, status }, 201);
    },

    get_refund(ctx) {
      const refund = loadRefund(ctx.args.refundId, ctx.mk);
      if (!refund) return notFound();
      ctx.rec.resourceId = refund.id;
      return labelled({ status: refund.status });
    },

    verify_webhook(ctx) {
      const input = webhookInput(ctx.args);
      if (input.invalid) return input.invalid;
      if (!input.complete) return labelled({ verified: false });
      const h = input.headers;
      const verified = signatureMatches(secret(), {
        transmissionId: h['paypal-transmission-id'], transmissionTime: h['paypal-transmission-time'], rawBody: input.body,
      }, h['paypal-transmission-sig']);
      return labelled({ verified });
    },
  };

  // ---- one provider call ----------------------------------------------------------------------------------------------------
  function transact(kind, args) {
    const mk = args.merchantKey;
    const mutating = MUTATING_KINDS.includes(kind);
    const afterCommit = [];
    const outcome = db.tx(() => {
      const rec = { resourceId: null, replayed: 0 };
      const now = clock.now();
      let result;
      const pre = takeFlag(db, mk, hooks, (p) => p.family === 'transport' && p.kind === kind && (p.type === 'http' || p.type === 'timeout'));
      if (pre) {
        result = pre.type === 'timeout' ? unknown('timeout') : httpFaultOutcome(pre.status);
      } else {
        const post = takeFlag(db, mk, hooks, (p) => p.family === 'transport' && p.kind === kind && (p.type === 'lost' || p.type === 'bad_body'));
        let applied = null;
        if (mutating) {
          const stored = db.prepare('SELECT kind, response_json FROM fake_paypal_requests WHERE merchant_key = ? AND request_id = ?').get(mk, args.requestId);
          if (stored && stored.kind !== kind) {
            applied = refuse('REQUEST_ID_KIND_MISMATCH');
          } else if (stored) {
            const replay = JSON.parse(stored.response_json);
            rec.replayed = 1;
            rec.resourceId = replay.resourceId ?? null;
            applied = ok(replay.value, replay.httpStatus);
          }
        }
        if (!applied) {
          applied = effects[kind]({ args, mk, now, rec, afterCommit });
          if (mutating && applied.kind === 'ok') {
            db.prepare('INSERT INTO fake_paypal_requests (merchant_key, request_id, kind, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(mk, args.requestId, kind, JSON.stringify({ value: applied.value, httpStatus: applied.httpStatus, resourceId: rec.resourceId }), isoFromMs(now));
          }
        }
        if (!post) result = applied;
        else result = post.type === 'lost' ? unknown('network') : unknown('bad_body');
      }
      db.prepare('INSERT INTO fake_paypal_calls (kind, merchant_key, request_id, resource_id, replayed, pid, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(kind, mk, mutating ? args.requestId : null, rec.resourceId, rec.replayed, pid, isoFromMs(now));
      return result;
    });
    for (const action of afterCommit) action();
    return outcome;
  }

  async function run(kind, args) {
    const bad = checkArguments(kind, args) ?? (kind === 'verify_webhook' ? webhookInput(args).invalid : null);
    if (bad) return bad;
    let outcome;
    try {
      if (kind === 'capture') {
        // freeze_before_capture_apply: stop BEFORE the call is counted or applied. Whoever resumes this process finds the same
        // request id possibly applied already, and the call then replays.
        if (takeFlag(db, args.merchantKey, hooks, (p) => p.name === 'freeze_before_capture_apply')) freeze();
      }
      if (kind === 'verify_webhook') secret(); // resolved before the transaction: it may have to create the key in `meta`
      outcome = transact(kind, args);
    } catch (err) {
      if (!isBusyError(err)) throw err;
      outcome = retryable(429, 'FAKE_DB_BUSY'); // nothing was applied: the transaction rolled back
    }
    log.info('provider.call', {
      kind, provider: FAKE_PROVIDER_ID, httpStatus: outcome.httpStatus, operationKey: MUTATING_KINDS.includes(kind) ? args.requestId : undefined,
      code: outcome.kind === 'ok' ? undefined : outcome.issue ?? outcome.reason,
    });
    return outcome;
  }

  return Object.freeze({
    id: FAKE_PROVIDER_ID,
    simulated: true,
    sandbox: false,
    createOrder: (args) => run('create_order', args),
    getOrder: (args) => run('get_order', args),
    authorizeOrder: (args) => run('authorize', args),
    getAuthorization: (args) => run('get_authorization', args),
    captureAuthorization: (args) => run('capture', args),
    getCapture: (args) => run('get_capture', args),
    voidAuthorization: (args) => run('void', args),
    refundCapture: (args) => run('refund', args),
    getRefund: (args) => run('get_refund', args),
    verifyWebhook: (args) => run('verify_webhook', args),
  });
}
