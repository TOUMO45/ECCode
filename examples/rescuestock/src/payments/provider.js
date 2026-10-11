// The PaymentProvider port (spec: Interface Contracts > Internal module contracts) and the helpers both adapters share.
//
//   { id: "fake"|"paypal-sandbox", simulated, sandbox,
//     createOrder, getOrder, authorizeOrder, getAuthorization, captureAuthorization, getCapture,
//     voidAuthorization, refundCapture, getRefund, verifyWebhook }       (every method returns a Promise<Outcome>)
//
// Outcome<T> = { kind: "ok", value, httpStatus }
//            | { kind: "rejected", httpStatus, issue }    definitive 4xx: the provider applied nothing
//            | { kind: "retryable", httpStatus, issue }   401/403/429: nothing applied, safe to retry later
//            | { kind: "unknown", reason: "timeout"|"network"|"http_5xx"|"bad_body" }   the effect may have happened
//
// A method never throws for a provider answer, a timeout or a bad argument: a bad argument is a `rejected` Outcome
// (400 INVALID_ARGUMENT) returned before anything is sent. requestId is provider_calls.operation_key, sent as
// PayPal-Request-Id. This file has no static import of an adapter, so it can be loaded by both of them.
import { MERCHANT_KEYS } from '../config.js';

export const PROVIDER_IDS = Object.freeze(['fake', 'paypal-sandbox']);
export const PROVIDER_METHODS = Object.freeze([
  'createOrder', 'getOrder', 'authorizeOrder', 'getAuthorization', 'captureAuthorization', 'getCapture',
  'voidAuthorization', 'refundCapture', 'getRefund', 'verifyWebhook',
]);
// The call kinds of fake_paypal_calls, of the paypal-stub and of the fault grammar (`<fault>:<kind>`).
export const CALL_KINDS = Object.freeze([
  'create_order', 'get_order', 'authorize', 'get_authorization', 'capture', 'get_capture', 'void', 'refund', 'get_refund',
  'verify_webhook',
]);
export const MUTATING_KINDS = Object.freeze(['create_order', 'authorize', 'capture', 'void', 'refund']);
export const UNKNOWN_REASONS = Object.freeze(['timeout', 'network', 'http_5xx', 'bad_body']);

export const MAX_AMOUNT_CENTS = 999_999_999;
export const MAX_WEBHOOK_BODY_BYTES = 65_536;
export const WEBHOOK_HEADER_NAMES = Object.freeze([
  'paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo',
]);
const MAX_HEADER_VALUE = 1024;

// ---- Outcomes ---------------------------------------------------------------------------------------------------------

export const ok = (value, httpStatus = 200) => ({ kind: 'ok', value, httpStatus });
export const rejected = (httpStatus, issue) => ({ kind: 'rejected', httpStatus, issue });
export const retryable = (httpStatus, issue) => ({ kind: 'retryable', httpStatus, issue });
export const unknown = (reason) => ({ kind: 'unknown', reason });

