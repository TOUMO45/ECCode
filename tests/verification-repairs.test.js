'use strict';
// Repairs for the defects the independent adversarial verification of 0.3.0 found
// (docs/evidence/verification-0.3.0/REPORT.md, section 4), one test per defect:
//   NEW-1 required criteria were derived from the brief file on disk, not from the bytes the
//         architecture approval pinned (an edited brief shrank the design and verification coverage);
//   NEW-2 a brief whose acceptance criteria carry no ids required nothing, so "the document has a
//         title" approved it;
//   NEW-3 the release-tree diff started at the LAST approved submission's commit, so a file committed
//         between a phase approval and the verification submission vanished once verification was approved;
//   NEW-4 git folded a staged rename into its new path, so the old path was never declared or reviewed;
//   NEW-5 the plan schema refused verification.cwd and an undeclared cwd matched a run from anywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const delivery = require('../lib/delivery');
const { gitChangedFiles } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const { writeJson } = require('../lib/util');
const { tmpProject, write, coverage, rejection, approveThroughPlan, samplePlan, passCheck, handoffFor, expectCode, DESIGN_MD } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const brief = (criteria) => `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
- R2 rate limit the classifier endpoint
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
const BRIEF_AC1_AC2 = brief('- AC1 category returned for every ticket\n- AC2 429 returned above the configured rate');
const BRIEF_AC1 = brief('- AC1 category returned for every ticket');
const BRIEF_NO_IDS = brief('- category returned for every ticket\n- 429 returned above the configured rate');
const ANCHOR = `artifact:${BRIEF_REL}#Acceptance Criteria`;
const DECLARED = 'node -e "process.exit(0)" api-check';
const PHASE_FILES = [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']];
const DELIVERABLES = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitAll(dir, msg = 'work') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}
const crit = (id, refs, description = `${id} verified against the brief`) => ({ id, description, met: true, evidence: refs });
const approve = (criteria) => ({ decision: 'approve', summary: 'Criteria checked against the submitted artifacts.', criteria, findings: [] });

function submitBrief(ctx, text) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, text);
  return gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
}

/** design → plan to approved, after the architecture gate. */
function approveDesignAndPlan(ctx, plan = samplePlan()) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']));
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan, null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
}

/** Complete the sample phase's tasks; `beforeSubmit` runs with the work done, before the phase is submitted. */
function finishPhase(ctx, { beforeSubmit } = {}) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE_FILES) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  if (beforeSubmit) beforeSubmit();
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${ev.id}`]));
}

function submitVerification(ctx, artifacts = DELIVERABLES) {
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  return gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts });
}

// ---------------------------------------------------------------------------------------------- NEW-1

test('NEW-1 required criteria come from the pinned brief: an approved brief edited on disk is refused at gate show, review and a later submission', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  commitAll(dir, 'base');
  submitBrief(ctx, BRIEF_AC1_AC2);
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', approve([crit('AC1', [ANCHOR]), crit('AC2', [ANCHOR])]));
  assert.strictEqual(store.state().gates.architecture.status, 'approved');

  // A document author rewrites the approved brief: AC2 is gone from the file, not from the record.
  write(dir, BRIEF_REL, BRIEF_AC1);
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  let err = expectCode(() => gates.requiredCriteria(store.state(), config, dir, 'design'), 'APPROVED_ARTIFACT_CHANGED');
  assert.match(err.message, /\.eccode\/artifacts\/architecture\/brief\.md/);
  assert.match(err.message, /approved .*architecture/);
  assert.match(err.message, /restore .*git/i);
  const show = spawnSync(process.execPath, [BIN, 'gate', 'show', 'design', '--root', dir], { encoding: 'utf8' });
  assert.strictEqual(show.status, 2, show.stdout);
  assert.match(show.stderr, /\[APPROVED_ARTIFACT_CHANGED\].*brief\.md/);
  // Neither an approval covering what the file says now nor a changes_requested review is recorded.
  expectCode(() => gates.recordReview(store, config, 'design', 'technical-reviewer', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components'])])), 'APPROVED_ARTIFACT_CHANGED');
  expectCode(() => gates.recordReview(store, config, 'design', 'technical-reviewer', rejection()), 'APPROVED_ARTIFACT_CHANGED');
  assert.strictEqual(store.state().gates.design.status, 'submitted');
  assert.strictEqual(store.state().gates.design.reviews.length, 0);

  // Restored bytes: the design gate requires AC1 and AC2 again.
  write(dir, BRIEF_REL, BRIEF_AC1_AC2);
  assert.deepStrictEqual(gates.requiredCriteria(store.state(), config, dir, 'design').map((c) => c.id), ['AC1', 'AC2']);
  assert.match(expectCode(() => gates.recordReview(store, config, 'design', 'technical-reviewer', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components'])])), 'REVIEW_REJECTED').message, /does not cover the required criteria: AC2/);
  gates.recordReview(store, config, 'design', 'technical-reviewer', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']));
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
  finishPhase(ctx);
  commitAll(dir, 'phase work');

  // Edited again before verification: a later gate may not re-pin an approved document with other bytes.
  write(dir, BRIEF_REL, BRIEF_AC1);
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  err = expectCode(() => gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: [...DELIVERABLES, BRIEF_REL] }), 'APPROVED_ARTIFACT_CHANGED');
  assert.match(err.message, /brief\.md/);
  assert.match(err.message, /architecture/);
  assert.strictEqual(store.state().gates.verification.submissions.length, 0);
  // Without listing it, the verification review still cannot derive its coverage from a brief that differs from the pin.
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: DELIVERABLES });
  const sev = passCheck(store, 'security-reviewer');
  expectCode(() => gates.recordReview(store, config, 'verification', 'security-reviewer', approve([crit('AC1', [`ev:${sev.id}`])])), 'APPROVED_ARTIFACT_CHANGED');
  assert.strictEqual(spawnSync(process.execPath, [BIN, 'gate', 'show', 'verification', '--root', dir], { encoding: 'utf8' }).status, 2);

  // Restored: the normal flow completes, and it requires both criteria.
  write(dir, BRIEF_REL, BRIEF_AC1_AC2);
  assert.deepStrictEqual(gates.requiredCriteria(store.state(), config, dir, 'verification').map((c) => c.id), ['AC1', 'AC2']);
  assert.match(expectCode(() => gates.recordReview(store, config, 'verification', 'security-reviewer', approve([crit('AC1', [`ev:${sev.id}`])])), 'REVIEW_REJECTED').message, /does not cover the required criteria: AC2/);
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${sev.id}`]));
  assert.strictEqual(store.state().gates.verification.status, 'approved');
  const res = delivery.deliver(store, 'delivery-lead', { config });
  assert.ok(fs.existsSync(path.join(dir, res.report)));
  assert.strictEqual(store.audit().ok, true);
});

