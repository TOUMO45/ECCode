'use strict';
// Simulated power (protocol 2026-11-02-senior-ambiguous-r1lite.md, Amendment 1, A1.1; run: node bench/suites/senior/_tools/r1lite-power.js)
// Simulated power of the pre-registered primary test (paired sign-flip on 16 per-item differences, ECCode minus bare, DECLARED_ASSUMPTION rate).
// Bare: item rate ~ logistic(logit(0.21) + N(0, tau)), 10 fresh runs on the 4 discriminating items, 3 screening runs elsewhere.
// ECCode: item rate ~ logistic(logit(q) + N(0, tau)), 3 runs per item. tau = 1 (the Phase 2 value). Seeded.
const { pairedPermutation } = require('../../../pilot/phase2-analysis');
const { mulberry32 } = require('../../../../lib/bench');
const logit = (p) => Math.log(p / (1 - p)); const lg = (x) => 1 / (1 + Math.exp(-x));
function normal(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
function power(q, { tau = 1, sims = 1500, seed = 11, bareRuns = [10, 10, 10, 10, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3], eccRuns = 3 } = {}) {
  const r = mulberry32(seed); let rej = 0; let meanDiff = 0;
  for (let s = 0; s < sims; s++) {
    const diffs = [];
    for (let i = 0; i < 16; i++) {
      const pb = lg(logit(0.21) + tau * normal(r)); const pe = lg(logit(q) + tau * normal(r));
      let kb = 0; for (let j = 0; j < bareRuns[i]; j++) kb += r() < pb ? 1 : 0;
      let ke = 0; for (let j = 0; j < eccRuns; j++) ke += r() < pe ? 1 : 0;
      diffs.push(ke / eccRuns - kb / bareRuns[i]);
    }
    const nz = diffs.filter((d) => Math.abs(d) > 1e-12);
    const t = pairedPermutation(nz);
    const mean = nz.reduce((a, b) => a + b, 0) / 16; meanDiff += mean;
    if (t.p !== null && t.p < 0.05 && mean > 0) rej++;
  }
  return { q, power: rej / sims, meanDiff: meanDiff / sims };
}
for (const q of [0.21, 0.35, 0.5, 0.65, 0.8, 0.9]) { const r = power(q); console.log(`ECCode true declared rate ${r.q}: power ${r.power.toFixed(3)}, mean per-item difference ${r.meanDiff.toFixed(3)}`); }
