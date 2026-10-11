// The PayPal Sandbox adapter (RS_PAYMENT_PROVIDER=paypal-sandbox): PayPal REST, Orders v2 and Payments v2, mapped as in the
// spec's "PayPal Sandbox wire mapping" (every row to be verified on Sandbox).
//
// LIVE-DEPENDENT. In this repository it is verified only against the loopback double test/helpers/paypal-stub.js under
// RS_TEST_OFFLINE=1; no Sandbox host is contacted by the tests and no credential exists. The issue names, link rels and status sets
// are the spec's guesses until the opt-in live suite (RS_LIVE_PAYPAL=1) has run.
//
// Rules this file keeps:
//   - one AbortSignal.timeout(timeoutMs) per call covers the OAuth fetch, the API fetch and the body reads (RS_PAYPAL_TIMEOUT_MS);
//   - OAuth tokens are cached per merchant until `expires_in - 60 s` (an injected clock); a 401 drops the cached token;
//   - classification: 2xx with a parseable body -> ok; 400/404/409/422 (and other 4xx) -> rejected with PayPal's details[0].issue or
//     name (only if it looks like an upper-case token: a provider message is never copied); 401/403/429 -> retryable;
//     5xx, timeout, network error, unparsable or oversized 2xx body, a redirect -> unknown;
//   - the approval link must be https on www.sandbox.paypal.com (a loopback http host only with testOffline), else
//     rejected APPROVAL_HOST_INVALID (SEC-3, T17); redirects are never followed (a Bearer token must not leave the host);
//   - verifyWebhook splices the received body BYTES into the request JSON (after proving they are one JSON object);
//   - credentials arrive as Secret values and are revealed only to build the Authorization header; no log line, Outcome or error
//     carries a token, a credential, a request or response body, a URL or payer data.
import { systemClock } from '../clock.js';
import { PAYPAL_SANDBOX_API } from '../config.js';
import { silentLogger } from '../log.js';
import {
  MUTATING_KINDS, checkArguments, ok, rejected, retryable, toPayPalValue, unknown, webhookInput,
} from './provider.js';

export const SANDBOX_PROVIDER_ID = 'paypal-sandbox';
export const APPROVAL_HOST = 'www.sandbox.paypal.com';
export const TOKEN_SAFETY_SECONDS = 60;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const APPROVAL_RELS = Object.freeze(['payer-action', 'approve']);
const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const ISSUE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/;
const AUTHORIZATION_STATUSES = Object.freeze(['CREATED', 'PENDING', 'DENIED']);
const CAPTURE_STATUSES = Object.freeze(['COMPLETED', 'PENDING', 'DECLINED']);
const REFUND_STATUSES = Object.freeze(['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED']);

const reveal = (secret) => {
  if (secret && typeof secret.reveal === 'function') return secret.reveal();
  return typeof secret === 'string' ? secret : null;
};

// The text of a PayPal error, reduced to an upper-case token or a status-derived default. Never a message.
function issueOf(parsed, status) {
  const first = parsed && typeof parsed === 'object' ? parsed.details?.[0]?.issue : undefined;
  if (typeof first === 'string' && ISSUE_TOKEN.test(first)) return first;
  const name = parsed && typeof parsed === 'object' ? parsed.name : undefined;
  if (typeof name === 'string' && ISSUE_TOKEN.test(name)) return name;
  return `HTTP_${status}`;
}

// Status + body text -> an Outcome whose value is the parsed JSON object ({} for an empty 2xx).
export function classifyResponse(status, text) {
  if (status >= 200 && status < 300) {
    if (text === '') return ok({}, status);
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return unknown('bad_body');
      return ok(value, status);
    } catch {
      return unknown('bad_body');
    }
  }
  if (status >= 300 && status < 400) return unknown('bad_body');
  if (status >= 500) return unknown('http_5xx');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the status alone classifies.
  }
  const issue = issueOf(parsed, status);
  if (status === 401 || status === 403 || status === 429) return retryable(status, issue);
  return rejected(status, issue);
}

