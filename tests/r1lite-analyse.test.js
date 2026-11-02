'use strict';
// The Round 1-lite analysis (protocol Amendment 1): Wilson and Newcombe intervals against textbook values, and the
// primary endpoint from synthetic labels. No run of ECCode is involved.
const test = require('node:test');
const assert = require('node:assert');
const a = require('../bench/suites/senior/_tools/r1lite-analyse');

const near = (x, y, eps = 6e-4) => Math.abs(x - y) <= eps;

test('Wilson score interval and Newcombe difference interval match the published values', () => {
  const [lo, hi] = a.wilson(7, 10);
  assert.ok(near(lo, 0.3968) && near(hi, 0.8922), `${lo} ${hi}`);
  // Newcombe (1998), method 10, the worked example 56/70 against 48/80: 0.2000 (0.0524, 0.3339).
  const d = a.newcombe(56, 70, 48, 80);
  assert.ok(near(d.diff, 0.2, 1e-9) && near(d.ci[0], 0.0524) && near(d.ci[1], 0.3339), JSON.stringify(d));
  assert.deepStrictEqual(a.wilson(0, 0), [null, null]);
  const same = a.newcombe(3, 10, 3, 10);
  assert.ok(Math.abs(same.diff) < 1e-12 && same.ci[0] < 0 && same.ci[1] > 0);
});

const ITEMS = Array.from({ length: 16 }, (_, i) => `item${String(i).padStart(2, '0')}`);
const PRIMARY4 = ITEMS.slice(0, 4);
function runs(variant, perItem, count) {
  const out = {};
  for (const t of ITEMS) for (let k = 0; k < count(t); k++) out[`${t}|${variant}|${k}`] = { task: t, variant, runIndex: k, label: perItem(t, k) };
  return { runs: out };
}

test('the primary endpoint: per-item rates, the paired permutation, pooled rates with intervals, nothing delivered counted apart', () => {
  // ECCode declares on 8 of 16 items in all 3 runs, asks once on item 15, delivers nothing once on item 14; bare never declares.
  const ecc = runs('engine', (t, k) => (ITEMS.indexOf(t) < 8 ? 'DECLARED_ASSUMPTION' : t === 'item15' && k === 0 ? 'ASKED' : t === 'item14' && k === 0 ? 'NEITHER' : 'SILENT_GUESS'), () => 3);
  const screening = runs('without', () => 'SILENT_GUESS', () => 3);
  const fresh = runs('without', () => 'SILENT_GUESS', () => 10);
  const r = a.analyse({ ecc, screening, fresh: { runs: Object.fromEntries(Object.entries(fresh.runs).filter(([, v]) => PRIMARY4.includes(v.task))) }, primaryItems: PRIMARY4, items: ITEMS });
  assert.strictEqual(r.items.length, 16);
  assert.strictEqual(r.items.find((x) => x.task === 'item00').bare.n, 10, 'fresh runs replace the screening runs on the re-run items');
  assert.strictEqual(r.items.find((x) => x.task === 'item05').bare.n, 3, 'screening runs elsewhere');
  assert.strictEqual(r.items.find((x) => x.task === 'item00').screeningNote.n, 3, 'the selected-on-failure runs are kept apart, not a baseline');
  assert.strictEqual(r.primary.k, 8, 'eight items differ');
  assert.ok(near(r.primary.p, 2 / 256, 1e-9), String(r.primary.p));
  assert.ok(r.primary.met);
  assert.ok(near(r.primary.meanDiff, 0.5, 1e-9));
  assert.deepStrictEqual([r.ecc.n, r.ecc.declared, r.ecc.asked, r.ecc.neither], [48, 24, 1, 1]);
  assert.strictEqual(r.bare.n, 4 * 10 + 12 * 3);
  assert.strictEqual(r.bare.declared, 0);
  assert.ok(near(r.ecc.nothingDeliveredShare, 2 / 48, 1e-12));
  assert.strictEqual(r.surfaced.ecc, 25);
  assert.ok(r.difference.ci[0] > 0.3);
});

test('no effect: equal rates give p = 1 and the rule is not met; a worse ECCode is not met either', () => {
  const same = a.analyse({ ecc: runs('engine', (t, k) => (k === 0 ? 'DECLARED_ASSUMPTION' : 'SILENT_GUESS'), () => 3), screening: runs('without', (t, k) => (k === 0 ? 'DECLARED_ASSUMPTION' : 'SILENT_GUESS'), () => 3), fresh: { runs: {} }, primaryItems: [], items: ITEMS });
  assert.strictEqual(same.primary.p, 1);
  assert.strictEqual(same.primary.met, false);
  const worse = a.analyse({ ecc: runs('engine', () => 'SILENT_GUESS', () => 3), screening: runs('without', () => 'DECLARED_ASSUMPTION', () => 3), fresh: { runs: {} }, primaryItems: [], items: ITEMS });
  assert.ok(worse.primary.meanDiff < 0);
  assert.strictEqual(worse.primary.met, false, 'a significant difference in the wrong direction is not a success');
});

test('an item without runs in an arm is refused, not silently dropped', () => {
  assert.throws(() => a.analyse({ ecc: runs('engine', () => 'SILENT_GUESS', (t) => (t === 'item03' ? 0 : 3)), screening: runs('without', () => 'SILENT_GUESS', () => 3), fresh: { runs: {} }, primaryItems: [], items: ITEMS }), /item03.*no ECCode runs/);
});
