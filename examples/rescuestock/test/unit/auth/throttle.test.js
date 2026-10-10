// Unit tests for src/auth/throttle.js (SEC-1, SEC-9, F-TR-17).
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNIN_IP_LIMIT,
  SIGNIN_PAIR_LIMIT,
  SIGNIN_WINDOW_MS,
  REGISTER_WINDOW_MS,
  createThrottle,
  crossIpDelayMs,
  usernameKey,
} from '../../../src/auth/throttle.js';
import { openTestDb } from './helpers.js';

describe('SEC-1: sign-in throttle', () => {
  const t = openTestDb();
  const throttle = createThrottle({ db: t.db, clock: t.clock });
  after(() => t.close());
  beforeEach(() => {
    t.db.exec('DELETE FROM login_failures');
    t.db.exec('DELETE FROM rate_events');
  });
  const attempt = (name, ip) => throttle.reserveSignin({ usernameKey: usernameKey(name), ip });

  test('SEC-1: the 6th attempt for one (username, IP) pair is refused with limit signin_pair', () => {
    for (let i = 1; i <= SIGNIN_PAIR_LIMIT; i++) assert.equal(attempt('cafe1', '10.0.0.1').allowed, true, `attempt ${i}`);
    const sixth = attempt('cafe1', '10.0.0.1');
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.limit, 'signin_pair');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM login_failures').get().n, SIGNIN_PAIR_LIMIT, 'a refusal records nothing');
  });

  test('SEC-1: Retry-After is the time until the oldest counted failure leaves the 15-minute window', () => {
    attempt('cafe1', '10.0.0.1');
    t.clock.advance(5 * 60_000);
    for (let i = 0; i < SIGNIN_PAIR_LIMIT - 1; i++) attempt('cafe1', '10.0.0.1');
    const refused = attempt('cafe1', '10.0.0.1');
    assert.equal(refused.retryAfterS, 10 * 60);
    t.clock.advance(10 * 60_000 - 1);
    assert.equal(attempt('cafe1', '10.0.0.1').allowed, false, 'still inside the window');
    t.clock.advance(1);
    assert.equal(attempt('cafe1', '10.0.0.1').allowed, true, 'the oldest failure has left the window');
  });

  test('SEC-1: a different IP is not refused by the pair limit (cross-IP is a delay, never a lockout)', () => {
    for (let i = 0; i < SIGNIN_PAIR_LIMIT; i++) attempt('cafe1', '10.0.0.1');
    assert.equal(attempt('cafe1', '10.0.0.1').allowed, false);
    const other = attempt('cafe1', '10.0.0.2');
    assert.equal(other.allowed, true);
    assert.equal(other.delayMs, 0, 'only 5 failures for the name: no delay yet');
  });

  test('SEC-1: an IP is refused after 20 failures across usernames, limit signin_ip', () => {
    for (let i = 0; i < SIGNIN_IP_LIMIT; i++) assert.equal(attempt(`user${i}`, '10.0.0.9').allowed, true, `attempt ${i + 1}`);
    const refused = attempt('brand-new-name', '10.0.0.9');
    assert.equal(refused.allowed, false);
    assert.equal(refused.limit, 'signin_ip');
    assert.equal(attempt('brand-new-name', '10.0.0.10').allowed, true);
  });

  test('SEC-1: the delay for a username across all IPs is min(10 s, (n - 9) s) from the 10th failure on', () => {
    assert.equal(crossIpDelayMs(0), 0);
    assert.equal(crossIpDelayMs(9), 0);
    assert.equal(crossIpDelayMs(10), 1000);
    assert.equal(crossIpDelayMs(11), 2000);
    assert.equal(crossIpDelayMs(18), 9000);
    assert.equal(crossIpDelayMs(19), 10000);
    assert.equal(crossIpDelayMs(500), 10000);
    for (let i = 0; i < 10; i++) assert.equal(attempt('cafe1', `10.1.0.${i + 1}`).delayMs, 0, `failure ${i + 1} is admitted without delay`);
    const eleventh = attempt('cafe1', '10.1.0.50');
    assert.equal(eleventh.allowed, true, 'a delay, never a refusal');
    assert.equal(eleventh.delayMs, 1000);
    assert.equal(attempt('cafe1', '10.1.0.51').delayMs, 2000);
    assert.equal(attempt('someone-else', '10.1.0.52').delayMs, 0, 'the delay is per username');
  });

  test('SEC-9: Admin and " admin " share one key, and unknown names are counted exactly like known ones', () => {
    assert.equal(usernameKey('Admin'), usernameKey(' admin '));
    assert.equal(usernameKey('ADMIN'), 'admin');
    assert.equal(usernameKey('é'), usernameKey('é'), 'NFC: composed and decomposed forms are one key');
    const variants = ['Admin', ' admin ', 'ADMIN', 'admin', '\tAdMiN\n'];
    for (const v of variants) assert.equal(attempt(v, '10.0.0.3').allowed, true);
    assert.equal(attempt('admin', '10.0.0.3').allowed, false, 'the 6th variant hits the same pair');
    for (let i = 0; i < SIGNIN_PAIR_LIMIT; i++) assert.equal(attempt('no-such-user-xyz', '10.0.0.4').allowed, true);
    assert.equal(attempt('no-such-user-xyz', '10.0.0.4').allowed, false, 'an unknown name is refused at the same count');
  });

  test('SEC-1: a success clears that pair only', () => {
    for (let i = 0; i < 3; i++) attempt('cafe1', '10.0.0.1');
    attempt('cafe1', '10.0.0.2');
    attempt('cafe2', '10.0.0.1');
    throttle.clearPair({ usernameKey: 'cafe1', ip: '10.0.0.1' });
    const rows = t.db.prepare('SELECT username_key, ip FROM login_failures ORDER BY id').all();
    assert.deepEqual(rows.map((r) => `${r.username_key}@${r.ip}`), ['cafe1@10.0.0.2', 'cafe2@10.0.0.1']);
  });

  test('SEC-1: failures older than 15 minutes are pruned', () => {
    for (let i = 0; i < SIGNIN_PAIR_LIMIT; i++) attempt('cafe1', '10.0.0.1');
    t.clock.advance(SIGNIN_WINDOW_MS);
    assert.equal(attempt('cafe1', '10.0.0.1').allowed, true);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM login_failures').get().n, 1);
  });

  test('SEC-1: admission is counted when it is granted, so any number of attempts admit exactly the limit', () => {
    const results = Array.from({ length: 12 }, () => attempt('cafe1', '10.0.0.1'));
    assert.equal(results.filter((r) => r.allowed).length, SIGNIN_PAIR_LIMIT);
  });
});

