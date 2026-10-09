import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../../src/http/envelope.js';
import { bool, enumOf, idParam, int, localDateTime, str, ts, validateObject } from '../../../src/http/validate.js';
import { canonicalJson } from '../../../src/http/body.js';
import { parseCookies, serializeCookie, sessionCookie, clearSessionCookie } from '../../../src/http/cookies.js';

test('int(min,max) accepts safe integers in range only', () => {
  const v = int(1, 10);
  assert.deepEqual(v(5), { ok: true, value: 5 });
  for (const bad of [0, 11, 1.5, '5', NaN, Infinity, null, undefined, Number.MAX_SAFE_INTEGER + 1, true]) assert.equal(v(bad).ok, false, String(bad));
  assert.equal(v(0).rule, 'range:1..10');
  assert.equal(v('5').rule, 'integer');
});

test('str(min,max,pattern) NFC-normalises and counts code points', () => {
  const v = str(1, 3);
  // "e" + combining acute (2 code points) normalises to one code point.
  assert.deepEqual(v('é'), { ok: true, value: 'é' });
  assert.equal(v('\u{1F600}\u{1F600}\u{1F600}').ok, true, 'three emoji are three code points');
  assert.equal(v('\u{1F600}\u{1F600}\u{1F600}\u{1F600}').ok, false);
  assert.equal(v('').ok, false);
  assert.equal(v(5).ok, false);
  const pattern = str(3, 40, /^[A-Za-z0-9_.-]+$/);
  assert.equal(pattern('good_name-1').ok, true);
  assert.equal(pattern('bad name').rule, 'pattern');
});

test('enumOf, bool, ts and localDateTime', () => {
  assert.equal(enumOf('a', 'b')('a').ok, true);
  assert.equal(enumOf('a', 'b')('c').ok, false);
  assert.equal(enumOf('a', 'b')(1).ok, false);
  assert.equal(bool()(true).ok, true);
  assert.equal(bool()('true').ok, false);
  assert.equal(ts()('2026-10-20T07:00:00.000Z').ok, true);
  for (const bad of ['2026-10-20T07:00:00Z', '2026-10-20 07:00:00.000Z', '2026-02-30T07:00:00.000Z', 'x', 5]) assert.equal(ts()(bad).ok, false, String(bad));
  assert.equal(localDateTime()('2026-10-20T11:00').ok, true);
  for (const bad of ['2026-10-20T25:00', '2026-10-20T11:00:00', '2026-13-20T11:00', '2026-10-20', 5]) assert.equal(localDateTime()(bad).ok, false, String(bad));
});

test('validateObject keeps only spec fields, drops unknown ones and reports every failing field with a 422', () => {
  const spec = {
    username: str(3, 40, /^[A-Za-z0-9_.-]+$/),
    age: { check: int(0, 150), optional: true },
    note: { check: str(0, 10), optional: true, nullable: true },
  };
  const out = validateObject({ username: 'alice', role: 'admin', __proto__: { evil: 1 }, age: 30, note: null }, spec);
  assert.deepEqual(out, { username: 'alice', age: 30, note: null });
  assert.ok(!('role' in out));

  let raised;
  try {
    validateObject({ username: 'x', age: 'old' }, spec);
  } catch (err) {
    raised = err;
  }
  assert.ok(raised instanceof AppError);
  assert.equal(raised.status, 422);
  assert.equal(raised.code, 'VALIDATION_FAILED');
  assert.deepEqual(raised.details.fields, [
    { field: 'username', rule: 'length:3..40' },
    { field: 'age', rule: 'integer' },
  ]);
  assert.throws(() => validateObject({}, spec), (e) => e.details.fields[0].rule === 'required');
  assert.throws(() => validateObject('nope', spec), (e) => e.code === 'VALIDATION_FAILED');
});

test('validation errors never echo the input value', () => {
  assert.throws(
    () => validateObject({ username: 'secret-value-<script>' }, { username: str(1, 3) }),
    (e) => !JSON.stringify(e.details).includes('secret-value'),
  );
});

test('idParam accepts positive integers only and answers 400 BAD_REQUEST otherwise', () => {
  assert.equal(idParam('7'), 7);
  assert.equal(idParam('123456789012345'), 123456789012345);
  for (const bad of ['0', '-1', '01', '1.5', 'abc', '', ' 1', '1 ', '1e3', '9999999999999999999']) {
    assert.throws(() => idParam(bad), (e) => e instanceof AppError && e.status === 400 && e.code === 'BAD_REQUEST', bad);
  }
});

test('canonicalJson sorts keys, drops undefined and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: 1, c: 2 }], z: undefined }), '{"a":[3,{"c":2,"d":1}],"b":1}');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('x"y'), '"x\\"y"');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: Infinity }));
});

test('parseCookies reads simple pairs and ignores malformed ones', () => {
  const c = parseCookies('rs_sid=abc123_-; other=1; bad name=2; evil=a b; dup=1; dup=2');
  assert.equal(c.rs_sid, 'abc123_-');
  assert.equal(c.other, '1');
  assert.equal(c.dup, '1');
  assert.ok(!('bad name' in c));
  assert.ok(!('evil' in c));
  assert.deepEqual(Object.keys(parseCookies(undefined)), []);
  assert.deepEqual(Object.keys(parseCookies('x'.repeat(9000))), []);
});

test('SEC-20: the session cookie is HttpOnly, SameSite=Lax, Path=/, 12 h, Secure over https', () => {
  const id = 'A'.repeat(43);
  assert.equal(sessionCookie(id), `rs_sid=${id}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`);
  assert.equal(sessionCookie(id, { secure: true }), `rs_sid=${id}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(clearSessionCookie(), 'rs_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
});

test('serializeCookie refuses values and names that could inject attributes', () => {
  for (const value of ['a;b', 'a b', 'a,b', 'a\r\nSet-Cookie: x=1', 'a"b']) assert.throws(() => serializeCookie('rs_sid', value), TypeError, value);
  assert.throws(() => serializeCookie('bad name', 'v'), TypeError);
  assert.throws(() => serializeCookie('n', 'v', { path: '/x; Domain=evil' }), TypeError);
  assert.throws(() => serializeCookie('n', 'v', { sameSite: 'Weird' }), TypeError);
  assert.throws(() => serializeCookie('n', 'v', { maxAge: -1 }), TypeError);
});
