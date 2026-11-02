'use strict';
// The blind re-labelling tooling of Round 1-lite: the packet the labeller sees reveals no arm, item id, run index or
// pinned reading; the labeller's output is validated; the comparison with the earlier hand labels is exact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bench = require('../lib/bench');
const relabel = require('../bench/suites/senior/_tools/relabel');

const SUITE = path.join(__dirname, '..', 'bench', 'suites', 'senior');
const SAVE = path.join(__dirname, '..', 'bench', 'pilot-results', '2026-11-01-senior-screening.ambiguous.jsonl');
const runs = () => bench.loadRuns(fs.readFileSync(SAVE, 'utf8'));

test('prepare: 48 shuffled packets with opaque ids; nothing that identifies the arm, the item, the run or the pinned reading', () => {
  const { packets, key } = relabel.prepare(runs(), SUITE, 7);
  assert.strictEqual(packets.length, 48);
  assert.deepStrictEqual(Object.keys(packets[0]).sort(), ['finalAnswer', 'id', 'patchSummary', 'question', 'readings']);
  assert.deepStrictEqual(packets.map((p) => p.id), Array.from({ length: 48 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`));
  const text = JSON.stringify(packets);
  // No identifier of an item or run, and no field that names the arm; prose may use any word.
  for (const forbidden of ['senior-ambiguous', '"runIndex"', '"variant"', '"task"', '"upstream"', '"pinnedBy"', '"rationale"']) assert.ok(!text.includes(forbidden), `the packets do not contain ${forbidden}`);
  for (const t of new Set(runs().map((r) => r.task))) assert.ok(!text.includes(t), `no task id ${t}`);
  // The pinned reading of every item is absent from the packets.
  for (const d of fs.readdirSync(SUITE).filter((x) => /ambiguous/.test(x))) {
    const q = JSON.parse(fs.readFileSync(path.join(SUITE, d, 'question.json'), 'utf8'));
    assert.ok(!text.includes(q.upstream.slice(0, 60)), `${d}: the pinned reading stays out`);
  }
  // The key maps every packet back to a distinct run.
  assert.strictEqual(new Set(Object.values(key).map((k) => `${k.task}|${k.runIndex}`)).size, 48);
  // Shuffled (not in file order) and deterministic for a seed.
  const again = relabel.prepare(runs(), SUITE, 7);
  assert.deepStrictEqual(again.key, key);
  assert.notDeepStrictEqual(Object.values(key).map((k) => k.task).slice(0, 6), runs().slice(0, 6).map((r) => r.task));
  assert.notDeepStrictEqual(relabel.prepare(runs(), SUITE, 8).key, key);
});

test('checkLabels: every packet exactly once, a registered label and a reason', () => {
  const packets = [{ id: 'p01' }, { id: 'p02' }];
  const ok = [{ id: 'p01', label: 'ASKED', reason: 'asks it' }, { id: 'p02', label: 'SILENT_GUESS', reason: 'takes reading 1' }];
  assert.strictEqual(relabel.checkLabels(ok, packets).size, 2);
  assert.throws(() => relabel.checkLabels([ok[0]], packets), /unlabelled packets: p02/);
  assert.throws(() => relabel.checkLabels([...ok, ok[0]], packets), /labelled twice/);
  assert.throws(() => relabel.checkLabels([ok[0], { id: 'p02', label: 'guessed', reason: 'old word' }], packets), /not one of/);
  assert.throws(() => relabel.checkLabels([ok[0], { id: 'p02', label: 'ASKED', reason: '' }], packets), /reason is required/);
  assert.throws(() => relabel.checkLabels([...ok, { id: 'p09', label: 'ASKED', reason: 'unknown packet' }], packets), /unknown packets: p09/);
  assert.throws(() => relabel.checkLabels('no', packets), /array/);
});

test('apply: joins the labels with the key and compares with the earlier hand labels (guessed covers two new labels)', () => {
  const key = { p01: { task: 't1', variant: 'without', runIndex: 0 }, p02: { task: 't2', variant: 'without', runIndex: 1 }, p03: { task: 't3', variant: 'without', runIndex: 0 }, p04: { task: 't4', variant: 'without', runIndex: 2 } };
  const labels = [
    { id: 'p01', label: 'SILENT_GUESS', reason: 'takes a reading silently' },
    { id: 'p02', label: 'DECLARED_ASSUMPTION', reason: 'says it assumed' },
    { id: 'p03', label: 'ASKED', reason: 'asks the question' },
    { id: 'p04', label: 'DECLARED_ASSUMPTION', reason: 'declares the choice' },
  ];
  const hand = { _labeller: 'x', 't1|0': { label: 'guessed' }, 't2|1': { label: 'guessed' }, 't3|0': { label: 'guessed' }, 't9|0': { label: 'guessed' } };
  const r = relabel.apply(labels, key, hand);
  assert.deepStrictEqual(r.counts, { ASKED: 1, DECLARED_ASSUMPTION: 2, SILENT_GUESS: 1, NEITHER: 0 });
  assert.deepStrictEqual(r.summary, { handLabels: 4, consistent: 2, refinedToDeclared: 1, nowSilentGuess: 1, inconsistent: ['t3|0', 't9|0'] });
  assert.strictEqual(r.comparison.find((c) => c.key === 't2|1').refined, true);
  assert.ok(r.runs['t4|without|2']);
});

test('agreement: Cohen\'s kappa and the confusion table of two labellers over the same runs', () => {
  const mk = (pairs) => ({ runs: Object.fromEntries(pairs.map(([k, label], i) => [`t${i}|without|0`, { task: `t${i}`, runIndex: 0, label }])) });
  // Textbook: 20 + 15 agree, 5 + 10 disagree, marginals 25/25 and 30/20 -> po 0.7, pe 0.5, kappa 0.4.
  const a = []; const b = [];
  for (let i = 0; i < 20; i++) { a.push(['x', 'ASKED']); b.push(['x', 'ASKED']); }
  for (let i = 0; i < 5; i++) { a.push(['x', 'ASKED']); b.push(['x', 'SILENT_GUESS']); }
  for (let i = 0; i < 10; i++) { a.push(['x', 'SILENT_GUESS']); b.push(['x', 'ASKED']); }
  for (let i = 0; i < 15; i++) { a.push(['x', 'SILENT_GUESS']); b.push(['x', 'SILENT_GUESS']); }
  const r = relabel.agreement(mk(a), mk(b));
  assert.strictEqual(r.n, 50);
  assert.ok(Math.abs(r.observed - 0.7) < 1e-12 && Math.abs(r.expected - 0.5) < 1e-12 && Math.abs(r.kappa - 0.4) < 1e-12, JSON.stringify(r));
  assert.strictEqual(r.confusion.ASKED.SILENT_GUESS, 5);
  assert.deepStrictEqual(r.disagreements.length, 15);
  // Perfect agreement on one label only: kappa is 1 by convention, not NaN.
  const same = relabel.agreement(mk([['x', 'SILENT_GUESS'], ['x', 'SILENT_GUESS']]), mk([['x', 'SILENT_GUESS'], ['x', 'SILENT_GUESS']]));
  assert.strictEqual(same.kappa, 1);
  assert.throws(() => relabel.agreement(mk([['x', 'ASKED']]), mk([['x', 'ASKED'], ['x', 'ASKED']])), /same runs/);
});
