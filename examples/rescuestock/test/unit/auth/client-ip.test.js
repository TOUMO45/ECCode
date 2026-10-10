// Unit tests for src/auth/client-ip.js. SEC-B-9 / FU-11: a forwarded address is only ever used when
// RS_TRUST_PROXY=1 and net.isIP accepts it; otherwise the socket address is the throttle key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, normalizeIp } from '../../../src/auth/client-ip.js';

const req = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
});

test('SEC-B-9: without RS_TRUST_PROXY the X-Forwarded-For header is ignored entirely', () => {
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7'), false), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', 'garbage'), false), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '127.0.0.1', 'the default is not to trust it');
});

test('SEC-B-9: with RS_TRUST_PROXY=1 the last hop is used when it is an IP address', () => {
  assert.equal(clientIp(req('10.0.0.5', '198.51.100.1, 203.0.113.7'), true), '203.0.113.7');
  assert.equal(clientIp(req('10.0.0.5', '198.51.100.1,   203.0.113.7  '), true), '203.0.113.7');
  assert.equal(clientIp(req('10.0.0.5', '2001:DB8::1'), true), '2001:db8::1');
  assert.equal(clientIp(req('10.0.0.5', '[2001:db8::2]'), true), '2001:db8::2');
  assert.equal(clientIp(req('10.0.0.5', '::ffff:203.0.113.9'), true), '203.0.113.9');
});

test('SEC-B-9: with RS_TRUST_PROXY=1 an invalid last hop falls back to the socket address, never used verbatim', () => {
  const invalid = [
    'not-an-ip',
    '203.0.113.7, evil.example',
    '203.0.113.7,',
    '',
    '   ',
    '999.1.1.1',
    '1.2.3',
    '203.0.113.7:8080',
    '<script>alert(1)</script>',
    "1.2.3.4'; DROP TABLE login_failures;--",
    '1.2.3.4\r\nX-Injected: 1',
    'x'.repeat(600),
    '0x7f.1',
    '203.0.113.7 /* c */',
  ];
  for (const value of invalid) assert.equal(clientIp(req('10.0.0.5', value), true), '10.0.0.5', JSON.stringify(value).slice(0, 60));
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': ['1.1.1.1'] } }, true), '10.0.0.5', 'a non-string header value');
});

test('SEC-B-9: the socket address is normalised, and a missing one becomes "unknown"', () => {
  assert.equal(clientIp(req('::ffff:127.0.0.1'), false), '127.0.0.1');
  assert.equal(clientIp(req('::1'), false), '::1');
  assert.equal(clientIp(req('FE80::1%eth0'), false), 'fe80::1');
  assert.equal(clientIp(req(undefined), false), 'unknown');
  assert.equal(clientIp({ headers: {} }, true), 'unknown');
  assert.equal(normalizeIp(42), null);
  assert.equal(normalizeIp('example.com'), null);
});
