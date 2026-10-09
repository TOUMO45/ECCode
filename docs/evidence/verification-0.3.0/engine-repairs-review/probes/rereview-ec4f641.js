'use strict';
// Re-review of ec4f641 (follow-up to findings L1 and L3): the cwd-spelling and APPROVED_ARTIFACT_CHANGED
// message probes from review-attacks.js, with the expectations the follow-up commit promises.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO, attempt, report, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const evidence = require(REPO + '/lib/evidence');
const { tmpProject, write, coverage, approveThroughPlan, handoffFor, samplePlan } = require(REPO + '/tests/helpers');

const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const head = (criteria) => `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
## Acceptance Criteria
${criteria}
## Architecture
Single Node service.
## Assumptions
- A1
## Open Questions
- Q1
## Risks
- RISK1
`;
const LIST = head('- AC1 category returned for every ticket\n- AC2 429 returned above the configured rate');
const AC1_ONLY = head('- AC1 category returned for every ticket');
const DECLARED = 'node -e "process.exit(0)" api-check';
const anchor = `artifact:${BRIEF_REL}#Acceptance Criteria`;

const { step, finish } = report('rereview-ec4f641');
const dirs = [];
const fresh = (opts) => { const c = tmpProject(opts); dirs.push(c.dir); return c; };
function approveArch(ctx) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, LIST);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', [anchor]));
}
try {
  // ---- L1: the message names the full pinned sha256 and makes the git hint conditional.
  for (const committed of [false, true]) {
    const ctx = fresh();
    if (committed) commitAll(ctx.dir, 'base');
    approveArch(ctx);
    if (committed) commitAll(ctx.dir, 'brief');
    const pin = ctx.store.state().gates.architecture.submissions[0].artifacts[0].sha256;
    write(ctx.dir, BRIEF_REL, AC1_ONLY);
    gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
    const r = attempt(() => gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'design'));
    const tag = committed ? 'committed' : 'uncommitted';
    step(`L1.${tag}.refused`, `edited brief (${tag}): design requiredCriteria`, 'refused:APPROVED_ARTIFACT_CHANGED', r);
    step(`L1.${tag}.message`, 'message carries the full pinned sha256, the conditional git hint and the "own copy" alternative', 'documented', {
      ok: r.message.includes(`sha256 ${pin})`) && /from git if the file was committed \(git checkout -- /.test(r.message) && /otherwise from your own copy/.test(r.message) && /new artifact of a later gate/.test(r.message),
      value: r.message,
    });
    const co = attempt(() => execFileSync('git', ['checkout', '--', BRIEF_REL], { cwd: ctx.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    step(`L1.${tag}.gitCheckout`, `git checkout -- brief.md (${tag})`, 'documented', { ok: co.ok, message: co.ok ? undefined : String(co.message).split('\n').slice(-2).join(' ').slice(0, 160) }, committed ? 'restores the pinned bytes' : 'fails, as the message now says it can');
    if (co.ok) step(`L1.${tag}.restored`, 'design derives AC1 + AC2 again', 'ok', attempt(() => gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'design').map((c) => c.id)));
    else {
      write(ctx.dir, BRIEF_REL, LIST); // "from your own copy"
      step(`L1.${tag}.ownCopy`, 'restored from the author\'s own copy: design derives AC1 + AC2 again', 'ok', attempt(() => gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'design').map((c) => c.id)));
    }
  }

  // ---- L3: cwd spellings.
  const base = fresh();
  const planWith = (verification) => { const p = samplePlan(); p.tasks[0].verification = verification; return p; };
  const validate = (cwd) => tasks.validatePlan(planWith({ method: 'run the api checks', command: DECLARED, cwd }), base.config);
  for (const bad of ['src\\server', 'src\\..\\x', ' src/server ', 'src/server ', ' src/server', '\tsrc/server', 'src/server\n', '/abs', 'C:\\x', '../up', 'src/server/../server', 'a\\b/c']) {
    const errors = validate(bad);
    step(`L3.refused:${JSON.stringify(bad)}`, `verification.cwd ${JSON.stringify(bad)} refused by validatePlan`, 'documented', { ok: errors.length > 0, value: errors });
  }
  for (const good of ['src/server', 'src/server/', './src/server', '.', 'src/sub dir', 'src/server/./x']) {
    const errors = validate(good);
    step(`L3.accepted:${JSON.stringify(good)}`, `verification.cwd ${JSON.stringify(good)} accepted`, 'documented', { ok: errors.length === 0, value: { errors, declaredCwd: tasks.declaredCwd(base.dir, { cwd: good }) } });
  }
  // the schema path: a plan with a backslash cwd is refused at the plan gate with the reason
  const ctx = fresh();
  const sub = attempt(() => approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED, cwd: 'src\\server' })));
  step('L3.planGate.backslash', 'plan submission with cwd "src\\\\server"', 'refused:INVALID_PLAN', sub);
  step('L3.planGate.reason', 'the reason says forward slashes', 'documented', { ok: /forward slashes/.test(sub.message || ''), value: (sub.message || '').split('\n').slice(0, 3) });
  // and the accepted spellings still bind the run
  const ctx2 = fresh();
  approveThroughPlan(ctx2, planWith({ method: 'run the api checks', command: DECLARED, cwd: 'src/sub dir/' }));
  gates.startGate(ctx2.store, ctx2.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx2.store, ctx2.config, 'api', 'backend-engineer');
  write(ctx2.dir, 'src/server/app.js', 'module.exports = 1;\n');
  fs.mkdirSync(path.join(ctx2.dir, 'src/sub dir'), { recursive: true });
  const run = (extra) => evidence.runCommand(ctx2.store, 'backend-engineer', { label: 'x', command: DECLARED, ...extra });
  const complete = (ids) => attempt(() => tasks.complete(ctx2.store, ctx2.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js'])));
  step('L3.spaceInName.root', 'declared "src/sub dir/", run at the root', 'refused:INVALID_HANDOFF', complete([run({}).id]));
  step('L3.spaceInName.inCwd', 'declared "src/sub dir/", run --cwd "src/sub dir"', 'ok', complete([run({ cwd: 'src/sub dir' }).id]));
} finally {
  cleanup(...dirs);
}
finish();
