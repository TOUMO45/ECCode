#!/usr/bin/env node
'use strict';
// The screening's yield per category and the go/no-go (protocol amendment 2).
// A usable item: at least one of its bare runs fails the category's harness
// grade (migration, authorization: the `grade` hidden check) or is labelled
// `guessed` (ambiguous: <save>.labels.json from label.js). Correctness (the
// target and regression checks) is reported beside it. Go at >= 12 usable
// items in the category (10 runs per arm per item); otherwise no-go for it.
//   node yield.js   (reads bench/pilot-results/2026-11-01-senior-screening.<category>.jsonl)
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '..', 'pilot-results');
const MIN_ITEMS = 12;

function runsOf(category) {
  const f = path.join(DIR, `2026-11-01-senior-screening.${category}.jsonl`);
  if (!fs.existsSync(f)) return { runs: [], labels: null, file: f };
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const lf = f.replace(/\.jsonl$/, '.labels.json');
  return { runs: lines.filter((r) => !r.type), lines, labels: fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, 'utf8')).runs : null, file: f };
}

function summarize(category) {
  const { runs, lines, labels } = runsOf(category);
  const byItem = new Map();
  for (const r of runs) {
    if (!byItem.has(r.task)) byItem.set(r.task, []);
    byItem.get(r.task).push(r);
  }
  const correct = (r) => !r.timedOut && r.checks.filter((c) => c.id !== 'grade').every((c) => c.passed);
  const gradeFail = (r) => {
    if (category === 'ambiguous') {
      const l = labels && labels[`${r.task}|${r.variant}|${r.runIndex}`];
      return l ? l.label === 'guessed' : null;
    }
    const g = r.checks.find((c) => c.id === 'grade');
    return g ? !g.passed : null;
  };
  const items = [...byItem.entries()].map(([task, rs]) => ({
    task, runs: rs.length,
    correct: rs.filter(correct).length,
    gradeFailed: rs.filter((r) => gradeFail(r) === true).length,
    unlabelled: rs.filter((r) => gradeFail(r) === null).length,
    costUsd: Math.round(rs.reduce((s, r) => s + ((r.usage && r.usage.costUsd) || 0), 0) * 100) / 100,
    minutes: Math.round(rs.reduce((s, r) => s + r.durationMs / 60000, 0) * 10) / 10,
  }));
  const usable = items.filter((i) => i.gradeFailed > 0);
  const stopped = (lines || []).find((l) => l.type === 'stopped');
  return { category, items, usable: usable.map((i) => i.task), runs: runs.length, costUsd: Math.round(items.reduce((s, i) => s + i.costUsd, 0) * 100) / 100, go: usable.length >= MIN_ITEMS, stopped: stopped || null };
}

function table(categories = ['migration', 'authorization', 'ambiguous']) {
  const out = ['| Category | Items screened | Bare runs | Runs passing correctness | Runs failing the harness grade / guessed | Usable items (>= 1 failing run) | Spend | Go/no-go (>= 12 usable) |', '|---|---|---|---|---|---|---|---|'];
  const all = [];
  for (const c of categories) {
    const s = summarize(c);
    all.push(s);
    const correct = s.items.reduce((n, i) => n + i.correct, 0);
    const failed = s.items.reduce((n, i) => n + i.gradeFailed, 0);
    const unl = s.items.reduce((n, i) => n + i.unlabelled, 0);
    out.push(`| ${c} | ${s.items.length} | ${s.runs} | ${correct}/${s.runs} | ${failed}/${s.runs}${unl ? ` (${unl} unlabelled)` : ''} | ${s.usable.length} | $${s.costUsd} | ${s.go ? 'go' : 'no-go'}${s.stopped ? ' (stopped at the cap)' : ''} |`);
  }
  out.push('', '| Category | Item | Runs | Correct | Grade failed / guessed | $ | Minutes |', '|---|---|---|---|---|---|---|');
  for (const s of all) for (const i of s.items) out.push(`| ${s.category} | ${i.task} | ${i.runs} | ${i.correct} | ${i.gradeFailed}${i.unlabelled ? ` (+${i.unlabelled} unlabelled)` : ''} | ${i.costUsd} | ${i.minutes} |`);
  return out.join('\n');
}

if (require.main === module) process.stdout.write(table() + '\n');
module.exports = { summarize, table, MIN_ITEMS };
