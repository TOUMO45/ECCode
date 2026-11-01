'use strict';
// Cost per correct change, per track (Phase 3, Part F). Reads benchmark run
// records (one JSON per line, with {variant, task, hiddenPassed, hiddenTotal,
// usage:{costUsd}}) and reports, per variant, the median cost of a CORRECT run
// (one that passed every hidden check), the share of runs that are correct,
// and the ratio of the median correct-run cost to the bare variant's. The
// targets of the phase are encoded and each track is flagged pass/over.
//   node bench/pilot/phase3-cost.js <runs.jsonl> [<runs.jsonl> ...]
const fs = require('fs');

// Variant -> track and its cost target (multiple of the bare median correct-run cost).
const TRACKS = {
  without: { track: 'bare', target: 1 },
  engine: { track: 'quick', target: 1.5 },
  debug: { track: 'fix (Debugging Lab)', target: 4 },
  ecc: { track: 'ECC v2.2.3', target: null },
};

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const costOf = (r) => (r.usage && typeof r.usage.costUsd === 'number' ? r.usage.costUsd : null);
const correct = (r) => !r.timedOut && r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

function load(files) {
  const rows = [];
  for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (!r.type && r.variant) rows.push(r); } catch { /* skip */ }
  }
  return rows;
}

function perVariant(rows) {
  const out = {};
  for (const v of [...new Set(rows.map((r) => r.variant))]) {
    const runs = rows.filter((r) => r.variant === v);
    const correctRuns = runs.filter(correct);
    const costs = runs.map(costOf).filter((c) => c !== null);
    out[v] = {
      track: (TRACKS[v] || {}).track || v,
      runs: runs.length,
      correct: correctRuns.length,
      correctRate: runs.length ? correctRuns.length / runs.length : 0,
      medianRunCost: median(costs),
      medianCorrectCost: median(correctRuns.map(costOf).filter((c) => c !== null)),
      // Cost per correct change: the arm's total spend over its correct runs.
      costPerCorrect: correctRuns.length ? Math.round((costs.reduce((a, b) => a + b, 0) / correctRuns.length) * 10000) / 10000 : null,
    };
  }
  return out;
}

function report(rows) {
  const v = perVariant(rows);
  const bare = v.without && v.without.costPerCorrect;
  const lines = ['Cost per correct change, per track:', ''];
  for (const [variant, t] of Object.entries(TRACKS)) {
    const d = v[variant];
    if (!d) continue;
    const ratio = bare && d.costPerCorrect ? Math.round((d.costPerCorrect / bare) * 100) / 100 : null;
    const flag = t.target && ratio !== null ? (ratio <= t.target ? 'within target' : `OVER target ${t.target}x`) : t.target ? 'target n/a (no data)' : 'reported only';
    lines.push(`- ${d.track}: ${d.correct}/${d.runs} correct, $${d.costPerCorrect ?? '-'} per correct change${ratio !== null ? `, ${ratio}x bare (target ${t.target ? `${t.target}x` : 'n/a'}: ${flag})` : ''}`);
  }
  // Tracks with no variant in the data are named so the gap is visible.
  const seen = new Set(Object.keys(v));
  for (const [variant, t] of Object.entries(TRACKS)) if (!seen.has(variant) && t.target) lines.push(`- ${t.track}: no runs in these records (target ${t.target}x bare)`);
  return { perVariant: v, bareCostPerCorrect: bare, text: lines.join('\n') };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { process.stderr.write('usage: phase3-cost.js <runs.jsonl> [...]\n'); process.exit(2); }
  const r = report(load(files));
  process.stdout.write(r.text + '\n');
}

module.exports = { perVariant, report, load, TRACKS, correct };
