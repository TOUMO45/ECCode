// Unit tests for src/auth/csrf.js (T6, ARCH-25).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixedClock } from '../../../src/clock.js';
import { AppError } from '../../../src/http/envelope.js';
import {
  PRE_LOGIN_TTL_MS,
  allowedOrigins,
  checkOrigin,
  createPreLoginTokens,
  requirePreLoginOrSessionToken,
  requireSessionToken,
} from '../../../src/auth/csrf.js';

const KEY = randomBytes(32);
const NOW = Date.UTC(2026, 9, 20, 6, 0, 0);

describe('ARCH-25: pre-login CSRF tokens', () => {
  test('ARCH-25: a token is nonce.hmac and verifies for 2 hours', () => {
    const clock = fixedClock(NOW);
    const tokens = createPreLoginTokens({ key: () => KEY, clock });
    const token = tokens.issue();
    assert.match(token, /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.notEqual(tokens.issue(), token);
    assert.equal(tokens.verify(token), true);
    clock.advance(PRE_LOGIN_TTL_MS);
    assert.equal(tokens.verify(token), true, 'valid up to 2 h');
    clock.advance(1);
    assert.equal(tokens.verify(token), false, 'expired after 2 h');
  });

  test('T6: a tampered, truncated, foreign-key or malformed token is refused', () => {
    const clock = fixedClock(NOW);
    const tokens = createPreLoginTokens({ key: () => KEY, clock });
    const other = createPreLoginTokens({ key: () => randomBytes(32), clock });
    const token = tokens.issue();
    const [nonce, mac] = token.split('.');
    const flipped = `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${mac}`;
    for (const bad of [
      flipped,
      `${nonce}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
      nonce,
      `${nonce}.`,
      `.${mac}`,
      `${token}.extra`,
      `${nonce}.${mac}\n`,
      other.issue(),
      '',
      undefined,
      null,
      42,
      'x'.repeat(500),
    ]) {
      assert.equal(tokens.verify(bad), false, String(bad).slice(0, 50));
    }
  });

  test('T6: a token dated in the future (beyond clock skew) is refused', () => {
    const issuer = createPreLoginTokens({ key: () => KEY, clock: fixedClock(NOW + 10 * 60_000) });
    const verifier = createPreLoginTokens({ key: () => KEY, clock: fixedClock(NOW) });
    assert.equal(verifier.verify(issuer.issue()), false);
  });
});

describe('T6: Origin and token checks', () => {
  const req = (headers) => ({ headers });
  const fails = (fn) => assert.throws(fn, (err) => err instanceof AppError && err.status === 403 && err.code === 'CSRF_FAILED');

  test('T6: Origin is optional, but when present must be the public origin or http(s)://<Host>', () => {
    const publicUrl = 'http://localhost:3000';
    checkOrigin(req({ host: 'localhost:3000' }), publicUrl);
    checkOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }), publicUrl);
    checkOrigin(req({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }), publicUrl);
    checkOrigin(req({ host: 'localhost:3000', origin: 'HTTP://LOCALHOST:3000' }), publicUrl);
    checkOrigin(req({ host: 'rescue.example', origin: 'https://rescue.example' }), publicUrl);
    fails(() => checkOrigin(req({ host: 'localhost:3000', origin: 'http://evil.example' }), publicUrl));
    fails(() => checkOrigin(req({ host: 'localhost:3000', origin: 'null' }), publicUrl));
    fails(() => checkOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000.evil.example' }), publicUrl));
    fails(() => checkOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3001' }), publicUrl));
    fails(() => checkOrigin(req({ host: 'localhost:3000', origin: '' }), publicUrl));
    assert.deepEqual([...allowedOrigins({ publicUrl: 'not a url', host: undefined })], []);
  });

  test('T6: a session token must match exactly; a pre-login token is not a session token', () => {
    const session = { csrfToken: 'abc'.repeat(14) };
    requireSessionToken(req({ 'x-csrf-token': session.csrfToken }), session);
    fails(() => requireSessionToken(req({}), session));
    fails(() => requireSessionToken(req({ 'x-csrf-token': `${session.csrfToken}x` }), session));
    fails(() => requireSessionToken(req({ 'x-csrf-token': session.csrfToken }), null));
    fails(() => requireSessionToken(req({ 'x-csrf-token': 'y'.repeat(300) }), session));
    const preLogin = createPreLoginTokens({ key: () => KEY, clock: fixedClock(NOW) });
    fails(() => requireSessionToken(req({ 'x-csrf-token': preLogin.issue() }), session));
  });

  test('T6: the pre-login routes accept a pre-login token or the current session token', () => {
    const preLogin = createPreLoginTokens({ key: () => KEY, clock: fixedClock(NOW) });
    const session = { csrfToken: 'session-token-value' };
    requirePreLoginOrSessionToken(req({ 'x-csrf-token': preLogin.issue() }), { session: null, preLogin });
    requirePreLoginOrSessionToken(req({ 'x-csrf-token': session.csrfToken }), { session, preLogin });
    fails(() => requirePreLoginOrSessionToken(req({}), { session, preLogin }));
    fails(() => requirePreLoginOrSessionToken(req({ 'x-csrf-token': session.csrfToken }), { session: null, preLogin }));
    fails(() => requirePreLoginOrSessionToken(req({ 'x-csrf-token': 'nope' }), { session, preLogin }));
  });
});
