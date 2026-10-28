'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gates = require('../lib/gates');
const { tmpProject, write, approval, rejection, expectCode, ARCH_MD } = require('./helpers');

function submitArch(ctx, content = ARCH_MD) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', content);
  return gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
}

test('gates cannot start before their predecessor is approved', () => {
  const ctx = tmpProject();
  expectCode(() => gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator'), 'GATE_BLOCKED');
  expectCode(() => gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator'), 'GATE_BLOCKED');
});

test('submissions missing required sections are refused', () => {
  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, 'brief.md', '# Brief\n## Users\nonly users\n');
  const err = expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['brief.md'] }), 'MISSING_SECTIONS');
  assert.match(err.message, /Acceptance Criteria/);
});

test('only configured authors may submit; paths outside the project are refused', () => {
  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, 'brief.md', ARCH_MD);
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'backend-engineer', { artifacts: ['brief.md'] }), 'ROLE_NOT_ALLOWED');
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['../../etc/passwd'] }), 'PATH_OUTSIDE_PROJECT');
});

test('the author cannot approve their own artifact, and the refusal is recorded', () => {
  const ctx = tmpProject({ configOverrides: { roles: { architecture: { authors: ['product-architect'], reviewers: ['architecture-reviewer', 'product-architect'] } } } });
  submitArch(ctx);
  const err = expectCode(
    () => gates.recordReview(ctx.store, ctx.config, 'architecture', 'product-architect', approval([['artifact:.eccode/artifacts/brief.md']])),
    'REVIEW_REJECTED',
  );
  assert.match(err.message, /author of an artifact cannot approve/);
  const state = ctx.store.state();
  assert.strictEqual(state.gates.architecture.status, 'submitted');
  assert.strictEqual(state.rejectedReviews.length, 1);
});

test('unauthorized reviewer roles are refused', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'backend-engineer', approval([['artifact:.eccode/artifacts/brief.md']])), 'REVIEW_REJECTED');
});

test('approval without resolvable evidence is refused (rubber-stamp protection)', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  const cases = [
    approval([[]]), // no evidence at all
    approval([['ev:ev-does-not-exist']]),
    approval([['artifact:some/other/file.md']]), // not part of the submission
  ];
  for (const review of cases) {
    expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', review), 'REVIEW_REJECTED');
  }
  const unmet = approval([['artifact:.eccode/artifacts/brief.md']]);
  unmet.criteria[0].met = false;
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', unmet), 'REVIEW_REJECTED');
  const withBlocking = approval([['artifact:.eccode/artifacts/brief.md']], {
    findings: [{ id: 'F9', severity: 'blocking', title: 'Unresolved gap', detail: 'Still missing auth design.', recommendation: 'Add it.' }],
  });
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', withBlocking), 'REVIEW_REJECTED');
  assert.strictEqual(ctx.store.state().rejectedReviews.length, 5);
});

test('schema-invalid reviews are refused', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', { decision: 'approve' }), 'REVIEW_REJECTED');
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', { ...approval([['artifact:.eccode/artifacts/brief.md']]), decision: 'lgtm' }), 'REVIEW_REJECTED');
});

test('reviews of an artifact that changed after submission are refused', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  fs.appendFileSync(path.join(ctx.dir, '.eccode/artifacts/brief.md'), '\nsneaky edit\n');
  const err = expectCode(
    () => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']])),
    'REVIEW_REJECTED',
  );
  assert.match(err.message, /changed after submission/);
});

test('the author resubmits a submitted gate whose artifact changed, and the review sees the new submission', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  fs.appendFileSync(path.join(ctx.dir, '.eccode/artifacts/brief.md'), '\n## Notes\nA late fix.\n');
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']])), 'REVIEW_REJECTED');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.status, 'submitted');
  assert.strictEqual(g.submissions.length, 2);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
});

