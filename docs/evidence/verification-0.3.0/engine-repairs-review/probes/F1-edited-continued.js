'use strict';
// Independent review of the engine repairs: the verifier's F1.edited chain (REPORT.md NEW-1), re-run against
// the repaired engine. The original probe calls requiredCriteria() directly in a `documented` step and crashes
// on the first refusal, so every step here is wrapped in attempt(); then the legitimate recovery (bytes
// restored) is driven through delivery to show no overblocking.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, attempt, report, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const delivery = require(REPO + '/lib/delivery');
const { tmpProject, write, coverage, passCheck, handoffFor, samplePlan, DESIGN_MD, rejection } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const head = (criteria) => `# Brief
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
const LIST = head(`- AC1 category returned for every ticket
- AC2 429 returned above the configured rate`);
const AC1_ONLY = head('- AC1 category returned for every ticket');
const crit = (id, refs, description = `${id} verified against the brief`) => ({ id, description, met: true, evidence: refs });
const approve = (criteria) => ({ decision: 'approve', summary: 'Criteria checked against the submitted brief.', criteria, findings: [] });
const anchor = `artifact:${BRIEF_REL}#Acceptance Criteria`;
const review = (ctx, gate, r, reviewer) => attempt(() => gates.recordReview(ctx.store, ctx.config, gate, reviewer, r));
const required = (ctx, gate) => attempt(() => gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, gate).map((c) => c.id));
const show = (ctx, gate) => {
  const r = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'gate', 'show', gate], { encoding: 'utf8' });
  return { ok: r.status === 0, exit: r.status, code: /\[([A-Z_]+)\]/.exec(r.stderr || '')?.[1], message: (r.stderr || r.stdout).split('\n')[0] };
};

const { step, finish } = report('F1-edited-continued (review of the repairs)');
const dirs = [];
try {
  const ctx = tmpProject();
  dirs.push(ctx.dir);
  commitAll(ctx.dir, 'base');
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, LIST);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
  commitAll(ctx.dir, 'brief');
  step('F1.edited.archApproval', 'architecture approved covering AC1 + AC2', 'ok', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])]), 'architecture-reviewer'));

  // A document author rewrites the approved brief (AC2 removed).
  write(ctx.dir, BRIEF_REL, AC1_ONLY);
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  step('F1.edited.designSubmit', 'design submission (spec.md only) while the approved brief is edited on disk', 'ok', attempt(() => gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] })));
  step('F1.edited.designRequired', 'required ids for design after AC2 was removed from the approved brief on disk', 'refused:APPROVED_ARTIFACT_CHANGED', required(ctx, 'design'));
  step('F1.edited.gateShowDesign', 'eccode gate show design', 'refused:APPROVED_ARTIFACT_CHANGED', show(ctx, 'design'));
  step('F1.edited.designApproval', 'design approval covering AC1 only (AC2 was in the approved brief)', 'refused:APPROVED_ARTIFACT_CHANGED', review(ctx, 'design', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components'])]), 'technical-reviewer'));
  step('F1.edited.designFullApproval', 'design approval covering AC1 + AC2 while the brief on disk differs from the pin (still refused: nothing is derived from an unreviewed edit)', 'refused:APPROVED_ARTIFACT_CHANGED', review(ctx, 'design', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components']), crit('AC2', ['artifact:.eccode/artifacts/spec.md#Components'])]), 'technical-reviewer'));
  step('F1.edited.designChangesRequested', 'a changes_requested review while the brief differs from the pin', 'refused:APPROVED_ARTIFACT_CHANGED', review(ctx, 'design', rejection(), 'technical-reviewer'));
  step('F1.edited.designState', 'design gate still submitted, no review recorded', 'documented', { ok: true, value: { status: ctx.store.state().gates.design.status, reviews: ctx.store.state().gates.design.reviews.length } });

  // Recovery: the documented path (restore the approved bytes from git).
  const checkout = attempt(() => require('child_process').execFileSync('git', ['checkout', '--', BRIEF_REL], { cwd: ctx.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  step('F1.edited.restoreFromGit', 'git checkout -- brief.md (the recovery the message names) restores the pinned bytes', 'ok', { ...checkout, value: fs.readFileSync(path.join(ctx.dir, BRIEF_REL), 'utf8') === LIST });
  step('F1.edited.designRequiredRestored', 'required ids for design once the bytes are restored', 'ok', required(ctx, 'design'));
  step('F1.edited.designOnlyAC1Restored', 'design approval covering AC1 only against the restored brief', 'refused:REVIEW_REJECTED', review(ctx, 'design', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components'])]), 'technical-reviewer'));
  step('F1.edited.designLegit', 'design approval covering AC1 + AC2 (overblocking check)', 'ok', review(ctx, 'design', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']), 'technical-reviewer'));
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${passCheck(ctx.store, 'technical-reviewer').id}`]));
  commitAll(ctx.dir, 'phase work');

  // Edited again before verification: the verifier's re-pin trick.
  write(ctx.dir, BRIEF_REL, AC1_ONLY);
  step('F1.edited.unreviewedBeforeVerification', 'unreviewedChanges before the verification gate', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  const DELIV = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];
  step('F1.edited.verificationSubmitWithBrief', 'verification submission listing the edited brief (re-pin attempt)', 'refused:APPROVED_ARTIFACT_CHANGED', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [...DELIV, BRIEF_REL] })));
  step('F1.edited.verificationSubmitWithoutBrief', 'verification submission WITHOUT the brief (the edit stays on disk)', 'ok', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV })));
  const sev = passCheck(ctx.store, 'security-reviewer');
  step('F1.edited.verificationRequired', 'required ids for verification while the brief differs from the pin', 'refused:APPROVED_ARTIFACT_CHANGED', required(ctx, 'verification'));
  step('F1.edited.gateShowVerification', 'eccode gate show verification', 'refused:APPROVED_ARTIFACT_CHANGED', show(ctx, 'verification'));
  step('F1.edited.verificationApproval', 'verification approval covering AC1 only (brief not in the artifact list)', 'refused:APPROVED_ARTIFACT_CHANGED', review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`, anchor])]), 'security-reviewer'));
  step('F1.edited.verificationFullApproval', 'verification approval covering AC1 + AC2 while the brief differs (refused too)', 'refused:APPROVED_ARTIFACT_CHANGED', review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`]), crit('AC2', [`ev:${sev.id}`])]), 'security-reviewer'));
  step('F1.edited.deliverWhileEdited', 'deliver() while the brief differs from the pin and verification is unapproved', 'refused:DELIVERY_BLOCKED', attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config })));
  // Restore and finish legitimately.
  write(ctx.dir, BRIEF_REL, LIST);
  step('F1.edited.verificationRequiredRestored', 'required ids for verification once restored', 'ok', required(ctx, 'verification'));
  step('F1.edited.verificationOnlyAC1Restored', 'verification approval covering AC1 only against the restored brief', 'refused:REVIEW_REJECTED', review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`])]), 'security-reviewer'));
  step('F1.edited.verificationLegit', 'verification approval covering AC1 + AC2', 'ok', review(ctx, 'verification', coverage(ctx, 'verification', [`ev:${sev.id}`]), 'security-reviewer'));
  const delivered = attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config }));
  step('F1.edited.deliver', 'delivery after the legitimate flow', 'ok', delivered);
  const audit = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
  step('F1.edited.audit', 'eccode audit after the delivery', 'ok', { ok: audit.status === 0, exit: audit.status, value: audit.stdout.trim().split('\n')[0] });
} finally {
  cleanup(...dirs);
}
finish();
