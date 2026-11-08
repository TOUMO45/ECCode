'use strict';
// Regression tests for the round-1 critique of S2 (review rev-mw6naeuh-013836a5, security-reviewer). Each test is
// named by its finding id, so a fix verification can run one finding's tests alone
// (node --test --test-name-pattern "^R2-1" tests/gf-review-s2.test.js). Each failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const audit = require('../lib/greenfield/audit');
const closure = require('../lib/greenfield/closure');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, resolve, closeIt, threeSteps, forgeProof, put, commitAll, tree, F, LONG, ORCH } = X;

const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refuses(fn, rule, re) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  assert.ok(rulesOf(err).includes(rule), `${rule} not in ${rulesOf(err).join(', ')}: ${err.message}`);
  assert.match(err.message, re);
}
const closeErrs = (ctx) => audit.run(ctx.store, ctx.config).errors.filter((e) => /^GF-CLOSE/.test(e.rule));
function expectAudit(ctx, rule, re) {
  const found = closeErrs(ctx);
  assert.ok(found.some((e) => e.rule === rule && re.test(e.message)), `expected ${rule} /${re.source}/; got ${JSON.stringify(found.map((e) => `${e.rule}: ${e.message.slice(0, 110)}`))}`);
}
/** A battery, then one critique with two blocking findings, on a committed tree. */
function twoFindings() {
  const ctx = closeProject();
  battery(ctx);
  const d = dispatch(ctx, 'critique', 'security-reviewer');
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [
    { id: 'F-1', severity: 'blocking', kind: 'defect', summary: 'a real defect that gets a real fix' },
    { id: 'F-2', severity: 'blocking', kind: 'defect', summary: 'a second defect with no fix of its own' },
  ] });
  return ctx;
}

// ------------------------------------------------------------------ R2-1: one proof resolves one finding
test('R2-1: one fix-verify proof cannot resolve a second finding through resolveFinding', () => {
  const ctx = twoFindings();
  const proof = forgeProof(ctx, 1);
  resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof });
  refuses(() => resolve(ctx, ORCH, { finding: 'F-2', resolution: 'fixed', proof }), 'GF-CLOSE-2', /proof ev:ev-post-1 already resolves finding F-1: one proof proves one finding/);
});
test('R2-1: a second post-fix run citing the same reproduction cannot prove a second finding', () => {
  const ctx = twoFindings();
  const proof = forgeProof(ctx, 2);
  resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof });
  F(ctx, 'evidence.recorded', ORCH, { id: 'ev-post-2b', kind: 'command', label: 'fix-verify: post-fix', command: 'node --test t.js', status: 'passed', purpose: 'check', exitCode: 0, fixVerify: { phase: 'post-fix', base: 'a'.repeat(40), preFix: 'ev-pre-2' } });
  refuses(() => resolve(ctx, ORCH, { finding: 'F-2', resolution: 'fixed', proof: 'ev:ev-post-2b' }), 'GF-CLOSE-2', /reproduction ev:ev-pre-2 already proves finding F-1/);
});
test('R2-1: resolutions forged with one shared proof are GF-CLOSE-2 in the audit, and the slice cannot close on them', () => {
  const ctx = twoFindings();
  const proof = forgeProof(ctx, 3);
  put(ctx, 'fix.js', '//\n'); commitAll(ctx, 'one fix');
  F(ctx, 'gf.finding.resolved', ORCH, { id: 'res-a', finding: 'F-1', resolution: 'fixed', proof });
  F(ctx, 'gf.finding.resolved', ORCH, { id: 'res-b', finding: 'F-2', resolution: 'fixed', proof });
  threeSteps(ctx);
  battery(ctx);
  expectAudit(ctx, 'GF-CLOSE-2', /res-b.*already resolves finding F-1/);
  refuses(() => closeIt(ctx), 'GF-CLOSE-2', /finding F-2 \(blocking\) of review .* is unresolved/);
});
test('R2-1: a paired-run proof of a documentation finding cannot be reused for another', () => {
  const ctx = closeProject();
  const d = dispatch(ctx, 'comprehension', 'technical-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: d.id, summary: LONG, findings: [
    { id: 'D-1', severity: 'minor', kind: 'documentation', summary: 'one undefined term in a section' },
    { id: 'D-2', severity: 'minor', kind: 'documentation', summary: 'another undefined term elsewhere' },
  ] });
  F(ctx, 'evidence.recorded', ORCH, { id: 'pre-d', kind: 'command', label: 'docs', command: 'node --test d.js', status: 'failed', purpose: 'reproduction', exitCode: 1 });
  F(ctx, 'evidence.recorded', ORCH, { id: 'post-d', kind: 'command', label: 'docs', command: 'node --test d.js', status: 'passed', purpose: 'check', exitCode: 0 });
  resolve(ctx, ORCH, { finding: 'D-1', resolution: 'fixed', reproduction: 'ev:pre-d', proof: 'ev:post-d' });
  refuses(() => resolve(ctx, ORCH, { finding: 'D-2', resolution: 'fixed', reproduction: 'ev:pre-d', proof: 'ev:post-d' }), 'GF-CLOSE-2', /already (resolves|proves) finding D-1/);
});
test('R2-1: the closure counts only valid records: a review forged by a non-reviewer does not stand in for a step', () => {
  const ctx = closeProject();
  battery(ctx);
  const c = dispatch(ctx, 'comprehension', 'technical-reviewer');
  const r = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: c.id, summary: LONG, findings: [] });
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] });
  F(ctx, 'gf.dispatch.recorded', ORCH, { id: 'disp-x', scope: 'S2', role: 'security-reviewer', step: 'critique', treeHash: tree(ctx), inputs: [{ path: 'docs/design.md', sha256: 'a'.repeat(64) }] });
  F(ctx, 'gf.review.recorded', 'backend-engineer', { id: 'rev-x', scope: 'S2', step: 'critique', dispatch: 'disp-x', treeHash: tree(ctx), summary: LONG, verdict: 'clean' });
  battery(ctx);
  refuses(() => closeIt(ctx), 'GF-CLOSE-1', /no critique review is recorded on the closing tree/);
});

