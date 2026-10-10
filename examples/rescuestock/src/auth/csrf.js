// CSRF defences (T6). Three checks on a state-changing request:
//   1. the Origin header, when present, names this application (RS_PUBLIC_URL's origin or http(s)://<Host>);
//   2. the X-CSRF-Token header equals the session's token (session routes), or
//   3. for the pre-login routes (signin, register) carries a valid pre-login token: nonce.hmac, valid 2 h.
// Every failure is 403 CSRF_FAILED.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/envelope.js';

export const PRE_LOGIN_TTL_MS = 2 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const MAX_TOKEN_LENGTH = 200;
const TOKEN_PART = /^[A-Za-z0-9_-]+$/;

function sign(key, nonce) {
  return createHmac('sha256', key).update(nonce, 'utf8').digest('base64url');
}

function sameText(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function csrfFailed() {
  return new AppError(403, 'CSRF_FAILED');
}

// key: () => Buffer|string, read lazily so the meta row exists by the time it is needed.
export function createPreLoginTokens({ key, clock }) {
  return {
    // nonce = base64url(8-byte issue time || 16 random bytes); token = nonce.hmac(nonce)
    issue() {
      const stamp = Buffer.alloc(8);
      stamp.writeBigUInt64BE(BigInt(clock.now()));
      const nonce = Buffer.concat([stamp, randomBytes(16)]).toString('base64url');
      return `${nonce}.${sign(key(), nonce)}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
      const parts = token.split('.');
      if (parts.length !== 2 || !TOKEN_PART.test(parts[0]) || !TOKEN_PART.test(parts[1])) return false;
      if (!sameText(parts[1], sign(key(), parts[0]))) return false;
      const raw = Buffer.from(parts[0], 'base64url');
      if (raw.length !== 24) return false;
      const issuedAt = Number(raw.readBigUInt64BE(0));
      const age = clock.now() - issuedAt;
      return age <= PRE_LOGIN_TTL_MS && age >= -FUTURE_SKEW_MS;
    },
  };
}

// Allowed origins for this request: the public URL's origin and http(s)://<Host>.
export function allowedOrigins({ publicUrl, host }) {
  const origins = new Set();
  try {
    origins.add(new URL(publicUrl).origin.toLowerCase());
  } catch {
    // An unusable public URL contributes nothing; the Host-based origins remain.
  }
  if (typeof host === 'string' && host.length > 0 && host.length <= 255) {
    origins.add(`http://${host.toLowerCase()}`);
    origins.add(`https://${host.toLowerCase()}`);
  }
  return origins;
}

// An absent Origin passes (non-browser clients). A present one must be an allowed origin; "null" is refused.
export function checkOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== 'string' || !allowedOrigins({ publicUrl, host: req.headers.host }).has(origin.toLowerCase())) {
    throw csrfFailed();
  }
}

export function headerToken(req) {
  const value = req.headers['x-csrf-token'];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : null;
}

// Throws 403 CSRF_FAILED unless the header equals the session token.
export function requireSessionToken(req, session) {
  const token = headerToken(req);
  if (!token || !session || !sameText(token, session.csrfToken)) throw csrfFailed();
}

// Pre-login routes accept the session token (a signed-in browser re-authenticating) or a pre-login token.
export function requirePreLoginOrSessionToken(req, { session, preLogin }) {
  const token = headerToken(req);
  if (!token) throw csrfFailed();
  if (session && sameText(token, session.csrfToken)) return;
  if (preLogin.verify(token)) return;
  throw csrfFailed();
}