test('a submitted gate whose artifacts are unchanged waits for its review', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  const err = expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }), 'INVALID_TRANSITION');
  assert.match(err.message, /submitted/);
});

test('changes requested → resubmission must respond → approval must resolve earlier findings', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  const { event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejection('F1'));
  const reviewId = event.data.reviewId;
  let g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.status, 'changes_requested');
  assert.deepStrictEqual(g.openFindings.map((f) => f.id), ['F1']);

  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD + '\n## Requirements (rev 2)\n- R2 rate limiting\n');
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }), 'RESPONSE_REQUIRED');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: reviewId });

  // Approving without addressing F1 is refused.
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']])), 'REVIEW_REJECTED');
  gates.recordReview(
    ctx.store,
    ctx.config,
    'architecture',
    'architecture-reviewer',
    approval([['artifact:.eccode/artifacts/brief.md#Requirements']], {
      resolvedFindings: [{ id: 'F1', resolution: 'R2 adds a rate limit requirement.', evidence: ['artifact:.eccode/artifacts/brief.md#Requirements'] }],
    }),
  );
  g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.status, 'approved');
  assert.strictEqual(g.openFindings.length, 0);
  assert.strictEqual(g.approvedBy, 'architecture-reviewer');
});

test('repeated rejections escalate; only the user can reopen', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxReviewIterations: 2 } } });
  submitArch(ctx);
  let { event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejection('F1'));
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD + '\nrev2\n');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId });
  ({ event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejection('F2')));
  const g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.status, 'escalated');
  assert.match(g.escalation.recovery, /User decision required/);
  assert.deepStrictEqual(g.escalation.unresolved.map((f) => f.id).sort(), ['F1', 'F2']);
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId }), 'INVALID_TRANSITION');
  expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'Proceed with narrower scope'), 'USER_AUTH_REQUIRED');
  gates.reopenGate(ctx.store, 'architecture', 'user', 'User accepted narrower scope: no rate limiting in v1');
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'in_progress');
});