// Money: integer cents -> the decimal string PayPal wants, with no floating point ("1250" -> "12.50").
export function toPayPalValue(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('toPayPalValue needs a non-negative integer number of cents');
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ---- argument validation (the boundary of the port) ---------------------------------------------------------------------

const ID = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_ATTEMPT = 999;
const REFERENCE =/^[A-Za-z0-9._:-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,108}$/;
const invalid = () => rejected(400, 'INVALID_ARGUMENT');

export function isHttpUrl(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2048) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

const isId = (v) => typeof v === 'string' && ID.test(v);
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_AMOUNT_CENTS;

// kind -> the argument names that must be valid ids. Returns null when the arguments are acceptable, else the `rejected`
// Outcome to hand back at once. Nothing is sent or stored for a rejected argument.
export function checkArguments(kind, args) {
  if (args === null || typeof args !== 'object') return invalid();
  if (!MERCHANT_KEYS.includes(args.merchantKey)) return invalid();
  if (MUTATING_KINDS.includes(kind) && !(typeof args.requestId === 'string' && REQUEST_ID.test(args.requestId))) return invalid();
  switch (kind) {
    case 'create_order':
      if (!isAmount(args.amountCents) || args.currency !== 'USD') return invalid();
      if (typeof args.referenceId !== 'string' || !REFERENCE.test(args.referenceId)) return invalid();
      if (!isHttpUrl(args.returnUrl) || !isHttpUrl(args.cancelUrl)) return invalid();
      // attempt (A13 re-create counter) is optional and defaults to 1; when given it is a positive integer up to MAX_ATTEMPT.
      if (args.attempt !== undefined && !(Number.isInteger(args.attempt) && args.attempt >= 1 && args.attempt <= MAX_ATTEMPT)) return invalid();
      return null;
    case 'get_order':
    case 'authorize':
      return isId(args.orderId) ? null : invalid();
    case 'get_authorization':
    case 'void':
      return isId(args.authorizationId) ? null : invalid();
    case 'capture':
      if (!isId(args.authorizationId) || !isAmount(args.amountCents) || args.currency !== 'USD') return invalid();
      if (args.invoiceId !== undefined && args.invoiceId !== null && !(typeof args.invoiceId === 'string' && REFERENCE.test(args.invoiceId))) return invalid();
      return null;
    case 'get_capture':
      return isId(args.captureId) ? null : invalid();
    case 'refund':
      return isId(args.captureId) && isAmount(args.amountCents) && args.currency === 'USD' ? null : invalid();
    case 'get_refund':
      return isId(args.refundId) ? null : invalid();
    case 'verify_webhook':
      return null; // handled by webhookInput
    default:
      return invalid();
  }
}

// verifyWebhook({ merchantKey, headers, rawBody }): headers is an object with lower-case names (Node's req.headers), rawBody
// the exact received bytes (Buffer, Uint8Array or string). Returns { complete: false } when a signature header is missing or
// malformed (the caller answers ok { verified: false }), { invalid: Outcome } for a bad merchant key or an unusable body, else
// { complete: true, headers: {name: value}, body: Buffer }.
export function webhookInput(args) {
  if (args === null || typeof args !== 'object' || !MERCHANT_KEYS.includes(args.merchantKey)) return { invalid: invalid() };
  const raw = args.rawBody;
  let body;
  if (Buffer.isBuffer(raw)) body = raw;
  else if (raw instanceof Uint8Array) body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (typeof raw === 'string') body = Buffer.from(raw, 'utf8');
  else return { invalid: invalid() };
  if (body.length === 0 || body.length > MAX_WEBHOOK_BODY_BYTES) return { invalid: invalid() };
  const source = args.headers;
  const headers = {};
  if (source !== null && typeof source === 'object') {
    for (const name of WEBHOOK_HEADER_NAMES) {
      const value = source[name];
      if (typeof value !== 'string' || value === '' || value.length > MAX_HEADER_VALUE) return { complete: false };
      headers[name] = value;
    }
    return { complete: true, headers, body };
  }
  return { complete: false };
}

// ---- the port --------------------------------------------------------------------------------------------------------------

export function assertPaymentProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('A PaymentProvider is an object');
  if (!PROVIDER_IDS.includes(provider.id)) throw new TypeError(`PaymentProvider id must be one of ${PROVIDER_IDS.join(', ')}`);
  if (typeof provider.simulated !== 'boolean' || typeof provider.sandbox !== 'boolean') {
    throw new TypeError('PaymentProvider needs boolean simulated and sandbox flags');
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') throw new TypeError(`PaymentProvider is missing ${method}()`);
  }
  return provider;
}

// createPayments({ config, db, clock, log, appOrigin }) -> Promise<{ provider, listener, close }>
//   fake            the DB-backed fake and its approval listener (second node:http listener, started here)
//   paypal-sandbox  the Sandbox REST adapter; there is no listener
// `appOrigin` is the origin of the app (a string or a function returning it, because the port is known only after the app
// listens): it is the origin of the stored return/cancel URLs and is listed in the listener's CSP form-action.
// `listener` is null for the Sandbox. Adapters are imported here, not at the top, so loading the port loads neither.
export async function createPayments({ config, db, clock, log, appOrigin, overrides = {} }) {
  if (!config) throw new TypeError('createPayments needs a configuration');
  if (config.paymentProvider === 'fake') {
    if (!db) throw new TypeError('The fake payment provider needs the database');
    const { createFakeProvider } = await import('./fake.js');
    const { startApprovalListener } = await import('./listener.js');
    const listener = await startApprovalListener({ db, clock, config, log, appOrigin, ...(overrides.listener ?? {}) });
    let provider;
    try {
      provider = createFakeProvider({
        db, clock, log, testHooks: config.testHooks, webhookSecret: config.fakeWebhookSecret ?? undefined,
        approvalOrigin: () => listener.origin, ...(overrides.fake ?? {}),
      });
    } catch (err) {
      await listener.close();
      throw err;
    }
    return { provider: assertPaymentProvider(provider), listener, close: () => listener.close() };
  }
  if (config.paymentProvider === 'paypal-sandbox') {
    const { createSandboxProvider } = await import('./sandbox.js');
    const { sandboxMerchants } = await import('./merchants.js');
    const provider = createSandboxProvider({
      baseUrl: config.paypalBaseUrl, merchants: sandboxMerchants(config), timeoutMs: config.paypalTimeoutMs, testOffline: config.testOffline,
      log, clock, ...(overrides.sandbox ?? {}),
    });
    return { provider: assertPaymentProvider(provider), listener: null, close: async () => {} };
  }
  throw new RangeError('Unknown payment provider');
}
