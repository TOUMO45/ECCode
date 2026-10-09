import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../../src/verify/normalize.js';

test('NFKC, case fold, whitespace', () => {
  assert.equal(normalize('  Ｈello \n  WORLD\t'), 'hello world');
  assert.equal(normalize('Ab', { fold: false }), 'Ab');
});
test('times normalised, zone and seconds dropped', () => {
  assert.equal(normalize('at 9:05 and 14:06:30'), 'at 09:05 and 14:06');
  assert.equal(normalize('2026-10-08T14:07:09.5Z'), '14:07');
  assert.equal(normalize('2026-10-08 14:08+01:00'), '14:08');
  assert.equal(normalize('25:00'), '25:00');
});
test('number words two..twelve; one only before a unit', () => {
  assert.equal(normalize('two hosts, twelve users'), '2 hosts, 12 users');
  assert.equal(normalize('five-minute delay'), '5 minute delay');
  assert.equal(normalize('one engineer'), 'one engineer');
  assert.equal(normalize('one minute'), '1 minute');
  assert.equal(normalize('one-hour'), '1 hour');
});
test('thousands separators removed, decimals kept', () => {
  assert.equal(normalize('1,200 errors, 3.5 s'), '1200 errors, 3.5 s');
  assert.equal(normalize('a, 1,200, b'), 'a, 1200, b');
});
test('units split from digits', () => {
  assert.equal(normalize('40% and 5min and 200ms'), '40 % and 5 min and 200 ms');
  assert.equal(normalize('p99 sev1'), 'p99 sev1');
});
test('idempotent', () => {
  const s = 'Two hosts at 9:05 saw 1,200 errors for five-minute, 40%';
  assert.equal(normalize(normalize(s)), normalize(s));
});
