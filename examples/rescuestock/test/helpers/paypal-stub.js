// SIMULATION of the PayPal Sandbox REST API. This is a local test double on 127.0.0.1, NEVER the real service and
// never a Sandbox host. It exists so that src/payments/sandbox.js (and the shared provider contract suite) can be
// verified offline: no PayPal host is contacted, no credential exists, every secret below is a fake constant.
// Its answers are what the spec's wire mapping ("PayPal Sandbox wire mapping", every row "verify on Sandbox") says
// PayPal should answer; they are NOT evidence that the real Sandbox behaves this way. The opt-in live suite
// (RS_LIVE_PAYPAL=1) is the only place that can confirm the guesses (issue names, link rels, status sets).
//
// Endpoints (Orders v2 / Payments v2 subset):
//   POST /v1/oauth2/token                              basic auth client_id:secret, grant_type=client_credentials
//   POST /v2/checkout/orders                           create order (intent AUTHORIZE, validated body)
//   GET  /v2/checkout/orders/{id}                      get order (payer data once approved, payments.* when present)
//   POST /v2/checkout/orders/{id}/authorize            needs an APPROVED order
//   GET  /v2/payments/authorizations/{id}              status, expiration_time (29 days after creation)
//   POST /v2/payments/authorizations/{id}/capture      422 AUTHORIZATION_ALREADY_CAPTURED on a second capture
//   POST /v2/payments/authorizations/{id}/void         204
//   GET  /v2/payments/captures/{id}
//   POST /v2/payments/captures/{id}/refund             422 CAPTURE_FULLY_REFUNDED once fully refunded
//   GET  /v2/payments/refunds/{id}
//   POST /v1/notifications/verify-webhook-signature    HMAC check of the RAW webhook_event bytes (webhook-signer.js)
//   GET  /checkoutnow?token={orderId}                  approval page; POST /checkoutnow/{orderId}/approve | cancel
//                                                      answer 303 to the stored return/cancel URL. Every response
//                                                      of these routes carries exactly one Content-Security-Policy
//                                                      header, approvalPageCsp(appOrigin) (F-TR-14).
//
// Recording. Every request (API, approval page, unknown paths) is appended to stub.calls as
//   { seq, kind, method, path, query, headers (lower-case), rawBody, body (parsed JSON/form or null), requestId
//     (the PayPal-Request-Id header or null), merchantKey, replayed, fault, status, responseBody, resourceId }.
// Authorization headers are recorded too (they hold fake tokens); nothing here ever logs them.
//
// Replay. A mutating call (create_order, authorize, capture, void, refund) with a PayPal-Request-Id already seen for
// the same merchant returns the stored 2xx response, applies nothing and is recorded with replayed = true. Only 2xx
// answers are stored (a rejected call applied nothing). The same id on another kind answers 422
// REQUEST_ID_KIND_MISMATCH. A mutating call without the header answers 400 MISSING_REQUEST_ID (option
// requireRequestId, default true, because the call protocol always sends one).
//
// Faults, armed with stub.fault(name, { count = 1, merchantKey }) and cleared with clearFaults(). Names follow the
// admin fault vocabulary of the spec, plus the transport faults the Outcome classes need. <kind> is one of KINDS:
//   http_<NNN>:<kind>        answer that HTTP status (400-599) with a PayPal-shaped error body; nothing applied
//   timeout:<kind>           nothing applied, the connection is held open and never answered (until released/closed)
//   lost_response:<kind>     the effect IS applied (and stored for replay), then the connection is destroyed
//   bad_body:<kind>          the effect IS applied, the answer is a 200 with a body that is not JSON
//   authorize_denied | authorize_pending     the authorization is created with status DENIED / PENDING
//   capture_declined | capture_pending       the capture answers DECLINED (authorization stays) / PENDING
//   refund_pending | refund_failed           the refund answers PENDING / FAILED
//   void_fail                                the void answers 422 AUTHORIZATION_CANNOT_BE_VOIDED
//   auth_expire                              the next authorization expires at once (reads show EXPIRED)
//   order_not_approvable                     the approval page refuses to approve (409), the order stays CREATED
//
// Fake payer data (FAKE_PAYER in webhook-signer.js) is returned by approved-order, authorize and getOrder answers.
// A test proves an adapter never logs it by searching its log lines for PAYER_MARKERS. Error bodies carry
// BODY_MARKER in `message` and `details[].description`; an adapter must not echo it into an Outcome or a log line.
//
// Time comes from options.clock (default: a fixed clock at 2026-10-20T06:00:00Z, like the app test harness). Token
// expiry and authorization expiry follow it, so tests advance time without sleeping.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fixedClock } from '../../src/clock.js';
import { approvalListenerHeaders } from '../../src/http/headers.js';
import { FAKE_PAYER, FAKE_WEBHOOK_SECRET, verifySignature } from './webhook-signer.js';

