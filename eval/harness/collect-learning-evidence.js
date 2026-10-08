#!/usr/bin/env node
'use strict';
// Collects requirement-R6 evidence from an official run directory:
//   * training: each verified lesson with its reproduction, failed attempts, sources,
//     verification evidence, applicability limits and the independent review that
//     verified it, plus the sanitized copy promoted to shared memory;
//   * holdout (C2): per trial, which lessons the claim offered, the decision recorded
//     for each (applied / not-applicable with a reason or an assessment), and whether
//     the hidden grader passed - so reuse in a fresh session and rejection on decoys
//     can be read from the record, not from a summary.
//
//   node eval/harness/collect-learning-evidence.js --run <runDir> --out <dir> [--split holdout|holdout2]

const fs = require('fs');
const path = require('path');
const { listTasks } = require('./lib');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const run = path.resolve(arg('run'));
const split = arg('split', 'holdout');
const out = path.resolve(arg('out'));
const tasks = new Map(listTasks().map((t) => [t.id, t]));

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lastRev = (r) => r.revisions[r.revisions.length - 1];
const events = (dir) => {
  const f = path.join(dir, '.eccode', 'events.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lessons'), { recursive: true });

// ---- training: lessons ------------------------------------------------------
const shared = path.join(run, 'snapshots', 'C2', 'eccode-shared', 'records');
const sharedRecords = fs.existsSync(shared) ? fs.readdirSync(shared).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(shared, f))) : [];
const lessons = [];
const trainRoot = path.join(run, 'trials', 'train', 'C2');
for (const task of fs.existsSync(trainRoot) ? fs.readdirSync(trainRoot) : []) {
  const mem = path.join(trainRoot, task, 'work', '.eccode', 'memory', 'records');
  if (!fs.existsSync(mem)) continue;
  for (const f of fs.readdirSync(mem).filter((x) => x.endsWith('.json'))) {
    const rec = readJson(path.join(mem, f));
    if (rec.layer !== 'debugging') continue;
    const c = lastRev(rec).content;
    const promoted = sharedRecords.find((s) => lastRev(s).content.fingerprint === c.fingerprint);
    const item = {
      task,
      projectRecordId: rec.id,
      title: c.title,
      status: rec.status,
      createdBy: rec.createdBy,
      reviews: (rec.reviews || []).map((r) => ({ reviewer: r.reviewer, decision: r.decision, notes: r.notes })),
      independentReview: (rec.reviews || []).some((r) => r.reviewer !== rec.createdBy && r.decision === 'verify'),
      symptoms: c.symptoms,
      environment: c.environment,
      rootCause: c.rootCause && c.rootCause.explanation,
      failedAttempts: c.failedAttempts,
      sources: c.sources,
      fix: c.solution && c.solution.description,
      appliesWhen: c.appliesWhen,
      notApplicableWhen: c.notApplicableWhen,
      verificationEvidence: Object.values(rec.evidenceSnapshots || {}).map((e) => ({ label: e.label, purpose: e.purpose, status: e.status, command: e.command })),
      promotedTo: promoted ? promoted.id : null,
    };
    lessons.push(item);
    fs.writeFileSync(path.join(out, 'lessons', `${task}.project-record.json`), JSON.stringify(rec, null, 2));
    if (promoted) fs.writeFileSync(path.join(out, 'lessons', `${task}.shared-record.json`), JSON.stringify(promoted, null, 2));
  }
}
fs.writeFileSync(path.join(out, 'lessons.json'), JSON.stringify(lessons, null, 2));

