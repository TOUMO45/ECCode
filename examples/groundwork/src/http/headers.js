// Security headers (spec 9) and request ids (spec 3.1).
import crypto from 'node:crypto';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

const REQ_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function requestIdFor(req) {
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && REQ_ID_RE.test(inbound)) return inbound;
  return crypto.randomBytes(8).toString('hex');
}
