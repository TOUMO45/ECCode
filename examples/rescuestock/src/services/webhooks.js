// Verified PayPal webhooks (spec: Interface Contracts > Webhooks; threat T13; SEC-6, SEC-16; RS-23, RS-24).
//
//   POST /api/webhooks/paypal/:merchantKey      public, CSRF-exempt, session-free (policy `signature`); the provider signature
//                                               is the only authentication.
//
// Order of work (nothing before step 5 calls the provider, nothing before step 3 reads the body):
//   1. merchantKey is not a configured key                        -> 404 NOT_FOUND (no row, no counter)
//   2. 60 requests per IP per minute (rate_events 'webhook')      -> 429 RATE_LIMITED {limit: webhook_ip} (no row, SEC-6)
//   3. raw body, at most 65,536 bytes, kept byte-exact            -> 413 PAYLOAD_TOO_LARGE
//   4. cheap pre-checks (precheck below)                          -> `invalid` row with flag_reason, 400 WEBHOOK_SIGNATURE_INVALID
//   5. a `valid` row with this transmission id exists             -> 200 {outcome: "duplicate"}, no row, no effect (RS-23)
//   6. PaymentProvider.verifyWebhook({merchantKey, headers, rawBody})
//        verified false                                           -> `invalid` row, 400 WEBHOOK_SIGNATURE_INVALID (RS-24)
//        unreachable, retryable, rejected, WEBHOOK_ID_MISSING     -> `unverified` row, 503 PROVIDER_UNAVAILABLE (PayPal retries)
//   7. verified: ONE transaction inserts the `valid` row (the partial UNIQUE index settles concurrent duplicates), maps the
//      event to a payment operation (merchant_key, provider = the active adapter, archived_at IS NULL: SEC-16) and applies the
//      transition only if domain/states.js allows it (compare-and-set on the status). Otherwise the row is `flagged` with a
//      reason; no match is `ignored`. A move into `authorized` calls the resolution hook (ctx.voidRule.onAuthorized) in the
//      same transaction, so a cancelled operation gets its so:<id>:void:1 exactly once (ARCH-22).
//   8. 200 {outcome: "applied" | "ignored" | "flagged"}
//
// What is stored: the SHA-256 of the raw body and a minimised summary (event type, event id, resource ids, resource status).
// The payload itself, and everything in it that identifies a payer, is never stored, audited or logged: the summary is built
// from an allow-list of fields and each value is pattern-checked.
import { createHash } from 'node:crypto';
import { isoFromMs } from '../clock.js';
import { canTransition } from '../domain/states.js';
import { isConstraintError } from '../db/errors.js';
import { AppError } from '../http/envelope.js';
import { JSON_MAX_DEPTH, jsonNestsDeeperThan, readRawBody } from '../http/body.js';
import { isActiveMerchantKey } from '../payments/merchants.js';
import { MAX_WEBHOOK_BODY_BYTES, WEBHOOK_HEADER_NAMES } from '../payments/provider.js';
import { recordAudit } from './audit.js';
import { moveOperation } from './calls.js';

export const WEBHOOK_RATE_LIMIT = 60;
export const WEBHOOK_RATE_WINDOW_MS = 60_000;
export const WEBHOOK_TIME_WINDOW_MS = 15 * 60_000;
export const DEFAULT_WEBHOOK_ALGOS = Object.freeze(['SHA256withRSA']);

const MAX_HEADER_VALUE = 1024;
const TRANSMISSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const ALGO = /^[A-Za-z0-9_-]{1,32}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RESOURCE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const STATUS_WORD = /^[A-Z][A-Z_]{0,31}$/;
const RESOURCE_TYPE = /^[A-Za-z0-9_.-]{1,32}$/;
const ISSUE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

