'use strict';
// The Phase 2 screening (protocol section 4, amendment 2): per item, the bare
// runs' hidden-check outcomes, cost and time; the failed runs to label; with
// labels, the hard items and the go/no-go outcome under the registered rule.
//   node bench/pilot/phase2-screening/summary.js [--labels bench/pilot/phase2-screening/labels.json] [--json]
const fs = require('fs');
const path = require('path');
const { mulberry32 } = require('../../../lib/bench');

const DIR = path.join(__dirname, '..', '..', 'pilot-results');
const FILES = ['realbugs', 'mealie3a', 'mealie3b', 'mealie4'].map((n) => path.join(DIR, `2026-10-31-phase2-screening.${n}.jsonl`));
const TIMEOUT_MS = 7200000;
const MIN_HARD = 20;
const MAX_ITEMS = 24;

function records() {
  const out = [];
  for (const f of FILES) {
    if (!fs.existsSync(f)) continue;
    const name = /screening\.(\w+)\.jsonl$/.exec(f)[1];
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.type && r.task);
    const counts = {};
    for (const r of rows) {
      counts[r.task] = (counts[r.task] || 0) + 1;
      out.push({ ...r, process: name, run: counts[r.task], timedOut: Boolean(r.timedOut) || r.durationMs >= TIMEOUT_MS });
    }
  }
  return out;
}

const passed = (r) => !r.timedOut && r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

function shuffle(a, rnd) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

function summarize(rows, labels = {}) {
  const items = new Map();
  for (const r of rows) {
    if (!items.has(r.task)) items.set(r.task, { task: r.task, runs: [], cost: 0 });
    const it = items.get(r.task);
    it.runs.push(r);
    it.cost += (r.usage && r.usage.costUsd) || 0;
  }
  const table = [...items.values()].map((it) => {
    const failed = it.runs.filter((r) => !passed(r));
    const labelled = failed.map((r) => ({ run: r.run, timedOut: r.timedOut, hidden: `${r.hiddenPassed}/${r.hiddenTotal}`, label: (labels[`${r.task}:${r.run}`] || {}).label || (r.timedOut ? 'harness' : null) }));
    const hard = labelled.some((l) => l.label === 'agent-error');
    const unlabelled = labelled.filter((l) => !l.label).length;
    return { task: it.task, runs: it.runs.length, passed: it.runs.filter(passed).length, failed: labelled, hard, unlabelled, costUsd: Math.round(it.cost * 100) / 100, medianMin: median(it.runs.map((r) => r.durationMs / 60000)) };
  });
  const hard = table.filter((t) => t.hard).map((t) => t.task);
  const unlabelled = table.reduce((n, t) => n + t.unlabelled, 0);
  const chosen = hard.length > MAX_ITEMS ? shuffle([...hard].sort(), mulberry32(42)).slice(0, MAX_ITEMS).sort() : [...hard].sort();
  const totalCost = Math.round(rows.reduce((s, r) => s + ((r.usage && r.usage.costUsd) || 0), 0) * 100) / 100;
  return { items: table, runs: rows.length, totalCost, hard, chosen, unlabelled, outcome: unlabelled ? 'labels pending' : hard.length >= MIN_HARD ? 'go' : 'fewer than 20: expand the pool (rule 2)' };
}

function median(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? Math.round((s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 10) / 10 : null;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const labelsFile = argv.includes('--labels') ? argv[argv.indexOf('--labels') + 1] : path.join(__dirname, 'labels.json');
  const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};
  const s = summarize(records(), labels);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  else {
    for (const t of s.items) process.stdout.write(`${t.task.padEnd(26)} ${t.passed}/${t.runs} passed  $${t.costUsd.toFixed(2)}  ${t.medianMin} min${t.failed.length ? '  failed: ' + t.failed.map((f) => `run ${f.run} ${f.hidden}${f.timedOut ? ' timeout' : ''} [${f.label || '?'}]`).join('; ') : ''}${t.hard ? '  HARD' : ''}\n`);
    process.stdout.write(`\n${s.runs} runs, $${s.totalCost.toFixed(2)}; hard items ${s.hard.length}${s.unlabelled ? ` (${s.unlabelled} failed run(s) unlabelled)` : ''}; outcome: ${s.outcome}${s.chosen.length ? `\nitems: ${s.chosen.join(', ')}` : ''}\n`);
  }
}

module.exports = { records, summarize, passed };