// ---- holdout (C2): lessons offered and decisions -----------------------------
const holdout = [];
const holdRoot = path.join(run, 'trials', split, 'C2');
for (const task of fs.existsSync(holdRoot) ? fs.readdirSync(holdRoot).sort() : []) {
  for (const rep of fs.readdirSync(path.join(holdRoot, task)).sort()) {
    const dir = path.join(holdRoot, task, rep);
    const resultFile = path.join(dir, 'attempt', 'result.json');
    const result = fs.existsSync(resultFile) ? readJson(resultFile) : null;
    const ev = events(path.join(dir, 'work'));
    const offered = [];
    const decisions = [];
    for (const e of ev) {
      if (e.type === 'task.claimed' && e.data.lessons) for (const l of e.data.lessons) offered.push({ task: e.data.task, id: l.id, title: l.title, matched: l.matched });
      if (e.type === 'task.completed' && e.data.lessonDecisions) for (const d of e.data.lessonDecisions) decisions.push({ task: e.data.task, id: d.id, decision: d.decision, basis: d.basis, note: d.note });
    }
    const t = tasks.get(task);
    holdout.push({
      task,
      rep,
      relation: (t && t.relation) || null,
      success: result ? result.grade.success : null,
      failedChecks: result ? result.grade.failed : null,
      lessonsOffered: offered,
      decisions,
      applied: decisions.filter((d) => d.decision === 'applied').length,
      setAside: decisions.filter((d) => d.decision !== 'applied').length,
    });
  }
}
fs.writeFileSync(path.join(out, 'holdout-lesson-decisions.json'), JSON.stringify(holdout, null, 2));

// ---- human-readable summary ---------------------------------------------------
const L = [];
L.push('# Verified learning: evidence collected from the official run', '');
L.push('Generated by `eval/harness/collect-learning-evidence.js` from the run directory. Nothing here is hand-written; the JSON files next to this README are the records themselves.', '');
L.push('## Lessons recorded during training (C2)', '');
if (!lessons.length) L.push('This run had no training phase: every condition started from the snapshots of an earlier run (see the evidence folder of that run for the lessons themselves and their independent reviews).', '');
if (lessons.length) L.push('| Task | Lesson | Status | Independent review | Reproduction -> fix | Promoted |', '|---|---|---|---|---|---|');
for (const l of lessons) {
  const rev = l.reviews.map((r) => `${r.reviewer}: ${r.decision}`).join('; ') || 'none';
  const ev = l.verificationEvidence.map((e) => `${e.purpose}:${e.status}`).join(', ');
  L.push(`| ${l.task} | ${l.title} | ${l.status} | ${rev}${l.independentReview || l.status === 'superseded' ? '' : ' (NOT independent)'} | ${ev || '-'} | ${l.status === 'superseded' ? '- (duplicate consolidated into the verified record)' : l.promotedTo || 'no'} |`);
}
L.push('', 'Each record also carries symptoms, environment, root cause, failed attempts, sources, the verified fix and applicability limits (see `lessons/`).', '');
L.push('## What the fresh holdout sessions did with those lessons (C2)', '');
L.push('Counts include every claim of a task in the trial (a task that went back to its owner after a review is claimed again, so its lessons are offered again).', '');
L.push('| Task | Relation | Rep | Hidden grader | Lessons offered | Applied | Set aside |', '|---|---|---|---|---|---|---|');
for (const h of holdout) L.push(`| ${h.task} | ${h.relation} | ${h.rep} | ${h.success === null ? 'n/a' : h.success ? 'pass' : 'FAIL'} | ${h.lessonsOffered.length} | ${h.applied} | ${h.setAside} |`);
L.push('');
const decoys = holdout.filter((h) => h.relation === 'decoy');
if (decoys.length) {
  L.push('## Decoys: similar symptoms, different cause', '');
  for (const h of decoys) {
    L.push(`### ${h.task} (${h.rep}) - hidden grader: ${h.success ? 'pass' : 'FAIL'}`, '');
    for (const d of h.decisions) L.push(`- \`${d.id}\` **${d.decision}** (${d.basis}): ${d.note}`);
    L.push('');
  }
}
fs.writeFileSync(path.join(out, 'README.md'), L.join('\n'));
console.log(`lessons: ${lessons.length}, holdout C2 trials: ${holdout.length}, written to ${out}`);
