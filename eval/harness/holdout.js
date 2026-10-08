#!/usr/bin/env node
'use strict';
// Holdout phase: each condition x holdout task x repeat runs ONE attempt from a
// fresh copy of that condition's post-training snapshot, so trials never learn
// from each other. Resumable: finished trials are skipped.
//
//   node eval/harness/holdout.js --run <runDir> [--conditions C0,C1,C2] [--repeats 3] [--parallel 6]
//        [--budget-usd 6] [--timeout-min 45] [--model claude-sonnet-5-5] [--split holdout]

const fs = require('fs');
const path = require('path');
const { listTasks, copyDir } = require('./lib');
const { runTrial, pool, argv } = require('./pool');

const run = path.resolve(argv('run'));
const conds = argv('conditions', 'C0,C1,C2').split(',');
const repeats = Number(argv('repeats', '3'));
const parallel = Number(argv('parallel', '6'));
const split = argv('split', 'holdout');
const common = ['--toolkits', path.join(run, 'toolkits'), '--budget-usd', argv('budget-usd', '6'), '--timeout-min', argv('timeout-min', '45'), '--model', argv('model', 'claude-sonnet-5-5'), '--drop-token', '1'];
const tasks = listTasks().filter((t) => t.split === split && (!argv('tasks') || argv('tasks').split(',').includes(t.id)));

async function main() {
  fs.mkdirSync(path.join(run, 'logs'), { recursive: true });
  const jobs = [];
  // Interleave conditions so that time-of-day effects are spread evenly.
  for (let rep = 1; rep <= repeats; rep++) {
    for (const task of tasks) {
      for (const cond of conds) {
        jobs.push(async () => {
          const trial = path.join(run, 'trials', split, cond, task.id, `r${rep}`);
          if (fs.existsSync(path.join(trial, 'attempt', 'result.json'))) return { cond, task: task.id, rep, skipped: true };
          const snap = path.join(run, 'snapshots', cond);
          if (!fs.existsSync(snap)) throw new Error(`no training snapshot for ${cond}: run train.js first`);
          fs.rmSync(trial, { recursive: true, force: true });
          const state = path.join(trial, 'state');
          copyDir(snap, state);
          const r = await runTrial(['--task', task.id, '--condition', cond, '--trial', trial, '--state', state, '--rep', String(rep), ...common], path.join(run, 'logs', `${split}-${cond}-${task.id}-r${rep}.log`));
          return { cond, task: task.id, rep, ...r };
        });
      }
    }
  }
  await pool(jobs, parallel, (r) => console.log(JSON.stringify(r)));
  console.log('holdout done');
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