// ------------------------------------------------------------------ R2-2: a battery is tied to its own run
test('R2-2: a battery forged re-citing another battery\'s evidence is GF-CLOSE-3 and does not count toward two', () => {
  const ctx = closeProject();
  const b1 = battery(ctx);
  threeSteps(ctx);
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-copy', scope: 'S2', round: 2, treeHash: tree(ctx), evidence: b1.evidence, total: 5, killed: 5, survived: 0, survivors: [] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-copy.*already cited by battery/);
  refuses(() => closeIt(ctx), 'GF-CLOSE-3', /1 battery recorded; two are required/);
});
test('R2-2: a battery forged with a survivor list emptier than its evidence is GF-CLOSE-3 (survivors cannot be hidden)', () => {
  const ctx = closeProject();
  battery(ctx);
  threeSteps(ctx);
  F(ctx, 'evidence.recorded', ORCH, { id: 'ev-mut', kind: 'mutation', label: 'mutate', command: 'node -e 0', status: 'recorded', mutation: { score: 0.8, total: 5, killed: 4, survived: 1, invalid: 0, timeouts: 0, base: 'HEAD', survivors: [{ file: 'a.js', line: 3, op: 'flip', from: '<', to: '>=' }] } });
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-hide', scope: 'S2', round: 2, treeHash: tree(ctx), evidence: 'ev:ev-mut', total: 5, killed: 5, survived: 0, survivors: [] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-hide.*does not match its evidence/);
  refuses(() => closeIt(ctx), 'GF-CLOSE-3', /1 battery recorded; two are required/);
});
test('battery 9 (S2.1): a battery forged with the right survivor count but another survivor key is GF-CLOSE-3 (survivors cannot be swapped)', () => {
  const ctx = closeProject();
  battery(ctx);
  threeSteps(ctx);
  F(ctx, 'evidence.recorded', ORCH, { id: 'ev-mut', kind: 'mutation', label: 'mutate', command: 'node -e 0', status: 'recorded', mutation: { score: 0.8, total: 5, killed: 4, survived: 1, invalid: 0, timeouts: 0, base: 'HEAD', survivors: [{ file: 'a.js', line: 3, op: 'flip', from: '<', to: '>=' }] } });
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-swap', scope: 'S2', round: 2, treeHash: tree(ctx), evidence: 'ev:ev-mut', total: 5, killed: 4, survived: 1, survivors: [{ key: 'b.js:9:flip' }] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-swap.*does not match its evidence/);
});
test('R2-2: a battery forged citing a mutation run that is not the event right before it (an old run relabeled for the closing tree) is GF-CLOSE-3', () => {
  const ctx = closeProject();
  battery(ctx);
  F(ctx, 'evidence.recorded', ORCH, { id: 'ev-old', kind: 'mutation', label: 'mutate', command: 'node -e 0', status: 'recorded', mutation: { score: 1, total: 5, killed: 5, survived: 0, invalid: 0, timeouts: 0, base: 'HEAD', survivors: [] } });
  put(ctx, 'later.js', '//\n'); commitAll(ctx, 'later');
  threeSteps(ctx);
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-relabel', scope: 'S2', round: 2, treeHash: tree(ctx), evidence: 'ev:ev-old', total: 5, killed: 5, survived: 0, survivors: [] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-relabel.*not recorded immediately before/);
  refuses(() => closeIt(ctx), 'GF-CLOSE-3', /1 battery recorded; two are required/);
});
test('R2-2: a battery forged on a tree hash that is no tree of the repository is GF-CLOSE-3', () => {
  const ctx = closeProject();
  battery(ctx);
  F(ctx, 'evidence.recorded', ORCH, { id: 'ev-n', kind: 'mutation', label: 'mutate', command: 'node -e 0', status: 'recorded', mutation: { score: 1, total: 5, killed: 5, survived: 0, invalid: 0, timeouts: 0, base: 'HEAD', survivors: [] } });
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-ghost', scope: 'S2', round: 2, treeHash: 'f'.repeat(40), evidence: 'ev:ev-n', total: 5, killed: 5, survived: 0, survivors: [] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-ghost.*is not a tree of this repository/);
});
test('R2-2: a real battery pair still counts (the engine writes the evidence and the battery back to back, matching)', () => {
  const ctx = closeProject();
  X.validClosure(ctx);
  closeIt(ctx);
  assert.deepStrictEqual(closeErrs(ctx), []);
});
void closure;
