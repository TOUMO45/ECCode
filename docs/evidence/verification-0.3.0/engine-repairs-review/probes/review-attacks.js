'use strict';
// Independent review of the five engine repairs (eccode/verification-repairs 9319875..a50a316): attacks on
// each repair and the legitimate flows around it. Expectations encode what the commit messages promise; a
// `documented` step is one whose outcome is judged in REVIEW.md rather than by the probe.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { REPO, attempt, report, git, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const evidence = require(REPO + '/lib/evidence');
const delivery = require(REPO + '/lib/delivery');
const rework = require(REPO + '/lib/rework');
const { gitChangedFiles } = require(REPO + '/lib/project');
const { loadConfig } = require(REPO + '/lib/config');
const { writeJson } = require(REPO + '/lib/util');
const { tmpProject, write, coverage, approveThroughPlan, passCheck, handoffFor, samplePlan, task, DESIGN_MD, rejection } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const head = (criteria, { heading = 'Acceptance Criteria' } = {}) => `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
- R2 rate limit the classifier endpoint
## ${heading}
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
const TABLE = head('| Id | Criterion |\n|---|---|\n| AC1 | category returned for every ticket |\n| AC2 | 429 returned above the configured rate |');
const TABLE_NO_IDS = head('| Criterion |\n|---|\n| category returned for every ticket |\n| 429 returned above the configured rate |');
const DOD = head('See Definition of Done.\n## Definition of Done\n- AC1 category returned for every ticket\n- AC2 429 returned above the configured rate');
const PHASE = [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']];
const DELIV = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];
const DECLARED = 'node -e "process.exit(0)" api-check';
const crit = (id, refs, description = `${id} verified against the brief`) => ({ id, description, met: true, evidence: refs });
const approve = (criteria) => ({ decision: 'approve', summary: 'Criteria checked against the submitted brief.', criteria, findings: [] });
const anchor = `artifact:${BRIEF_REL}#Acceptance Criteria`;
const review = (ctx, gate, r, reviewer) => attempt(() => gates.recordReview(ctx.store, ctx.config, gate, reviewer, r));
const required = (ctx, gate) => attempt(() => gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, gate).map((c) => c.id));
const unreviewed = (ctx) => delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config);
const deliver = (ctx) => attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config }));
const cli = (ctx, ...args) => {
  const r = spawnSync(process.execPath, [BIN, '--root', ctx.dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, exit: r.status, code: /\[([A-Z_]+)\]/.exec(r.stderr || '')?.[1], message: (r.stderr || r.stdout).split('\n')[0] };
};

function submitBrief(ctx, text, extra = []) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, text);
  return gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL, ...extra] });
}
function approveArch(ctx, text = LIST, extra = []) {
  submitBrief(ctx, text, extra);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', [anchor]));
}
function approveDesignAndPlan(ctx, plan = samplePlan()) {
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(ctx.store, ctx.config, 'design', 'technical-reviewer', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']));
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/plan.json', JSON.stringify(plan, null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
}
function completePhase(ctx, phase = 'core', items = PHASE) {
  gates.startGate(ctx.store, ctx.config, `phase:${phase}`, 'orchestrator');
  for (const [id, owner, file] of items) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  gates.submit(ctx.store, ctx.config, `phase:${phase}`, 'delivery-lead');
  gates.recordReview(ctx.store, ctx.config, `phase:${phase}`, 'technical-reviewer', coverage(ctx, `phase:${phase}`, [`ev:${passCheck(ctx.store, 'technical-reviewer').id}`]));
}
function submitVerification(ctx, artifacts = DELIV) {
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  return gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts });
}
const approveVerification = (ctx) => review(ctx, 'verification', coverage(ctx, 'verification', [`ev:${passCheck(ctx.store, 'security-reviewer').id}`]), 'security-reviewer');

