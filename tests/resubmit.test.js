'use strict';
// An author who corrects a file after submitting it, before anyone has reviewed it, must be able to submit
// again. Found in the Groundwork demonstration: the gate was `submitted`, the pinned hash no longer matched
// (so the review was refused) and a resubmission was refused too, and `gate reopen` only applies to escalated
// gates, so the delivery was stuck.
const test = require('node:test');
const assert = require('node:assert');
const gates = require('../lib/gates');
const { tmpProject, write, approval, coverage, expectCode, ARCH_MD } = require('./helpers');

function submitted(ctx) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
}

test('an unreviewed submission can be replaced after the file was corrected; the earlier one stays on record as superseded', () => {
  const ctx = tmpProject();
  submitted(ctx);
  const first = ctx.store.state().gates.architecture.submissions[0];
  write(ctx.dir, '.eccode/artifacts/brief.md', `${ARCH_MD}\nCorrected after submission.\n`);
  // The stale hash still blocks the review of the first submission ...
  const stale = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md']])), 'REVIEW_REJECTED');
  assert.match(stale.message, /changed after submission/);
  // ... and the author can now replace it.
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const g = ctx.store.state().gates.architecture;
  assert.strictEqual(g.submissions.length, 2);
  assert.strictEqual(g.submissions[1].supersedes, first.id);
  assert.strictEqual(g.status, 'submitted');
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', ['artifact:.eccode/artifacts/brief.md#Acceptance Criteria']));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
});

test('only the submitter may replace a submission, and nothing can be replaced once a review exists', () => {
  const ctx = tmpProject({ configOverrides: { roles: { architecture: { authors: ['product-architect', 'technical-designer'], reviewers: ['architecture-reviewer'] } } } });
  submitted(ctx);
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'technical-designer', { artifacts: ['.eccode/artifacts/brief.md'] }), 'OWNERSHIP');
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', ['artifact:.eccode/artifacts/brief.md#Acceptance Criteria']));
  expectCode(() => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }), 'INVALID_TRANSITION');
});
