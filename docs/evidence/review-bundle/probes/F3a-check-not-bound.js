'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F3a: is the cited passing evidence bound to the task's declared verification command?
// Expected weakness: tasks.complete() accepts ANY passing command evidence recorded after the claim,
// never comparing it with task.verification.command; the phase review likewise accepts any reviewer-run
// passing command. Standalone, deterministic, self-cleaning (temp dirs under os.tmpdir()).

const fs = require('fs');
const path = require('path');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const evidence = require(REPO + '/lib/evidence');
const { tmpProject, write, approveThroughPlan, task, handoffFor, approval } = require(REPO + '/tests/helpers');

const DECLARED = 'node -e "process.exit(1)"'; // the declared verification: always fails
const UNRELATED = 'node -e "process.exit(0)"'; // an unrelated check: always passes

function attempt(fn) {
  try {
    const value = fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

const result = { probe: 'F3a-check-not-bound', steps: {} };
const ctx = tmpProject();
const { dir, store, config } = ctx;
try {
  // One-task plan so the phase can be submitted after the single task completes.
  const t = task('api', 'backend-engineer', ['src/server/**']);
  t.verification = { method: 'run the api checks', command: DECLARED };
  const plan = {
    phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }],
    tasks: [t],
  };
  approveThroughPlan(ctx, plan);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  result.steps.declaredVerificationInState = store.state().tasks.api.verification;

  write(dir, 'src/server/app.js', 'module.exports = 1;\n');

  // Show the declared check really fails on this tree (recorded, status failed, never cited).
  const declaredRun = evidence.runCommand(store, 'backend-engineer', { label: 'declared verification', command: DECLARED });
  result.steps.declaredCommandRun = { id: declaredRun.id, command: declaredRun.command, status: declaredRun.status, exitCode: declaredRun.exitCode };

  // Unrelated passing command, recorded after the claim.
  const unrelated = evidence.runCommand(store, 'backend-engineer', { label: 'unrelated', command: UNRELATED });
  result.steps.unrelatedCommandRun = { id: unrelated.id, command: unrelated.command, status: unrelated.status };

  // Step 1: complete the task citing only the unrelated passing evidence.
  const completion = attempt(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [unrelated.id], ['src/server/app.js'])));
  const taskAfter = store.state().tasks.api;
  result.steps.complete = {
    accepted: completion.ok,
    refusal: completion.ok ? null : { code: completion.code, message: completion.message },
    taskStatus: taskAfter.status,
    citedEvidenceCommand: unrelated.command,
    declaredCommand: DECLARED,
    commandsMatch: unrelated.command === DECLARED,
  };

  // Step 2: phase review path. Submit the phase; the reviewer runs their own unrelated passing command and approves citing it.
  let review = { skipped: true, reason: 'task not done, phase cannot be submitted' };
  if (completion.ok) {
    const submit = attempt(() => gates.submit(store, config, 'phase:core', 'delivery-lead'));
    if (!submit.ok) {
      review = { skipped: true, reason: `submit refused: ${submit.code}: ${submit.message}` };
    } else {
      const reviewerCheck = evidence.runCommand(store, 'technical-reviewer', { label: 'reviewer unrelated', command: UNRELATED });
      const rec = attempt(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${reviewerCheck.id}`, 'artifact:src/server/app.js']])));
      const gate = store.state().gates['phase:core'];
      review = {
        skipped: false,
        accepted: rec.ok,
        refusal: rec.ok ? null : { code: rec.code, message: rec.message },
        gateStatus: gate.status,
        approvedBy: gate.approvedBy,
        reviewerCitedCommand: reviewerCheck.command,
        declaredCommand: DECLARED,
        commandsMatch: reviewerCheck.command === DECLARED,
      };
    }
  }
  result.steps.phaseReview = review;

  // Was the declared verification command EVER recorded as passing in the project record?
  const allEv = Object.values(store.state().evidence);
  const declaredPassing = allEv.filter((e) => e.kind === 'command' && e.command === DECLARED && e.status === 'passed');
  result.steps.declaredCommandPassingEvidenceCount = declaredPassing.length;
  result.steps.evidenceSummary = allEv.map((e) => ({ id: e.id, by: e.recordedBy, command: e.command, status: e.status }));

  result.reproduces = Boolean(completion.ok && taskAfter.status === 'done' && declaredPassing.length === 0);
  result.reviewPathReproduces = Boolean(review.accepted && review.gateStatus === 'approved' && declaredPassing.length === 0);
  result.decisionPoint = {
    taskCompletion: REPO + '/lib/tasks.js:313-316 complete(): filters cited evidence by kind/status/at only; t.verification is never read',
    phaseReview: REPO + '/lib/gates.js:277-288 checkReview(): requires any reviewer-run passing command after submission; never compares against task verification commands',
  };
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
