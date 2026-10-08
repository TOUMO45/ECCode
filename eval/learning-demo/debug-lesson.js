#!/usr/bin/env node
'use strict';
// R6 demonstration with a DEBUGGING lesson (the evaluation's own lessons are organisational rules):
//   1. LEARN    a real investigation (`/eccode:investigate`) of a defect with a memoisation-key root cause
//               produces a lesson that a different reviewer must verify (reproduction flips to passing).
//   2. REUSE    a fresh session on a different service with the same kind of defect gets the lesson at
//               the plan and at the claim, and has to apply it.
//   3. REJECT   a fresh session on a service whose symptoms look the same (stale cached numbers) but whose
//               cause is different gets the same lesson and must set it aside, with a stated reason or an
//               experiment, and still fix the real cause.
// Every session is a real headless Claude Code session in the evaluation sandbox. The hidden graders of the
// evaluation tasks score the outcomes. Nothing here is part of the R7 evaluation.
//
//   node eval/learning-demo/debug-lesson.js --toolkits <dir> --out <dir> [--model claude-sonnet-5-5] [--budget-usd 6]
//        [--reuse-learning <earlier out dir>]   skip step 1 and start from the lesson that run produced
//        [--fresh C1-quote-cache,M6-menu-costing]   the tasks of steps 2 and 3 (reuse, then reject)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { listTasks, materialize, copyDir } = require('../harness/lib');
const { prepareState, dropToken } = require('../harness/sandbox-env');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const toolkits = path.resolve(arg('toolkits'));
const out = path.resolve(arg('out'));
const model = arg('model', 'claude-sonnet-5-5');
const budget = arg('budget-usd', '6');
const RUN_TRIAL = path.join(__dirname, '..', 'harness', 'run-trial.js');
const tasks = new Map(listTasks().map((t) => [t.id, t]));

const reuseFrom = arg('reuse-learning') ? path.resolve(arg('reuse-learning')) : null;
const fresh = arg('fresh', 'C1-quote-cache,M6-menu-costing').split(',');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const state = path.join(out, 'state');
if (reuseFrom) {
  copyDir(path.join(reuseFrom, 'state'), state);
  copyDir(path.join(reuseFrom, 'learn'), path.join(out, 'learn'));
}
prepareState('C2', state);
const log = [];

function feedbackFor(work, task) {
  const grader = path.join(task.dir, 'grader');
  const files = fs.readdirSync(grader).filter((f) => f.endsWith('.test.js')).map((f) => path.join(grader, f));
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: work, encoding: 'utf8', env: { ...process.env, TASK_ROOT: work } });
  const lines = `${r.stdout}`.split('\n');
  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    outLines.push(`- ${m[1].replace(/\s*\[(trap|org):[\w-]+\]/g, '')}`);
    for (let j = i + 1; j < lines.length && !/^(not )?ok \d+ - /.test(lines[j]) && j < i + 30; j++) {
      if (/^\s+error:/.test(lines[j]) || /^\s{4,}\S/.test(lines[j])) outLines.push(`  ${lines[j].trim()}`);
    }
  }
  return outLines.join('\n');
}

function trial(label, args) {
  const r = spawnSync(process.execPath, [RUN_TRIAL, ...args, '--toolkits', toolkits, '--budget-usd', budget, '--timeout-min', '60', '--model', model], { encoding: 'utf8' });
  const lastLine = `${r.stdout}`.trim().split('\n').pop();
  let parsed = null;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    /* reported below */
  }
  log.push({ label, exit: r.status, result: parsed, stderr: parsed ? undefined : `${r.stderr}`.slice(-400) });
  console.log(`${label}: ${lastLine.slice(0, 220)}`);
  return parsed;
}

// ---- 1. LEARN: the naive memoisation defect of the work-order service, investigated by a real session --------
if (!reuseFrom) {
  const learnTask = tasks.get('H4-workorder-access');
  const learnDir = path.join(out, 'learn');
  fs.mkdirSync(learnDir, { recursive: true });
  const learnWork = path.join(learnDir, 'work');
  materialize(learnTask, { overlay: 'naive', into: learnWork });
  const fb = feedbackFor(learnWork, learnTask);
  fs.writeFileSync(path.join(learnDir, 'feedback.txt'), fb);
  trial('learn: /eccode:investigate on a service with a memoisation-key defect', ['--task', learnTask.id, '--condition', 'C2', '--trial', learnDir, '--state', state, '--phase', 'feedback', '--feedback-file', path.join(learnDir, 'feedback.txt')]);
  dropToken(state);
} else {
  log.push({ label: 'learning step reused from an earlier run', from: reuseFrom });
}

const sharedRecords = () => {
  const dir = path.join(state, 'eccode-shared', 'records');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};
const lessons = sharedRecords();
log.push({ label: 'lessons in shared memory after learning', lessons: lessons.map((r) => ({ id: r.id, status: r.status, title: r.revisions[r.revisions.length - 1].content.title, reviews: (r.reviews || []).map((x) => `${x.reviewer}: ${x.decision}`) })) });
fs.writeFileSync(path.join(out, 'shared-records.json'), JSON.stringify(lessons, null, 2));

// ---- 2. REUSE and 3. REJECT: fresh sessions, each with its own copy of the state after learning ----------------
for (const [label, id] of [['reuse: a different service with the same kind of defect', fresh[0]], ['reject: stale cached numbers with a different cause', fresh[1]]]) {
  const t = tasks.get(id);
  const dir = path.join(out, id);
  const st = path.join(dir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  copyDir(state, st);
  trial(label, ['--task', id, '--condition', 'C2', '--trial', dir, '--state', st, '--phase', 'attempt', '--rep', '1', '--drop-token', '1']);
  void t;
}

// ---- evidence from the records of each fresh session -----------------------------------------------------------
const evidence = {};
for (const id of fresh) {
  const f = path.join(out, id, 'work', '.eccode', 'events.jsonl');
  const ev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  evidence[id] = {
    lessonsOfferedAtPlan: ev.filter((e) => e.type === 'gate.submitted' && e.data.lessons).flatMap((e) => e.data.lessons.map((l) => l.title)),
    planDecisions: ev.filter((e) => e.type === 'gate.submitted' && e.data.lessonDecisions).flatMap((e) => e.data.lessonDecisions),
    claimDecisions: ev.filter((e) => e.type === 'task.completed' && e.data.lessonDecisions).flatMap((e) => e.data.lessonDecisions),
    assessments: ev.filter((e) => e.type === 'memory.assessed').map((e) => ({ by: e.actor, ...e.data })),
    graderSuccess: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(out, id, 'attempt', 'result.json'), 'utf8')).grade.success;
      } catch {
        return null;
      }
    })(),
  };
}
fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
console.log(JSON.stringify(evidence, null, 2).slice(0, 3000));