describe('F-TR-17: register throttle', () => {
  const t = openTestDb();
  const throttle = createThrottle({ db: t.db, clock: t.clock });
  after(() => t.close());

  test('F-TR-17: at most `limit` registrations per IP per hour, counted in rate_events', () => {
    for (let i = 0; i < 5; i++) assert.equal(throttle.reserveRegister({ ip: '10.0.0.1', limit: 5 }).allowed, true);
    const refused = throttle.reserveRegister({ ip: '10.0.0.1', limit: 5 });
    assert.deepEqual({ allowed: refused.allowed, limit: refused.limit }, { allowed: false, limit: 'register_ip' });
    assert.equal(refused.retryAfterS, 3600);
    assert.equal(throttle.reserveRegister({ ip: '10.0.0.2', limit: 5 }).allowed, true, 'another IP has its own budget');
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'register' AND user_key = 'ip:10.0.0.1'").get().n, 5);
    t.clock.advance(REGISTER_WINDOW_MS);
    assert.equal(throttle.reserveRegister({ ip: '10.0.0.1', limit: 5 }).allowed, true, 'the hour has passed');
  });

  test('F-TR-17: the limit is a parameter (RS_REGISTER_PER_IP_PER_HOUR)', () => {
    assert.equal(throttle.reserveRegister({ ip: '10.0.0.7', limit: 1 }).allowed, true);
    assert.equal(throttle.reserveRegister({ ip: '10.0.0.7', limit: 1 }).allowed, false);
  });
});
