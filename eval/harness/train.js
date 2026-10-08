#!/usr/bin/env node
'use strict';
// Training phase: every condition gets the same experience on the tune split.
// Per (condition, task): one attempt session; if hidden checks fail, one
// feedback session in the same working copy that lists the failing checks and
// their messages (as QA would report them). Afterwards, each condition's state
// is snapshotted for the holdout phase.
//
//   node eval/harness/train.js --run <runDir> [--conditions C0,C1,C2] [--tasks a,b] [--parallel 6]
//        [--budget-usd 6] [--timeout-min 45] [--model claude-sonnet-5-5]
// <runDir> must contain toolkits/ (export-toolkits.js). Resumable: finished steps are skipped.

const fs = require('fs');
const path = require('path');
const { listTasks, copyDir } = require('./lib');
const { runTrial, pool, argv } = require('./pool');
const { dropToken } = require('./sandbox-env');

const run = path.resolve(argv('run'));
const conds = (argv('conditions', 'C0,C1,C2')).split(',');
const parallel = Number(argv('parallel', '6'));
const common = ['--toolkits', path.join(run, 'toolkits'), '--budget-usd', argv('budget-usd', '6'), '--timeout-min', argv('timeout-min', '45'), '--model', argv('model', 'claude-sonnet-5-5')];
const tasks = listTasks().filter((t) => t.split === 'tune' && (!argv('tasks') || argv('tasks').split(',').includes(t.id)));

/** QA feedback text: failing check names (tags stripped) and their assertion messages. */
function feedbackFrom(tapFile) {
  const lines = fs.readFileSync(tapFile, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    out.push(`- ${m[1].replace(/\s*\[(trap|org):[\w-]+\]/g, '')}`);
    for (let j = i + 1; j < lines.length && !/^(not )?ok \d+ - /.test(lines[j]) && j < i + 40; j++) {
      const l = lines[j];
      if (/^\s+(error|expected|actual|message):/.test(l) || /^\s{4,}\S/.test(l)) {
        if (/^\s+(location|failureType|code|name|stack|duration_ms|type|operator):/.test(l) || /^\s+at /.test(l)) continue;
        out.push(`  ${l.trim()}`);
      }
    }
  }
  return out.join('\n');
}

function readResult(dir) {
  const f = path.join(dir, 'result.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

async function main() {
  fs.mkdirSync(path.join(run, 'logs'), { recursive: true });
  const jobs = [];
  for (const cond of conds) {
    const state = path.join(run, 'state', cond);
    for (const task of tasks) {
      jobs.push(async () => {
        const trial = path.join(run, 'trials', 'train', cond, task.id);
        const log = path.join(run, 'logs', `train-${cond}-${task.id}.log`);
        let attempt = readResult(path.join(trial, 'attempt'));
        if (!attempt) {
          await runTrial(['--task', task.id, '--condition', cond, '--trial', trial, '--state', state, '--phase', 'attempt', ...common], log);
          attempt = readResult(path.join(trial, 'attempt'));
        }
        if (!attempt) return { cond, task: task.id, error: 'attempt produced no result' };
        const rec = { cond, task: task.id, attempt: attempt.grade, attemptCost: attempt.costUsd, fedBack: null, feedback: null };
        if (!attempt.grade.success) {
          const fbFile = path.join(trial, 'feedback.txt');
          if (!fs.existsSync(fbFile)) fs.writeFileSync(fbFile, feedbackFrom(path.join(trial, 'attempt', 'grader.tap')));
          rec.fedBack = { checks: attempt.grade.failed, traps: attempt.grade.failedTraps, org: attempt.grade.failedOrg };
          let fb = readResult(path.join(trial, 'feedback'));
          if (!fb) {
            await runTrial(['--task', task.id, '--condition', cond, '--trial', trial, '--state', state, '--phase', 'feedback', '--feedback-file', fbFile, ...common], log);
            fb = readResult(path.join(trial, 'feedback'));
          }
          rec.feedback = fb && fb.grade;
          rec.feedbackCost = fb && fb.costUsd;
        }
        return rec;
      });
    }
  }
  const results = await pool(jobs, parallel, (r) => console.log(JSON.stringify({ cond: r.cond, task: r.task, attempt: r.attempt && r.attempt.success, fedBack: r.fedBack && [...r.fedBack.traps, ...r.fedBack.org], afterFeedback: r.feedback && r.feedback.success })));
  for (const cond of conds) {
    const state = path.join(run, 'state', cond);
    dropToken(state);
    const recs = results.filter((r) => r.cond === cond);
    fs.mkdirSync(path.join(run, 'training'), { recursive: true });
    fs.writeFileSync(path.join(run, 'training', `${cond}.json`), JSON.stringify(recs, null, 2));
    // Snapshot for holdout: toolkit memory stays; harness-level session data
    // (transcripts, todos, shell snapshots) is removed so no condition can
    // read raw past sessions, only what its toolkit chose to keep.
    const snap = path.join(run, 'snapshots', cond);
    fs.rmSync(snap, { recursive: true, force: true });
    copyDir(state, snap);
    // Session data goes (transcripts, todos, shell snapshots); what a toolkit chose to keep stays
    // (ECCode's shared memory, ECC's skills/learned and its own state under ~/.claude).
    for (const d of ['projects', 'sessions', 'todos', 'shell-snapshots', 'file-history', 'debug', 'plans', 'statsig', 'backups', 'session-env', 'cache', 'ide', 'telemetry']) fs.rmSync(path.join(snap, 'home', '.claude', d), { recursive: true, force: true });
    fs.rmSync(path.join(snap, 'home', '.claude.json'), { force: true });
    fs.rmSync(path.join(snap, '.ingress_token'), { force: true });
  }
  console.log(`training done: ${results.length} (condition, task) pairs; snapshots in ${path.join(run, 'snapshots')}`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