// ---------------------------------------------------------------------------------------------- NEW-2

test('NEW-2 a brief whose criteria sections carry no ids cannot be approved; review.criteriaSections.architecture: [] disables the rule', () => {
  const title = (ctx) => approve([crit('C1', [`artifact:${BRIEF_REL}#Risks`], 'The document has a title')]);
  // The heading exists but lists no ids.
  const ctx = tmpProject();
  submitBrief(ctx, BRIEF_NO_IDS);
  assert.deepStrictEqual(gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'architecture'), []);
  let err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', title(ctx)), 'REVIEW_REJECTED');
  assert.match(err.message, /Acceptance Criteria/);
  assert.match(err.message, /no criterion ids/);
  assert.match(err.message, /- AC1: /);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'submitted');
  // The configured heading does not exist at all: refused too, naming the heading.
  const ctx2 = tmpProject({ configOverrides: { review: { criteriaSections: { architecture: ['Definition of Done'] } } } });
  submitBrief(ctx2, BRIEF_AC1_AC2);
  err = expectCode(() => gates.recordReview(ctx2.store, ctx2.config, 'architecture', 'architecture-reviewer', title(ctx2)), 'REVIEW_REJECTED');
  assert.match(err.message, /Definition of Done/);
  assert.match(err.message, /- AC1: /);
  // Explicitly empty: the rule is off, and an approval without acceptance ids goes through.
  const ctx3 = tmpProject({ configOverrides: { review: { criteriaSections: { architecture: [] } } } });
  assert.deepStrictEqual(ctx3.config.review.criteriaSections.architecture, []);
  submitBrief(ctx3, BRIEF_NO_IDS);
  gates.recordReview(ctx3.store, ctx3.config, 'architecture', 'architecture-reviewer', title(ctx3));
  assert.strictEqual(ctx3.store.state().gates.architecture.status, 'approved');
  // The verification gate applies the same rule: with the rule back on, the no-ids brief cannot pass verification either.
  approveDesignAndPlan(ctx3);
  finishPhase(ctx3);
  const file = path.join(ctx3.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.review.criteriaSections = { architecture: ['Acceptance Criteria'] };
  writeJson(file, cfg);
  const config = loadConfig(ctx3.dir);
  submitVerification({ ...ctx3, config });
  const sev = passCheck(ctx3.store, 'security-reviewer');
  err = expectCode(() => gates.recordReview(ctx3.store, config, 'verification', 'security-reviewer', coverage({ ...ctx3, config }, 'verification', [`ev:${sev.id}`])), 'REVIEW_REJECTED');
  assert.match(err.message, /no criterion ids/);
  assert.strictEqual(ctx3.store.state().gates.verification.status, 'submitted');
});

// ---------------------------------------------------------------------------------------------- NEW-3

