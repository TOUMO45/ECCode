import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_CSP,
  applyApprovalListenerHeaders,
  applySecurityHeaders,
  approvalListenerHeaders,
  approvalPageCsp,
  securityHeaders,
} from '../../../src/http/headers.js';

test('F-TR-14: approvalPageCsp(appOrigin) returns the exact revision-3 string', () => {
  assert.equal(
    approvalPageCsp('http://localhost:3000'),
    "default-src 'none'; style-src 'self'; form-action 'self' http://localhost:3000; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(
    approvalPageCsp('https://rescue.example.com'),
    "default-src 'none'; style-src 'self'; form-action 'self' https://rescue.example.com; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(
    approvalPageCsp('http://127.0.0.1:41233'),
    "default-src 'none'; style-src 'self'; form-action 'self' http://127.0.0.1:41233; frame-ancestors 'none'; base-uri 'none'",
  );
});

test('F-TR-14: approvalPageCsp refuses anything that is not a plain http(s) origin (no header injection)', () => {
  const bad = [
    '',
    undefined,
    null,
    42,
    'localhost:3000',
    'ftp://localhost:3000',
    "http://localhost:3000; script-src 'unsafe-inline'",
    'http://localhost:3000 http://evil.example',
    'http://localhost:3000/path',
    'http://localhost:3000\r\nX-Evil: 1',
    "http://x.example'",
  ];
  for (const value of bad) assert.throws(() => approvalPageCsp(value), TypeError, String(value));
});

test('F-TR-14: the approval listener headers carry exactly one CSP, the approval one, and not the app CSP', () => {
  const headers = approvalListenerHeaders('http://localhost:3000');
  const cspNames = Object.keys(headers).filter((n) => n.toLowerCase() === 'content-security-policy');
  assert.equal(cspNames.length, 1);
  assert.equal(headers['Content-Security-Policy'], approvalPageCsp('http://localhost:3000'));
  assert.notEqual(headers['Content-Security-Policy'], APP_CSP);
  assert.match(headers['Content-Security-Policy'], /form-action 'self' http:\/\/localhost:3000/);
  // The other app security headers are inherited.
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('F-TR-14: applyApprovalListenerHeaders sets one CSP header on a response object', () => {
  const set = new Map();
  const res = { setHeader: (n, v) => set.set(n.toLowerCase(), v) };
  applyApprovalListenerHeaders(res, 'http://localhost:3000');
  assert.equal(set.get('content-security-policy'), approvalPageCsp('http://localhost:3000'));
  assert.equal([...set.keys()].filter((k) => k === 'content-security-policy').length, 1);
});

test('SEC-12: the app CSP is the pinned string and keeps form-action self for the app pages', () => {
  assert.equal(
    APP_CSP,
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  assert.equal(securityHeaders({})['Content-Security-Policy'], APP_CSP);
  assert.doesNotMatch(APP_CSP, /unsafe-inline|unsafe-eval|\*/);
});

test('T22: app security headers include clickjacking, sniffing, referrer, opener and permissions policies', () => {
  const h = securityHeaders({ api: false });
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(h['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(h['Cache-Control'], undefined, 'no-store applies to /api only');
  assert.equal(securityHeaders({ api: true })['Cache-Control'], 'no-store');
});

test('SEC-20: no header helper ever sets an Access-Control-* header', () => {
  const all = [
    securityHeaders({}),
    securityHeaders({ api: true }),
    securityHeaders({ csp: null }),
    approvalListenerHeaders('http://localhost:3000'),
  ];
  for (const headers of all) {
    for (const name of Object.keys(headers)) assert.doesNotMatch(name, /^access-control-/i, name);
  }
  const set = [];
  applySecurityHeaders({ setHeader: (n) => set.push(n) }, { api: true });
  assert.ok(set.length >= 6);
  assert.ok(!set.some((n) => /^access-control-/i.test(n)));
});

test('securityHeaders with csp: null sends no CSP so a caller can set its own', () => {
  assert.equal(securityHeaders({ csp: null })['Content-Security-Policy'], undefined);
});
