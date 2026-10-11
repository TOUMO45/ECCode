// SIMULATION. This module signs FAKE PayPal webhook events with a FAKE shared secret so tests can drive the
// webhook route and the verifyWebhook calls of the fake adapter and of the Sandbox adapter (through paypal-stub.js).
// It is NOT PayPal's real signature scheme (PayPal signs with an RSA certificate and a CRC32 of the body; this
// helper uses HMAC-SHA256 so no certificate, no network and no credential exist). Nothing here proves anything about
// the real service; the real scheme is exercised only by the opt-in live suite (RS_LIVE_PAYPAL=1), never by npm test.
//
// Verification contract shared by every verifier in the test suite (src/payments/fake.js `verifyWebhook`, the
// verify-webhook-signature endpoint of paypal-stub.js):
//
//   signingString = `${transmissionId}|${transmissionTime}|${sha256hex(rawBody)}`        (rawBody: the exact bytes)
//   signature     = base64( HMAC-SHA256( secret, signingString ) )
//
// The event body is signed and verified as BYTES. A verifier that parses and re-serialises the body (different
// whitespace, key order, unicode escapes) computes another hash and the signature fails; this is deliberate, it is the
// "splice the raw body bytes" rule of the spec's verifyWebhook row.
//
// Headers produced (lower-case names, as Node delivers them in req.headers):
//   paypal-transmission-id    `TX-` + 12 digits (<= 64 chars of [A-Za-z0-9-], passes the route's pre-check)
//   paypal-transmission-time  ISO-8601 UTC
//   paypal-transmission-sig   the base64 HMAC above
//   paypal-cert-url           https URL on a paypal.com host (never fetched by anything)
//   paypal-auth-algo          SHA256withRSA (the allow-list value; the label only, the math is HMAC)
//
// The secret: tests use RS_FAKE_WEBHOOK_SECRET when the harness set it, otherwise FAKE_WEBHOOK_SECRET below
// (>= 32 bytes, not placeholder-shaped, SEC-5). It protects nothing.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const FAKE_WEBHOOK_SECRET = 'rs-test-fake-webhook-secret-0123456789abcdef-SIMULATED';
export const FAKE_CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-SIMULATED-STUB';
export const FAKE_AUTH_ALGO = 'SHA256withRSA';
export const WEBHOOK_HEADER_NAMES = Object.freeze([
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
]);

// Fake payer data. paypal-stub.js puts these into its approved-order, authorize and getOrder responses, and
// buildEvent({ withPayer: true }) puts them into a webhook resource, so a test can prove that no log line, stored
// payload or Outcome ever carries them. Every value is unique enough to search for.
export const FAKE_PAYER = Object.freeze({
  payerId: 'STUBPAYERLEAK0001',
  email: 'leakcheck.payer@example.invalid',
  givenName: 'Leakcheckgiven',
  surname: 'Leakchecksurname',
  addressLine: '42 Leakcheck Payer Lane',
  postalCode: 'LK-90210',
});
export const PAYER_MARKERS = Object.freeze(Object.values(FAKE_PAYER));

export function webhookSecretFromEnv(env = process.env) {
  const value = env.RS_FAKE_WEBHOOK_SECRET;
  if (typeof value === 'string' && Buffer.byteLength(value) >= 32 && !/^<.*>$/.test(value)) return value;
  return FAKE_WEBHOOK_SECRET;
}

export function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new TypeError('rawBody must be a Buffer or a string');
}

export function signingString({ transmissionId, transmissionTime, rawBody }) {
  const digest = createHash('sha256').update(toBuffer(rawBody)).digest('hex');
  return `${transmissionId}|${transmissionTime}|${digest}`;
}

export function computeSignature(secret, parts) {
  if (typeof secret !== 'string' || secret === '') throw new TypeError('secret is required');
  return createHmac('sha256', secret).update(signingString(parts)).digest('base64');
}

// Constant-time comparison; false for anything that is not a matching signature (never throws on bad input).
export function verifySignature(secret, parts, signature) {
  if (typeof signature !== 'string' || signature === '') return false;
  if (typeof parts.transmissionId !== 'string' || typeof parts.transmissionTime !== 'string') return false;
  let expected;
  try {
    expected = Buffer.from(computeSignature(secret, parts));
  } catch {
    return false;
  }
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let eventCounter = 0;
let transmissionCounter = 0;

export function nextTransmissionId() {
  transmissionCounter += 1;
  return `TX-${String(transmissionCounter).padStart(12, '0')}`;
}

// A PayPal-shaped event object (not yet serialised). resource is passed through unchanged except for withPayer, which
// adds the fake payer data under resource.payer.
export function buildEvent({ eventType, resource = {}, id, createTime = '2026-10-20T06:00:00.000Z', resourceType, withPayer = false }) {
  if (typeof eventType !== 'string' || eventType === '') throw new TypeError('eventType is required');
  eventCounter += 1;
  const finalResource = { ...resource };
  if (withPayer) {
    finalResource.payer = {
      payer_id: FAKE_PAYER.payerId,
      email_address: FAKE_PAYER.email,
      name: { given_name: FAKE_PAYER.givenName, surname: FAKE_PAYER.surname },
      address: { address_line_1: FAKE_PAYER.addressLine, postal_code: FAKE_PAYER.postalCode, country_code: 'US' },
    };
  }
  return {
    id: id ?? `WH-EVT-${String(eventCounter).padStart(8, '0')}`,
    event_version: '1.0',
    create_time: createTime,
    resource_type: resourceType ?? eventType.split('.')[1]?.toLowerCase() ?? 'unknown',
    event_type: eventType,
    summary: 'Simulated event (paypal-stub / webhook-signer)',
    resource: finalResource,
    links: [],
  };
}

// Signs an event. Pass `event` (serialised with JSON.stringify) or `rawBody` (the bytes to sign as they are, for the
// byte-exactness tests). Returns { rawBody: Buffer, headers, transmissionId }. Overrides let a test build a forged
// request: a wrong `secret`, a `signature` of its own, or a `transmissionTime` outside the accepted window.
export function signEvent({
  event,
  rawBody,
  secret = webhookSecretFromEnv(),
  transmissionId = nextTransmissionId(),
  transmissionTime = new Date().toISOString(),
  certUrl = FAKE_CERT_URL,
  authAlgo = FAKE_AUTH_ALGO,
  signature,
} = {}) {
  if ((event === undefined) === (rawBody === undefined)) throw new TypeError('pass exactly one of event or rawBody');
  const body = toBuffer(rawBody === undefined ? JSON.stringify(event) : rawBody);
  const sig = signature ?? computeSignature(secret, { transmissionId, transmissionTime, rawBody: body });
  return {
    rawBody: body,
    transmissionId,
    headers: {
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': sig,
      'paypal-cert-url': certUrl,
      'paypal-auth-algo': authAlgo,
    },
  };
}

// The same bytes with one byte changed (the first '2' becomes '3', else the last byte is bumped): a signed request
// whose body was altered after signing. Returns a Buffer of the same length.
export function tamperBody(rawBody) {
  const copy = Buffer.from(toBuffer(rawBody));
  if (copy.length === 0) throw new RangeError('cannot tamper an empty body');
  const index = copy.indexOf(0x32); // '2'
  const at = index >= 0 ? index : copy.length - 1;
  copy[at] = copy[at] === 0x39 ? 0x38 : copy[at] + 1;
  return copy;
}
