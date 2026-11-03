'use strict';
// The second-labeller arithmetic (owner decision 4 of 2026-11-03): a seeded stratified sample of the misses, percent agreement and
// Cohen's kappa of two labellers on the capability/configuration label, and the per-blocker agreement. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert');
const agree = require('../bench/pilot/hb3/agree');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('Cohen\'s kappa: textbook values, the degenerate cases and the 2x2 table', () => {
  const mk = (pairs) => pairs.map(([a, b], i) => [`p${i}`, a, b]);
  // 20 items: 14 both A, 2 A/B, 2 B/A, 2 both B -> po = 16/20 = 0.8, pe = (16/20*16/20) + (4/20*4/20) = 0.64 + 0.04 = 0.68, kappa = 0.12/0.32 = 0.375
  const pairs = [...Array(14).fill(['A', 'A']), ...Array(2).fill(['A', 'B']), ...Array(2).fill(['B', 'A']), ...Array(2).fill(['B', 'B'])];
  const r = agree.cohenKappa(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  assert.ok(near(r.observed, 0.8) && near(r.expected, 0.68) && near(r.kappa, 0.375), JSON.stringify(r));
  assert.deepStrictEqual(r.table, { A: { A: 14, B: 2 }, B: { A: 2, B: 2 } });
  // perfect agreement with both categories present: kappa 1
  assert.strictEqual(agree.cohenKappa(['A', 'B', 'A', 'B'], ['A', 'B', 'A', 'B']).kappa, 1);
  // complete disagreement: kappa -1 for two balanced categories
  assert.strictEqual(agree.cohenKappa(['A', 'B', 'A', 'B'], ['B', 'A', 'B', 'A']).kappa, -1);
  // one category only: kappa is undefined (null), observed agreement is still reported
  const same = agree.cohenKappa(['A', 'A', 'A'], ['A', 'A', 'A']);
  assert.strictEqual(same.kappa, null);
  assert.strictEqual(same.observed, 1);
  assert.throws(() => agree.cohenKappa(['A'], ['A', 'B']), /same items/);
  assert.throws(() => agree.cohenKappa([], []), /no items/);
});

test('sample: seeded, stratified by the first label, reproducible, without replacement', () => {
  const labels = {};
  for (let i = 1; i <= 23; i++) labels[`s${String(i).padStart(2, '0')}`] = 'capability';
  for (let i = 24; i <= 32; i++) labels[`s${String(i).padStart(2, '0')}`] = 'configuration';
  const a = agree.sample(labels, { capability: 5, configuration: 5 }, 'hb2-second-labeller-1');
  const b = agree.sample(labels, { capability: 5, configuration: 5 }, 'hb2-second-labeller-1');
  const c = agree.sample(labels, { capability: 5, configuration: 5 }, 'another seed');
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
  assert.strictEqual(a.length, 10);
  assert.strictEqual(new Set(a).size, 10);
  assert.strictEqual(a.filter((id) => labels[id] === 'capability').length, 5);
  assert.strictEqual(a.filter((id) => labels[id] === 'configuration').length, 5);
  assert.throws(() => agree.sample(labels, { capability: 24 }, 'x'), /only 23/);
});

test('summary: kappa on the label, agreement per class, and the per-blocker agreement on the items both labelled capability', () => {
  const first = { a: { label: 'capability', blockers: ['C1'] }, b: { label: 'capability', blockers: ['C1', 'C5'] }, c: { label: 'configuration', blockers: ['F1'] }, d: { label: 'configuration', blockers: ['F2'] } };
  const second = { a: { label: 'capability', blockers: ['C1'] }, b: { label: 'capability', blockers: ['C5'] }, c: { label: 'capability', blockers: ['C6'] }, d: { label: 'configuration', blockers: ['F2'] } };
  const s = agree.summary(first, second);
  assert.strictEqual(s.n, 4);
  assert.strictEqual(s.label.observed, 0.75);
  assert.ok(near(s.label.kappa, 0.5), JSON.stringify(s.label));
  assert.deepStrictEqual(s.disagreements, ['c']);
  // blockers: exact set match on a (yes), b (no: C1,C5 vs C5), c (no), d (yes) = 2 of 4
  assert.strictEqual(s.blockers.exactMatch, 2);
  assert.strictEqual(s.blockers.n, 4);
  assert.throws(() => agree.summary(first, { a: second.a }), /same items/);
});
