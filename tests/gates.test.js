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
  expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'user', 'User accepted narrower scope: no rate limiting in v1', { waive: 'F9' }), 'INVALID_INPUT');
  gates.reopenGate(ctx.store, 'architecture', 'user', 'User accepted narrower scope: no rate limiting in v1');
  // Reopening is not acceptance: without --waive the findings stay open.
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'in_progress');
  assert.deepStrictEqual(ctx.store.state().gates.architecture.openFindings.map((f) => f.id).sort(), ['F1', 'F2']);
});

test('the user can waive named findings (or all) when reopening; the rest stay open', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxReviewIterations: 2 } } });
  submitArch(ctx);
  let { event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejection('F1'));
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD + '\nrev2\n');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId });
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejection('F2'));
  gates.reopenGate(ctx.store, 'architecture', 'user', 'User accepts F1 as a known limitation for v1', { waive: 'F1' });
  const g = ctx.store.state().gates.architecture;
  assert.deepStrictEqual(g.openFindings.map((f) => f.id), ['F2']);
  assert.deepStrictEqual(g.waivedFindings.map((f) => [f.id, f.waivedBy]), [['F1', 'user']]);
});
