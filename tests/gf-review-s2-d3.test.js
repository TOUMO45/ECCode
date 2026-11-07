'use strict';
// Regression test for the residual named by the round-3 readiness review of S2 (architecture-reviewer, review
// rev-mw6q3txu-010a6624 on tree 9fd568e): design 16.5 says a closing review's author "is not the closer", and the
// close check did not compare the two. Named D3-1 (node --test --test-name-pattern "^D3-1" ...). It failed before
// its fix.
const test = require('node:test');
const assert = require('node:assert');
const audit = require('../lib/greenfield/audit');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, closeIt, tree, F, LONG, ORCH } = X;

const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);

/** A project whose configuration names the closer (the orchestrator) as a reviewer of one gate. */
function closerIsReviewer() {
  const ctx = closeProject();
  ctx.config.roles.phase.reviewers = [...ctx.config.roles.phase.reviewers, ORCH];
  return ctx;
}

function closingRound(ctx, readinessBy) {
  battery(ctx);
  const c = dispatch(ctx, 'comprehension', 'technical-reviewer');
  const k = dispatch(ctx, 'critique', 'security-reviewer');
  const r = dispatch(ctx, 'readiness', readinessBy);
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: c.id, summary: LONG, findings: [] });
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: k.id, summary: LONG, findings: [] });
  const rv = review(ctx, readinessBy, { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] });
  battery(ctx);
  return rv;
}

test('D3-1: the closer cannot close on a closing-tree review it recorded itself, even when the configuration names it a reviewer', () => {
  const ctx = closerIsReviewer();
  closingRound(ctx, ORCH);
  let err;
  try { closeIt(ctx); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the close succeeded');
  assert.ok(rulesOf(err).includes('GF-CLOSE-1'), rulesOf(err).join(', '));
  assert.match(err.message, /readiness review .* on the closing tree was recorded by orchestrator, the closer/);
});
test('D3-1: the same closure forged with Store.commit is reported by the audit', () => {
  const ctx = closerIsReviewer();
  const rv = closingRound(ctx, ORCH);
  F(ctx, 'gf.slice.closed', ORCH, { scope: 'S2', treeHash: tree(ctx), steps: { comprehension: 'a', critique: 'b', readiness: rv.id }, batteries: [], accepted: [], accounting: { unit: 'all-processed-tokens', start: 1, end: 2 } });
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-CLOSE-1' && /recorded by orchestrator, the closer/.test(e.message)), JSON.stringify(errs.map((e) => e.message)));
});
// The fifth engine battery (round 5) swapped the label of a dispatch problem: a refused new dispatch named "seq Infinity"
// and a forged recorded one lost its seq. No test read the label.
test('a refused new dispatch names no seq; the audit names the seq of a recorded dispatch it reports', () => {
  const ctx = closeProject();
  let err;
  try { X.dispatch(ctx, 'critique', 'security-reviewer', 'S2', ['.eccode/handoffs/h.json']); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  assert.doesNotMatch(err.message, /seq|Infinity/);
  const e = F(ctx, 'gf.dispatch.recorded', ORCH, { id: 'disp-forged', scope: 'S2', role: 'security-reviewer', step: 'critique', treeHash: tree(ctx), inputs: [{ path: '.eccode/handoffs/h.json', sha256: 'a'.repeat(64) }] });
  const errs = audit.run(ctx.store, ctx.config).errors.filter((x) => x.rule === 'GF-CLOSE-5');
  assert.ok(errs.some((x) => x.message.includes(`(seq ${e.event.seq})`)), JSON.stringify(errs.map((x) => x.message)));
});
test('D3-1: with that configuration, a closure whose reviews are all by other roles still closes', () => {
  const ctx = closerIsReviewer();
  closingRound(ctx, 'architecture-reviewer');
  assert.doesNotThrow(() => closeIt(ctx));
});