// Mealie pilot, c1: design and plan reviewers cited the approved architecture
// brief and design spec to show the work traces back to them, and were refused.
// Mealie pilot (b2 item 6): the orchestrator dispatched the technical and the
// security reviewer to one phase, as the playbook says for auth code. The
// technical approval closed the gate, and the security reviewer's blocking
// finding (an SSRF bypass) was then refused: the gate was no longer submitted.
test('a gate started with named reviewers is approved only once each of them approves', () => {
  const roles = { architecture: { authors: ['product-architect'], reviewers: ['architecture-reviewer', 'security-reviewer'] } };
  const ctx = tmpProject({ configOverrides: { roles } });
  const both = ['architecture-reviewer', 'security-reviewer'];
  expectCode(() => gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator', { reviewers: ['technical-reviewer'] }), 'INVALID_INPUT');
  expectCode(() => gates.startGate(ctx.store, ctx.config, 'architecture', 'product-architect', { reviewers: both }), 'ROLE_NOT_ALLOWED');
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator', { reviewers: both });
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const ok = (extra) => approval([['artifact:.eccode/artifacts/brief.md#Requirements']], extra);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ok());
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'submitted', 'one approval of two leaves the gate open');
  const next = require('../lib/status').nextAction(ctx.store.state(), ctx.config, ctx.dir);
  assert.deepStrictEqual(next.awaiting, ['security-reviewer']);
  assert.match(next.detail, /Waiting for security-reviewer to review/);
  const { event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'security-reviewer', rejection('S1'));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'changes_requested', 'the later blocking finding is recorded');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD + '\n## Requirements (rev 2)\n- R2 rate limiting\n');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId });
  const resolved = { resolvedFindings: [{ id: 'S1', resolution: 'R2 adds a rate limit requirement.', evidence: ['artifact:.eccode/artifacts/brief.md#Requirements'] }] };
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'security-reviewer', ok(resolved));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'submitted', 'an approval of the earlier submission does not count');
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ok());
  const g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.status, 'approved');
  assert.deepStrictEqual(g.reviewers, both);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('gate start --reviewers through the CLI and MCP names the reviewers', () => {
  const { spawnSync } = require('child_process');
  const roles = { architecture: { authors: ['product-architect'], reviewers: ['architecture-reviewer', 'security-reviewer'] } };
  const ctx = tmpProject({ configOverrides: { roles } });
  const cli = path.join(__dirname, '..', 'bin', 'eccode.js');
  const r = spawnSync(process.execPath, [cli, 'gate', 'start', 'architecture', '--actor', 'orchestrator', '--reviewers', 'architecture-reviewer,security-reviewer'], { cwd: ctx.dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(ctx.store.state().gates.architecture.reviewers, ['architecture-reviewer', 'security-reviewer']);
  const tool = require('../lib/mcp').tools().find((t) => t.name === 'gate_start');
  assert.ok(tool.schema.reviewers, 'gate_start takes reviewers');
});

// Mealie pilot (b2 item 5): a reviewer cited fix verify's pre-fix run, which
// failed as a reproduction should, to show the test fails before the fix; the
// gate refused it as a failed check. A failed reproduction supports a met
// criterion; a failed check, or a run the integrity window failed, does not.
test('a failed reproduction run supports a met criterion; a failed check does not', () => {
  const evidence = require('../lib/evidence');
  const ctx = tmpProject();
  submitArch(ctx);
  const run = (purpose, command) => `ev:${evidence.runCommand(ctx.store, 'orchestrator', { label: purpose, purpose, command }).id}`;
  const check = run('check', 'node -e "process.exit(1)"');
  const tampered = run('reproduction', `node -e "require('fs').appendFileSync('.eccode/events.jsonl', 'x\\\\n'); process.exit(1)"`);
  const repro = run('reproduction', 'node -e "process.exit(1)"');
  for (const ref of [check, tampered]) {
    expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md', ref]])), 'REVIEW_REJECTED');
  }
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md', repro]]));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
});

test('a review may cite what earlier gates approved, not other files', () => {
  const ctx = tmpProject();
  const { DESIGN_MD } = require('./helpers');
  submitArch(ctx);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  write(ctx.dir, 'notes.md', '# notes\n');
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'design', 'technical-reviewer', approval([['artifact:notes.md']])), 'REVIEW_REJECTED');
  gates.recordReview(ctx.store, ctx.config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md#Components', 'artifact:.eccode/artifacts/brief.md#Requirements']]));
  assert.strictEqual(ctx.store.state().gates.design.status, 'approved');
});

// Multi-file run (s2e2 item 05): a task added an empty tests package
// __init__.py, and its phase gate, which always submits the tasks' changed
// files, was refused; nothing could cover that file at verification either.
test('an empty file a task changed goes into its phase gate; a submission of nothing but empty files is refused', () => {
  const tasks = require('../lib/tasks');
  const { approveThroughPlan, passCheck, handoffFor } = require('./helpers');
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const [id, owner, files] of [['api', 'backend-engineer', ['src/server/app.js', 'src/server/__init__.py']], ['ui', 'frontend-engineer', ['src/web/b.js']], ['tests', 'test-engineer', ['tests/c.test.js']]]) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    for (const f of files) write(ctx.dir, f, f.endsWith('__init__.py') ? '' : `// ${id}\n`);
    const ev = passCheck(ctx.store, owner);
    tasks.complete(ctx.store, ctx.config, id, owner, { ...handoffFor(id, owner, [ev.id], files), testsNotNeeded: 'fixture change, covered by phase checks' });
  }
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  const sub = ctx.store.state().gates['phase:core'].submissions.at(-1);
  assert.ok(sub.artifacts.some((a) => a.path === 'src/server/__init__.py'), 'the empty file is submitted');
  const fresh = tmpProject();
  gates.startGate(fresh.store, fresh.config, 'architecture', 'orchestrator');
  write(fresh.dir, 'brief.md', '');
  expectCode(() => gates.submit(fresh.store, fresh.config, 'architecture', 'product-architect', { artifacts: ['brief.md'] }), 'EMPTY_ARTIFACT');
});

