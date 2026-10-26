'use strict';
// The proof run's analysis (bench/protocols/2026-10-26-mealie-proof.md).
// Stage 1 runs every item bare and through the engine; an item is hard when a
// stage-1 bare run failed a hidden check and that failure is labelled
// agent-error (the request states what the failing test checks). The primary
// comparison uses stage-2 runs on the hard items only: the stage-1 bare runs
// chose the items, so they would bias it.
// usage: node bench/pilot/proof.js --stage1 <dir> --labels <file> [--stage2 <dir>] [--out <file.md>]
const fs = require('fs');
const path = require('path');
const { stratifiedTest } = require('../../lib/bench');

const readRuns = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => ({ process: path.basename(f, '.jsonl'), ...JSON.parse(l) })));

/** Passed every hidden check; a run with no result line (cut, or no checks ran) did not. */
const passed = (r) => r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

/** One key per run: process:task:n, n counting that process's runs of the task from 1. */
function runKeys(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const k = `${r.process}:${r.task}`;
    seen.set(k, (seen.get(k) || 0) + 1);
    return `${k}:${seen.get(k)}`;
  });
}

/** Items a stage-1 bare run failed by agent error; throws if a failed bare run has no label. */
function hardItems(stage1, labels) {
  const keys = runKeys(stage1);
  const hard = new Set();
  const unlabelled = [];
  stage1.forEach((r, i) => {
    if (r.variant !== 'without' || passed(r)) return;
    const l = labels[keys[i]];
    if (!l) unlabelled.push(keys[i]);
    else if (l.label === 'agent-error') hard.add(r.task);
  });
  if (unlabelled.length) throw new Error(`unlabelled failed bare runs: ${unlabelled.join(', ')}`);
  return [...hard].sort();
}

const tally = (rows) => ({ passed: rows.filter(passed).length, runs: rows.length });

/** Stage-2 engine against bare on the hard items: counts and the stratified permutation test. */
function primary(stage2, hard) {
  const rows = stage2.filter((r) => hard.includes(r.task));
  const engine = rows.filter((r) => r.variant === 'engine');
  const without = rows.filter((r) => r.variant === 'without');
  const test = stratifiedTest(rows.map((r) => ({ stratum: r.task, variant: r.variant === 'engine' ? 'with' : 'without', lines: passed(r) ? 1 : 0 })));
  return { engine: tally(engine), without: tally(without), test };
}

/** Engine runs delivered with a clean audit; a run with no result counts as not delivered. */
function delivery(rows) {
  const engine = rows.filter((r) => r.variant === 'engine');
  const delivered = engine.filter((r) => r.engine && r.engine.delivered && r.engine.auditOk).length;
  return { delivered, runs: engine.length, share: engine.length ? delivered / engine.length : null };
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const cost = (r) => (r.usage ? r.usage.costUsd : undefined);

function report({ stage1, stage2, labels }) {
  const tasks = [...new Set(stage1.map((r) => r.task))].sort();
  const lines = ['# Proof run: analysis', '', '## Stage 1: every item', '', '| Item | Bare passed | Engine passed |', '|---|---|---|'];
  for (const t of tasks) {
    const of = (v) => tally(stage1.filter((r) => r.task === t && r.variant === v));
    lines.push(`| ${t} | ${of('without').passed}/${of('without').runs} | ${of('engine').passed}/${of('engine').runs} |`);
  }
  const hard = hardItems(stage1, labels);
  lines.push('', `Hard items (a stage-1 bare run failed by agent error): ${hard.length ? hard.join(', ') : 'none'}.`);
  if (stage2) {
    const p = primary(stage2, hard);
    lines.push('', '## Stage 2: the hard items (primary)', '', `Engine ${p.engine.passed}/${p.engine.runs}, bare ${p.without.passed}/${p.without.runs}.`);
    if (p.test) lines.push(`Stratified permutation test: difference ${p.test.delta.toFixed(3)}, p = ${p.test.p.toFixed(4)} (${p.test.strata} items, ${p.test.runs} runs).`);
  }
  const all = stage2 ? stage1.concat(stage2) : stage1;
  const d = delivery(all);
  const ratio = median(all.filter((r) => r.variant === 'engine').map(cost)) / median(all.filter((r) => r.variant === 'without').map(cost));
  lines.push('', '## Delivery and cost (every engine run)', '', `Delivered with a clean audit: ${d.delivered}/${d.runs}${d.share === null ? '' : ` (${(d.share * 100).toFixed(0)}%)`}.`, `Median cost, engine over bare: ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : '—'}.`);
  return `${lines.join('\n')}\n`;
}

module.exports = { readRuns, passed, runKeys, hardItems, primary, delivery, report };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : null);
  const md = report({ stage1: readRuns(opt('stage1')), stage2: opt('stage2') ? readRuns(opt('stage2')) : null, labels: JSON.parse(fs.readFileSync(opt('labels'), 'utf8')) });
  if (opt('out')) fs.writeFileSync(opt('out'), md);
  process.stdout.write(md);
}