function failureOutcome(err) {
  const name = err && err.name;
  return unknown(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

// The approval link is where the BUYER is sent: it must be PayPal's Sandbox page (T17).
export function approvalHostAllowed(href, testOffline) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:' && url.hostname === APPROVAL_HOST && url.port === '') return true;
  return testOffline === true && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

async function readCapped(res, signal) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

const tail = (href) => String(href ?? '').split('?')[0].split('/').filter(Boolean).pop();
const linkTo = (links, rel) => (Array.isArray(links) ? links.find((l) => l && l.rel === rel)?.href : undefined);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

// createSandboxProvider({ baseUrl, merchants, timeoutMs, testOffline, log, clock, fetch })
//   merchants  { KEY: { clientId, clientSecret, webhookId } } with Secret (or plain string) values.
//   baseUrl    https://api-m.sandbox.paypal.com, or a loopback http://127.0.0.1:<port> only with testOffline (the stub).
export function createSandboxProvider({
  baseUrl = PAYPAL_SANDBOX_API, merchants = {}, timeoutMs = 20000, testOffline = false, log = silentLogger(), clock = systemClock, fetch: fetchImpl,
} = {}) {
  const base = typeof baseUrl === 'string' && baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (base !== PAYPAL_SANDBOX_API && !(testOffline === true && LOOPBACK_BASE.test(base ?? ''))) {
    throw new RangeError(`The Sandbox adapter talks only to ${PAYPAL_SANDBOX_API} (a loopback stub only with RS_TEST_OFFLINE=1)`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  const tokens = new Map();

  async function token(merchantKey, signal) {
    const cached = tokens.get(merchantKey);
    if (cached && clock.now() < cached.expiresAtMs) return { token: cached.value };
    const creds = merchants[merchantKey];
    const id = reveal(creds?.clientId);
    const secret = reveal(creds?.clientSecret);
    if (!id || !secret) return { outcome: rejected(400, 'MERCHANT_NOT_CONFIGURED') };
    const res = await (fetchImpl ?? globalThis.fetch)(`${base}/v1/oauth2/token`, {
      method: 'POST',
      signal,
      redirect: 'manual',
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await readCapped(res, signal);
    const outcome = text === null ? unknown('bad_body') : classifyResponse(res.status, text);
    if (outcome.kind !== 'ok') return { outcome };
    const value = str(outcome.value.access_token);
    const ttl = outcome.value.expires_in;
    if (!value || !Number.isFinite(ttl) || ttl <= 0) return { outcome: unknown('bad_body') };
    tokens.set(merchantKey, { value, expiresAtMs: clock.now() + Math.max(0, ttl - TOKEN_SAFETY_SECONDS) * 1000 });
    return { token: value };
  }

  // One REST call: OAuth (cached) + the request, all under one deadline. Returns an Outcome whose ok value is the parsed body.
  async function call(kind, merchantKey, method, path, { body, requestId, prefer } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    let outcome;
    try {
      const t = await token(merchantKey, signal);
      if (t.outcome) {
        outcome = t.outcome;
      } else {
        const headers = { authorization: `Bearer ${t.token}`, accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (requestId) headers['paypal-request-id'] = requestId;
        if (prefer) headers.prefer = prefer;
        const res = await (fetchImpl ?? globalThis.fetch)(`${base}${path}`, { method, signal, redirect: 'manual', headers, body });
        const text = await readCapped(res, signal);
        outcome = text === null ? unknown('bad_body') : classifyResponse(res.status, text);
        if (res.status === 401) tokens.delete(merchantKey); // the next call fetches a fresh token
      }
    } catch (err) {
      outcome = failureOutcome(err);
    }
    log.info('provider.call', {
      kind, provider: SANDBOX_PROVIDER_ID, httpStatus: outcome.httpStatus, operationKey: MUTATING_KINDS.includes(kind) ? requestId : undefined,
      code: outcome.kind === 'ok' ? undefined : outcome.issue ?? outcome.reason,
    });
    return outcome;
  }

  const label = (value) => ({ ...value, provider: SANDBOX_PROVIDER_ID, sandbox: true });
  // Maps the ok value of an Outcome; `map` returns the new value or null when the answer lacks what the port promises.
  const mapped = (outcome, map) => {
    if (outcome.kind !== 'ok') return outcome;
    const value = map(outcome.value);
    return value ? ok(label(value), outcome.httpStatus) : unknown('bad_body');
  };
  const money = (cents, currency) => ({ currency_code: currency, value: toPayPalValue(cents) });
  // A bad argument is a `rejected` Outcome returned before anything is sent; every method returns a Promise.
  const guarded = async (kind, args, send) => checkArguments(kind, args) ?? send();
  const enc = encodeURIComponent;

  return Object.freeze({
    id: SANDBOX_PROVIDER_ID,
    simulated: false,
    sandbox: true,

    createOrder(args) {
      return guarded('create_order', args, async () => {
        const { merchantKey, requestId, amountCents, currency, referenceId, returnUrl, cancelUrl } = args;
        const body = JSON.stringify({
          intent: 'AUTHORIZE',
          purchase_units: [{
            reference_id: referenceId, custom_id: referenceId, invoice_id: `rs-${referenceId}-a1`, description: 'RescueStock demo order (Sandbox)',
            amount: money(amountCents, currency),
          }],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'RescueStock Sandbox Demo',
              },
            },
          },
        });
        const outcome = await call('create_order', merchantKey, 'POST', '/v2/checkout/orders', { body, requestId, prefer: 'return=minimal' });
        if (outcome.kind !== 'ok') return outcome;
        const orderId = str(outcome.value.id);
        const status = str(outcome.value.status);
        if (!orderId || !status) return unknown('bad_body');
        const href = APPROVAL_RELS.map((rel) => linkTo(outcome.value.links, rel)).find((h) => typeof h === 'string');
        if (!href) return rejected(outcome.httpStatus, 'APPROVAL_LINK_MISSING');
        if (!approvalHostAllowed(href, testOffline)) return rejected(outcome.httpStatus, 'APPROVAL_HOST_INVALID');
        return ok(label({ orderId, approvalUrl: href, status }), outcome.httpStatus);
      });
    },

    getOrder(args) {
      return guarded('get_order', args, async () => {
        const outcome = await call('get_order', args.merchantKey, 'GET', `/v2/checkout/orders/${enc(args.orderId)}`);
        return mapped(outcome, (v) => {
          const status = str(v.status);
          const payments = v.purchase_units?.[0]?.payments ?? {};
          if (!status || typeof payments !== 'object') return null;
          const list = (key) => (Array.isArray(payments[key]) ? payments[key] : []);
          const authorizations = list('authorizations').map((a) => ({ id: str(a?.id), status: str(a?.status), expirationTime: str(a?.expiration_time) }));
          const captures = list('captures').map((c) => ({ id: str(c?.id), status: str(c?.status), authorizationId: str(tail(linkTo(c?.links, 'up'))) }));
          const refunds = list('refunds').map((r) => ({ id: str(r?.id), status: str(r?.status), captureId: str(tail(linkTo(r?.links, 'up'))) }));
          const complete = authorizations.every((a) => a.id && a.status) && captures.every((c) => c.id && c.status) && refunds.every((r) => r.id && r.status);
          return complete ? { status, authorizations, captures, refunds } : null;
        });
      });
    },

    authorizeOrder(args) {
      return guarded('authorize', args, async () => {
        const outcome = await call('authorize', args.merchantKey, 'POST', `/v2/checkout/orders/${enc(args.orderId)}/authorize`, { body: '{}', requestId: args.requestId });
        return mapped(outcome, (v) => {
          const a = v.purchase_units?.[0]?.payments?.authorizations?.[0];
          const authorizationId = str(a?.id);
          // An authorization that is already EXPIRED when it is returned (the simulated auth_expire) was still created: the port
          // reports CREATED and the past expirationTime carries the expiry, as the fake does; a later read shows EXPIRED.
          const status = a?.status === 'EXPIRED' ? 'CREATED' : a?.status;
          if (!authorizationId || !AUTHORIZATION_STATUSES.includes(status)) return null;
          return { authorizationId, status, expirationTime: str(a.expiration_time) };
        });
      });
    },

    getAuthorization(args) {
      return guarded('get_authorization', args, async () => {
        const outcome = await call('get_authorization', args.merchantKey, 'GET', `/v2/payments/authorizations/${enc(args.authorizationId)}`);
        return mapped(outcome, (v) => (str(v.status) ? { status: v.status, expirationTime: str(v.expiration_time) } : null));
      });
    },

    captureAuthorization(args) {
      return guarded('capture', args, async () => {
        const payload = { amount: money(args.amountCents, args.currency), final_capture: true };
        if (args.invoiceId) payload.invoice_id = args.invoiceId;
        const outcome = await call('capture', args.merchantKey, 'POST', `/v2/payments/authorizations/${enc(args.authorizationId)}/capture`, {
          body: JSON.stringify(payload), requestId: args.requestId,
        });
        return mapped(outcome, (v) => (str(v.id) && CAPTURE_STATUSES.includes(v.status) ? { captureId: v.id, status: v.status } : null));
      });
    },

    getCapture(args) {
      return guarded('get_capture', args, async () => {
        const outcome = await call('get_capture', args.merchantKey, 'GET', `/v2/payments/captures/${enc(args.captureId)}`);
        return mapped(outcome, (v) => (str(v.status) ? { status: v.status } : null));
      });
    },

    voidAuthorization(args) {
      return guarded('void', args, async () => {
        const outcome = await call('void', args.merchantKey, 'POST', `/v2/payments/authorizations/${enc(args.authorizationId)}/void`, { requestId: args.requestId });
        return mapped(outcome, () => ({ status: 'VOIDED' })); // 204 or 200 = ok
      });
    },

    refundCapture(args) {
      return guarded('refund', args, async () => {
        const body = JSON.stringify({ amount: money(args.amountCents, args.currency), note_to_payer: 'RescueStock demo compensation' });
        const outcome = await call('refund', args.merchantKey, 'POST', `/v2/payments/captures/${enc(args.captureId)}/refund`, { body, requestId: args.requestId });
        return mapped(outcome, (v) => (str(v.id) && REFUND_STATUSES.includes(v.status) ? { refundId: v.id, status: v.status } : null));
      });
    },

    getRefund(args) {
      return guarded('get_refund', args, async () => {
        const outcome = await call('get_refund', args.merchantKey, 'GET', `/v2/payments/refunds/${enc(args.refundId)}`);
        return mapped(outcome, (v) => (str(v.status) ? { status: v.status } : null));
      });
    },

    // verifyWebhook({ merchantKey, headers, rawBody }): headers with lower-case names, rawBody the exact received bytes.
    // Missing or malformed signature headers, or a body that is not one JSON object, verify nothing: ok { verified: false }.
    async verifyWebhook(args) {
      const input = webhookInput(args);
      if (input.invalid) return input.invalid;
      if (!input.complete) return ok(label({ verified: false }), 200);
      const webhookId = reveal(merchants[args.merchantKey]?.webhookId);
      if (!webhookId) return rejected(400, 'WEBHOOK_ID_MISSING');
      let event;
      try {
        // ignoreBOM keeps a leading BOM in the text (JSON.parse then refuses it): the decoder must never change the bytes.
        event = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.body);
        const parsed = JSON.parse(event);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object');
      } catch {
        return ok(label({ verified: false }), 200);
      }
      const h = input.headers;
      const head = [
        ['auth_algo', h['paypal-auth-algo']], ['cert_url', h['paypal-cert-url']], ['transmission_id', h['paypal-transmission-id']],
        ['transmission_sig', h['paypal-transmission-sig']], ['transmission_time', h['paypal-transmission-time']], ['webhook_id', webhookId],
      ].map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
      // The received bytes are spliced in unchanged; the whole text was proved above to be exactly one JSON object.
      const body = `{${head},"webhook_event":${event}}`;
      const outcome = await call('verify_webhook', args.merchantKey, 'POST', '/v1/notifications/verify-webhook-signature', { body });
      return mapped(outcome, (v) => (str(v.verification_status) ? { verified: v.verification_status === 'SUCCESS' } : null));
    },
  });
}
