'use strict';
// F1 (review coverage and anchors), variations not covered by tests/review-F1-F3.test.js:
//   table-format criteria; lower-case and Unicode look-alike ids; AC1 twice + AC2 omitted; a config
//   criteriaSections that names no heading; a brief whose criteria carry no ids; reflowing the brief
//   after submission; JSON-path anchors at the plan gate through recordReview; a verification
//   approval omitting an AC; and the brief EDITED AFTER the architecture approval (the design and
//   verification gates derive their required ids from the brief file as it is on disk NOW).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, attempt, report, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const delivery = require(REPO + '/lib/delivery');
const { tmpProject, write, coverage, passCheck, handoffFor, samplePlan, DESIGN_MD } = require(REPO + '/tests/helpers');

const GUARD = path.join(REPO, 'scripts/hooks/guard.js');
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
const TABLE = head(`| Id | Criterion |
|---|---|
| AC1 | category returned for every ticket |
| AC2 | 429 returned above the configured rate |`);
const LIST = head(`- AC1 category returned for every ticket
- AC2 429 returned above the configured rate`);
const NO_IDS = head(`- category returned for every ticket
- 429 returned above the configured rate`);

const crit = (id, refs, description = `${id} verified against the brief`) => ({ id, description, met: true, evidence: refs });
const approve = (criteria) => ({ decision: 'approve', summary: 'Criteria checked against the submitted brief.', criteria, findings: [] });
const anchor = `artifact:${BRIEF_REL}#Acceptance Criteria`;

function submitBrief(ctx, text) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, text);
  return gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
}
const review = (ctx, gate, r, reviewer = 'architecture-reviewer') => attempt(() => gates.recordReview(ctx.store, ctx.config, gate, reviewer, r));

function guard(payload) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_HOOKS: '' } });
  const o = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
  return { decision: o ? o.permissionDecision : 'allow', reason: o ? o.permissionDecisionReason : null };
}