// event_type -> how it maps. `target` is the payment status the event reports (null = informational, never a transition);
// `from` limits the statuses the event may move (when absent the state table alone decides); `lookup` lists, in order, the
// operation column and the summary key whose value identifies the operation. Column names are constants, never input.
export const WEBHOOK_EVENTS = Object.freeze({
  'PAYMENT.AUTHORIZATION.CREATED': { target: 'authorized', lookup: [['provider_authorization_id', 'resource_id'], ['provider_order_id', 'order_id']] },
  'PAYMENT.AUTHORIZATION.VOIDED': { target: 'voided', lookup: [['provider_authorization_id', 'resource_id'], ['provider_order_id', 'order_id']] },
  'PAYMENT.CAPTURE.COMPLETED': { target: 'captured', lookup: [['provider_capture_id', 'resource_id'], ['provider_authorization_id', 'authorization_id']] },
  'PAYMENT.CAPTURE.PENDING': { target: 'capture_pending', lookup: [['provider_capture_id', 'resource_id'], ['provider_authorization_id', 'authorization_id']] },
  // A denied capture leaves the authorization usable: capture_pending -> authorized.
  'PAYMENT.CAPTURE.DENIED': { target: 'authorized', from: ['capture_pending'], lookup: [['provider_capture_id', 'resource_id'], ['provider_authorization_id', 'authorization_id']] },
  'PAYMENT.CAPTURE.REFUNDED': { target: 'refunded', lookup: [['provider_refund_id', 'resource_id'], ['provider_capture_id', 'capture_id']] },
  'CHECKOUT.ORDER.APPROVED': { target: null, lookup: [['provider_order_id', 'resource_id']] },
});

// The allow-list of paypal-auth-algo values: config.paypalWebhookAlgos when the configuration provides it, else the comma
// separated RS_PAYPAL_WEBHOOK_ALGOS, else SHA256withRSA. A malformed list falls back to the default (never to "anything").
export function webhookAlgos(config, env = process.env) {
  const given = Array.isArray(config?.paypalWebhookAlgos) ? config.paypalWebhookAlgos : null;
  const listed = given ?? (typeof env.RS_PAYPAL_WEBHOOK_ALGOS === 'string' ? env.RS_PAYPAL_WEBHOOK_ALGOS.split(',').map((s) => s.trim()).filter(Boolean) : null);
  if (!listed || listed.length === 0 || !listed.every((a) => typeof a === 'string' && ALGO.test(a))) return DEFAULT_WEBHOOK_ALGOS;
  return Object.freeze([...listed]);
}

// ---- pre-checks (no provider call, SEC-6) ----------------------------------------------------------------------------------

// A header is present when it is a non-empty string of at most 1024 characters (also the adapters' limit); an over-long value
// counts as missing, so the certificate URL is bounded by it as well.
function headerValue(headers, name) {
  const value = headers?.[name];
  return typeof value === 'string' && value !== '' && value.length <= MAX_HEADER_VALUE ? value : null;
}

function certUrlOk(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return false;
  return url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com');
}