const { step, finish } = report('review-attacks (independent review of the repairs)');
const dirs = [];
const fresh = (opts) => { const c = tmpProject(opts); dirs.push(c.dir); return c; };
try {
  // =============================================================================================== NEW-1
  // 1.1 whitespace / line-ending edits of the approved brief.
  let ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveArch(ctx);
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  write(ctx.dir, BRIEF_REL, LIST.replace(/\n/g, '\r\n'));
  step('N1.crlf', 'approved brief converted to CRLF (bytes differ, text identical)', 'refused:APPROVED_ARTIFACT_CHANGED', required(ctx, 'design'));
  write(ctx.dir, BRIEF_REL, LIST + '\n');
  step('N1.trailingNewline', 'one newline appended to the approved brief', 'refused:APPROVED_ARTIFACT_CHANGED', required(ctx, 'design'));
  write(ctx.dir, BRIEF_REL, LIST);
  step('N1.restored', 'bytes restored: design derives AC1 + AC2 again', 'ok', required(ctx, 'design'));
  fs.unlinkSync(path.join(ctx.dir, BRIEF_REL));
  const gone = required(ctx, 'design');
  step('N1.deleted', 'approved brief deleted from disk', 'refused:APPROVED_ARTIFACT_CHANGED', gone);
  step('N1.deleted.message', 'the message says it was deleted (not "differs")', 'documented', { ok: /was deleted after/.test(gone.message || ''), value: (gone.message || '').slice(0, 120) });
  write(ctx.dir, BRIEF_REL, LIST);
  // 1.2 the brief listed again by the design submission at the SAME bytes (allowed) and at other bytes (refused).
  step('N1.repinSameBytes', 'design submission listing the approved brief at the pinned bytes', 'ok', attempt(() => gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md', BRIEF_REL] })));
  write(ctx.dir, BRIEF_REL, AC1_ONLY);
  step('N1.repinOtherBytes', 'design submission listing the edited brief', 'refused:APPROVED_ARTIFACT_CHANGED', attempt(() => gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md', BRIEF_REL] })));
  write(ctx.dir, BRIEF_REL, LIST);

  // 1.3 a non-Markdown artifact pinned by architecture, edited after approval.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  write(ctx.dir, '.eccode/artifacts/architecture/diagram.json', '{"nodes":["api"]}\n');
  approveArch(ctx, LIST, ['.eccode/artifacts/architecture/diagram.json']);
  commitAll(ctx.dir, 'approved docs');
  write(ctx.dir, '.eccode/artifacts/architecture/diagram.json', '{"nodes":["api","backdoor"]}\n');
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  step('N1.json.designRequired', 'requiredCriteria(design) with the non-Markdown architecture artifact edited (only Markdown is hash-checked there)', 'documented', required(ctx, 'design'));
  const jsonDesign = review(ctx, 'design', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']), 'technical-reviewer');
  step('N1.json.designApproval', 'design approval while the edited diagram.json differs from the architecture pin', 'documented', jsonDesign, jsonDesign.ok ? 'accepted: the design review does not consult unreviewedChanges; the edit is caught later (verification approval / delivery), see next steps' : 'refused');
  step('N1.json.unreviewed', 'unreviewedChanges reports the edited diagram.json against architecture', 'documented', { ok: unreviewed(ctx).some((c) => c.path.endsWith('diagram.json')), value: unreviewed(ctx) });
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  step('N1.json.repin', 'verification submission listing the edited diagram.json', 'refused:APPROVED_ARTIFACT_CHANGED', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [...DELIV, '.eccode/artifacts/architecture/diagram.json'] })));
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV });
  step('N1.json.verificationApproval', 'verification approval without listing it (the edit is an unreviewed change of an approved artifact)', 'refused:REVIEW_REJECTED', approveVerification(ctx));
  step('N1.json.deliver', 'deliver() while diagram.json differs', 'refused:DELIVERY_BLOCKED', deliver(ctx));
  write(ctx.dir, '.eccode/artifacts/architecture/diagram.json', '{"nodes":["api"]}\n');
  step('N1.json.restoredApproval', 'verification approval once diagram.json is restored', 'ok', approveVerification(ctx));

  // 1.4 the spec (design artifact) edited after the design approval.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveArch(ctx);
  approveDesignAndPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD + '## Addendum\nquietly changed\n');
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  step('N1.spec.repin', 'verification submission listing the edited spec.md (pinned by design)', 'refused:APPROVED_ARTIFACT_CHANGED', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [...DELIV, '.eccode/artifacts/spec.md'] })));
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV });
  const specApproval = approveVerification(ctx);
  step('N1.spec.verificationApproval', 'verification approval while spec.md differs from the design pin', 'refused:REVIEW_REJECTED', specApproval);
  step('N1.spec.reason', 'the refusal names spec.md modified after approval (design)', 'documented', { ok: /spec\.md modified after approval \(design\)/.test(specApproval.message || ''), value: (specApproval.details || {}).reasons });

  // 1.5 can an approved brief ever change legitimately? reopen / rework / resubmission before approval.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  submitBrief(ctx, AC1_ONLY);
  const rej = review(ctx, 'architecture', rejection(), 'architecture-reviewer');
  step('N1.iterate.changesRequested', 'architecture changes_requested on the first brief', 'ok', rej);
  write(ctx.dir, BRIEF_REL, LIST);
  step('N1.iterate.resubmit', 'the author resubmits the revised brief BEFORE approval (the normal iteration, other bytes, same gate, --responds-to)', 'ok', attempt(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL], respondsTo: rej.value.event.data.reviewId })));
  step('N1.iterate.approve', 'approval of the revised brief (resolving F1)', 'ok', review(ctx, 'architecture', coverage(ctx, 'architecture', [anchor], { resolvedFindings: [{ id: 'F1', resolution: 'R2 adds the rate limit.', evidence: [`artifact:${BRIEF_REL}#Requirements`] }] }), 'architecture-reviewer'));
  step('N1.reopen.architecture', 'eccode gate reopen architecture --actor user on the approved gate', 'refused:INVALID_TRANSITION', attempt(() => gates.reopenGate(ctx.store, 'architecture', 'user', 'revise the brief')));
  step('N1.rework.brief', 'a rework scoped to the brief', 'refused:INVALID_INPUT', attempt(() => rework.openRework(ctx.store, ctx.config, 'user', { reason: 'revise the brief', files: ['.eccode/artifacts/**'], owner: 'product-architect' })));
  const planWithBriefOwner = samplePlan();
  planWithBriefOwner.tasks[0].files = ['.eccode/artifacts/architecture/**'];
  step('N1.plan.briefOwnership', 'a plan task owning .eccode/artifacts/architecture/**', 'documented', { ok: tasks.validatePlan(planWithBriefOwner, ctx.config).length === 0, value: tasks.validatePlan(planWithBriefOwner, ctx.config) });
  const msg = (() => { write(ctx.dir, BRIEF_REL, AC1_ONLY); gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator'); const r = required(ctx, 'design'); write(ctx.dir, BRIEF_REL, LIST); return r; })();
  step('N1.message', 'the APPROVED_ARTIFACT_CHANGED message names the file, the gate, the restore command and the documented revision path', 'documented', { ok: /brief\.md/.test(msg.message) && /approved architecture/.test(msg.message) && /git checkout -- /.test(msg.message) && /new artifact of a later gate/.test(msg.message), value: msg.message });

  // 1.6 the recovery advice when the artifact was never committed.
  ctx = fresh();
  approveArch(ctx); // nothing committed after init
  write(ctx.dir, BRIEF_REL, AC1_ONLY);
  const co = attempt(() => execFileSync('git', ['checkout', '--', BRIEF_REL], { cwd: ctx.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  step('N1.uncommitted.checkout', 'git checkout -- brief.md when the brief was never committed (the message\'s recovery)', 'documented', { ...co, message: co.ok ? undefined : String(co.message).split('\n').slice(-2).join(' ').slice(0, 200) }, co.ok ? 'works' : 'the named recovery fails for an uncommitted artifact: the pinned bytes exist only as a hash in the record');

  // =============================================================================================== NEW-2
  ctx = fresh();
  submitBrief(ctx, TABLE);
  step('N2.table.required', 'ids in a Markdown table', 'ok', required(ctx, 'architecture'));
  step('N2.table.approve', 'table brief approved with AC1 + AC2', 'ok', review(ctx, 'architecture', coverage(ctx, 'architecture', [anchor]), 'architecture-reviewer'));
  ctx = fresh();
  submitBrief(ctx, TABLE_NO_IDS);
  const tni = review(ctx, 'architecture', approve([crit('C1', [`artifact:${BRIEF_REL}#Risks`], 'The document has a title')]), 'architecture-reviewer');
  step('N2.tableNoIds', 'a table under Acceptance Criteria whose rows carry no ids', 'refused:REVIEW_REJECTED', tni);
  step('N2.tableNoIds.reason', 'the reason says the section lists no criterion ids', 'documented', { ok: /list no criterion ids/.test(tni.message || ''), value: (tni.details || {}).reasons });
  ctx = fresh({ configOverrides: { review: { criteriaSections: { architecture: ['Definition of Done'] } } } });
  submitBrief(ctx, DOD);
  step('N2.dod.required', 'ids under "Definition of Done" with criteriaSections configured to it', 'ok', required(ctx, 'architecture'));
  step('N2.dod.approve', 'approval covering AC1 + AC2 under the configured heading', 'ok', review(ctx, 'architecture', coverage(ctx, 'architecture', [`artifact:${BRIEF_REL}#Definition of Done`]), 'architecture-reviewer'));
  approveDesignAndPlan(ctx);
  completePhase(ctx);
  submitVerification(ctx);
  step('N2.dod.verification', 'verification approval covering the configured-heading ids', 'ok', approveVerification(ctx));
  ctx = fresh({ configOverrides: { review: { criteriaSections: { architecture: [] } } } });
  submitBrief(ctx, head('- category returned for every ticket'));
  step('N2.optout.arch', 'criteriaSections.architecture: [] and a no-ids brief: architecture approval goes through', 'ok', review(ctx, 'architecture', approve([crit('C1', [`artifact:${BRIEF_REL}#Risks`], 'The document has a title')]), 'architecture-reviewer'));
  approveDesignAndPlan(ctx);
  completePhase(ctx);
  submitVerification(ctx);
  step('N2.optout.verificationRequired', 'with the rule off, verification falls back to phase:<id> coverage', 'documented', { ok: true, value: required(ctx, 'verification').value });
  step('N2.optout.verification', 'verification approval with the rule off', 'ok', approveVerification(ctx));
  ctx = fresh();
  submitBrief(ctx, `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- AC1 category returned for every ticket
- AC2 429 returned above the configured rate
## Acceptance Criteria
See the requirements above.
## Architecture
Single Node service.
## Assumptions
- A1
## Open Questions
- Q1
## Risks
- RISK1
`);
  step('N2.idsElsewhere', 'ids listed under Requirements, the Acceptance Criteria section only points at them', 'refused:REVIEW_REJECTED', review(ctx, 'architecture', approve([crit('AC1', [anchor]), crit('AC2', [anchor])]), 'architecture-reviewer'));
  const usage = fs.readFileSync(path.join(REPO, 'docs/usage.md'), 'utf8');
  step('N2.docs', 'docs/usage.md documents the [] opt-out in the config table and the troubleshooting row', 'documented', { ok: /\{ architecture: \[\] \}/.test(usage) && /review\.criteriaSections\.architecture` to `\[\]`/.test(usage), value: usage.split('\n').filter((l) => l.includes('[]') && l.includes('criteriaSections')).length });

  // =============================================================================================== NEW-3
  // 3.1 a file committed between approvals but under release.ignore.
  ctx = fresh({ configOverrides: { release: { ignore: ['dist/**'] } } });
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  write(ctx.dir, 'dist/bundle.js', '// generated between approvals\n');
  commitAll(ctx.dir, 'generated');
  step('N3.ignore.unreviewed', 'dist/bundle.js committed between approvals under release.ignore is not reported', 'documented', { ok: unreviewed(ctx).length === 0, value: unreviewed(ctx) });
  submitVerification(ctx);
  step('N3.ignore.approve', 'verification approval with the ignored file in the tree', 'ok', approveVerification(ctx));
  step('N3.ignore.deliver', 'delivery (the ignore is the deliberate opt-out)', 'ok', deliver(ctx));

  // 3.2 the config edited after the fact to ignore a stray file (residual: config integrity).
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  write(ctx.dir, 'src/server/backdoor.js', 'module.exports = "never reviewed";\n');
  commitAll(ctx.dir, 'stray');
  submitVerification(ctx);
  step('N3.configIgnore.before', 'verification approval with the stray file (refused)', 'refused:REVIEW_REJECTED', approveVerification(ctx));
  {
    const file = path.join(ctx.dir, '.eccode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.release = { ...(cfg.release || {}), ignore: ['src/server/backdoor.js'] };
    writeJson(file, cfg);
  }
  const cfg2 = loadConfig(ctx.dir);
  const cfgApproval = attempt(() => gates.recordReview(ctx.store, cfg2, 'verification', 'security-reviewer', coverage({ ...ctx, config: cfg2 }, 'verification', [`ev:${passCheck(ctx.store, 'security-reviewer').id}`])));
  step('N3.configIgnore.after', 'the same approval after .eccode/config.json release.ignore was edited to name the stray file', 'documented', cfgApproval, cfgApproval.ok ? 'RESIDUAL (pre-existing): whoever can edit .eccode/config.json can exempt a path; the config is outside the release tree and is not pinned by any review' : 'refused');

  // 3.3 a file added by an in-flight task of a later, unapproved phase.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  const twoPhases = {
    phases: [
      { id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] },
      { id: 'next', name: 'Next', goal: 'Build the admin tools', acceptanceCriteria: ['admin responds'] },
    ],
    tasks: [task('api', 'backend-engineer', ['src/server/**']), task('ui', 'frontend-engineer', ['src/web/**']), task('tests', 'test-engineer', ['tests/**'], ['api']), task('admin', 'backend-engineer', ['src/admin/**'], [], 'next')],
  };
  approveThroughPlan(ctx, twoPhases);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase core');
  gates.startGate(ctx.store, ctx.config, 'phase:next', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'admin', 'backend-engineer');
  write(ctx.dir, 'src/admin/index.js', '// in flight\n');
  commitAll(ctx.dir, 'in-flight work committed');
  step('N3.inflight.unreviewed', 'a file added (and committed) by an in-flight task of the unapproved phase:next is not reported', 'documented', { ok: unreviewed(ctx).length === 0, value: unreviewed(ctx) });
  write(ctx.dir, 'src/other/stray.js', '// owned by nobody\n');
  commitAll(ctx.dir, 'stray outside any ownership');
  step('N3.inflight.stray', 'a file outside every ownership committed meanwhile IS reported', 'documented', { ok: unreviewed(ctx).some((c) => c.path === 'src/other/stray.js'), value: unreviewed(ctx) });
  fs.rmSync(path.join(ctx.dir, 'src/other'), { recursive: true });
  commitAll(ctx.dir, 'stray removed');
  tasks.complete(ctx.store, ctx.config, 'admin', 'backend-engineer', handoffFor('admin', 'backend-engineer', [passCheck(ctx.store, 'backend-engineer').id], ['src/admin/index.js']));
  gates.submit(ctx.store, ctx.config, 'phase:next', 'delivery-lead');
  gates.recordReview(ctx.store, ctx.config, 'phase:next', 'technical-reviewer', coverage(ctx, 'phase:next', [`ev:${passCheck(ctx.store, 'technical-reviewer').id}`]));
  commitAll(ctx.dir, 'phase next');
  submitVerification(ctx, [...DELIV, 'src/admin/index.js']);
  step('N3.inflight.verification', 'verification approval after both phases (overblocking check)', 'ok', approveVerification(ctx));
  step('N3.inflight.deliver', 'delivery', 'ok', deliver(ctx));

  // 3.4 a reviewed file deleted between approvals; 3.5 a reviewed file renamed between approvals (from).
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  fs.unlinkSync(path.join(ctx.dir, 'src/web/b.js'));
  commitAll(ctx.dir, 'b.js deleted after the phase approval');
  step('N3.deleted.unreviewed', 'unreviewedChanges after a pinned file was deleted and committed', 'documented', { ok: unreviewed(ctx).some((c) => c.path === 'src/web/b.js' && /deleted/.test(c.problem)), value: unreviewed(ctx) });
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  step('N3.deleted.listGone', 'the verification submission cannot list the deleted path', 'refused:NOT_FOUND', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV })));
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV.filter((p) => p !== 'src/web/b.js') });
  step('N3.deleted.approval', 'verification approval with the unreviewed deletion', 'refused:REVIEW_REJECTED', approveVerification(ctx));
  step('N3.deleted.deliver', 'deliver()', 'refused:DELIVERY_BLOCKED', deliver(ctx));
  git(ctx.dir, 'checkout', 'HEAD~1', '--', 'src/web/b.js');
  commitAll(ctx.dir, 'b.js restored');
  step('N3.deleted.restoredApproval', 'verification approval once the file is restored', 'ok', approveVerification(ctx));
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  git(ctx.dir, 'mv', 'src/server/a.js', 'src/server/a2.js');
  commitAll(ctx.dir, 'renamed after the phase approval');
  const ren = unreviewed(ctx);
  step('N3.renamed.from', 'a rename committed after approval is reported with its old path (from), and the old pinned path as deleted', 'documented', { ok: ren.some((c) => c.path === 'src/server/a2.js' && c.from === 'src/server/a.js' && /renamed/.test(c.problem)) && ren.some((c) => c.path === 'src/server/a.js' && /deleted/.test(c.problem)), value: ren });
  submitVerification(ctx, ['.eccode/artifacts/verification.md', 'src/server/a2.js', 'src/web/b.js', 'tests/c.test.js']);
  const renApproval = approveVerification(ctx);
  step('N3.renamed.approval', 'verification approval listing the new path (the old pinned path left the tree unreviewed)', 'refused:REVIEW_REJECTED', renApproval);
  step('N3.renamed.reason', 'the refusal names the deleted old path', 'documented', { ok: /src\/server\/a\.js deleted after approval/.test(renApproval.message || ''), value: (renApproval.details || {}).reasons });

  // 3.5b the same rename when the latest approved commit CONTAINS the file (the phase work was committed before
  // the phase submission): the commit message promises the entry keeps its `from`.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  commitAll(ctx.dir, 'phase work committed before the phase submission');
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${passCheck(ctx.store, 'technical-reviewer').id}`]));
  git(ctx.dir, 'mv', 'src/server/a.js', 'src/server/a2.js');
  commitAll(ctx.dir, 'renamed after the phase approval');
  const ren2 = unreviewed(ctx);
  step('N3.renamed.fromCommitted', 'rename after approval when the phase commit contains the file: reported as renamed with from', 'documented', { ok: ren2.some((c) => c.path === 'src/server/a2.js' && c.from === 'src/server/a.js' && /renamed/.test(c.problem)), value: ren2 });
  submitVerification(ctx, ['.eccode/artifacts/verification.md', 'src/server/a2.js', 'src/web/b.js', 'tests/c.test.js']);
  step('N3.renamed.fromCommitted.approval', 'verification approval listing the new path only', 'refused:REVIEW_REJECTED', approveVerification(ctx));

  // 3.6 the early window: a stray file committed between the architecture approval and the design submission.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveArch(ctx);
  commitAll(ctx.dir, 'brief');
  write(ctx.dir, 'tools/early.js', '// committed right after the architecture approval\n');
  commitAll(ctx.dir, 'early stray');
  approveDesignAndPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  step('N3.early.unreviewed', 'the early stray file is still reported after three later approvals on later commits', 'documented', { ok: unreviewed(ctx).some((c) => c.path === 'tools/early.js'), value: unreviewed(ctx) });
  submitVerification(ctx);
  step('N3.early.approval', 'verification approval without it', 'refused:REVIEW_REJECTED', approveVerification(ctx));
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [...DELIV, 'tools/early.js'] });
  step('N3.early.listed', 'listed in the verification submission: approved', 'ok', approveVerification(ctx));
  step('N3.early.deliver', 'delivery', 'ok', deliver(ctx));

  // 3.7 VER-2: a pinned file edited after the phase approval and listed in the verification submission at its new bytes.
  ctx = fresh();
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  fs.appendFileSync(path.join(ctx.dir, 'src/server/a.js'), '// clarifying edit for the release\n');
  commitAll(ctx.dir, 'release edit');
  submitVerification(ctx);
  step('N3.ver2.pending', 'the edit is pending re-review in verification', 'documented', { ok: unreviewed(ctx).every((c) => c.pending === 'verification'), value: unreviewed(ctx) });
  step('N3.ver2.approval', 'verification approval pins the new version (TriageDesk VER-2 flow, overblocking check)', 'ok', approveVerification(ctx));
  step('N3.ver2.deliver', 'delivery', 'ok', deliver(ctx));

  // =============================================================================================== NEW-4
  ctx = fresh();
  write(ctx.dir, 'src/server/old.js', '// old\n');
  write(ctx.dir, 'src/server/sub/deep.js', '// deep\n');
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  const base = ctx.store.state().tasks.api.claim.baseCommit;
  git(ctx.dir, 'mv', 'src/server/old.js', 'src/server/new.js');
  fs.appendFileSync(path.join(ctx.dir, 'src/server/new.js'), '// edited after the move\n');
  step('N4.mvEdit.changed', 'git mv + edit of the new file: both paths changed', 'documented', { ok: true, value: gitChangedFiles(ctx.dir, base).filter((f) => !f.startsWith('.eccode/')).sort() });
  let ev = passCheck(ctx.store, 'backend-engineer');
  step('N4.mvEdit.newOnly', 'handoff declaring new.js only', 'refused:INVALID_HANDOFF', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/new.js']))));
  fs.mkdirSync(path.join(ctx.dir, 'src/server/other'), { recursive: true });
  git(ctx.dir, 'mv', 'src/server/sub/deep.js', 'src/server/other/deep2.js');
  step('N4.acrossDirs.changed', 'rename across directories inside the ownership: both paths changed', 'documented', { ok: true, value: gitChangedFiles(ctx.dir, base).filter((f) => !f.startsWith('.eccode/')).sort() });
  ev = passCheck(ctx.store, 'backend-engineer');
  step('N4.acrossDirs.partial', 'handoff declaring old.js, new.js and deep2.js but not sub/deep.js', 'refused:INVALID_HANDOFF', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/server/new.js', 'src/server/other/deep2.js']))));
  git(ctx.dir, 'commit', '-q', '-m', 'moves committed during the claim');
  ev = passCheck(ctx.store, 'backend-engineer');
  step('N4.committed.newOnly', 'the moves committed during the claim, handoff still declaring only the new paths', 'refused:INVALID_HANDOFF', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/new.js', 'src/server/other/deep2.js']))));
  step('N4.committed.all', 'all four paths declared', 'ok', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/server/new.js', 'src/server/sub/deep.js', 'src/server/other/deep2.js']))));
  // rename out of the ownership
  ctx = fresh();
  write(ctx.dir, 'src/server/old.js', '// old\n');
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  fs.mkdirSync(path.join(ctx.dir, 'src/web'), { recursive: true });
  git(ctx.dir, 'mv', 'src/server/old.js', 'src/web/moved.js');
  ev = passCheck(ctx.store, 'backend-engineer');
  const outside = attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/web/moved.js'])));
  step('N4.outOfOwnership', 'git mv from the ownership into another task\'s area, both paths declared', 'refused:INVALID_HANDOFF', outside);
  // untracked rename (fs.rename): deletion + untracked file
  ctx = fresh();
  write(ctx.dir, 'src/server/old.js', '// old\n');
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  fs.renameSync(path.join(ctx.dir, 'src/server/old.js'), path.join(ctx.dir, 'src/server/new.js'));
  ev = passCheck(ctx.store, 'backend-engineer');
  step('N4.untracked.newOnly', 'fs.rename (unstaged): handoff declaring new.js only', 'refused:INVALID_HANDOFF', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/new.js']))));
  step('N4.untracked.both', 'fs.rename: both declared', 'ok', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/server/new.js']))));

  // =============================================================================================== NEW-5
  const planWith = (verification) => { const p = samplePlan(); p.tasks[0].verification = verification; return p; };
  const validate = (cwd) => tasks.validatePlan(planWith({ method: 'run the api checks', command: DECLARED, cwd }), ctx.config);
  const schema = (cwd) => attempt(() => { const c = fresh(); approveThroughPlan(c, planWith({ method: 'run the api checks', command: DECLARED, cwd })); return c; });
  step('N5.validate.trailingSlash', 'verification.cwd "src/server/"', 'documented', { ok: validate('src/server/').length === 0, value: validate('src/server/') });
  step('N5.validate.dotSlash', 'verification.cwd "./src/server"', 'documented', { ok: validate('./src/server').length === 0, value: validate('./src/server') });
  step('N5.validate.dot', 'verification.cwd "."', 'documented', { ok: validate('.').length === 0, value: validate('.') });
  step('N5.validate.backslash', 'verification.cwd "src\\\\server" (Windows separator) on Linux', 'documented', { ok: true, value: { errors: validate('src\\server'), declaredCwd: tasks.declaredCwd(ctx.dir, { cwd: 'src\\server' }) } });
  step('N5.validate.backslashDotDot', 'verification.cwd "src\\\\..\\\\x" on Linux (no .. segment after splitting on /)', 'documented', { ok: true, value: { errors: validate('src\\..\\x'), declaredCwd: tasks.declaredCwd(ctx.dir, { cwd: 'src\\..\\x' }) } });
  step('N5.validate.spaces', 'verification.cwd " src/server " (surrounding spaces)', 'documented', { ok: true, value: { errors: validate(' src/server '), declaredCwd: tasks.declaredCwd(ctx.dir, { cwd: ' src/server ' }) } });
  step('N5.validate.nonexistent', 'verification.cwd "src/nope" (directory does not exist yet)', 'documented', { ok: true, value: validate('src/nope') });
  step('N5.validate.dotdotInside', 'verification.cwd "src/server/../server" (resolves inside, refused for the .. segment)', 'documented', { ok: true, value: validate('src/server/../server') });
  for (const bad of ['/abs', 'C:\\x', '../up', '']) step(`N5.validate.bad:${JSON.stringify(bad)}`, `verification.cwd ${JSON.stringify(bad)} refused by validatePlan`, 'documented', { ok: validate(bad).length > 0, value: validate(bad) });
  step('N5.schema.cwdNumber', 'plan schema refuses a non-string cwd', 'refused', schema(5));
  step('N5.schema.cwdEmpty', 'plan schema/validation refuses an empty cwd', 'refused', schema(''));

  const openApi = (c) => { gates.startGate(c.store, c.config, 'phase:core', 'orchestrator'); tasks.claim(c.store, c.config, 'api', 'backend-engineer'); write(c.dir, 'src/server/app.js', 'module.exports = 1;\n'); };
  const run = (c, actor, extra = {}) => evidence.runCommand(c.store, actor, { label: 'api check', command: DECLARED, ...extra });
  const complete = (c, ids) => attempt(() => tasks.complete(c.store, c.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js'])));
  // trailing slash declared, run with the bare path (and vice versa)
  let c5 = schema('src/server/').value;
  openApi(c5);
  step('N5.trailingSlash.run', 'declared "src/server/", run --cwd src/server', 'ok', complete(c5, [run(c5, 'backend-engineer', { cwd: 'src/server' }).id]));
  c5 = schema('./src/server').value;
  openApi(c5);
  step('N5.dotSlash.run', 'declared "./src/server", run --cwd src/server/', 'ok', complete(c5, [run(c5, 'backend-engineer', { cwd: 'src/server/' }).id]));
  c5 = schema('.').value;
  openApi(c5);
  step('N5.dot.runRoot', 'declared ".", run at the root', 'ok', complete(c5, [run(c5, 'backend-engineer').id]));
  // backslash on Linux
  c5 = schema('src\\server').value;
  if (c5) {
    openApi(c5);
    const bsRun = complete(c5, [run(c5, 'backend-engineer', { cwd: 'src/server' }).id]);
    step('N5.backslash.runPosix', 'declared "src\\\\server" on Linux, run --cwd src/server', 'documented', bsRun, bsRun.ok ? 'normalised' : 'refused: on Linux the backslash is a literal character, so the declared cwd can never be satisfied (portability inconsistency, see REVIEW.md)');
    const bsEv = attempt(() => run(c5, 'backend-engineer', { cwd: 'src\\server' }));
    step('N5.backslash.runLiteral', 'run --cwd "src\\\\server" on Linux', 'documented', { ok: bsEv.ok && bsEv.value.status === 'passed', value: bsEv.ok ? { status: bsEv.value.status, cwd: bsEv.value.cwd, tail: bsEv.value.outputTail } : bsEv });
  }
  // nonexistent cwd
  c5 = schema('src/nope').value;
  openApi(c5);
  const nope = attempt(() => run(c5, 'backend-engineer', { cwd: 'src/nope' }));
  step('N5.nonexistent.run', 'evidence run --cwd src/nope (directory absent)', 'documented', { ok: nope.ok && nope.value.status === 'passed', value: nope.ok ? { status: nope.value.status, exitCode: nope.value.exitCode, cwd: nope.value.cwd, tail: nope.value.outputTail } : nope });
  if (nope.ok) step('N5.nonexistent.complete', 'completion citing that run', 'refused:INVALID_HANDOFF', complete(c5, [nope.value.id]));
  step('N5.nonexistent.rootRun', 'completion citing a run at the root instead', 'refused:INVALID_HANDOFF', complete(c5, [run(c5, 'backend-engineer').id]));
  // symlink to the declared directory
  c5 = schema('src/server').value;
  openApi(c5);
  fs.symlinkSync('server', path.join(c5.dir, 'src/link'));
  const viaLink = complete(c5, [run(c5, 'backend-engineer', { cwd: 'src/link' }).id]);
  step('N5.symlink', 'declared src/server, run --cwd src/link (symlink to it)', 'documented', viaLink, viaLink.ok ? 'accepted' : 'refused (fail closed: the recorded cwd is the path as given)');
  // older evidence without cwd
  const old = { id: 'ev-old', kind: 'command', command: DECLARED, status: 'passed' };
  step('N5.compat.noCwdField', 'evidence recorded without a cwd field (older engine) matches a root-declared check and not a subdirectory one', 'documented', { ok: tasks.matchesVerification(c5.dir, old, { command: DECLARED }) === true && tasks.matchesVerification(c5.dir, old, { command: DECLARED, cwd: 'src/server' }) === false, value: { root: tasks.matchesVerification(c5.dir, old, { command: DECLARED }), sub: tasks.matchesVerification(c5.dir, old, { command: DECLARED, cwd: 'src/server' }) } });
  // CLI: --cwd on evidence run records the relative cwd; gate show lists the cwd for the reviewer
  c5 = schema('src/server').value;
  openApi(c5);
  const cliRun = cli(c5, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'x', '--cwd', 'src/server/', '--', 'node', '-e', 'process.exit(0)', 'api-check');
  step('N5.cli.run', 'eccode evidence run --cwd src/server/ -- <declared command>', 'ok', cliRun);
  const last = c5.store.state().evidence ? Object.values(c5.store.state().evidence).slice(-1)[0] : null;
  const lastEv = last || (() => { const evs = require(REPO + '/lib/evidence'); return evs.listEvidence ? evs.listEvidence(c5.store).slice(-1)[0] : null; })();
  step('N5.cli.recordedCwd', 'the recorded cwd is project-relative without the trailing slash', 'documented', { ok: !!lastEv && lastEv.cwd === 'src/server', value: lastEv ? { id: lastEv.id, cwd: lastEv.cwd, command: lastEv.command } : 'evidence not found in state' });
} finally {
  cleanup(...dirs);
}
finish();
