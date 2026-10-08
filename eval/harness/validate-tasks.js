#!/usr/bin/env node
'use strict';
// Validate every eval task (or those named on the command line):
//   original repo : visible tests pass, >=1 hidden AC fails, every REG passes
//   solution/     : visible tests pass, every hidden check passes
//   naive/        : visible tests pass, >=1 [trap:*] check fails (if present)
//   vendored kit  : identical to eval/kit/acme-kit
// Prints one JSON line per task. Exit 1 if any task is invalid.
// --quiet-names omits check names (used for sealed holdout tasks).

const fs = require('fs');
const path = require('path');
const { listTasks, materialize, runVisible, runGrader, score, sha256Dir, KIT_DIR } = require('./lib');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet-names');
const only = args.filter((a) => !a.startsWith('--'));
let bad = 0;

for (const task of listTasks().filter((t) => !only.length || only.includes(t.id))) {
  const problems = [];
  const out = { id: task.id, split: task.split, family: task.family };
  const kitCopy = path.join(task.dir, 'repo', 'vendor', 'acme-kit');
  if (!fs.existsSync(kitCopy) || sha256Dir(kitCopy) !== sha256Dir(KIT_DIR)) problems.push('vendor/acme-kit differs from eval/kit/acme-kit');
  if (!fs.existsSync(path.join(task.dir, 'repo', 'TASK.md'))) problems.push('repo/TASK.md missing');

  const variants = [['original'], ['solution', 'solution'], ...(fs.existsSync(path.join(task.dir, 'naive')) ? [['naive', 'naive']] : [])];
  for (const [label, overlay] of variants) {
    const work = materialize(task, { overlay });
    const vis = runVisible(work);
    const grade = runGrader(task, work);
    const s = score(vis, grade);
    out[label] = { visibleOk: vis.ok, acPassed: s.acPassed, acTotal: s.acTotal, regressions: s.regressions, failedTraps: s.failedTraps, ...(quiet ? {} : { failed: s.failed }) };
    if (!vis.ok) problems.push(`${label}: visible tests fail\n${vis.tail}`);
    if (!grade.checks.length) problems.push(`${label}: grader produced no checks\n${grade.tail}`);
    if (label === 'original') {
      if (s.acPassed === s.acTotal) problems.push('original: no hidden acceptance check fails (task is already solved)');
      if (s.regressions.length) problems.push(`original: regression checks fail: ${s.regressions.join(', ')}`);
    }
    if (label === 'solution' && !s.success) problems.push(`solution: not all hidden checks pass (${s.failed.join('; ')})`);
    if (label === 'naive' && !s.failedTraps.length) problems.push('naive: no [trap:*] check fails');
    fs.rmSync(work, { recursive: true, force: true });
  }
  out.valid = problems.length === 0;
  if (!out.valid) {
    bad++;
    out.problems = problems;
  }
  console.log(JSON.stringify(out));
}
process.exit(bad ? 1 : 0);