test('NEW-3 a file committed after a phase approval that no gate lists blocks the verification approval; listed in the verification submission it passes', () => {
  // The report\'s F2.between scenario: committed between the phase approval and the verification submission.
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  commitAll(dir, 'base');
  approveThroughPlan(ctx);
  finishPhase(ctx);
  commitAll(dir, 'phase work');
  write(dir, 'src/server/backdoor.js', 'module.exports = "never reviewed";\n');
  commitAll(dir, 'added between the phase approval and the verification submission');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), [{ path: 'src/server/backdoor.js', gate: 'phase:core', problem: 'added after approval' }]);
  submitVerification(ctx); // lists verification.md and the three reviewed files only
  const sev = passCheck(store, 'security-reviewer');
  const err = expectCode(() => gates.recordReview(store, config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${sev.id}`])), 'REVIEW_REJECTED');
  assert.match(err.message, /src\/server\/backdoor\.js added after approval \(phase:core\)/);
  assert.match(err.message, /not pinned by submission/);
  assert.strictEqual(store.state().gates.verification.status, 'submitted');
  assert.strictEqual(store.state().delivery, null);
  expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');

  // The baseline is the earliest approved submission's commit: a stray file committed WITH the phase work (so
  // the phase submission's commit contains it) stays reported after the phase approval instead of vanishing.
  const ctx2 = tmpProject();
  commitAll(ctx2.dir, 'base');
  approveThroughPlan(ctx2);
  finishPhase(ctx2, { beforeSubmit: () => {
    write(ctx2.dir, 'tools/backdoor.js', 'module.exports = "committed with the phase work, owned by no task";\n');
    commitAll(ctx2.dir, 'phase work plus a stray file');
  } });
  assert.deepStrictEqual(delivery.unreviewedChanges(ctx2.store.state(), ctx2.dir, ctx2.config), [{ path: 'tools/backdoor.js', gate: 'phase:core', problem: 'added after approval' }]);
  submitVerification(ctx2);
  const sev2 = passCheck(ctx2.store, 'security-reviewer');
  assert.match(expectCode(() => gates.recordReview(ctx2.store, ctx2.config, 'verification', 'security-reviewer', coverage(ctx2, 'verification', [`ev:${sev2.id}`])), 'REVIEW_REJECTED').message, /tools\/backdoor\.js added after approval/);
  // The legitimate flow: the delivery-lead lists the file in the verification submission, so the approval pins it.
  gates.submit(ctx2.store, ctx2.config, 'verification', 'delivery-lead', { artifacts: [...DELIVERABLES, 'tools/backdoor.js'] });
  const sev3 = passCheck(ctx2.store, 'security-reviewer');
  gates.recordReview(ctx2.store, ctx2.config, 'verification', 'security-reviewer', coverage(ctx2, 'verification', [`ev:${sev3.id}`]));
  assert.strictEqual(ctx2.store.state().gates.verification.status, 'approved');
  assert.deepStrictEqual(delivery.unreviewedChanges(ctx2.store.state(), ctx2.dir, ctx2.config), []);
  const res = delivery.deliver(ctx2.store, 'delivery-lead', { config: ctx2.config });
  assert.strictEqual(res.commit, git(ctx2.dir, 'rev-parse', 'HEAD'));
});

// ---------------------------------------------------------------------------------------------- NEW-4

test('NEW-4 a staged rename inside the ownership must declare the old path as well as the new one', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  write(dir, 'src/server/old.js', '// old\n');
  commitAll(dir, 'base with old.js');
  approveThroughPlan(ctx);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  git(dir, 'mv', 'src/server/old.js', 'src/server/new.js');
  assert.deepStrictEqual(gitChangedFiles(dir, store.state().tasks.api.claim.baseCommit).filter((f) => !f.startsWith('.eccode/')).sort(), ['src/server/new.js', 'src/server/old.js'], 'a staged rename is both paths');
  const ev = passCheck(store, 'backend-engineer');
  const err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/new.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /inside your ownership that the handoff does not declare.*src\/server\/old\.js/);
  assert.strictEqual(store.state().tasks.api.status, 'claimed');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/server/new.js']));
  assert.deepStrictEqual(store.state().tasks.api.filesChanged, ['src/server/old.js', 'src/server/new.js']);
  for (const [id, owner, file] of PHASE_FILES.slice(1)) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const pinned = store.state().gates['phase:core'].submissions[0].artifacts.map((a) => a.path);
  assert.ok(pinned.includes('src/server/new.js') && !pinned.includes('src/server/old.js'), 'the new path is pinned; the deletion is on record');
  const rev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${rev.id}`]));
  commitAll(dir, 'phase work');
  // The reviewed rename is not an unreviewed change, and the release tree still names it as one (from old to new).
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), []);
  submitVerification(ctx, ['.eccode/artifacts/verification.md', 'src/server/new.js', 'src/web/b.js', 'tests/c.test.js']);
  const sev = passCheck(store, 'security-reviewer');
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${sev.id}`]));
  assert.ok(delivery.deliver(store, 'delivery-lead', { config }).commit);
});

// ---------------------------------------------------------------------------------------------- NEW-5

test('NEW-5 the declared check is bound to its working directory: verification.cwd is accepted by the plan schema, and a run elsewhere is refused', () => {
  const planWith = (verification) => {
    const plan = samplePlan();
    plan.tasks[0].verification = verification;
    return plan;
  };
  const base = tmpProject();
  assert.deepStrictEqual(tasks.validatePlan(planWith({ method: 'run the api checks', command: DECLARED, cwd: 'src/server' }), base.config), []);
  assert.deepStrictEqual(tasks.validatePlan(planWith({ method: 'run the api checks', command: DECLARED, cwd: './src/server/' }), base.config), []);
  for (const bad of ['../elsewhere', '/abs/path', 'src/../../x', '']) {
    const errors = tasks.validatePlan(planWith({ method: 'run the api checks', command: DECLARED, cwd: bad }), base.config);
    assert.ok(errors.some((e) => /verification\.cwd|cwd/.test(e)), `${JSON.stringify(bad)}: ${errors.join('; ')}`);
  }
  const openApi = (ctx) => {
    gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
    tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
    write(ctx.dir, 'src/server/app.js', 'module.exports = 1;\n');
  };
  const run = (ctx, actor, extra = {}) => evidence.runCommand(ctx.store, actor, { label: 'api check', command: DECLARED, ...extra });
  const complete = (ctx, ids) => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));

  // No cwd declared means the project root: the same command string run in src/server is not the declared check.
  const ctx = tmpProject();
  approveThroughPlan(ctx, planWith({ method: 'run the api checks', command: DECLARED }));
  openApi(ctx);
  const elsewhere = run(ctx, 'backend-engineer', { cwd: 'src/server' });
  assert.strictEqual(elsewhere.cwd, 'src/server');
  let err = expectCode(() => complete(ctx, [elsewhere.id]), 'INVALID_HANDOFF');
  assert.match(err.message, new RegExp(`ev:${elsewhere.id} in src/server`));
  assert.match(err.message, /the project root/);
  const atRoot = run(ctx, 'backend-engineer');
  assert.strictEqual(atRoot.cwd, '.');
  complete(ctx, [atRoot.id]);
  assert.strictEqual(ctx.store.state().tasks.api.status, 'done');

  // A declared cwd: a run at the root is refused, a run in that directory passes; the reviewer is held to it too.
  const ctx2 = tmpProject();
  approveThroughPlan(ctx2, planWith({ method: 'run the api checks', command: DECLARED, cwd: 'src/server' }));
  openApi(ctx2);
  const root = run(ctx2, 'backend-engineer');
  err = expectCode(() => complete(ctx2, [root.id]), 'INVALID_HANDOFF');
  assert.match(err.message, /different working directory than the task declares \(src\/server\)/);
  assert.match(err.message, /--cwd src\/server/);
  const inCwd = run(ctx2, 'backend-engineer', { cwd: 'src/server' });
  complete(ctx2, [inCwd.id]);
  assert.strictEqual(ctx2.store.state().tasks.api.status, 'done');
  for (const [id, owner, file] of PHASE_FILES.slice(1)) {
    tasks.claim(ctx2.store, ctx2.config, id, owner);
    write(ctx2.dir, file, `// ${id}\n`);
    tasks.complete(ctx2.store, ctx2.config, id, owner, handoffFor(id, owner, [passCheck(ctx2.store, owner).id], [file]));
  }
  gates.submit(ctx2.store, ctx2.config, 'phase:core', 'delivery-lead');
  const reviewerDefault = passCheck(ctx2.store, 'technical-reviewer');
  const reviewerRoot = run(ctx2, 'technical-reviewer');
  err = expectCode(() => gates.recordReview(ctx2.store, ctx2.config, 'phase:core', 'technical-reviewer', coverage(ctx2, 'phase:core', [`ev:${reviewerDefault.id}`, `ev:${reviewerRoot.id}`])), 'REVIEW_REJECTED');
  assert.match(err.message, /missing: node -e "process.exit\(0\)" api-check \(cwd src\/server\) \[api\]/);
  const reviewerInCwd = run(ctx2, 'technical-reviewer', { cwd: 'src/server' });
  gates.recordReview(ctx2.store, ctx2.config, 'phase:core', 'technical-reviewer', coverage(ctx2, 'phase:core', [`ev:${reviewerDefault.id}`, `ev:${reviewerInCwd.id}`]));
  assert.strictEqual(ctx2.store.state().gates['phase:core'].status, 'approved');
});
