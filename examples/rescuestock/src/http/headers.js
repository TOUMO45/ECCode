// Security headers (Security > Security headers) and the fake approval page CSP.
// No function here ever sets an Access-Control-* header (SEC-20).

export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

// The single Content-Security-Policy of the fake approval listener and of the
// paypal-stub approval page (revision 3, F-TR-14). It lists the app origin in
// form-action so Chromium lets the 303 chain of approve/cancel reach the app.
export function approvalPageCsp(appOrigin) {
  if (typeof appOrigin !== 'string' || !ORIGIN_PATTERN.test(appOrigin)) {
    throw new TypeError('approvalPageCsp needs an http(s) origin without path');
  }
  return `default-src 'none'; style-src 'self'; form-action 'self' ${appOrigin}; frame-ancestors 'none'; base-uri 'none'`;
}

const BASE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

// Headers for every app response. `api` adds Cache-Control: no-store.
// `csp` is the policy to send; pass null to send none (a caller that sets its own).
export function securityHeaders({ api = false, csp = APP_CSP } = {}) {
  const headers = { ...BASE_HEADERS };
  if (csp) headers['Content-Security-Policy'] = csp;
  if (api) headers['Cache-Control'] = 'no-store';
  return headers;
}

export function applySecurityHeaders(res, options) {
  for (const [name, value] of Object.entries(securityHeaders(options))) res.setHeader(name, value);
}

// Headers for the fake approval listener: the app's headers, except that the
// one Content-Security-Policy is approvalPageCsp(appOrigin), not the app CSP.
export function approvalListenerHeaders(appOrigin) {
  return securityHeaders({ csp: approvalPageCsp(appOrigin) });
}

export function applyApprovalListenerHeaders(res, appOrigin) {
  for (const [name, value] of Object.entries(approvalListenerHeaders(appOrigin))) res.setHeader(name, value);
}