// The delivery run: three engine runs stopped on an approved artifact that a
// project formatter rewrote after approval (Mealie's code generator runs
// `ruff format` on the whole tree; an agent ran `ruff format mealie`). No
// approved gate could be submitted again and only an escalated gate reopens,
// so delivery was refused with no way back but the user.
test('an approved gate whose artifact changed is re-reviewed: its author resubmits the current file and a reviewer approves again', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  const err = expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }), 'INVALID_TRANSITION');
  assert.match(err.message, /approved/, 'an approval whose files are unchanged stands');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD.replace(/\n/g, '\n\n')); // a formatter's rewrite
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', { artifacts: ['.eccode/artifacts/brief.md'] }), 'ROLE_NOT_ALLOWED');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect');
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'submitted', 'not approved until a reviewer approves the new version');
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
  assert.deepStrictEqual(require('../lib/delivery').unreviewedChanges(ctx.store.state(), ctx.dir), []);
});

test('a re-review resubmits every file the approval covered, so a later edit to an unchanged one is still caught', () => {
  // Found by the delivery run's final review: a re-review that named only the
  // changed file dropped the others from the approval, and edits to them went unseen.
  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  write(ctx.dir, '.eccode/artifacts/extra.md', '# Extra\n');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md', '.eccode/artifacts/extra.md'] });
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD.replace(/\n/g, '\n\n')); // a formatter's rewrite
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [path.join(ctx.dir, '.eccode/artifacts/brief.md')] });
  const g = ctx.store.state().gates.architecture;
  assert.deepStrictEqual(g.submissions[g.submissions.length - 1].artifacts.map((a) => a.path).sort(), ['.eccode/artifacts/brief.md', '.eccode/artifacts/extra.md']);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  write(ctx.dir, '.eccode/artifacts/extra.md', '# Extra, edited later\n');
  assert.deepStrictEqual(require('../lib/delivery').unreviewedChanges(ctx.store.state(), ctx.dir).map((c) => `${c.path} ${c.problem}`), ['.eccode/artifacts/extra.md modified after approval']);
});

test('re-reviewing an approved plan gate keeps its tasks and their progress', () => {
  const ctx = tmpProject();
  const { approveThroughPlan } = require('./helpers');
  const tasks = require('../lib/tasks');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  const plan = path.join(ctx.dir, '.eccode/artifacts/plan.json');
  fs.writeFileSync(plan, JSON.stringify(JSON.parse(fs.readFileSync(plan, 'utf8')))); // reformatted, same plan
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  assert.strictEqual(ctx.store.state().tasks.api.status, 'claimed', 'the record\'s tasks are kept, not re-imported');
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved');
});

test('a re-reviewed plan must be the plan the record runs: changed tasks are refused and pointed to a rescope', () => {
  // Found by the delivery run's final review: re-review never re-imports, so an
  // approved plan with other tasks would have been approved but never run.
  const ctx = tmpProject();
  require('./helpers').approveThroughPlan(ctx);
  const file = path.join(ctx.dir, '.eccode/artifacts/plan.json');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  plan.tasks[0].files = [...plan.tasks[0].files, 'src/shared/**']; // a valid plan, with other tasks
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  const err = expectCode(() => gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] }), 'INVALID_PLAN');
  assert.match(err.message, /rescope/);
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved', 'nothing was submitted');
});

test('the audit names the way back for an approved file that changed', () => {
  const ctx = tmpProject();
  submitArch(ctx);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']]));
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD + '\n');
  const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
  assert.match(res.stdout + res.stderr, /\.eccode\/artifacts\/brief\.md modified after approval \(architecture\): its author resubmits architecture with the current file for a fresh review/);
});