// The body as text with a leading BOM removed for PARSING ONLY (the bytes that are verified are never changed).
function parseEvent(rawBody) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBody);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (jsonNestsDeeperThan(text, JSON_MAX_DEPTH)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// precheck({ headers, rawBody, nowMs, algos }) -> { ok: true, transmissionId, event } | { ok: false, reason, transmissionId }
// `transmissionId` is the header when it has the allowed shape, else null.
export function precheck({ headers, rawBody, nowMs, algos = DEFAULT_WEBHOOK_ALGOS }) {
  const values = {};
  for (const name of WEBHOOK_HEADER_NAMES) values[name] = headerValue(headers, name);
  const id = values['paypal-transmission-id'];
  const transmissionId = id !== null && TRANSMISSION_ID.test(id) ? id : null;
  const fail = (reason) => ({ ok: false, reason, transmissionId });

  if (WEBHOOK_HEADER_NAMES.some((name) => values[name] === null)) return fail('HEADER_MISSING');
  if (transmissionId === null) return fail('TRANSMISSION_ID_INVALID');
  if (!algos.includes(values['paypal-auth-algo'])) return fail('AUTH_ALGO_NOT_ALLOWED');
  const timeText = values['paypal-transmission-time'];
  const time = ISO_TIME.test(timeText) ? Date.parse(timeText) : Number.NaN;
  if (!Number.isFinite(time)) return fail('TRANSMISSION_TIME_INVALID');
  if (Math.abs(nowMs - time) > WEBHOOK_TIME_WINDOW_MS) return fail('TRANSMISSION_TIME_OUT_OF_WINDOW');
  if (!certUrlOk(values['paypal-cert-url'])) return fail('CERT_URL_INVALID');
  const event = parseEvent(rawBody);
  if (event === null) return fail('BODY_NOT_JSON_OBJECT');
  if (typeof event.event_type !== 'string' || !Object.hasOwn(WEBHOOK_EVENTS, event.event_type)) return fail('EVENT_TYPE_NOT_MAPPED');
  return { ok: true, transmissionId, event };
}

// ---- the minimised summary --------------------------------------------------------------------------------------------------

const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

function upLinkCaptureId(links) {
  if (!Array.isArray(links)) return null;
  for (const link of links.slice(0, 20)) {
    if (link && link.rel === 'up' && typeof link.href === 'string' && link.href.length <= 512) {
      const match = /\/v2\/payments\/captures\/([A-Za-z0-9._-]{1,64})\/?$/.exec(link.href.split('?')[0]);
      if (match) return match[1];
    }
  }
  return null;
}

// {event_type, event_id, resource_type, resource_id, resource_status, order_id, authorization_id, capture_id}: only values that
// pass a strict pattern, only these fields. Nothing under resource.payer, resource.payee, shipping or amounts is read.
export function summarise(event) {
  const resource = event.resource !== null && typeof event.resource === 'object' && !Array.isArray(event.resource) ? event.resource : {};
  const related = resource.supplementary_data?.related_ids;
  const ids = related !== null && typeof related === 'object' ? related : {};
  const summary = {
    event_type: event.event_type,
    event_id: pick(event.id, RESOURCE_ID),
    resource_type: pick(event.resource_type, RESOURCE_TYPE),
    resource_id: pick(resource.id, RESOURCE_ID),
    resource_status: pick(resource.status, STATUS_WORD),
    order_id: pick(ids.order_id, RESOURCE_ID),
    authorization_id: pick(ids.authorization_id, RESOURCE_ID),
    capture_id: pick(ids.capture_id, RESOURCE_ID) ?? upLinkCaptureId(resource.links),
  };
  for (const key of Object.keys(summary)) if (summary[key] === null) delete summary[key];
  return summary;
}

function expirationOf(event) {
  const text = event.resource?.expiration_time;
  if (typeof text !== 'string' || !ISO_TIME.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? isoFromMs(ms) : null;
}

// ---- rate limit (SEC-6) ------------------------------------------------------------------------------------------------------

// 60 admitted requests per IP per minute, counted in rate_events (kind 'webhook', key ip:<throttle key>) in one BEGIN IMMEDIATE,
// so parallel requests, also from another process, cannot overshoot. A refused request is not inserted.
function takeWebhookSlot(ctx) {
  const { db, clock } = ctx;
  const nowMs = clock.now();
  const cutoff = isoFromMs(nowMs - WEBHOOK_RATE_WINDOW_MS);
  const key = `ip:${ctx.clientIp()}`;
  const decision = db.tx(() => {
    db.prepare("DELETE FROM rate_events WHERE kind = 'webhook' AND user_key = ? AND at <= ?").run(key, cutoff);
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = 'webhook' AND user_key = ? AND at > ?").get(key, cutoff);
    if (row.n >= WEBHOOK_RATE_LIMIT) {
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((Date.parse(row.oldest) + WEBHOOK_RATE_WINDOW_MS - nowMs) / 1000)) };
    }
    db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'webhook', ?)").run(key, isoFromMs(nowMs));
    return { allowed: true };
  });
  if (!decision.allowed) {
    throw new AppError(429, 'RATE_LIMITED', { details: { limit: 'webhook_ip' }, headers: { 'Retry-After': String(decision.retryAfterS) } });
  }
}

// ---- rows --------------------------------------------------------------------------------------------------------------------

