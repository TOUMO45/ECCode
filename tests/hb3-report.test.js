'use strict';
// The H-B3 additions to the report (protocol 2026-11-03-hb3.md, sections 2 and 5): the two thresholds (50 percent: met by the point
// estimate, established only if the exact lower bound also reaches it; 90 percent aspirational), the four outcomes of an intended
// seed, a false-positive rate whose denominator is the seeds whose declared change was observed, and a primary/comparison pair that
// is not tied to v2/v1. Synthetic records only; no seed, key or measurement.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const report = require('../bench/pilot/hb2/report');

function rec(id, kind, intended, over = {}) {
  return { id, kind, intended, flagged: false, probes: 10, executed: 10, differences: 0, expected: 0, unexplained: 0, coverage: 'ok', route: 'run', ...over };
}

test('intended seeds fall into four outcomes; only "accepted and observed" counts as acceptance', () => {
  const records = [
    rec('o1', 'boundary', true, { flagged: true, differences: 3, expected: 3 }),
    rec('o2', 'format', true, { flagged: true, differences: 1, expected: 1 }),
    rec('u1', 'boundary', true, { flagged: true, differences: 0 }), // accepted, but the diff saw nothing
    rec('f1', 'format', true, { flagged: false, differences: 2, expected: 1, unexplained: 1, miss: '1 unexplained difference(s) on a declared change (false positive)' }),
    rec('n1', 'format', true, { flagged: false, coverage: 'insufficient-coverage', probes: 0, executed: 0, miss: 'coverage: no probe executed' }),
    rec('n2', 'format', true, { flagged: false, error: 'eccode behavior contract failed' }),
    rec('n3', 'format', true, { flagged: false, route: 'skip', miss: 'routing skip: no public surface reached' }),
  ];
  const i = report.summarize(records).intended;
  assert.deepStrictEqual(i.outcomes, { acceptedObserved: 2, acceptedUnobserved: 1, falsePositive: 1, notVerifiable: 3 });
  assert.strictEqual(i.n, 7);
  assert.deepStrictEqual(i.acceptance, { k: 2, n: 7, rate: 2 / 7, ci: report.clopperPearson(2, 7) });
  // A false positive can only show on a seed whose declared change was observed: 2 accepted-and-observed plus 1 false positive.
  assert.deepStrictEqual(i.falsePositiveOfObserved, { k: 1, n: 3, rate: 1 / 3, ci: report.clopperPearson(1, 3) });
  // The fields of H-B2 keep their meaning.
  assert.deepStrictEqual([i.accepted, i.falsePositives, i.notVerifiable], [3, 1, 3]);
});

test('no intended seed observed: the false-positive rate has no denominator and says so', () => {
  const i = report.summarize([rec('u1', 'boundary', true, { flagged: true }), rec('u2', 'boundary', true, { flagged: true })]).intended;
  assert.deepStrictEqual(i.outcomes, { acceptedObserved: 0, acceptedUnobserved: 2, falsePositive: 0, notVerifiable: 0 });
  assert.deepStrictEqual(i.falsePositiveOfObserved, { k: 0, n: 0, rate: null, ci: [null, null] });
  assert.strictEqual(i.acceptance.rate, 0);
});

test('the 50 percent threshold: met by the point estimate, established only by the lower bound; 90 percent aspirational', () => {
  const unintended = (flagged, n) => Array.from({ length: n }, (_, i) => rec(`u${i}`, 'boundary', false, { flagged: i < flagged, unexplained: i < flagged ? 1 : 0 }));
  const at = (k, n) => report.summarize(unintended(k, n)).unintended.thresholds;
  // 28 of 41 = 0.683, lower bound above 0.5
  assert.deepStrictEqual([at(28, 41).half.met, at(28, 41).half.established, at(28, 41).ninety.met], [true, true, false]);
  // 21 of 41 = 0.512: met, not established
  const t = at(21, 41);
  assert.deepStrictEqual([t.half.met, t.half.established], [true, false]);
  assert.ok(t.half.lowerBound < 0.5);
  // exactly half is met (>= 0.5)
  assert.strictEqual(at(20, 40).half.met, true);
  assert.strictEqual(at(20, 40).half.established, false);
  // 19 of 41: not met
  assert.deepStrictEqual([at(19, 41).half.met, at(19, 41).half.established], [false, false]);
  assert.strictEqual(at(41, 41).ninety.met, true);
  assert.strictEqual(report.summarize([]).unintended.thresholds.half.met, false);
});

test('compare names the pair neutrally and keeps the v2/v1 keys', () => {
  const a = [rec('a', 'x', false, { flagged: true }), rec('b', 'x', false, { flagged: true }), rec('c', 'x', false, { flagged: false })];
  const b = [rec('a', 'x', false, { flagged: true }), rec('b', 'x', false, { flagged: false }), rec('c', 'x', false, { flagged: true })];
  const c = report.compare(a, b);
  assert.deepStrictEqual([c.both, c.onlyPrimary, c.onlyComparison, c.neither], [1, 1, 1, 0]);
  assert.deepStrictEqual([c.onlyV2, c.onlyV1], [1, 1]);
});

test('the command line: a primary and a comparison pipeline of any name, with the four outcomes and the thresholds printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb3-report-'));
  const write = (name, rows) => { const f = path.join(dir, name); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); return f; };
  const base = (flaggedIds) => [
    ...Array.from({ length: 6 }, (_, i) => rec(`u${i}`, i % 2 ? 'format' : 'boundary', false, { flagged: flaggedIds.includes(i), unexplained: flaggedIds.includes(i) ? 1 : 0 })),
    rec('i1', 'boundary', true, { flagged: true, differences: 2, expected: 2 }),
    rec('i2', 'boundary', true, { flagged: true, differences: 0 }),
  ];
  const v3 = write('v3.jsonl', base([0, 1, 2, 3]));
  const v2 = write('v2.jsonl', base([0]));
  const out = path.join(dir, 'aggregate.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, '../bench/pilot/hb2/report.js'), '--primary', v3, '--primary-name', 'v3', '--comparison', v2, '--comparison-name', 'v2', '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /== v3/);
  assert.match(r.stdout, /== v2/);
  assert.match(r.stdout, /50 percent threshold: MET/);
  assert.match(r.stdout, /established \(exact lower bound >= 50%\): NO/);
  assert.match(r.stdout, /90 percent \(aspirational\): NOT MET/);
  assert.match(r.stdout, /accepted and observed 1, accepted but unobserved 1, false positive 0, not verifiable 0/);
  assert.match(r.stdout, /Paired, unintended seeds: both 1, only v3 3, only v2 0, neither 2/);
  const agg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(Object.keys(agg).sort(), ['comparison', 'comparisonName', 'primary', 'primaryName']);
  assert.strictEqual(agg.primary.unintended.flagged, 4);
  assert.strictEqual(agg.comparison.unintended.flagged, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