export const KINDS = Object.freeze([
  'token', 'create_order', 'get_order', 'authorize', 'get_authorization', 'capture', 'get_capture', 'void', 'refund',
  'get_refund', 'verify_webhook',
]);
export const MUTATING_KINDS = Object.freeze(['create_order', 'authorize', 'capture', 'void', 'refund']);
export const BODY_MARKER = 'STUB-PROVIDER-BODY-MARKER-91c4';
export const STUB_START_MS = Date.UTC(2026, 9, 20, 6, 0, 0);
export const AUTHORIZATION_TTL_MS = 29 * 24 * 60 * 60 * 1000;
export const DEFAULT_MERCHANT = Object.freeze({
  clientId: 'stub-client-id-DEFAULT',
  clientSecret: 'stub-client-secret-DEFAULT-SIMULATED',
  webhookId: 'WH-STUB-DEFAULT',
});

const MAX_BODY_BYTES = 1024 * 1024;
const MUTATING = new Set(MUTATING_KINDS);
const KIND_SET = new Set(KINDS);

const SCENARIOS = Object.freeze({
  authorize_denied: { kind: 'authorize', type: 'status', value: 'DENIED' },
  authorize_pending: { kind: 'authorize', type: 'status', value: 'PENDING' },
  capture_declined: { kind: 'capture', type: 'status', value: 'DECLINED' },
  capture_pending: { kind: 'capture', type: 'status', value: 'PENDING' },
  refund_pending: { kind: 'refund', type: 'status', value: 'PENDING' },
  refund_failed: { kind: 'refund', type: 'status', value: 'FAILED' },
  void_fail: { kind: 'void', type: 'reject' },
  auth_expire: { kind: 'authorize', type: 'expire' },
  order_not_approvable: { kind: 'approve', type: 'refuse' },
});

// [PayPal error name, details[0].issue] for an injected http_<NNN> fault.
const HTTP_ERRORS = Object.freeze({
  400: ['INVALID_REQUEST', 'INJECTED_BAD_REQUEST'],
  401: ['AUTHENTICATION_FAILURE', 'AUTHENTICATION_FAILURE'],
  403: ['NOT_AUTHORIZED', 'PERMISSION_DENIED'],
  404: ['RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID'],
  409: ['RESOURCE_CONFLICT', 'INJECTED_CONFLICT'],
  422: ['UNPROCESSABLE_ENTITY', 'INJECTED_UNPROCESSABLE'],
  429: ['RATE_LIMIT_REACHED', 'RATE_LIMIT_REACHED'],
  500: ['INTERNAL_SERVER_ERROR', 'INTERNAL_SERVICE_ISSUE'],
  502: ['BAD_GATEWAY', 'INTERNAL_SERVICE_ISSUE'],
  503: ['SERVICE_UNAVAILABLE', 'INTERNAL_SERVICE_ISSUE'],
});

export function parseFaultName(name) {
  if (Object.hasOwn(SCENARIOS, name)) return { name, ...SCENARIOS[name] };
  let m = /^(lost_response|timeout|bad_body):([a-z_]+)$/.exec(name);
  if (m && KIND_SET.has(m[2])) return { name, kind: m[2], type: m[1] === 'lost_response' ? 'lost' : m[1] };
  m = /^http_([4-5]\d\d):([a-z_]+)$/.exec(name);
  if (m && KIND_SET.has(m[2])) return { name, kind: m[2], type: 'http', status: Number(m[1]) };
  throw new RangeError(`unknown stub fault "${name}"`);
}

// Raw text of the top-level member `key` of a JSON object text, exactly as written (no parsing of the member's value).
// Returns null when the text is not a JSON object or has no such member.
export function rawMemberSpan(text, key) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1; };
  const str = () => { // at the opening quote; returns the end index (exclusive)
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') j += 2;
      else if (text[j] === '"') return j + 1;
      else j += 1;
    }
    return -1;
  };
  const value = () => { // returns end index (exclusive) of the value starting at i, or -1
    const c = text[i];
    if (c === '"') return str();
    if (c === '{' || c === '[') {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        const d = text[j];
        if (d === '"') {
          const save = i;
          i = j;
          const end = str();
          i = save;
          if (end < 0) return -1;
          j = end;
          continue;
        }
        if (d === '{' || d === '[') depth += 1;
        else if (d === '}' || d === ']') {
          depth -= 1;
          if (depth === 0) return j + 1;
        }
        j += 1;
      }
      return -1;
    }
    let j = i;
    while (j < text.length && !',}] \t\r\n'.includes(text[j])) j += 1;
    return j > i ? j : -1;
  };
  ws();
  if (text[i] !== '{') return null;
  i += 1;
  for (;;) {
    ws();
    if (text[i] === '}') return null;
    if (text[i] !== '"') return null;
    const keyEnd = str();
    if (keyEnd < 0) return null;
    let name;
    try { name = JSON.parse(text.slice(i, keyEnd)); } catch { return null; }
    i = keyEnd;
    ws();
    if (text[i] !== ':') return null;
    i += 1;
    ws();
    const start = i;
    const end = value();
    if (end < 0) return null;
    if (name === key) return text.slice(start, end);
    i = end;
    ws();
    if (text[i] === ',') { i += 1; continue; }
    return null;
  }
}