const INSERT_ROW =
  'INSERT INTO webhook_events (provider, transmission_id, merchant_key, event_type, resource_type, resource_id, signature_status, outcome, flagged, flag_reason, ' +
  'payload_json, payload_sha256, received_at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function insertRow(ctx, row) {
  const received = isoFromMs(ctx.clock.now());
  return Number(
    ctx.db
      .prepare(INSERT_ROW)
      .run(
        ctx.config.paymentProvider, row.transmissionId ?? '-', row.merchantKey, row.eventType ?? null, row.resourceType ?? null, row.resourceId ?? null,
        row.signatureStatus, row.outcome, row.flagged ? 1 : 0, row.flagReason ?? null, row.payloadJson ?? null, row.sha, received, row.appliedAt ?? null,
      ).lastInsertRowid,
  );
}

// `invalid` and `unverified` rows keep nothing from the unverified body except its hash and, when it is one of the mapped
// constants, the event type. Both are purged after 7 days (retention).
function recordUnverified(ctx, { merchantKey, transmissionId, eventType, status, reason, sha }) {
  ctx.db.tx(() =>
    insertRow(ctx, {
      transmissionId, merchantKey, eventType: eventType && Object.hasOwn(WEBHOOK_EVENTS, eventType) ? eventType : null,
      signatureStatus: status, outcome: 'rejected', flagged: false, flagReason: reason, sha,
    }),
  );
}

// ---- mapping and applying (one transaction) ------------------------------------------------------------------------------------

function findOperations(ctx, event, summary) {
  const spec = WEBHOOK_EVENTS[event.event_type];
  for (const [column, key] of spec.lookup) {
    const value = summary[key];
    if (value === undefined) continue;
    // SEC-16: the merchant of the URL, the active adapter and a non-archived operation. `column` is one of the constants above.
    const rows = ctx.db
      .prepare(
        `SELECT * FROM payment_operations WHERE ${column} = ? AND merchant_key = ? AND provider = ? AND archived_at IS NULL ORDER BY id LIMIT 2`,
      )
      .all(value, ctx.merchantKey, ctx.config.paymentProvider);
    if (rows.length > 0) return rows;
  }
  return [];
}

function applyEvent(ctx, event, summary) {
  const { db, clock } = ctx;
  const spec = WEBHOOK_EVENTS[event.event_type];
  const result = { outcome: 'ignored', flagged: false, flagReason: null, operationId: null, appliedAt: null };
  const flag = (reason, op) => ({ ...result, outcome: 'flagged', flagged: true, flagReason: reason, operationId: op?.id ?? null });

  const found = findOperations(ctx, event, summary);
  if (found.length === 0) return { ...result, flagReason: 'NO_MATCHING_OPERATION' };
  if (found.length > 1) return flag('AMBIGUOUS_RESOURCE', null);
  const op = found[0];
  result.operationId = op.id;
  if (spec.target === null) return { ...result, flagReason: 'INFORMATIONAL_EVENT' };
  if (op.status === spec.target) return { ...result, flagReason: 'ALREADY_IN_STATE' };

  // An `unknown` operation is judged by the state it came from, so that a webhook can only resolve it forward.
  const effective = op.status === 'unknown' ? op.prev_status : op.status;
  if (spec.from && !spec.from.includes(effective)) return flag('TRANSITION_NOT_ALLOWED', op);
  const allowed = canTransition('payment', op.status, spec.target) && (op.status !== 'unknown' || effective === spec.target || canTransition('payment', effective, spec.target));
  if (!allowed) return flag('TRANSITION_NOT_ALLOWED', op);

  // The ids the event carries must agree with the ones already stored.
  const set = {};
  if (spec.target === 'authorized' && event.event_type === 'PAYMENT.AUTHORIZATION.CREATED') {
    if (op.provider_authorization_id !== null && summary.resource_id !== undefined && op.provider_authorization_id !== summary.resource_id) return flag('AUTHORIZATION_ID_MISMATCH', op);
    if (op.provider_authorization_id === null && summary.resource_id !== undefined) set.provider_authorization_id = summary.resource_id;
    const expires = expirationOf(event);
    if (expires !== null && op.authorization_expires_at === null) set.authorization_expires_at = expires;
  }
  if (spec.target === 'captured' || spec.target === 'capture_pending') {
    if (op.provider_capture_id !== null && summary.resource_id !== undefined && op.provider_capture_id !== summary.resource_id) return flag('CAPTURE_ID_MISMATCH', op);
    if (op.provider_capture_id === null && summary.resource_id !== undefined) set.provider_capture_id = summary.resource_id;
  }
  if (spec.target === 'refunded') {
    if (op.provider_refund_id !== null && summary.resource_id !== undefined && op.provider_refund_id !== summary.resource_id) return flag('REFUND_ID_MISMATCH', op);
    if (op.provider_refund_id === null && summary.resource_id !== undefined) set.provider_refund_id = summary.resource_id;
  }
  if (op.status === 'unknown') set.unknown_since = null;

  if (!moveOperation(db, clock, op, spec.target, set)) return flag('STATE_CHANGED', op);
  if (spec.target === 'authorized' && ctx.voidRule && typeof ctx.voidRule.onAuthorized === 'function') {
    // Resolution hook (ARCH-22): same transaction as the move into `authorized`.
    ctx.voidRule.onAuthorized(db, { operationId: op.id, requestId: ctx.requestId });
  }
  recordAudit(db, clock, {
    actorRole: 'system', action: 'webhook.apply', entityType: 'payment_operation', entityId: op.id, outcome: 'ok',
    detail: { eventType: event.event_type, from: op.status, to: spec.target }, requestId: ctx.requestId,
  });
  return { ...result, outcome: 'applied', appliedAt: isoFromMs(clock.now()) };
}

