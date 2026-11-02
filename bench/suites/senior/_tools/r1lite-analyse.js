'use strict';
// The Round 1-lite analysis (protocol 2026-11-02-senior-ambiguous-r1lite.md, Amendment 1): the primary endpoint is the
// DECLARED_ASSUMPTION rate per item, ECCode against bare, over 16 items, by a paired sign-flip permutation test; pooled
// rates carry exact Clopper-Pearson intervals and their difference a Newcombe interval; ASKED, NEITHER and the nothing
// delivered share are counted apart. Inputs are label files in the relabel.js format ({ runs: { key: { task, label } } }).
//   node r1lite-analyse.js --ecc <labels.json> --screening <relabel-r1lite.json> --fresh <labels.json> [--primary-items a,b,c,d] [--out <aggregate.json>]
// The bare baseline of a primary (re-run) item is its fresh runs; of every other item, its screening runs. The screening
// runs of a primary item are reported apart: they were selected on failure and are not a baseline.
const fs = require('fs');
const path = require('path');
const { pairedPermutation } = require('../../../pilot/phase2-analysis');
const { clopperPearson } = require('../../../pilot/hb2/report');

const Z = 1.959963984540054;

/** Wilson score interval for k of n. */
function wilson(k, n, z = Z) {
  if (!n) return [null, null];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n); const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/** Newcombe's hybrid-score interval (method 10) for the difference p1 - p2. */
function newcombe(k1, n1, k2, n2, z = Z) {
  const p1 = k1 / n1; const p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1, z); const [l2, u2] = wilson(k2, n2, z);
  const diff = p1 - p2;
  return { diff, ci: [diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)] };
}

const tally = (runs) => ({
  n: runs.length,
  declared: runs.filter((r) => r.label === 'DECLARED_ASSUMPTION').length,
  asked: runs.filter((r) => r.label === 'ASKED').length,
  neither: runs.filter((r) => r.label === 'NEITHER').length,
  silent: runs.filter((r) => r.label === 'SILENT_GUESS').length,
});
const rateOf = (t) => (t.n ? t.declared / t.n : null);

function analyse({ ecc, screening, fresh, primaryItems = [], items }) {
  const by = (labels, task) => Object.values(labels.runs).filter((r) => r.task === task);
  const rows = items.map((task) => {
    const e = by(ecc, task);
    if (!e.length) throw new Error(`${task}: no ECCode runs`);
    const isPrimary = primaryItems.includes(task);
    const baseRuns = isPrimary ? by(fresh, task) : by(screening, task);
    if (!baseRuns.length) throw new Error(`${task}: no bare runs (${isPrimary ? 'fresh' : 'screening'})`);
    const eT = tally(e); const bT = tally(baseRuns);
    return { task, primaryItem: isPrimary, ecc: { ...eT, rate: rateOf(eT) }, bare: { ...bT, rate: rateOf(bT) }, diff: rateOf(eT) - rateOf(bT), screeningNote: isPrimary ? tally(by(screening, task)) : null };
  });
  const diffs = rows.map((r) => r.diff);
  const t = pairedPermutation(diffs);
  const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sum = (arm, f) => rows.reduce((s, r) => s + r[arm][f], 0);
  const pooled = (arm) => { const n = sum(arm, 'n'); const declared = sum(arm, 'declared'); return { n, declared, asked: sum(arm, 'asked'), neither: sum(arm, 'neither'), silent: sum(arm, 'silent'), rate: declared / n, ci: clopperPearson(declared, n) }; };
  const e = pooled('ecc'); const b = pooled('bare');
  const nothing = e.asked + e.neither;
  return {
    items: rows,
    primary: { k: diffs.filter((d) => Math.abs(d) > 1e-12).length, meanDiff, p: t.p, exact: t.exact, alpha: 0.05, met: t.p !== null && t.p < 0.05 && meanDiff > 0 },
    ecc: { ...e, nothingDeliveredShare: nothing / e.n, friction: nothing / e.n > 0.25 },
    bare: b,
    difference: newcombe(e.declared, e.n, b.declared, b.n),
    surfaced: { ecc: e.declared + e.asked, bare: b.declared + b.asked },
  };
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (n) => { const v = arg(n); if (!v) { process.stderr.write('usage: r1lite-analyse.js --ecc <labels> --screening <labels> --fresh <labels> [--primary-items a,b] [--out <json>]\n'); process.exit(2); } return JSON.parse(fs.readFileSync(path.resolve(v), 'utf8')); };
  const ecc = need('--ecc'); const screening = need('--screening'); const fresh = need('--fresh');
  const items = [...new Set(Object.values(screening.runs).map((r) => r.task))].sort();
  const primaryItems = (arg('--primary-items') || '').split(',').filter(Boolean);
  const r = analyse({ ecc, screening, fresh, primaryItems, items });
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  process.stdout.write(`PRIMARY (DECLARED_ASSUMPTION rate, ${items.length} items): ECCode ${r.ecc.declared}/${r.ecc.n} (${pc(r.ecc.rate)}, exact 95% [${pc(r.ecc.ci[0])}, ${pc(r.ecc.ci[1])}]) against bare ${r.bare.declared}/${r.bare.n} (${pc(r.bare.rate)}, [${pc(r.bare.ci[0])}, ${pc(r.bare.ci[1])}]); difference ${pc(r.difference.diff)} (Newcombe [${pc(r.difference.ci[0])}, ${pc(r.difference.ci[1])}]); mean per-item difference ${r.primary.meanDiff.toFixed(3)}; paired permutation over ${r.primary.k} differing items p = ${r.primary.p.toFixed(5)}: ${r.primary.met ? 'MET' : 'NOT MET'}.\n`);
  process.stdout.write(`Nothing delivered by ECCode (ASKED ${r.ecc.asked}, NEITHER ${r.ecc.neither}): ${pc(r.ecc.nothingDeliveredShare)}${r.ecc.friction ? ' — above 25%, reported as friction' : ''}. Surfaced (ASKED or DECLARED): ECCode ${r.surfaced.ecc}, bare ${r.surfaced.bare}.\n`);
  for (const i of r.items) process.stdout.write(`  ${i.task.padEnd(30)} ECCode ${i.ecc.declared}/${i.ecc.n}  bare ${i.bare.declared}/${i.bare.n}${i.primaryItem ? ` (fresh; screening ${i.screeningNote.declared}/${i.screeningNote.n}, selected on failure)` : ''}  diff ${i.diff.toFixed(2)}\n`);
  if (arg('--out')) fs.writeFileSync(path.resolve(arg('--out')), JSON.stringify(r, null, 2) + '\n');
  return 0;
}

module.exports = { wilson, newcombe, analyse };

if (require.main === module) process.exit(main(process.argv.slice(2)));
