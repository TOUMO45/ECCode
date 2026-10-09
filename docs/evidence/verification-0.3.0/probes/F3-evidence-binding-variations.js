'use strict';
// F3 (evidence bound to the declared check, the tree and the log), variations not in tests/review-F1-F3.test.js:
//   same command string run in a different cwd when the task declares none; a declared cwd and a run at the
//   root; a log altered by appending one newline; the reviewer citing the implementer's run; evidence recorded
//   under another task id; a method-only task; and the environment the check inherits (documented residual).
const fs = require('fs');
const path = require('path');
const { REPO, attempt, report, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const evidence = require(REPO + '/lib/evidence');
const { tmpProject, write, coverage, approveThroughPlan, passCheck, handoffFor, samplePlan } = require(REPO + '/tests/helpers');

const DECLARED = 'node -e "process.exit(0)" api-check';
const run = (ctx, actor, command, extra = {}) => evidence.runCommand(ctx.store, actor, { label: 'check', command, ...extra });
const complete = (ctx, id, actor, ids, files) => attempt(() => tasks.complete(ctx.store, ctx.config, id, actor, handoffFor(id, actor, ids, files)));

function planWith(verification) {
  const plan = samplePlan();
  plan.tasks[0].verification = verification;
  return plan;
}
function openApi(ctx) {
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  write(ctx.dir, 'src/server/app.js', 'module.exports = 1;\n');
}

const { step, finish } = report('F3-evidence-binding-variations');
const dirs = [];
try {
  // ---- A. Whitespace variant passes; same string in another cwd (none declared).
  let ctx = tmpProject();
  dirs.push(ctx.dir);
  approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED }));
  openApi(ctx);
  const spaced = run(ctx, 'backend-engineer', 'node   -e  "process.exit(0)"   api-check');
  step('F3.whitespace', 'declared command with extra whitespace is accepted (overblocking check)', 'ok', complete(ctx, 'api', 'backend-engineer', [spaced.id], ['src/server/app.js']));
  // Reset for the cwd variation: a fresh project.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED }));
  openApi(ctx);
  const elsewhere = run(ctx, 'backend-engineer', DECLARED, { cwd: 'src/server' });
  const cwdRes = complete(ctx, 'api', 'backend-engineer', [elsewhere.id], ['src/server/app.js']);
  step('F3.cwd.undeclared', 'declared command (no cwd declared) cited from a run in src/server/', 'documented', cwdRes, cwdRes.ok ? 'NEW (non-blocking): when the task declares no cwd, the same command string run from any directory satisfies the check (npm test in a subdirectory runs a different package.json)' : 'refused');

  // ---- B. A declared cwd: lib/tasks.js matchesVerification and lib/gates.js honour verification.cwd, but the plan
  // schema (schemas/plan.schema.json, additionalProperties: false) refuses it, so no task can ever declare one.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  const withCwd = attempt(() => approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED, cwd: 'src/server' })));
  step('F3.cwd.schema', 'a plan whose task declares verification.cwd', 'documented', withCwd, withCwd.ok ? 'accepted' : 'NEW (non-blocking, consistency): the cwd binding the engine implements is unreachable through the plan schema, so the cwd of a declared check is never bound (see F3.cwd.undeclared)');
  const evRoot = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'x', command: DECLARED });
  write(ctx.dir, 'src/server/.keep', '');
  const evSub = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'x', command: DECLARED, cwd: 'src/server' });
  step('F3.cwd.matchesVerification', 'matchesVerification with a synthetic {command, cwd: src/server}: run at root vs run in src/server', 'documented', { ok: true, value: { atRoot: tasks.matchesVerification(ctx.dir, evRoot, { command: DECLARED, cwd: 'src/server' }), inCwd: tasks.matchesVerification(ctx.dir, evSub, { command: DECLARED, cwd: 'src/server' }) } });

  // ---- C. Log altered by appending one newline; a check before the last edit; the reviewer's own run.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED }));
  openApi(ctx);
  const good = run(ctx, 'backend-engineer', DECLARED);
  fs.appendFileSync(path.join(ctx.dir, good.log), '\n');
  step('F3.log.newline', 'one newline appended to the evidence log', 'refused:INVALID_HANDOFF', complete(ctx, 'api', 'backend-engineer', [good.id], ['src/server/app.js']));
  const before = run(ctx, 'backend-engineer', DECLARED);
  write(ctx.dir, 'src/server/app.js', 'module.exports = 2;\n');
  step('F3.tree.editAfterCheck', 'check run before the last edit', 'refused:INVALID_HANDOFF', complete(ctx, 'api', 'backend-engineer', [before.id], ['src/server/app.js']));
  const after = run(ctx, 'backend-engineer', DECLARED, { task: 'ui' });
  step('F3.taskId', 'evidence recorded with --task ui cited for task api (same command, same actor, same tree)', 'documented', complete(ctx, 'api', 'backend-engineer', [after.id], ['src/server/app.js']), 'accepted: the task id on the evidence is informational; the binding is command + actor + time + tree');
  for (const [id, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  const implementerRun = run(ctx, 'backend-engineer', DECLARED); // after submission, by the implementer
  step('F3.reviewer.citesImplementer', 'phase approval citing only the implementer\'s post-submission run of the declared command', 'refused:REVIEW_REJECTED', attempt(() => gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${implementerRun.id}`]))));
  const reviewerOther = passCheck(ctx.store, 'technical-reviewer');
  step('F3.reviewer.unrelatedOnly', 'phase approval citing the reviewer\'s run of an unrelated passing command', 'refused:REVIEW_REJECTED', attempt(() => gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${reviewerOther.id}`]))));
  const reviewerDeclared = run(ctx, 'technical-reviewer', DECLARED);
  step('F3.reviewer.declared', 'phase approval citing the reviewer\'s own run of the declared command', 'ok', attempt(() => gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${reviewerDeclared.id}`]))));

  // ---- D. Method-only task: the any-passing-check rule (documented).
  ctx = tmpProject();
  dirs.push(ctx.dir);
  approveThroughPlan(ctx, planWith({ method: 'manual inspection' }));
  openApi(ctx);
  const whatever = run(ctx, 'backend-engineer', 'node -e "process.exit(0)" anything-at-all');
  step('F3.methodOnly', 'task declares a method and no command: any passing check by the owner after the claim completes it', 'documented', complete(ctx, 'api', 'backend-engineer', [whatever.id], ['src/server/app.js']), 'documented rule (CHANGELOG 0.3.0): method-only tasks keep the any-passing-check rule; a plan reviewer must insist on a command');

  // ---- E. The environment is not bound (documented residual): the declared command passes only under FORCE_OK.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  const envCmd = 'node -e "process.exit(process.env.FORCE_OK ? 0 : 1)"';
  approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: envCmd }));
  openApi(ctx);
  const honest = run(ctx, 'backend-engineer', envCmd);
  step('F3.env.honest', 'declared command without FORCE_OK fails', 'documented', { ok: honest.status === 'passed', value: honest.status });
  process.env.FORCE_OK = '1';
  const forced = run(ctx, 'backend-engineer', envCmd);
  delete process.env.FORCE_OK;
  step('F3.env.forced', 'same declared command with FORCE_OK=1 exported in the runner\'s environment, cited for completion', 'documented', complete(ctx, 'api', 'backend-engineer', [forced.id], ['src/server/app.js']), 'RESIDUAL (stated in README: "not done: binding to the environment"): the record does not capture the environment; the guard denies only inline ECCODE_* assignments');
} finally {
  cleanup(...dirs);
}
finish();