// -> { outcome: 'duplicate' } | { outcome, rowId }
function storeValid(ctx, { transmissionId, event, summary, sha }) {
  const run = () =>
    ctx.db.tx(() => {
      const dup = ctx.db.prepare("SELECT id FROM webhook_events WHERE transmission_id = ? AND signature_status = 'valid'").get(transmissionId);
      if (dup) return { outcome: 'duplicate' };
      const applied = applyEvent(ctx, event, summary);
      const rowId = insertRow(ctx, {
        transmissionId, merchantKey: ctx.merchantKey, eventType: event.event_type, resourceType: summary.resource_type, resourceId: summary.resource_id,
        signatureStatus: 'valid', outcome: applied.outcome, flagged: applied.flagged, flagReason: applied.flagReason, payloadJson: JSON.stringify(summary), sha,
        appliedAt: applied.appliedAt,
      });
      return { outcome: applied.outcome, rowId, operationId: applied.operationId };
    });
  try {
    return run();
  } catch (err) {
    // The partial UNIQUE index on valid transmission ids lost a race against another process: that is a duplicate.
    if (isConstraintError(err)) {
      const dup = ctx.db.prepare("SELECT id FROM webhook_events WHERE transmission_id = ? AND signature_status = 'valid'").get(transmissionId);
      if (dup) return { outcome: 'duplicate' };
    }
    throw err;
  }
}