function centsOf(value) {
  const m = /^(\d{1,9})\.(\d{2})$/.exec(typeof value === 'string' ? value : '');
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

function valueOf(cents) {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const ROUTES = [
  ['POST', /^\/v1\/oauth2\/token$/, 'token', []],
  ['POST', /^\/v2\/checkout\/orders$/, 'create_order', []],
  ['GET', /^\/v2\/checkout\/orders\/([^/]+)$/, 'get_order', ['id']],
  ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/, 'authorize', ['id']],
  ['GET', /^\/v2\/payments\/authorizations\/([^/]+)$/, 'get_authorization', ['id']],
  ['POST', /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/, 'capture', ['id']],
  ['POST', /^\/v2\/payments\/authorizations\/([^/]+)\/void$/, 'void', ['id']],
  ['GET', /^\/v2\/payments\/captures\/([^/]+)$/, 'get_capture', ['id']],
  ['POST', /^\/v2\/payments\/captures\/([^/]+)\/refund$/, 'refund', ['id']],
  ['GET', /^\/v2\/payments\/refunds\/([^/]+)$/, 'get_refund', ['id']],
  ['POST', /^\/v1\/notifications\/verify-webhook-signature$/, 'verify_webhook', []],
  ['GET', /^\/checkoutnow$/, 'approval_page', []],
  ['POST', /^\/checkoutnow\/([^/]+)\/approve$/, 'approve', ['id']],
  ['POST', /^\/checkoutnow\/([^/]+)\/cancel$/, 'cancel', ['id']],
];

export async function startPaypalStub(options = {}) {
  const {
    merchants: merchantOptions = { DEFAULT: DEFAULT_MERCHANT },
    webhookSecret = FAKE_WEBHOOK_SECRET,
    clock = fixedClock(STUB_START_MS),
    tokenTtlSeconds = 32400,
    requireRequestId = true,
    approvalLink = {},
    webhookAlgos = ['SHA256withRSA'],
  } = options;
  let appOrigin = options.appOrigin ?? 'http://localhost:3000';
  const merchants = {};
  for (const [key, creds] of Object.entries(merchantOptions)) merchants[key] = { ...DEFAULT_MERCHANT, ...creds };

  const calls = [];
  const orders = new Map();
  const authorizations = new Map();
  const captures = new Map();
  const refunds = new Map();
  const replays = new Map();
  const tokens = new Map();
  const everIssued = [];
  const faults = [];
  const held = new Set();
  const sockets = new Set();
  const counters = { order: 0, authorization: 0, capture: 0, refund: 0, token: 0 };
  let origin = '';

  const nowMs = () => clock.now();
  const iso = (ms) => new Date(ms).toISOString();

  // ---- fault bookkeeping ----------------------------------------------------------------------------------------

  function takeFault(kind, merchantKey, types) {
    const hit = faults.find((f) => f.remaining > 0 && f.kind === kind && types.includes(f.type)
      && (f.merchantKey === null || f.merchantKey === merchantKey));
    if (!hit) return null;
    hit.remaining -= 1;
    hit.fired += 1;
    return hit;
  }

  // ---- response helpers -----------------------------------------------------------------------------------------

  function reply(res, record, status, payload, headers = {}) {
    record.status = status;
    const body = payload === undefined || payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
    record.responseBody = body;
    const h = { ...headers };
    if (body !== '' && !h['content-type']) h['content-type'] = 'application/json';
    if (status !== 204) h['content-length'] = Buffer.byteLength(body);
    res.writeHead(status, h);
    res.end(body);
  }

  function fail(status, name, issue) {
    return {
      status,
      body: {
        name,
        message: `Simulated PayPal error ${issue} ${BODY_MARKER}`,
        debug_id: `stubdebug${randomBytes(4).toString('hex')}`,
        details: [{ issue, description: `Simulated description ${BODY_MARKER}` }],
        links: [],
      },
    };
  }

  const notFound = () => fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');

  // ---- resources ------------------------------------------------------------------------------------------------

  function own(map, id, merchantKey) {
    const r = map.get(id);
    return r && r.merchantKey === merchantKey ? r : null;
  }

  function authStatus(a) {
    if (a.status === 'CREATED' && nowMs() >= a.expiresMs) return 'EXPIRED';
    return a.status;
  }

  function authJson(a) {
    return {
      id: a.id,
      status: authStatus(a),
      amount: { currency_code: a.currency, value: valueOf(a.amountCents) },
      expiration_time: iso(a.expiresMs),
      create_time: iso(a.createdMs),
      seller_protection: { status: 'ELIGIBLE' },
      links: [
        { href: `${origin}/v2/payments/authorizations/${a.id}`, rel: 'self', method: 'GET' },
        { href: `${origin}/v2/payments/authorizations/${a.id}/capture`, rel: 'capture', method: 'POST' },
        { href: `${origin}/v2/payments/authorizations/${a.id}/void`, rel: 'void', method: 'POST' },
        { href: `${origin}/v2/checkout/orders/${a.orderId}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  function captureJson(c) {
    return {
      id: c.id,
      status: c.status,
      amount: { currency_code: c.currency, value: valueOf(c.amountCents) },
      final_capture: true,
      invoice_id: c.invoiceId,
      create_time: iso(c.createdMs),
      links: [
        { href: `${origin}/v2/payments/captures/${c.id}`, rel: 'self', method: 'GET' },
        { href: `${origin}/v2/payments/captures/${c.id}/refund`, rel: 'refund', method: 'POST' },
        { href: `${origin}/v2/payments/authorizations/${c.authorizationId}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  function refundJson(r) {
    return {
      id: r.id,
      status: r.status,
      amount: { currency_code: r.currency, value: valueOf(r.amountCents) },
      note_to_payer: r.note,
      create_time: iso(r.createdMs),
      links: [
        { href: `${origin}/v2/payments/refunds/${r.id}`, rel: 'self', method: 'GET' },
        { href: `${origin}/v2/payments/captures/${r.captureId}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  function payerJson() {
    return {
      payer_id: FAKE_PAYER.payerId,
      email_address: FAKE_PAYER.email,
      name: { given_name: FAKE_PAYER.givenName, surname: FAKE_PAYER.surname },
      address: { address_line_1: FAKE_PAYER.addressLine, postal_code: FAKE_PAYER.postalCode, country_code: 'US' },
    };
  }

  function paymentSourceJson() {
    return { paypal: { account_id: FAKE_PAYER.payerId, email_address: FAKE_PAYER.email, name: payerJson().name } };
  }

  function approvalHref(orderId) {
    return `${approvalLink.base ?? origin}/checkoutnow?token=${orderId}`;
  }

  function orderJson(o) {
    const out = {
      id: o.id,
      status: o.status,
      intent: 'AUTHORIZE',
      create_time: iso(o.createdMs),
      purchase_units: [{
        reference_id: o.referenceId,
        custom_id: o.customId,
        invoice_id: o.invoiceId,
        amount: { currency_code: o.currency, value: valueOf(o.amountCents) },
      }],
      links: [{ href: `${origin}/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' }],
    };
    if (o.status === 'CREATED') {
      out.links.push({ href: approvalHref(o.id), rel: approvalLink.rel ?? 'payer-action', method: 'GET' });
    }
    if (o.payerApproved) {
      out.payer = payerJson();
      out.payment_source = paymentSourceJson();
    }
    const payments = {};
    const auths = [...authorizations.values()].filter((a) => a.orderId === o.id).map(authJson);
    const caps = [...captures.values()].filter((c) => c.orderId === o.id).map(captureJson);
    const refs = [...refunds.values()].filter((r) => r.orderId === o.id).map(refundJson);
    if (auths.length) payments.authorizations = auths;
    if (caps.length) payments.captures = caps;
    if (refs.length) payments.refunds = refs;
    if (Object.keys(payments).length) out.purchase_units[0].payments = payments;
    return out;
  }

  // ---- API handlers (return { status, body, headers? }) -------------------------------------------------------------

  function createOrder(ctx) {
    const b = ctx.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'INVALID_REQUEST', 'MALFORMED_REQUEST');
    if (b.intent !== 'AUTHORIZE') return fail(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE');
    const unit = Array.isArray(b.purchase_units) && b.purchase_units.length === 1 ? b.purchase_units[0] : null;
    if (!unit) return fail(422, 'UNPROCESSABLE_ENTITY', 'MISSING_REQUIRED_PARAMETER');
    if (unit.amount?.currency_code !== 'USD') return fail(422, 'UNPROCESSABLE_ENTITY', 'CURRENCY_NOT_SUPPORTED');
    const cents = centsOf(unit.amount?.value);
    if (cents === null) return fail(422, 'UNPROCESSABLE_ENTITY', 'DECIMAL_PRECISION');
    if (cents <= 0) return fail(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE');
    const ctxUrls = b.payment_source?.paypal?.experience_context;
    const urlOk = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
    if (!ctxUrls || !urlOk(ctxUrls.return_url) || !urlOk(ctxUrls.cancel_url)) {
      return fail(422, 'UNPROCESSABLE_ENTITY', 'MISSING_REQUIRED_PARAMETER');
    }
    counters.order += 1;
    const id = `STUBORD${String(counters.order).padStart(6, '0')}`;
    const o = {
      id, merchantKey: ctx.merchantKey, status: 'CREATED', amountCents: cents, currency: 'USD',
      referenceId: unit.reference_id ?? null, customId: unit.custom_id ?? null, invoiceId: unit.invoice_id ?? null,
      returnUrl: ctxUrls.return_url, cancelUrl: ctxUrls.cancel_url, payerApproved: false, authorizationId: null,
      createdMs: nowMs(),
    };
    orders.set(id, o);
    ctx.record.resourceId = id;
    return {
      status: 201,
      body: {
        id, status: 'CREATED',
        links: [
          { href: `${origin}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
          { href: approvalHref(id), rel: approvalLink.rel ?? 'payer-action', method: 'GET' },
        ],
      },
    };
  }

  function getOrder(ctx) {
    const o = own(orders, ctx.params.id, ctx.merchantKey);
    if (!o) return notFound();
    ctx.record.resourceId = o.id;
    return { status: 200, body: orderJson(o) };
  }

  function authorizeOrder(ctx) {
    const o = own(orders, ctx.params.id, ctx.merchantKey);
    if (!o) return notFound();
    ctx.record.resourceId = o.id;
    if (o.authorizationId) return fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_AUTHORIZED');
    if (o.status !== 'APPROVED') return fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED');
    const status = takeFault('authorize', ctx.merchantKey, ['status']);
    const expire = takeFault('authorize', ctx.merchantKey, ['expire']);
    counters.authorization += 1;
    const id = `STUBAUTH${String(counters.authorization).padStart(6, '0')}`;
    const created = nowMs();
    const a = {
      id, orderId: o.id, merchantKey: o.merchantKey, status: status ? status.value : 'CREATED', amountCents: o.amountCents,
      currency: o.currency, createdMs: created, expiresMs: expire ? created : created + AUTHORIZATION_TTL_MS,
    };
    authorizations.set(id, a);
    o.authorizationId = id;
    o.status = 'COMPLETED';
    ctx.record.resourceId = id;
    return {
      status: 201,
      body: {
        id: o.id, status: 'COMPLETED', payer: payerJson(), payment_source: paymentSourceJson(),
        purchase_units: [{ reference_id: o.referenceId, payments: { authorizations: [authJson(a)] } }],
      },
    };
  }

  function getAuthorization(ctx) {
    const a = own(authorizations, ctx.params.id, ctx.merchantKey);
    if (!a) return notFound();
    ctx.record.resourceId = a.id;
    return { status: 200, body: authJson(a) };
  }

  function captureAuthorization(ctx) {
    const a = own(authorizations, ctx.params.id, ctx.merchantKey);
    if (!a) return notFound();
    ctx.record.resourceId = a.id;
    const status = authStatus(a);
    const refusal = {
      CAPTURED: 'AUTHORIZATION_ALREADY_CAPTURED', VOIDED: 'AUTHORIZATION_VOIDED', EXPIRED: 'AUTHORIZATION_EXPIRED',
      PENDING: 'AUTHORIZATION_PENDING', DENIED: 'AUTHORIZATION_DENIED',
    }[status];
    if (refusal) return fail(422, 'UNPROCESSABLE_ENTITY', refusal);
    const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    let cents = a.amountCents;
    if (b.amount !== undefined) {
      cents = centsOf(b.amount?.value);
      if (cents === null || cents <= 0 || b.amount.currency_code !== 'USD') return fail(422, 'UNPROCESSABLE_ENTITY', 'DECIMAL_PRECISION');
      if (cents > a.amountCents) return fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_AMOUNT_EXCEEDED');
    }
    const scenario = takeFault('capture', ctx.merchantKey, ['status']);
    const capStatus = scenario ? scenario.value : 'COMPLETED';
    counters.capture += 1;
    const id = `STUBCAP${String(counters.capture).padStart(6, '0')}`;
    const c = {
      id, authorizationId: a.id, orderId: a.orderId, merchantKey: a.merchantKey, status: capStatus, amountCents: cents,
      currency: 'USD', invoiceId: b.invoice_id ?? null, createdMs: nowMs(), refundedCents: 0,
    };
    captures.set(id, c);
    if (capStatus !== 'DECLINED') a.status = 'CAPTURED';
    ctx.record.resourceId = id;
    return { status: 201, body: captureJson(c) };
  }

  function getCapture(ctx) {
    const c = own(captures, ctx.params.id, ctx.merchantKey);
    if (!c) return notFound();
    ctx.record.resourceId = c.id;
    return { status: 200, body: captureJson(c) };
  }

  function voidAuthorization(ctx) {
    const a = own(authorizations, ctx.params.id, ctx.merchantKey);
    if (!a) return notFound();
    ctx.record.resourceId = a.id;
    if (takeFault('void', ctx.merchantKey, ['reject'])) return fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_CANNOT_BE_VOIDED');
    const status = authStatus(a);
    if (status === 'CAPTURED') return fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED');
    if (status === 'VOIDED') return fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED');
    if (status === 'EXPIRED') return fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_EXPIRED');
    a.status = 'VOIDED';
    return { status: 204, body: null };
  }

  function refundCapture(ctx) {
    const c = own(captures, ctx.params.id, ctx.merchantKey);
    if (!c) return notFound();
    ctx.record.resourceId = c.id;
    if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED' && c.status !== 'REFUNDED') {
      return fail(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_NOT_COMPLETED');
    }
    const remaining = c.amountCents - c.refundedCents;
    if (remaining <= 0) return fail(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED');
    const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    let cents = remaining;
    if (b.amount !== undefined) {
      cents = centsOf(b.amount?.value);
      if (cents === null || cents <= 0 || b.amount.currency_code !== 'USD') return fail(422, 'UNPROCESSABLE_ENTITY', 'DECIMAL_PRECISION');
      if (cents > remaining) return fail(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED');
    }
    const scenario = takeFault('refund', ctx.merchantKey, ['status']);
    const status = scenario ? scenario.value : 'COMPLETED';
    counters.refund += 1;
    const id = `STUBREF${String(counters.refund).padStart(6, '0')}`;
    const r = {
      id, captureId: c.id, orderId: c.orderId, merchantKey: c.merchantKey, status, amountCents: cents, currency: 'USD',
      note: b.note_to_payer ?? null, createdMs: nowMs(),
    };
    refunds.set(id, r);
    if (status !== 'FAILED' && status !== 'CANCELLED') {
      c.refundedCents += cents;
      c.status = c.refundedCents >= c.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    }
    ctx.record.resourceId = id;
    return { status: 201, body: refundJson(r) };
  }

  function getRefund(ctx) {
    const r = own(refunds, ctx.params.id, ctx.merchantKey);
    if (!r) return notFound();
    ctx.record.resourceId = r.id;
    return { status: 200, body: refundJson(r) };
  }

  function verifyWebhook(ctx) {
    const b = ctx.body;
    const need = ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_id'];
    if (b === null || typeof b !== 'object' || need.some((k) => typeof b[k] !== 'string' || b[k] === '') || !('webhook_event' in b)) {
      return fail(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
    }
    const raw = rawMemberSpan(ctx.record.rawBody, 'webhook_event');
    ctx.record.webhookEventRaw = raw;
    let ok = raw !== null
      && b.webhook_id === merchants[ctx.merchantKey].webhookId
      && webhookAlgos.includes(b.auth_algo);
    if (ok) {
      ok = verifySignature(webhookSecret, {
        transmissionId: b.transmission_id, transmissionTime: b.transmission_time, rawBody: Buffer.from(raw, 'utf8'),
      }, b.transmission_sig);
    }
    return { status: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }

  const API = {
    create_order: createOrder, get_order: getOrder, authorize: authorizeOrder, get_authorization: getAuthorization,
    capture: captureAuthorization, get_capture: getCapture, void: voidAuthorization, refund: refundCapture,
    get_refund: getRefund, verify_webhook: verifyWebhook,
  };

  // ---- OAuth ----------------------------------------------------------------------------------------------------

  function basicMerchant(record) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(record.headers.authorization ?? '');
    const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    const sep = decoded.indexOf(':');
    const id = sep >= 0 ? decoded.slice(0, sep) : '';
    const secret = sep >= 0 ? decoded.slice(sep + 1) : '';
    return Object.keys(merchants).find((k) => merchants[k].clientId === id && merchants[k].clientSecret === secret) ?? null;
  }

  function tokenEndpoint(ctx) {
    if (ctx.body?.grant_type !== 'client_credentials') {
      return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' } };
    }
    counters.token += 1;
    const token = `A21AASTUB${counters.token}${randomBytes(12).toString('hex')}`;
    tokens.set(token, { merchantKey: ctx.merchantKey, expiresMs: nowMs() + tokenTtlSeconds * 1000 });
    everIssued.push(token);
    return {
      status: 200,
      body: {
        scope: 'https://uri.paypal.com/services/payments/payment', access_token: token, token_type: 'Bearer',
        app_id: 'APP-STUB-SIMULATED', expires_in: tokenTtlSeconds, nonce: 'stub-nonce',
      },
    };
  }

  function authenticate(record) {
    const m = /^Bearer (\S+)$/.exec(record.headers.authorization ?? '');
    const t = m ? tokens.get(m[1]) : undefined;
    if (!t || nowMs() >= t.expiresMs) return null;
    return t.merchantKey;
  }

  // ---- approval page (F-TR-14) ----------------------------------------------------------------------------------------

  function pageHeaders() {
    return { ...approvalListenerHeaders(appOrigin), 'content-type': 'text/html; charset=utf-8' };
  }

  function page(res, record, status, title, inner) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
      + `<body><h1>${escapeHtml(title)}</h1>${inner}</body></html>`;
    reply(res, record, status, html, pageHeaders());
  }

  function approvalRoute(kind, req, res, record, params, url) {
    const id = kind === 'approval_page' ? url.searchParams.get('token') : params.id;
    const o = id ? orders.get(id) : undefined;
    record.resourceId = o ? o.id : null;
    const banner = 'Simulated PayPal approval — local test stub, not PayPal';
    if (!o) return page(res, record, 404, banner, '<p>Unknown order.</p>');
    if (kind === 'approval_page') {
      const inner = `<p>Amount: ${escapeHtml(valueOf(o.amountCents))} ${escapeHtml(o.currency)}</p>`
        + `<form method="post" action="/checkoutnow/${escapeHtml(o.id)}/approve"><button type="submit">Approve (simulated)</button></form>`
        + `<form method="post" action="/checkoutnow/${escapeHtml(o.id)}/cancel"><button type="submit">Cancel</button></form>`;
      return page(res, record, 200, banner, inner);
    }
    if (kind === 'cancel') {
      const target = new URL(o.cancelUrl);
      target.searchParams.set('token', o.id);
      return reply(res, record, 303, null, { ...approvalListenerHeaders(appOrigin), location: target.toString() });
    }
    // approve
    if (o.status === 'CREATED' && takeFault('approve', o.merchantKey, ['refuse'])) {
      return page(res, record, 409, banner, '<p>This order cannot be approved.</p>');
    }
    if (o.status !== 'CREATED' && o.status !== 'APPROVED') return page(res, record, 409, banner, '<p>This order cannot be approved.</p>');
    o.status = 'APPROVED';
    o.payerApproved = true;
    const target = new URL(o.returnUrl);
    target.searchParams.set('token', o.id);
    target.searchParams.set('PayerID', FAKE_PAYER.payerId);
    return reply(res, record, 303, null, { ...approvalListenerHeaders(appOrigin), location: target.toString() });
  }

  // ---- request pipeline -------------------------------------------------------------------------------------------

  async function handle(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end('{"name":"PAYLOAD_TOO_LARGE"}');
      req.destroy();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = ROUTES.map(([method, re, kind, names]) => {
      const m = req.method === method ? re.exec(url.pathname) : null;
      return m ? { kind, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) } : null;
    }).find(Boolean);
    const rawBody = raw.toString('utf8');
    const record = {
      seq: calls.length + 1,
      kind: route ? route.kind : 'unknown',
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      rawBody,
      body: null,
      requestId: typeof req.headers['paypal-request-id'] === 'string' ? req.headers['paypal-request-id'] : null,
      merchantKey: null,
      replayed: false,
      fault: null,
      status: null,
      responseBody: null,
      resourceId: null,
    };
    calls.push(record);
    if (!route) return reply(res, record, 404, fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID').body);

    const { kind, params } = route;
    if (kind === 'approval_page' || kind === 'approve' || kind === 'cancel') {
      return approvalRoute(kind, req, res, record, params, url);
    }

    if (rawBody !== '') {
      const type = String(req.headers['content-type'] ?? '');
      try {
        record.body = type.includes('application/x-www-form-urlencoded')
          ? Object.fromEntries(new URLSearchParams(rawBody))
          : JSON.parse(rawBody);
      } catch {
        return reply(res, record, 400, fail(400, 'INVALID_REQUEST', 'MALFORMED_REQUEST_JSON').body);
      }
    }
    const ctx = { record, params, body: record.body, merchantKey: null };

    // 1. Authentication: the token endpoint checks the basic credentials, everything else a bearer token.
    if (kind === 'token') {
      ctx.merchantKey = basicMerchant(record);
      if (!ctx.merchantKey) {
        return reply(res, record, 401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      }
    } else {
      ctx.merchantKey = authenticate(record);
      if (!ctx.merchantKey) {
        return reply(res, record, 401, { name: 'AUTHENTICATION_FAILURE', message: `Authentication failed ${BODY_MARKER}`, links: [] });
      }
    }
    record.merchantKey = ctx.merchantKey;

    // 2. Faults that stop the call before it has any effect.
    const pre = takeFault(kind, ctx.merchantKey, ['http', 'timeout']);
    if (pre) {
      record.fault = pre.name;
      if (pre.type === 'timeout') {
        held.add(res);
        res.on('close', () => held.delete(res));
        return null; // never answered
      }
      const named = HTTP_ERRORS[pre.status] ?? ['INJECTED_ERROR', 'INJECTED_ERROR'];
      return reply(res, record, pre.status, fail(pre.status, named[0], named[1]).body);
    }
    const post = takeFault(kind, ctx.merchantKey, ['lost', 'bad_body']);
    if (post) record.fault = post.name;

    // 3. Replay by PayPal-Request-Id (mutating calls only), else apply the effect.
    let result = null;
    let replayKey = null;
    if (MUTATING.has(kind)) {
      if (record.requestId === null && requireRequestId) {
        return reply(res, record, 400, fail(400, 'INVALID_REQUEST', 'MISSING_REQUEST_ID').body);
      }
      if (record.requestId !== null) {
        replayKey = `${ctx.merchantKey}\u0000${record.requestId}`;
        const stored = replays.get(replayKey);
        if (stored && stored.kind !== kind) {
          return reply(res, record, 422, fail(422, 'UNPROCESSABLE_ENTITY', 'REQUEST_ID_KIND_MISMATCH').body);
        }
        if (stored) {
          record.replayed = true;
          record.resourceId = stored.resourceId;
          result = stored.result;
        }
      }
    }
    if (!result) {
      result = kind === 'token' ? tokenEndpoint(ctx) : API[kind](ctx);
      if (replayKey && result.status >= 200 && result.status < 300) {
        replays.set(replayKey, { kind, result, resourceId: record.resourceId });
      }
    }

    // 4. Faults that act after the effect: the answer is lost or unreadable.
    if (post && post.type === 'lost') {
      record.status = null;
      res.socket.destroy();
      return null;
    }
    if (post && post.type === 'bad_body') {
      return reply(res, record, 200, 'stub: this answer is not JSON', { 'content-type': 'text/plain' });
    }
    return reply(res, record, result.status, result.body, result.headers);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"name":"STUB_INTERNAL_ERROR"}');
      } else {
        res.destroy();
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;

  function releaseHeld() {
    for (const res of held) res.socket?.destroy();
    held.clear();
  }

  function snapshotOf(map, id) {
    const r = map.get(id);
    return r ? { ...r } : null;
  }

  return {
    host: '127.0.0.1',
    port,
    baseUrl: origin,
    clock,
    merchants,
    webhookSecret,
    get appOrigin() { return appOrigin; },
    set appOrigin(value) { appOrigin = value; },
    calls,
    callsOf(kind, { replayed } = {}) {
      return calls.filter((c) => c.kind === kind && (replayed === undefined || c.replayed === replayed));
    },
    lastCall(kind) {
      const list = calls.filter((c) => c.kind === kind);
      return list.length ? list[list.length - 1] : null;
    },
    counts() {
      const out = {};
      for (const c of calls) out[c.kind] = (out[c.kind] ?? 0) + 1;
      return out;
    },
    clearCalls() { calls.length = 0; },
    fault(name, { count = 1, merchantKey = null } = {}) {
      const parsed = parseFaultName(name);
      if (count !== Infinity && (!Number.isInteger(count) || count < 1)) throw new RangeError('count must be a positive integer');
      faults.push({ ...parsed, remaining: count, fired: 0, merchantKey });
    },
    faultsFired() { return faults.map((f) => ({ name: f.name, fired: f.fired, remaining: f.remaining })); },
    clearFaults() { faults.length = 0; releaseHeld(); },
    releaseHeld,
    // Programmatic buyer approval (the same state change as the approval page's POST, without the redirect).
    approve(orderId) {
      const o = orders.get(orderId);
      if (!o) throw new RangeError(`unknown order ${orderId}`);
      if (o.status !== 'CREATED' && o.status !== 'APPROVED') throw new RangeError(`order ${orderId} is ${o.status}`);
      o.status = 'APPROVED';
      o.payerApproved = true;
    },
    approvalUrl(orderId) { return approvalHref(orderId); },
    order: (id) => snapshotOf(orders, id),
    authorization: (id) => {
      const a = snapshotOf(authorizations, id);
      return a ? { ...a, status: authStatus(a) } : null;
    },
    capture: (id) => snapshotOf(captures, id),
    refund: (id) => snapshotOf(refunds, id),
    counters: () => ({ ...counters }),
    expireTokens() { tokens.clear(); },
    // Every access token this stub ever issued (a log must contain none of them).
    issuedTokens() { return [...everIssued]; },
    async close() {
      releaseHeld();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
