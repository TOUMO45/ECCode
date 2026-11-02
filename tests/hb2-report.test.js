'use strict';
// The H-B2 report arithmetic: exact intervals and tails against textbook values, and the per-class tables from
// synthetic records. No seed, key or measurement is involved.
const test = require('node:test');
const assert = require('node:assert');
const report = require('../bench/pilot/hb2/report');

const near = (a, b, eps = 5e-4) => Math.abs(a - b) <= eps;

test('Clopper-Pearson 95% intervals match the textbook values, including the edges', () => {
  const ci = (k, n) => report.clopperPearson(k, n);
  let [lo, hi] = ci(7, 10);
  assert.ok(near(lo, 0.3475) && near(hi, 0.9333), `${lo} ${hi}`);
  [lo, hi] = ci(0, 10);
  assert.ok(lo === 0 && near(hi, 0.3085), `${lo} ${hi}`);
  [lo, hi] = ci(10, 10);
  assert.ok(near(lo, 0.6915) && hi === 1, `${lo} ${hi}`);
  [lo, hi] = ci(21, 21);
  assert.ok(near(lo, 0.8389) && hi === 1, `${lo} ${hi}`);
  [lo, hi] = ci(1, 4);
  assert.ok(near(lo, 0.0063) && near(hi, 0.8059), `${lo} ${hi}`);
  assert.deepStrictEqual(ci(0, 0), [null, null]);
});

test('the one-sided exact binomial tail against 0.90, and the number of seeds that could ever reject it', () => {
  assert.ok(near(report.binomialTailGE(21, 21, 0.9), 0.10942, 1e-5));
  assert.ok(near(report.binomialTailGE(29, 29, 0.9), 0.04710, 1e-5));
  assert.ok(near(report.binomialTailGE(0, 5, 0.9), 1, 1e-12));
  assert.ok(near(report.binomialTailGE(6, 10, 0.5), 0.376953125, 1e-9));
  assert.strictEqual(report.seedsToReject(0.9, 0.05), 29);
});

test('the exact two-sided sign test on discordant pairs', () => {
  assert.ok(near(report.signTest(0, 0), 1, 1e-12));
  assert.ok(near(report.signTest(5, 0), 0.0625, 1e-9));
  assert.ok(near(report.signTest(3, 3), 1, 1e-9));
  assert.ok(near(report.signTest(9, 2), 0.0654296875, 1e-9));
});

function rec(id, kind, intended, over = {}) {
  return { id, kind, intended, flagged: false, probes: 10, executed: 10, unexplained: 0, coverage: 'ok', route: 'run', ...over };
}

test('summarize: per-class and overall counts, rates with intervals, the H-B rule, and the intended-seed false positives apart', () => {
  const records = [
    ...['a', 'b', 'c', 'd'].map((x, i) => rec(`u${i}`, 'status-code', false, { flagged: i < 3, unexplained: i < 3 ? 2 : 0, miss: i < 3 ? undefined : 'no unexplained difference' })),
    ...['e', 'f'].map((x, i) => rec(`m${i}`, 'format', false, { flagged: false, coverage: 'insufficient-coverage', probes: 0, executed: 0, miss: 'coverage: no probe executed' })),
    rec('i0', 'boundary', true, { flagged: true }),
    rec('i1', 'boundary', true, { flagged: false, unexplained: 2, miss: '2 unexplained difference(s) on a declared change (false positive)' }),
    rec('i2', 'format', true, { flagged: false, coverage: 'insufficient-coverage', probes: 0, executed: 0, miss: 'coverage: no probe executed' }),
    rec('i3', 'format', true, { flagged: false, error: 'eccode behavior contract failed', miss: undefined }),
  ];
  const s = report.summarize(records);
  assert.deepStrictEqual([s.unintended.n, s.unintended.flagged, s.unintended.missed], [6, 3, 3]);
  assert.strictEqual(s.unintended.rate, 0.5);
  assert.ok(near(s.unintended.ci[0], 0.1181) && near(s.unintended.ci[1], 0.8819), JSON.stringify(s.unintended.ci));
  assert.strictEqual(s.unintended.met, false);
  assert.ok(s.unintended.binomialP > 0.9, 'a rate of 0.5 is nowhere near rejecting p <= 0.9');
  assert.deepStrictEqual(s.byClass.find((c) => c.kind === 'status-code').unintended, { n: 4, flagged: 3, ci: report.clopperPearson(3, 4) });
  assert.deepStrictEqual(s.byClass.find((c) => c.kind === 'format').unintended.n, 2);
  // Intended: accepted, false positive (an unexplained difference on a declared change), not verifiable (coverage, error).
  assert.deepStrictEqual([s.intended.n, s.intended.accepted, s.intended.falsePositives, s.intended.notVerifiable], [4, 1, 1, 2]);
  assert.strictEqual(s.intended.falsePositiveRate, 0.25);
  assert.deepStrictEqual(s.intended.falsePositiveCi, report.clopperPearson(1, 4));
  // The miss list names what the runner knows; capability/configuration labels come from a hand-made file.
  assert.deepStrictEqual(s.misses.map((m) => m.id).sort(), ['m0', 'm1', 'u3']);
  assert.ok(s.misses.every((m) => m.label === 'unlabelled'));
  const labelled = report.summarize(records, { labels: { u3: { label: 'capability', reason: 'needs data' }, m0: { label: 'configuration', reason: 'no probe' } } });
  assert.deepStrictEqual(labelled.misses.map((m) => [m.id, m.label]).sort(), [['m0', 'configuration'], ['m1', 'unlabelled'], ['u3', 'capability']]);
  assert.deepStrictEqual(labelled.labelCounts, { capability: 1, configuration: 1, unlabelled: 1 });
});

test('summarize: the rule is met at 0.90 and the statistical limit of a small set is stated', () => {
  const records = Array.from({ length: 21 }, (_, i) => rec(`u${i}`, 'boundary', false, { flagged: true, unexplained: 1 }));
  const s = report.summarize(records);
  assert.strictEqual(s.unintended.met, true);
  assert.ok(near(s.unintended.binomialP, 0.10942, 1e-5));
  assert.strictEqual(s.unintended.canReject, false, 'even 21 of 21 cannot reject a true rate of 0.90');
  assert.match(s.unintended.statement, /cannot reject/);
  const big = report.summarize(Array.from({ length: 29 }, (_, i) => rec(`u${i}`, 'boundary', false, { flagged: true, unexplained: 1 })));
  assert.strictEqual(big.unintended.canReject, true);
});

test('compare: the same seeds under two pipelines, paired', () => {
  const v2 = [rec('a', 'x', false, { flagged: true }), rec('b', 'x', false, { flagged: true }), rec('c', 'x', false, { flagged: false }), rec('d', 'x', false, { flagged: false })];
  const v1 = [rec('a', 'x', false, { flagged: true }), rec('b', 'x', false, { flagged: false }), rec('c', 'x', false, { flagged: false }), rec('d', 'x', false, { flagged: false })];
  const c = report.compare(v2, v1);
  assert.deepStrictEqual([c.both, c.onlyV2, c.onlyV1, c.neither], [1, 1, 0, 2]);
  assert.ok(near(c.signP, 1, 1e-9));
  assert.throws(() => report.compare(v2, v1.slice(1)), /same seeds/);
});