// ---- verification ----------------------------------------------------------------------------------------------------------------

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown', reason: 'timeout' }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// -> { verdict: 'valid' } | { verdict: 'invalid', reason } | { verdict: 'unverified', reason }
async function verify(ctx, rawBody) {
  const provider = ctx.payments;
  if (!provider || typeof provider.verifyWebhook !== 'function') return { verdict: 'unverified', reason: 'PROVIDER_MISSING' };
  const headers = {};
  for (const name of WEBHOOK_HEADER_NAMES) headers[name] = ctx.req.headers[name];
  let outcome;
  try {
    outcome = await withDeadline(
      Promise.resolve(provider.verifyWebhook({ merchantKey: ctx.merchantKey, headers, rawBody })),
      (ctx.config.paypalTimeoutMs ?? 20_000) + 1000,
    );
  } catch {
    ctx.log.warn('webhook.verify_failed', { code: 'VERIFY_THREW' });
    return { verdict: 'unverified', reason: 'VERIFY_THREW' };
  }
  if (outcome?.kind === 'ok') {
    return outcome.value?.verified === true ? { verdict: 'valid' } : { verdict: 'invalid', reason: 'SIGNATURE_VERIFICATION_FAILED' };
  }
  if (outcome?.kind === 'rejected') {
    const issue = typeof outcome.issue === 'string' && ISSUE_CODE.test(outcome.issue) ? outcome.issue : 'VERIFY_REJECTED';
    // Nothing was sent (our own argument check): the request is not verifiable, so it is not genuine.
    if (issue === 'INVALID_ARGUMENT') return { verdict: 'invalid', reason: 'VERIFY_ARGUMENT_INVALID' };
    // The provider could not decide (no webhook id configured, credentials, ...): PayPal should retry, we must not accept.
    return { verdict: 'unverified', reason: issue };
  }
  return { verdict: 'unverified', reason: outcome?.kind === 'retryable' ? 'VERIFY_RETRYABLE' : 'VERIFY_UNREACHABLE' };
}

// ---- the route --------------------------------------------------------------------------------------------------------------------

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function receivePaypalWebhook(ctx) {
  const merchantKey = ctx.params.merchantKey;
  // 1. only a configured, active merchant key exists (nothing is read, counted or stored for any other)
  if (!isActiveMerchantKey(ctx.config, merchantKey)) throw new AppError(404, 'NOT_FOUND');
  ctx.merchantKey = merchantKey;
  // 2. SEC-6: 60 per IP per minute, before the body is read; a refusal writes no row
  takeWebhookSlot(ctx);
  // 3. the raw bytes, never re-serialised
  const rawBody = await readRawBody(ctx.req, { limit: MAX_WEBHOOK_BODY_BYTES });
  const sha = sha256Hex(rawBody);
  const log = (code, extra = {}) => ctx.log.info('webhook.received', { provider: ctx.config.paymentProvider, code, ...extra });

  // 4. cheap pre-checks, no provider call
  const checked = precheck({ headers: ctx.req.headers, rawBody, nowMs: ctx.clock.now(), algos: webhookAlgos(ctx.config) });
  if (!checked.ok) {
    recordUnverified(ctx, { merchantKey, transmissionId: checked.transmissionId, eventType: null, status: 'invalid', reason: checked.reason, sha });
    log(`INVALID_${checked.reason}`, { httpStatus: 400 });
    throw new AppError(400, 'WEBHOOK_SIGNATURE_INVALID');
  }
  const { transmissionId, event } = checked;

  // 5. RS-23: a valid row with this transmission id means the event was already handled; no provider call, no row, no effect
  if (ctx.db.prepare("SELECT 1 AS found FROM webhook_events WHERE transmission_id = ? AND signature_status = 'valid'").get(transmissionId)) {
    log('DUPLICATE', { httpStatus: 200 });
    return { status: 200, body: { outcome: 'duplicate' } };
  }

  // 6. verification through the provider
  const verdict = await verify(ctx, rawBody);
  if (verdict.verdict === 'invalid') {
    recordUnverified(ctx, { merchantKey, transmissionId, eventType: event.event_type, status: 'invalid', reason: verdict.reason, sha });
    log('INVALID_SIGNATURE', { httpStatus: 400 });
    throw new AppError(400, 'WEBHOOK_SIGNATURE_INVALID');
  }
  if (verdict.verdict === 'unverified') {
    recordUnverified(ctx, { merchantKey, transmissionId, eventType: event.event_type, status: 'unverified', reason: verdict.reason, sha });
    log('UNVERIFIED', { httpStatus: 503 });
    throw new AppError(503, 'PROVIDER_UNAVAILABLE', { headers: { 'Retry-After': '30' } });
  }

  // 7. valid: store, map and apply in one transaction
  const summary = summarise(event);
  const stored = storeValid(ctx, { transmissionId, event, summary, sha });
  log(stored.outcome.toUpperCase(), { httpStatus: 200, paymentOperationId: stored.operationId ?? undefined });
  return { status: 200, body: { outcome: stored.outcome } };
}
