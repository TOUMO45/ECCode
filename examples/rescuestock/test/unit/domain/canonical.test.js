// Canonical JSON and hashes (planHash, offersHash, fingerprints).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHash, canonicalJson, sha256Hex } from '../../../src/domain/canonical.js';
import { plan } from '../../../src/domain/planner.js';
import { fixtureInput } from './helpers/fixture.js';

test('canonical: keys are sorted, whitespace removed, arrays keep their order', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 2, 1], c: { z: null, y: 'x' } }), '{"a":[3,2,1],"b":1,"c":{"y":"x","z":null}}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson('a"b\n'), '"a\\"b\\n"');
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson({ 'é': 1, a: 2 }), '{"a":2,"é":1}');
  assert.equal(canonicalJson(Object.create(null)), '{}');
});

test('canonical: values JSON cannot represent exactly are refused, never dropped or coerced', () => {
  for (const bad of [undefined, () => 1, Symbol('x'), NaN, Infinity, -Infinity, 10n, new Date(0), new Map(), new Set(), new (class X {})(), [undefined]]) {
    assert.throws(() => canonicalJson(bad), TypeError, String(typeof bad));
  }
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson([1, , 3]), TypeError); // sparse array
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), TypeError);
  const shared = { n: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"n":1},"b":{"n":1}}', 'a repeated (non-cyclic) object is fine');
});

test('canonical: sha256 is 64 lowercase hex and matches the known vector', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(canonicalHash({ a: 1 }), /^[0-9a-f]{64}$/);
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('canonical: the plan hash of RS-FIX-1 is stable across runs and input order, and changes with the plan', () => {
  const a = canonicalHash(plan(fixtureInput()).best);
  const b = canonicalHash(plan(fixtureInput((i) => i.offers.reverse())).best);
  assert.equal(a, b);
  const changed = canonicalHash(plan(fixtureInput((i) => { i.offers[0].priceCents += 1; })).best);
  assert.notEqual(a, changed);
});
