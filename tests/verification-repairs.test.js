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
