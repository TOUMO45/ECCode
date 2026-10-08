#!/usr/bin/env node
'use strict';
// Infrastructure-failure rule, applied outcome-blind and to every condition alike:
// a trial whose session transcript contains the account's usage-limit message
// ("You've hit your session limit ...") was disturbed by something that has
// nothing to do with the toolkit under test, so it carries no information about
// the toolkit. Such trials are moved aside (kept, never deleted) and re-run from
// the same snapshot by the normal resumable `holdout.js` / `train.js`.
//
// This rule was NOT predeclared; it was introduced after the first official
// holdout run was hit by a usage limit. The report lists the quarantined trials
// and their original outcomes, and gives results both ways.
//
//   node eval/harness/quarantine-invalid.js --run <runDir> [--split holdout] [--dry-run]

const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const run = path.resolve(arg('run'));
const split = arg('split', 'holdout');
const dry = process.argv.includes('--dry-run');
const PATTERN = /you'?ve hit your (session|usage|weekly|rate)? ?limit|(session|weekly) limit ·|usage limit reached/i;

const base = path.join(run, 'trials', split);
const quarantine = path.join(run, 'trials', `${split}-invalid`);
const moved = [];
for (const cond of fs.existsSync(base) ? fs.readdirSync(base) : []) {
  for (const task of fs.readdirSync(path.join(base, cond))) {
    for (const rep of fs.readdirSync(path.join(base, cond, task))) {
      const dir = path.join(base, cond, task, rep);
      const transcript = path.join(dir, 'attempt', 'transcript.jsonl');
      if (!fs.existsSync(transcript)) continue;
      const text = fs.readFileSync(transcript, 'utf8');
      if (!PATTERN.test(text)) continue;
      const resultFile = path.join(dir, 'attempt', 'result.json');
      const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
      const rec = {
        condition: cond,
        task,
        rep,
        originalSuccess: result ? result.grade.success : null,
        originalCostUsd: result ? result.costUsd : null,
        toolUses: result ? result.toolUses : null,
        neverRan: result ? result.toolUses === 0 && result.costUsd === 0 : null,
      };
      moved.push(rec);
      if (!dry) {
        const dest = path.join(quarantine, cond, task, rep);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(dir, dest);
      }
    }
  }
}
const logFile = path.join(run, `invalid-${split}-trials.json`);
if (!dry) {
  const prior = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  fs.writeFileSync(logFile, JSON.stringify([...prior, ...moved], null, 2));
}
console.log(`${dry ? 'would quarantine' : 'quarantined'} ${moved.length} trial(s)`);
for (const m of moved) console.log(`  ${m.condition} ${m.task} ${m.rep} (original: ${m.originalSuccess ? 'pass' : 'fail'}${m.neverRan ? ', never ran' : ''})`);