const { step, finish } = report('F1-coverage-variations');
const dirs = [];
try {
  // ---- Table-format brief: the attack, the look-alikes, then the legitimate approval.
  let ctx = tmpProject();
  dirs.push(ctx.dir);
  submitBrief(ctx, TABLE);
  const required = gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'architecture').map((c) => c.id);
  step('F1.table.required', 'required ids derived from a Markdown TABLE under Acceptance Criteria', 'documented', { ok: true, value: required });
  step('F1.table.attack', 'approve "the document has a title" citing a non-existent section', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('C1', [`artifact:${BRIEF_REL}#no-such-section`], 'The document has a title')])));
  step('F1.lookalike.lowercase', 'ids ac1 + AC2 (AC1 omitted, lower-case look-alike)', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('ac1', [anchor]), crit('AC2', [anchor])])));
  step('F1.lookalike.cyrillic', 'ids АC1 (Cyrillic A) + AC2 (AC1 omitted)', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('АC1', [anchor]), crit('AC2', [anchor])])));
  step('F1.lookalike.ac01', 'ids AC01 + AC2 (zero-padded look-alike, AC1 omitted)', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('AC01', [anchor]), crit('AC2', [anchor])])));
  step('F1.duplicate', 'AC1 twice, AC2 omitted', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC1', [anchor])])));
  step('F1.table.legit', 'full coverage AC1 + AC2 against the table brief is approved (overblocking check)', 'ok', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])])));
  step('F1.table.status', 'architecture gate status after the legitimate approval', 'documented', { ok: true, value: ctx.store.state().gates.architecture.status });

  // ---- Reflow the brief after submission: pinned bytes differ -> the author must resubmit.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  submitBrief(ctx, LIST);
  write(ctx.dir, BRIEF_REL, LIST.replace('- AC1 category returned for every ticket\n- AC2 429', '- AC1  category returned for every ticket\n\n- AC2 429'));
  step('F1.reflow', 'brief reflowed (whitespace only) after submission, then a full-coverage approval', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])])));
  write(ctx.dir, BRIEF_REL, LIST);
  step('F1.reflow.restored', 'bytes restored: the same approval passes', 'ok', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])])));

  // ---- criteriaSections pointing at a heading that does not exist: coverage silently becomes empty.
  ctx = tmpProject({ configOverrides: { review: { criteriaSections: { architecture: ['Definition of Done'] } } } });
  dirs.push(ctx.dir);
  submitBrief(ctx, LIST);
  step('F1.config.noheading.required', 'config review.criteriaSections names a heading the brief lacks: required ids', 'documented', { ok: true, value: gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'architecture') });
  step('F1.config.noheading.attack', 'then "the document has a title" (valid anchor) is accepted: coverage is not enforced', 'documented', review(ctx, 'architecture', approve([crit('C1', [`artifact:${BRIEF_REL}#Risks`], 'The document has a title')])), 'RESIDUAL (config): a misconfigured criteriaSections disables coverage silently; eccode gate show says "coverage cannot be checked"');

  // ---- A brief whose criteria carry no ids: nothing is required, so the F1 attack goes through.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  submitBrief(ctx, NO_IDS);
  step('F1.noids.required', 'brief lists two acceptance criteria without ids: required ids', 'documented', { ok: true, value: gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'architecture') });
  const noIds = review(ctx, 'architecture', approve([crit('C1', [`artifact:${BRIEF_REL}#Risks`], 'The document has a title')]));
  step('F1.noids.attack', 'approval "the document has a title" against a brief with un-numbered criteria', 'documented', noIds, noIds.ok ? 'NEW (non-blocking): the author controls whether coverage is enforced; a brief without criterion ids makes the F1 attack succeed again' : 'refused');
  step('F1.noids.status', 'gate status', 'documented', { ok: true, value: ctx.store.state().gates.architecture.status });

  // ---- Plan gate: JSON-path anchors through recordReview (not only resolveRef).
  ctx = tmpProject();
  dirs.push(ctx.dir);
  submitBrief(ctx, LIST);
  review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])]));
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  review(ctx, 'design', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']), 'technical-reviewer');
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  step('F1.plan.badpath', 'plan approval citing artifact:plan.json#phases.9.goal (no such path)', 'refused:REVIEW_REJECTED', review(ctx, 'plan', approve([crit('phase:core', ['artifact:.eccode/artifacts/plan.json#phases.9.goal'])]), 'technical-reviewer'));
  step('F1.plan.badphase', 'plan approval covering phase:nope instead of phase:core', 'refused:REVIEW_REJECTED', review(ctx, 'plan', approve([crit('phase:nope', ['artifact:.eccode/artifacts/plan.json#phases.0.goal'])]), 'technical-reviewer'));
  step('F1.plan.legit', 'plan approval citing #phases.0.goal and #tasks.api.verification', 'ok', review(ctx, 'plan', approve([crit('phase:core', ['artifact:.eccode/artifacts/plan.json#phases.0.goal', 'artifact:.eccode/artifacts/plan.json#tasks.api.verification'])]), 'technical-reviewer'));

  // ---- Phase and verification: the verification approval must cover AC1 and AC2.
  const finishPhase = (c) => {
    gates.startGate(c.store, c.config, 'phase:core', 'orchestrator');
    for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
      tasks.claim(c.store, c.config, id, owner);
      write(c.dir, file, `// ${id}\n`);
      tasks.complete(c.store, c.config, id, owner, handoffFor(id, owner, [passCheck(c.store, owner).id], [file]));
    }
    gates.submit(c.store, c.config, 'phase:core', 'delivery-lead');
    const ev = passCheck(c.store, 'technical-reviewer');
    gates.recordReview(c.store, c.config, 'phase:core', 'technical-reviewer', coverage(c, 'phase:core', [`ev:${ev.id}`]));
  };
  finishPhase(ctx);
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md'] });
  let sev = passCheck(ctx.store, 'security-reviewer');
  step('F1.verification.required', 'required ids for the verification gate', 'documented', { ok: true, value: gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'verification').map((c) => c.id) });
  step('F1.verification.omitAC2', 'verification approval covering AC1 only', 'refused:REVIEW_REJECTED', review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`])]), 'security-reviewer'));
  step('F1.verification.legit', 'verification approval covering AC1 and AC2', 'ok', review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`]), crit('AC2', [`ev:${sev.id}`])]), 'security-reviewer'));

  // ---- NEW candidate: the brief edited AFTER the architecture approval shrinks the design/verification coverage.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  commitAll(ctx.dir, 'base');
  submitBrief(ctx, LIST);
  review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])]));
  // The guard lets a document author write under .eccode/artifacts/** through the shell (shipped test: "designer redirect into artifacts").
  step('F1.edited.guard', 'guard: technical-designer `echo … > brief.md` (the approved architecture artifact)', 'documented', guard({ cwd: ctx.dir, tool_name: 'Bash', agent_type: 'eccode:technical-designer', tool_input: { command: `echo x > ${BRIEF_REL}` } }));
  write(ctx.dir, BRIEF_REL, head('- AC1 category returned for every ticket')); // AC2 removed after approval
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  step('F1.edited.designRequired', 'required ids for design after AC2 was removed from the approved brief on disk', 'documented', { ok: true, value: gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'design').map((c) => c.id) });
  const designOnlyAC1 = review(ctx, 'design', approve([crit('AC1', ['artifact:.eccode/artifacts/spec.md#Components'])]), 'technical-reviewer');
  step('F1.edited.designApproval', 'design approval covering AC1 only (AC2 was in the approved brief)', 'documented', designOnlyAC1, designOnlyAC1.ok ? 'NEW: required ids are derived from the brief as it is NOW, not from the bytes the architecture approval pinned' : 'refused');
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  review(ctx, 'plan', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']), 'technical-reviewer');
  finishPhase(ctx);
  commitAll(ctx.dir, 'phase work');
  step('F1.edited.unreviewedBeforeVerification', 'unreviewedChanges before the verification gate', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  // The delivery-lead lists the edited brief among the verification artifacts, so the later approval pins it.
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', BRIEF_REL, 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  sev = passCheck(ctx.store, 'security-reviewer');
  step('F1.edited.verificationRequired', 'required ids for verification', 'documented', { ok: true, value: gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'verification').map((c) => c.id) });
  const verOnlyAC1 = review(ctx, 'verification', approve([crit('AC1', [`ev:${sev.id}`, `artifact:${BRIEF_REL}#Acceptance Criteria`])]), 'security-reviewer');
  step('F1.edited.verificationApproval', 'verification approval covering AC1 only', 'documented', verOnlyAC1, verOnlyAC1.ok ? 'NEW: AC2 was never covered at design or verification' : 'refused');
  const delivered = attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config }));
  step('F1.edited.deliver', 'delivery after the brief was edited post-approval and re-pinned by the verification gate', 'documented', delivered, delivered.ok ? 'NEW: delivered; the audit CLI also reports OK (next step)' : 'blocked');
  const audit = spawnSync(process.execPath, [path.join(REPO, 'bin/eccode.js'), '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
  step('F1.edited.audit', 'eccode audit after the delivery', 'documented', { ok: audit.status === 0, exit: audit.status, value: audit.stdout.trim().split('\n')[0] });
} finally {
  cleanup(...dirs);
}
finish();
