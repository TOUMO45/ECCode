'use strict';
// The narrowed re-measurement's comparison table (Phase 3 report §4a): per
// item and arm, runs, runs passing every hidden check, delivered (engine
// arms), mean cost and minutes per run, and the cost per prevented failure
// against bare (protocol amendment 3): (the arm's mean cost per run − bare's)
// / (bare's failure rate − the arm's), undefined when the denominator is not
// positive. Computed from the saved records, never typed in.
//   node bench/pilot/narrowed-compare.js
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'pilot-results');
const load = (f) => (fs.existsSync(path.join(DIR, f)) ? fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => !r.type) : []);
const ARMS = {
  'mealie3-01-fix-3be8f3d8': {
    bare: load('2026-11-01-phase2-ha-exploratory.bare-m3.jsonl'),
    'ECC v2.2.3': load('2026-11-01-phase2-ha-exploratory.ecc-m3.jsonl'),
    '0.A debug (un-narrowed Phase 2)': load('2026-11-01-phase2-ha-exploratory.ph2-m3.jsonl'),
    'narrowed Phase 3 debug': load('2026-11-01-phase3-remeasure-narrowed.m3.jsonl'),
  },
  'mealie4-05-fix-fb221afa': {
    bare: load('2026-11-01-phase2-ha-exploratory.bare-m4.jsonl'),
    'ECC v2.2.3': [...load('2026-11-01-phase2-ha-exploratory.ecc-calibration.jsonl'), ...load('2026-11-01-phase2-ha-exploratory.ecc-m4.jsonl')],
    'narrowed Phase 3 debug': load('2026-11-01-phase3-remeasure-narrowed.m4.jsonl'),
  },
};
const pass = (r) => !r.timedOut && r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x === null ? '—' : (Math.round(x * 100) / 100).toFixed(2));

function stats(runs) {
  const costs = runs.map((r) => (r.usage && r.usage.costUsd) || 0);
  return { n: runs.length, passed: runs.filter(pass).length, delivered: runs.filter((r) => r.engine).length ? runs.filter((r) => r.engine && r.engine.delivered).length : null, cost: mean(costs), minutes: mean(runs.map((r) => r.durationMs / 60000)), failRate: runs.length ? runs.filter((r) => !pass(r)).length / runs.length : null };
}

function table() {
  const lines = ['| Item | Arm | Runs | Passing every hidden check | Delivered | Mean $/run | Mean min/run | $ per prevented failure vs bare |', '|---|---|---|---|---|---|---|---|'];
  for (const [item, arms] of Object.entries(ARMS)) {
    const bare = stats(arms.bare);
    for (const [arm, runs] of Object.entries(arms)) {
      if (!runs.length) { lines.push(`| ${item} | ${arm} | 0 | — | — | — | — | — |`); continue; }
      const s = stats(runs);
      let cppf = '—';
      if (arm !== 'bare') {
        const denom = bare.failRate - s.failRate;
        cppf = denom > 0 ? `$${r2((s.cost - bare.cost) / denom)}` : 'undefined (no failure prevented)';
      }
      lines.push(`| ${item} | ${arm} | ${s.n} | ${s.passed}/${s.n} | ${s.delivered === null ? '—' : `${s.delivered}/${s.n}`} | ${r2(s.cost)} | ${r2(s.minutes)} | ${cppf} |`);
    }
  }
  return lines.join('\n');
}

if (require.main === module) process.stdout.write(table() + '\n');
module.exports = { table, stats, ARMS };
