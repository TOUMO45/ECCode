'use strict';
// S2, T5: the slice-closure rule, GF-CLOSE-1..5 (owner conditions of 2026-11-07). A slice closes only after an
// independent review of the final tree, in three recorded steps (comprehension, critique, readiness), each its own
// dispatch with declared inputs; every finding reproduced by a fix-verify pair before it is resolved; two batteries,
// the last on the final tree; accounting that is a number or the word "unmeasurable". Table-driven: a valid closure,
// then one change per row. The author's own tests cannot be recorded as a review: only a reviewer role can.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const audit = require('../lib/greenfield/audit');
const closure = require('../lib/greenfield/closure');
const { project } = require('../lib/greenfield/projection');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, resolve, closeIt, threeSteps, validClosure, forgeProof, put, commitAll, tree, F, LONG, ORCH } = X;

const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refuses(fn, rule, re) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  assert.ok(rulesOf(err).includes(rule), `${rule} not in ${rulesOf(err).join(', ')}: ${err.message}`);
  assert.match(err.message, re);
}
const errs = (ctx) => audit.run(ctx.store, ctx.config).errors.filter((e) => /^GF-CLOSE/.test(e.rule));
function expectAudit(ctx, rule, re) {
  const found = errs(ctx);
  assert.ok(found.some((e) => e.rule === rule && re.test(e.message)), `expected ${rule} /${re.source}/; got ${JSON.stringify(found.map((e) => `${e.rule}: ${e.message.slice(0, 110)}`))}`);
}

// ------------------------------------------------------------------ positive
test('GF-CLOSE positive: battery, three steps on the final tree, second battery, accounting: the slice closes and the audit is clean', () => {
  const ctx = closeProject();
  const v = validClosure(ctx);
  const r = closeIt(ctx);
  assert.strictEqual(r.event.type, 'gf.slice.closed');
  assert.strictEqual(r.event.data.treeHash, tree(ctx));
  assert.deepStrictEqual(r.event.data.steps, v.steps);
  assert.deepStrictEqual(r.event.data.batteries, [v.b1.id, v.b2.id]);
  assert.deepStrictEqual(errs(ctx), []);
  assert.strictEqual(project(ctx.store.readEvents()).closures.length, 1);
});
test('GF-CLOSE positive: a critique finding, reproduced then fixed, then a second round on the fixed tree closes', () => {
  const ctx = closeProject();
  battery(ctx);
  const c0 = dispatch(ctx, 'critique', 'security-reviewer');
  const found = review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: c0.id, summary: LONG, findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }] });
  assert.strictEqual(found.verdict, 'findings');
  const proof = forgeProof(ctx, 1);
  put(ctx, 'app_fix.js', '// the fix\n');
  commitAll(ctx, 'fix F-1');
  resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof });
  threeSteps(ctx, { evidence: ['docs/design.md:1'] });
  battery(ctx);
  closeIt(ctx);
  assert.deepStrictEqual(errs(ctx), []);
});
test('GF-CLOSE positive: a finding withdrawn by the reviewer role that raised it, and one deferred by the user (minor, with a limit), do not block', () => {
  const ctx = closeProject();
  battery(ctx);
  const c = dispatch(ctx, 'critique', 'security-reviewer');
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: c.id, summary: LONG, findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'not a defect after all' }, { id: 'F-2', severity: 'minor', kind: 'defect', summary: 'a latent pattern cost' }] });
  resolve(ctx, 'security-reviewer', { finding: 'F-1', resolution: 'withdrawn', reason: 'I re-read the rule: the case is refused three lines earlier' });
  resolve(ctx, 'user', { finding: 'F-2', resolution: 'deferred', limit: 'L-GF-6', reason: 'recorded as a named limit; no user pattern is evaluated in this slice' });
  const k = dispatch(ctx, 'comprehension', 'technical-reviewer');
  const r = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: k.id, summary: LONG, findings: [] });
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/plan.md:1'] });
  battery(ctx);
  closeIt(ctx);
  assert.deepStrictEqual(errs(ctx), []);
});
const ACCOUNTING_OK = [
  [{ unit: 'all-processed-tokens', start: 1000, end: 2500 }],
  [{ unit: 'all-processed-tokens', start: 'unmeasurable', end: 'unmeasurable' }],
  [{ unit: 'all-processed-tokens', start: 0, end: 0 }],
  [{ unit: 'all-processed-tokens', start: 'unmeasurable', end: 4000 }],
];
for (const [accounting] of ACCOUNTING_OK) {
  test(`GF-CLOSE-4 positive: accounting ${JSON.stringify(accounting)} is accepted`, () => {
    const ctx = closeProject(); validClosure(ctx);
    closeIt(ctx, { accounting });
    assert.deepStrictEqual(errs(ctx), []);
  });
}

// ------------------------------------------------------------------ negative: the dispatch (GF-CLOSE-5)
const DISPATCH_ROWS = [
  ['a non-orchestrator', (c) => closure.recordDispatch(c.store, c.config, 'backend-engineer', { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/design.md'] }), /only the orchestrator records a dispatch/],
  ['a role that is not a reviewer', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'backend-engineer', step: 'critique', inputs: ['docs/design.md'] }), /backend-engineer is not a reviewer role/],
  ['an unknown step', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'vibes', inputs: ['docs/design.md'] }), /unknown step vibes/],
  ['no inputs', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: [] }), /lists the artifacts the reviewer receives/],
  ['an input that does not exist', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/nope.md'] }), /docs\/nope\.md is not a regular file in the project/],
  ['an input that is a directory', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs'] }), /docs is not a regular file in the project/],
  ['an input outside the project', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['../x.md'] }), /outside the project or not a relative path/],
  ['the implementers\' drafts', (c) => { put(c, '.eccode/drafts/backend/notes.md', 'n'); return closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['.eccode/drafts/backend/notes.md'] }); }, /working record/],
  ['the handoffs', (c) => { put(c, '.eccode/handoffs/h.json', '{}'); return closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['.eccode/handoffs/h.json'] }); }, /working record/],
  ['the event log', (c) => closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['.eccode/events.jsonl'] }), /working record/],
  ['a dirty tree', (c) => { put(c, 'docs/dirty.md', 'x'); return closure.recordDispatch(c.store, c.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/design.md'] }); }, /the tree is not clean/],
];
for (const [name, fn, re] of DISPATCH_ROWS) {
  test(`GF-CLOSE-5 negative: a dispatch with ${name} is refused and writes nothing`, () => {
    const ctx = closeProject();
    const before = ctx.store.readEvents().length;
    refuses(() => fn(ctx), 'GF-CLOSE-5', re);
    assert.strictEqual(ctx.store.readEvents().length, before);
  });
}

// ------------------------------------------------------------------ negative: recording a review (GF-CLOSE-1)
const RV = (ctx, step = 'critique', role = 'security-reviewer') => ({ ctx, d: dispatch(ctx, step, role), base: { scope: 'S2', step, summary: LONG, findings: [] } });
const REVIEW_ROWS = [
  ['an actor that is not a reviewer role', (c, d, b) => closure.recordReview(c.store, c.config, 'backend-engineer', { ...b, dispatch: d.id }), /backend-engineer is not a reviewer role/],
  ['the orchestrator recording its own review', (c, d, b) => closure.recordReview(c.store, c.config, ORCH, { ...b, dispatch: d.id }), /orchestrator is not a reviewer role/],
  ['a dispatch that is not recorded', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: 'disp-nope' }), /dispatch disp-nope is not recorded/],
  ['another reviewer role than the dispatch was for', (c, d, b) => closure.recordReview(c.store, c.config, 'technical-reviewer', { ...b, dispatch: d.id }), /was recorded for security-reviewer, not technical-reviewer/],
  ['a different step than the dispatch', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, step: 'comprehension', dispatch: d.id }), /is for step critique, not comprehension/],
  ['a dispatch of another scope', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, scope: 'S9', dispatch: d.id }), /belongs to scope S2/],
  ['a dispatch that already carries a review', (c, d, b) => { closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id }); return closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id }); }, /already carries review/],
  ['a tree that moved since the dispatch', (c, d, b) => { put(c, 'late.js', '//'); commitAll(c, 'late'); return closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id }); }, /the tree changed since dispatch/],
  ['a reviewer that authored work (a claim)', (c, d, b) => { F(c, 'task.claimed', 'security-reviewer', { task: 's0-app' }); return closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id }); }, /authored work in this record/],
  ['a summary under 100 characters', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, summary: 'short', dispatch: d.id }), /summary needs 100 characters/],
  ['a critique finding that is a documentation defect', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id, findings: [{ id: 'F-1', severity: 'minor', kind: 'documentation', summary: 'a doc gap in the text' }] }), /a critique finding is a defect/],
  ['a critique verdict that does not match its findings', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id, verdict: 'clean', findings: [{ id: 'F-1', severity: 'minor', kind: 'defect', summary: 'a real defect here' }] }), /verdict clean does not fit/],
  ['a critique with the readiness verdict', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id, verdict: 'go' }), /verdict go does not fit step critique/],
  ['a duplicate finding id', (c, d, b) => closure.recordReview(c.store, c.config, 'security-reviewer', { ...b, dispatch: d.id, findings: [{ id: 'F-1', severity: 'minor', kind: 'defect', summary: 'first finding text' }, { id: 'F-1', severity: 'minor', kind: 'defect', summary: 'second finding text' }] }), /finding id F-1 is repeated/],
];
for (const [name, fn, re] of REVIEW_ROWS) {
  test(`GF-CLOSE-1 negative: recording a review with ${name} is refused and writes nothing for it`, () => {
    const ctx = closeProject();
    const { d, base } = RV(ctx);
    const before = ctx.store.readEvents().filter((e) => e.type === 'gf.review.recorded').length;
    refuses(() => fn(ctx, d, base), 'GF-CLOSE-1', re);
    const after = ctx.store.readEvents().filter((e) => e.type === 'gf.review.recorded').length;
    assert.ok(after <= before + 1, 'at most the one earlier valid review exists');
  });
}
const STEP_ROWS = [
  ['a comprehension finding that is a defect', 'comprehension', { findings: [{ id: 'F-1', severity: 'minor', kind: 'defect', summary: 'defect text here' }] }, /a comprehension finding is a documentation defect/],
  ['a readiness verdict with findings', 'readiness', { verdict: 'go', evidence: ['docs/design.md:1'], findings: [{ id: 'F-1', severity: 'minor', kind: 'defect', summary: 'defect text here' }] }, /a readiness verdict carries no findings/],
  ['a readiness verdict that is neither go nor no-go', 'readiness', { verdict: 'maybe', evidence: ['docs/design.md:1'] }, /readiness is go or no-go/],
  ['a readiness verdict with no evidence', 'readiness', { verdict: 'go', evidence: [] }, /cites evidence/],
  ['a readiness citing a check that is not recorded', 'readiness', { verdict: 'go', evidence: ['ev:nope'] }, /ev:nope is not a recorded check/],
  ['a readiness citing a line past the end of the file', 'readiness', { verdict: 'go', evidence: ['docs/design.md:999'] }, /docs\/design\.md:999 is not a line of that file at this tree/],
  ['a readiness citing a file that is not in the tree', 'readiness', { verdict: 'go', evidence: ['docs/ghost.md:1'] }, /docs\/ghost\.md:1 is not a line of that file at this tree/],
  ['a readiness citing a line zero', 'readiness', { verdict: 'go', evidence: ['docs/design.md:0'] }, /docs\/design\.md:0 is not a line/],
];
for (const [name, step, over, re] of STEP_ROWS) {
  test(`GF-CLOSE-1 negative: ${name} is refused`, () => {
    const ctx = closeProject();
    const d = dispatch(ctx, step, 'security-reviewer');
    refuses(() => closure.recordReview(ctx.store, ctx.config, 'security-reviewer', { scope: 'S2', step, dispatch: d.id, summary: LONG, ...over }), 'GF-CLOSE-1', re);
  });
}
test('a closed scope takes no further dispatch, review, resolution or battery', () => {
  const ctx = closeProject(); validClosure(ctx); closeIt(ctx);
  refuses(() => dispatch(ctx, 'critique'), 'GF-CLOSE-5', /scope S2 is closed/);
  refuses(() => battery(ctx), 'GF-CLOSE-3', /scope S2 is closed/);
  refuses(() => closeIt(ctx), 'GF-CLOSE-1', /scope S2 is already closed/);
});

// ------------------------------------------------------------------ negative: resolving a finding (GF-CLOSE-2)
function raised(severity = 'major') {
  const ctx = closeProject();
  const d = dispatch(ctx, 'critique', 'security-reviewer');
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [{ id: 'F-1', severity, kind: 'defect', summary: 'a forged event is accepted' }] });
  return ctx;
}
const RES_ROWS = [
  ['an unknown finding', (c) => resolve(c, ORCH, { finding: 'F-9', resolution: 'withdrawn', reason: 'x'.repeat(30) }), /finding F-9 is not recorded/],
  ['fixed with no proof', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed' }), /fixed needs a proof/],
  ['a proof that is not a recorded check', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: 'ev:ghost' }), /proof ev:ghost is not a recorded check/],
  ['a proof that is not a post-fix run', (c) => { F(c, 'evidence.recorded', ORCH, { id: 'ev-plain', kind: 'command', label: 'check', command: 'x', status: 'passed', purpose: 'check', exitCode: 0 }); return resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: 'ev:ev-plain' }); }, /is not the post-fix run of a fix verification/],
  ['a post-fix run that failed', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: forgeProof(c, 2, { post: { status: 'failed', exitCode: 1 } }) }), /post-fix run ev:ev-post-2 did not pass/],
  ['a post-fix run that cites no pre-fix run', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: forgeProof(c, 3, { noPre: true, post: { fixVerify: { phase: 'post-fix', base: 'a'.repeat(40) } } }) }), /cites no pre-fix run/],
  ['a pre-fix run that passed', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: forgeProof(c, 4, { pre: { status: 'passed', exitCode: 0 } }) }), /did not fail: the test does not reproduce the finding/],
  ['a pre-fix run that is not a reproduction', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof: forgeProof(c, 5, { pre: { purpose: 'check' } }) }), /is not a reproduction/],
  ['withdrawal by the orchestrator', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'withdrawn', reason: 'x'.repeat(30) }), /only the reviewer role that raised a finding may withdraw it/],
  ['withdrawal by another reviewer role', (c) => resolve(c, 'technical-reviewer', { finding: 'F-1', resolution: 'withdrawn', reason: 'x'.repeat(30) }), /only the reviewer role that raised a finding may withdraw it/],
  ['a withdrawal reason under 30 characters', (c) => resolve(c, 'security-reviewer', { finding: 'F-1', resolution: 'withdrawn', reason: 'short' }), /reason needs 30 characters/],
  ['a deferral by the orchestrator', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'deferred', limit: 'L-GF-6', reason: 'x'.repeat(30) }), /only the user may defer a finding/],
  ['a deferral of a major finding', (c) => resolve(c, 'user', { finding: 'F-1', resolution: 'deferred', limit: 'L-GF-6', reason: 'x'.repeat(30) }), /a blocking or major finding cannot be deferred/],
  ['an unknown resolution', (c) => resolve(c, ORCH, { finding: 'F-1', resolution: 'ignored', reason: 'x'.repeat(30) }), /unknown resolution ignored/],
  ['a second resolution of the same finding', (c) => { resolve(c, 'security-reviewer', { finding: 'F-1', resolution: 'withdrawn', reason: 'x'.repeat(30) }); return resolve(c, 'security-reviewer', { finding: 'F-1', resolution: 'withdrawn', reason: 'y'.repeat(30) }); }, /finding F-1 is already resolved/],
];
for (const [name, fn, re] of RES_ROWS) {
  test(`GF-CLOSE-2 negative: ${name} is refused`, () => {
    const ctx = raised();
    refuses(() => fn(ctx), 'GF-CLOSE-2', re);
  });
}
test('GF-CLOSE-2 negative: a deferral without a limit id, and a deferral of a blocking finding, are refused', () => {
  const ctx = raised('minor');
  refuses(() => resolve(ctx, 'user', { finding: 'F-1', resolution: 'deferred', reason: 'x'.repeat(30) }), 'GF-CLOSE-2', /a deferral names its limit/);
  const blocking = raised('blocking');
  refuses(() => resolve(blocking, 'user', { finding: 'F-1', resolution: 'deferred', limit: 'L-GF-6', reason: 'x'.repeat(30) }), 'GF-CLOSE-2', /cannot be deferred/);
});
test('GF-CLOSE-2 negative: a proof whose reproduction was recorded before the finding was raised is refused', () => {
  const ctx = closeProject();
  const proof = forgeProof(ctx, 6);
  const d = dispatch(ctx, 'critique', 'security-reviewer');
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }] });
  refuses(() => resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof }), 'GF-CLOSE-2', /was recorded before finding F-1/);
});

// ------------------------------------------------------------------ negative: the battery (GF-CLOSE-3)
test('GF-CLOSE-3 negative: only the orchestrator runs a battery, on a clean tree, with a mutant, on a tree that does not move', () => {
  const ctx = closeProject();
  refuses(() => X.withMutation({}, () => closure.runBattery(ctx.store, ctx.config, 'backend-engineer', { scope: 'S2', test: 'node -e 0', base: 'HEAD' })), 'GF-CLOSE-3', /only the orchestrator runs a battery/);
  refuses(() => battery(ctx, 'S2', { total: 0, killed: 0, score: null }), 'GF-CLOSE-3', /ran no mutant/);
  put(ctx, 'dirty.txt', 'x');
  refuses(() => battery(ctx), 'GF-CLOSE-3', /the tree is not clean/);
  fs.rmSync(path.join(ctx.dir, 'dirty.txt'));
  const moved = require('../lib/mutate');
  const original = moved.run;
  moved.run = () => { put(ctx, 'moved.txt', 'x'); commitAll(ctx, 'moved'); return { command: 'x', base: 'HEAD', total: 3, killed: 3, survived: 0, invalid: 0, timeouts: 0, score: 1, survivors: [] }; };
  try { refuses(() => closure.runBattery(ctx.store, ctx.config, ORCH, { scope: 'S2', test: 'node -e 0', base: 'HEAD' }), 'GF-CLOSE-3', /the tree changed while the battery ran/); } finally { moved.run = original; }
});

// ------------------------------------------------------------------ negative: closing
function closureWith(mut) { const ctx = closeProject(); mut(ctx); return ctx; }
const CLOSE_ROWS = [
  ['no battery at all', (c) => threeSteps(c), 'GF-CLOSE-3', /0 batteries recorded; two are required/],
  ['one battery only', (c) => { battery(c); threeSteps(c); }, 'GF-CLOSE-3', /1 battery recorded; two are required/],
  ['a second battery that is not on the final tree', (c) => { battery(c); battery(c); put(c, 'x.js', '//'); commitAll(c, 'x'); threeSteps(c); }, 'GF-CLOSE-3', /the last battery was run on tree/],
  ['a survivor with no accepted reason', (c) => { battery(c); threeSteps(c); battery(c, 'S2', { survived: 1, killed: 4, score: 0.8, survivors: [{ file: 'a.js', line: 3, op: 'flip', from: '<', to: '>=' }] }); }, 'GF-CLOSE-3', /survivor a\.js:3:flip has no accepted reason/],
  ['no comprehension review on the final tree', (c) => { battery(c); const k = dispatch(c, 'critique', 'security-reviewer'); const r = dispatch(c, 'readiness', 'architecture-reviewer'); review(c, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: k.id, summary: LONG, findings: [] }); review(c, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] }); battery(c); }, 'GF-CLOSE-1', /no comprehension review is recorded on the closing tree/],
  ['a readiness verdict of no-go', (c) => { battery(c); threeSteps(c, { readiness: { verdict: 'no-go' } }); battery(c); }, 'GF-CLOSE-1', /the readiness verdict on the closing tree is no-go/],
  ['steps recorded on an earlier tree', (c) => { battery(c); threeSteps(c); put(c, 'later.js', '//'); commitAll(c, 'later'); battery(c); }, 'GF-CLOSE-1', /no comprehension review is recorded on the closing tree/],
  ['an unresolved finding', (c) => { battery(c); const d = dispatch(c, 'critique', 'security-reviewer'); review(c, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }] }); const k = dispatch(c, 'comprehension', 'technical-reviewer'); const r = dispatch(c, 'readiness', 'architecture-reviewer'); review(c, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: k.id, summary: LONG, findings: [] }); review(c, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] }); battery(c); }, 'GF-CLOSE-2', /finding F-1 \(major\) of review .* is unresolved/],
  ['a second battery recorded before the last fix', (c) => { battery(c); const d = dispatch(c, 'critique', 'security-reviewer'); review(c, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }] }); battery(c); const proof = forgeProof(c, 7); resolve(c, ORCH, { finding: 'F-1', resolution: 'fixed', proof }); threeSteps(c); }, 'GF-CLOSE-3', /recorded before the last fix/],
];
for (const [name, mut, rule, re] of CLOSE_ROWS) {
  test(`${rule} negative: closing with ${name} is refused and writes nothing`, () => {
    const ctx = closureWith(mut);
    const before = ctx.store.readEvents().length;
    refuses(() => closeIt(ctx), rule, re);
    assert.strictEqual(ctx.store.readEvents().length, before);
  });
}
const ACCOUNTING_BAD = [
  ['absent', undefined, /accounting is required/],
  ['null', null, /accounting is required/],
  ['a blank start', { unit: 'all-processed-tokens', start: '', end: 5 }, /accounting\.start must be a non-negative integer or "unmeasurable"/],
  ['null for end', { unit: 'all-processed-tokens', start: 1, end: null }, /accounting\.end must be/],
  ['a missing end', { unit: 'all-processed-tokens', start: 1 }, /accounting\.end must be/],
  ['a number as text', { unit: 'all-processed-tokens', start: '12', end: 20 }, /accounting\.start must be/],
  ['a negative number', { unit: 'all-processed-tokens', start: -1, end: 5 }, /accounting\.start must be/],
  ['a fraction', { unit: 'all-processed-tokens', start: 1.5, end: 5 }, /accounting\.start must be/],
  ['the wrong unit', { unit: 'output-tokens', start: 1, end: 2 }, /accounting\.unit must be all-processed-tokens/],
  ['an end below the start', { unit: 'all-processed-tokens', start: 100, end: 50 }, /accounting\.end is below accounting\.start/],
];
for (const [name, accounting, re] of ACCOUNTING_BAD) {
  test(`GF-CLOSE-4 negative: accounting ${name} is refused`, () => {
    const ctx = closeProject(); validClosure(ctx);
    refuses(() => closure.close(ctx.store, ctx.config, ORCH, { scope: 'S2', accounting, accepted: [] }), 'GF-CLOSE-4', re);
  });
}
test('GF-CLOSE negative: closing on a dirty tree, and by a role that is not the orchestrator or the user, is refused', () => {
  const ctx = closeProject(); validClosure(ctx);
  refuses(() => closure.close(ctx.store, ctx.config, 'backend-engineer', { scope: 'S2', accounting: { unit: 'all-processed-tokens', start: 1, end: 2 }, accepted: [] }), 'GF-CLOSE-1', /only the orchestrator or the user closes a slice/);
  put(ctx, 'dirty.txt', 'x');
  refuses(() => closeIt(ctx), 'GF-CLOSE-1', /the tree is not clean/);
});
test('GF-CLOSE-3: a survivor with an accepted reason of 30 characters or more is allowed', () => {
  const ctx = closeProject();
  battery(ctx); threeSteps(ctx);
  battery(ctx, 'S2', { survived: 1, killed: 4, score: 0.8, survivors: [{ file: 'a.js', line: 3, op: 'flip', from: '<', to: '>=' }] });
  refuses(() => closeIt(ctx, { accepted: [{ key: 'a.js:3:flip', reason: 'short' }] }), 'GF-CLOSE-3', /accepted reason/);
  closeIt(ctx, { accepted: [{ key: 'a.js:3:flip', reason: 'equivalent mutant: the comparison is on a value that is never equal' }] });
  assert.deepStrictEqual(errs(ctx), []);
});

// ------------------------------------------------------------------ documentation findings: the paired-run proof
function docRaised() {
  const ctx = closeProject();
  const d = dispatch(ctx, 'comprehension', 'technical-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: d.id, summary: LONG, findings: [{ id: 'D-1', severity: 'minor', kind: 'documentation', summary: 'the closure order is not written down' }] });
  return ctx;
}
const run = (ctx, id, status, purpose, command = 'node --test tests/gf-docs.test.js') => { F(ctx, 'evidence.recorded', ORCH, { id, kind: 'command', label: 'docs check', command, status, purpose, exitCode: status === 'passed' ? 0 : 1 }); return `ev:${id}`; };
test('GF-CLOSE-2 positive: a documentation finding is fixed by a paired run of one command, failed as a reproduction, then passed', () => {
  const ctx = docRaised();
  const pre = run(ctx, 'ev-d-pre', 'failed', 'reproduction');
  const post = run(ctx, 'ev-d-post', 'passed', 'check');
  resolve(ctx, ORCH, { finding: 'D-1', resolution: 'fixed', reproduction: pre, proof: post });
  assert.deepStrictEqual(errs(ctx).filter((e) => e.rule === 'GF-CLOSE-2'), []);
});
const PAIRED_ROWS = [
  ['a reproduction that passed', (c) => ({ reproduction: run(c, 'p1', 'passed', 'reproduction'), proof: run(c, 'q1', 'passed', 'check') }), /must have failed and be recorded with purpose reproduction/],
  ['a reproduction recorded as a check', (c) => ({ reproduction: run(c, 'p2', 'failed', 'check'), proof: run(c, 'q2', 'passed', 'check') }), /purpose reproduction/],
  ['a proof that failed', (c) => ({ reproduction: run(c, 'p3', 'failed', 'reproduction'), proof: run(c, 'q3', 'failed', 'check') }), /did not pass/],
  ['two different commands', (c) => ({ reproduction: run(c, 'p4', 'failed', 'reproduction', 'node --test a.js'), proof: run(c, 'q4', 'passed', 'check', 'node --test b.js') }), /ran different commands/],
  ['a proof recorded before its reproduction', (c) => { const proof = run(c, 'q5', 'passed', 'check'); return { reproduction: run(c, 'p5', 'failed', 'reproduction'), proof }; }, /recorded before its reproduction/],
  ['a reproduction that is not recorded', (c) => ({ reproduction: 'ev:ghost', proof: run(c, 'q6', 'passed', 'check') }), /reproduction ev:ghost is not a recorded check/],
];
for (const [name, mk, re] of PAIRED_ROWS) {
  test(`GF-CLOSE-2 negative: a paired-run proof with ${name} is refused`, () => {
    const ctx = docRaised();
    refuses(() => resolve(ctx, ORCH, { finding: 'D-1', resolution: 'fixed', ...mk(ctx) }), 'GF-CLOSE-2', re);
  });
}
test('GF-CLOSE-2 negative: a paired run recorded before the documentation finding was raised is refused', () => {
  const ctx = closeProject();
  const pre = run(ctx, 'ev-early', 'failed', 'reproduction');
  const d = dispatch(ctx, 'comprehension', 'technical-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: d.id, summary: LONG, findings: [{ id: 'D-1', severity: 'minor', kind: 'documentation', summary: 'the closure order is not written down' }] });
  const post = run(ctx, 'ev-late', 'passed', 'check');
  refuses(() => resolve(ctx, ORCH, { finding: 'D-1', resolution: 'fixed', reproduction: pre, proof: post }), 'GF-CLOSE-2', /was recorded before finding D-1 was raised/);
});
test('GF-CLOSE-2 negative: a defect cannot be proven by a paired run: it needs a fix verification', () => {
  const ctx = raised();
  refuses(() => resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', reproduction: run(ctx, 'p9', 'failed', 'reproduction'), proof: run(ctx, 'q9', 'passed', 'check') }), 'GF-CLOSE-2', /a defect is proven by a fix verification/);
});
test('bypass: a paired-run resolution forged for a defect is GF-CLOSE-2 in the audit', () => {
  const ctx = raised();
  const pre = run(ctx, 'p10', 'failed', 'reproduction');
  const post = run(ctx, 'q10', 'passed', 'check');
  F(ctx, 'gf.finding.resolved', ORCH, { id: 'res-p', finding: 'F-1', resolution: 'fixed', reproduction: pre, proof: post });
  expectAudit(ctx, 'GF-CLOSE-2', /res-p.*a defect is proven by a fix verification/);
});

// ------------------------------------------------------------------ the CLI
const CLI = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const { spawnSync } = require('child_process');
const cli = (ctx, args) => { const r = spawnSync(process.execPath, [CLI, ...args, '--root', ctx.dir, '--json'], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } }); return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) }; };
test('CLI: dispatch, review from a summary file and findings file, status, and a refused close exit 2 with the reasons', () => {
  const ctx = closeProject();
  const d = cli(ctx, ['close', 'dispatch', '--actor', 'orchestrator', '--scope', 'S2', '--role', 'security-reviewer', '--step', 'critique', '--input', 'docs/design.md,docs/plan.md']);
  assert.strictEqual(d.code, 0, d.err);
  const dispatchId = d.json().id;
  const summary = path.join(ctx.dir, '..', `summary-${path.basename(ctx.dir)}.txt`);
  const findings = path.join(ctx.dir, '..', `findings-${path.basename(ctx.dir)}.json`);
  fs.writeFileSync(summary, LONG);
  fs.writeFileSync(findings, JSON.stringify([{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }]));
  const r = cli(ctx, ['close', 'review', '--actor', 'security-reviewer', '--scope', 'S2', '--step', 'critique', '--dispatch', dispatchId, '--summary-file', summary, '--findings', findings]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.json().verdict, 'findings');
  const st = cli(ctx, ['close', 'status', '--scope', 'S2']);
  assert.strictEqual(st.code, 2);
  const p = st.json();
  assert.ok(p.problems.some((x) => /finding F-1 \(major\)/.test(x.message)));
  assert.strictEqual(p.reviews.length, 1);
  const bad = cli(ctx, ['close', 'review', '--actor', 'backend-engineer', '--scope', 'S2', '--step', 'critique', '--dispatch', dispatchId, '--summary-file', summary]);
  assert.strictEqual(bad.code, 2);
  assert.match(bad.err, /GF-CLOSE-1/);
});
test('CLI: a full closure through the command line (battery through the stubbed runner is not possible across processes, so the batteries are recorded in-process, the rest by the CLI)', () => {
  const ctx = closeProject();
  battery(ctx);
  for (const [step, role] of [['comprehension', 'technical-reviewer'], ['critique', 'security-reviewer'], ['readiness', 'architecture-reviewer']]) {
    const d = cli(ctx, ['close', 'dispatch', '--actor', 'orchestrator', '--scope', 'S2', '--role', role, '--step', step, '--input', 'docs/design.md']).json();
    const summary = path.join(ctx.dir, '..', `s-${step}-${path.basename(ctx.dir)}.txt`);
    fs.writeFileSync(summary, LONG);
    const args = ['close', 'review', '--actor', role, '--scope', 'S2', '--step', step, '--dispatch', d.id, '--summary-file', summary];
    if (step === 'readiness') args.push('--verdict', 'go', '--evidence', 'docs/design.md:1');
    const r = cli(ctx, args);
    assert.strictEqual(r.code, 0, r.err);
  }
  battery(ctx);
  const acc = path.join(ctx.dir, '..', `acc-${path.basename(ctx.dir)}.json`);
  fs.writeFileSync(acc, JSON.stringify({ unit: 'all-processed-tokens', start: 'unmeasurable', end: 'unmeasurable' }));
  assert.strictEqual(cli(ctx, ['close', 'status', '--scope', 'S2']).code, 0);
  const done = cli(ctx, ['close', 'slice', '--actor', 'orchestrator', '--scope', 'S2', '--accounting', acc]);
  assert.strictEqual(done.code, 0, done.err);
  assert.deepStrictEqual(errs(ctx), []);
});

// ------------------------------------------------------------------ bypass: forged events judged by the audit
const forge = {
  dispatch: (ctx, over = {}) => F(ctx, 'gf.dispatch.recorded', ORCH, { id: 'disp-f', scope: 'S2', role: 'technical-reviewer', step: 'critique', treeHash: tree(ctx), inputs: [{ path: 'docs/design.md', sha256: 'a'.repeat(64) }], ...over }),
  review: (ctx, actor, over = {}) => F(ctx, 'gf.review.recorded', actor, { id: 'rev-f', scope: 'S2', step: 'critique', dispatch: 'disp-f', treeHash: tree(ctx), summary: LONG, verdict: 'clean', findings: [], ...over }),
};
test('bypass: a review forged by a role that is not a reviewer is GF-CLOSE-1 in the audit', () => {
  const ctx = closeProject();
  forge.dispatch(ctx);
  forge.review(ctx, 'backend-engineer');
  expectAudit(ctx, 'GF-CLOSE-1', /rev-f.*backend-engineer is not a reviewer role/);
});
test('bypass: a review forged against a dispatch for another role, or a missing dispatch, is GF-CLOSE-1', () => {
  const ctx = closeProject();
  forge.dispatch(ctx);
  forge.review(ctx, 'security-reviewer');
  expectAudit(ctx, 'GF-CLOSE-1', /dispatch disp-f was recorded for technical-reviewer, not security-reviewer/);
  forge.review(ctx, 'security-reviewer', { id: 'rev-g', dispatch: 'disp-none' });
  expectAudit(ctx, 'GF-CLOSE-1', /dispatch disp-none is not recorded/);
});
test('bypass: a dispatch forged by a group role is GF-CLOSE-5 in the audit', () => {
  const ctx = closeProject();
  F(ctx, 'gf.dispatch.recorded', 'backend-engineer', { id: 'disp-g', scope: 'S2', role: 'technical-reviewer', step: 'critique', treeHash: tree(ctx), inputs: [{ path: 'docs/design.md', sha256: 'a'.repeat(64) }] });
  expectAudit(ctx, 'GF-CLOSE-5', /disp-g.*recorded by backend-engineer/);
});
test('bypass: a dispatch forged with the implementers\' record as input is GF-CLOSE-5', () => {
  const ctx = closeProject();
  forge.dispatch(ctx, { inputs: [{ path: '.eccode/handoffs/h.json', sha256: 'a'.repeat(64) }] });
  expectAudit(ctx, 'GF-CLOSE-5', /working record/);
});
test('bypass: a review reusing a dispatch that already carries a review is GF-CLOSE-1', () => {
  const ctx = closeProject();
  forge.dispatch(ctx);
  forge.review(ctx, 'technical-reviewer');
  forge.review(ctx, 'technical-reviewer', { id: 'rev-g' });
  expectAudit(ctx, 'GF-CLOSE-1', /dispatch disp-f already carries review rev-f/);
});
test('bypass: a readiness verdict forged with no evidence, and one citing a check that does not exist, are GF-CLOSE-1', () => {
  const ctx = closeProject();
  forge.dispatch(ctx, { step: 'readiness' });
  forge.review(ctx, 'technical-reviewer', { step: 'readiness', verdict: 'go', evidence: [] });
  expectAudit(ctx, 'GF-CLOSE-1', /rev-f.*cites evidence/);
  forge.dispatch(ctx, { id: 'disp-h', step: 'readiness' });
  forge.review(ctx, 'technical-reviewer', { id: 'rev-h', dispatch: 'disp-h', step: 'readiness', verdict: 'go', evidence: ['ev:ghost'] });
  expectAudit(ctx, 'GF-CLOSE-1', /ev:ghost is not a recorded check/);
});
test('bypass: a slice.closed forged citing reviews that do not exist, with no battery and no accounting, is reported on every count', () => {
  const ctx = closeProject();
  F(ctx, 'gf.slice.closed', ORCH, { scope: 'S2', treeHash: tree(ctx), steps: { comprehension: 'rev-a', critique: 'rev-b', readiness: 'rev-c' }, batteries: [], accounting: { unit: 'all-processed-tokens', start: 1, end: 2 }, accepted: [] });
  expectAudit(ctx, 'GF-CLOSE-1', /no comprehension review is recorded on the closing tree/);
  expectAudit(ctx, 'GF-CLOSE-3', /0 batteries recorded; two are required/);
});
test('bypass: a slice.closed forged with blank accounting is malformed (GF-AUD-1) and never counts as a closure', () => {
  const ctx = closeProject();
  F(ctx, 'gf.slice.closed', ORCH, { scope: 'S2', treeHash: tree(ctx), steps: { comprehension: 'a', critique: 'b', readiness: 'c' }, batteries: [], accounting: { unit: 'all-processed-tokens', start: '', end: null }, accepted: [] });
  const all = audit.run(ctx.store, ctx.config).errors;
  assert.ok(all.some((e) => e.rule === 'GF-AUD-1' && /gf\.slice\.closed is malformed/.test(e.message)), JSON.stringify(all.map((e) => e.rule)));
  assert.strictEqual(project(ctx.store.readEvents()).closures.length, 0);
});
test('bypass: a late review forged for a closed scope is GF-CLOSE-1 in the audit', () => {
  const ctx = closeProject(); validClosure(ctx); closeIt(ctx);
  forge.dispatch(ctx, { id: 'disp-late' });
  expectAudit(ctx, 'GF-CLOSE-5', /dispatch disp-late.*scope S2 is closed \(closed at seq \d+\)/);
});
test('bypass: a resolution forged as withdrawn by the orchestrator, and a fixed with no proof, are GF-CLOSE-2 in the audit', () => {
  const ctx = raised();
  F(ctx, 'gf.finding.resolved', ORCH, { id: 'res-1', finding: 'F-1', resolution: 'withdrawn', reason: 'x'.repeat(30) });
  expectAudit(ctx, 'GF-CLOSE-2', /res-1.*only the reviewer role that raised a finding may withdraw it/);
  const c2 = raised();
  F(c2, 'gf.finding.resolved', ORCH, { id: 'res-2', finding: 'F-1', resolution: 'fixed' });
  expectAudit(c2, 'GF-CLOSE-2', /res-2.*fixed needs a proof/);
});
test('bypass: a battery forged citing evidence that does not exist is GF-CLOSE-3 in the audit', () => {
  const ctx = closeProject();
  F(ctx, 'gf.battery.recorded', ORCH, { id: 'bat-f', scope: 'S2', round: 1, treeHash: tree(ctx), evidence: 'ev:ghost', total: 5, killed: 5, survived: 0, survivors: [] });
  expectAudit(ctx, 'GF-CLOSE-3', /bat-f.*ev:ghost is not a recorded mutation run/);
});
test('bypass: a closure that is correct audits clean however it was written (the forgery is the legitimate record)', () => {
  const ctx = closeProject();
  validClosure(ctx);
  closeIt(ctx);
  assert.deepStrictEqual(errs(ctx), []);
});
test('the author\'s own tests cannot be recorded as the independent pass: recordReview refuses every role that is not a reviewer, and a group role forged as reviewer is not independent', () => {
  const ctx = closeProject();
  const d = dispatch(ctx, 'critique', 'technical-reviewer');
  for (const role of ['orchestrator', 'backend-engineer', 'test-engineer', 'integration-engineer', 'user']) {
    refuses(() => closure.recordReview(ctx.store, ctx.config, role, { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [] }), 'GF-CLOSE-1', /is not a reviewer role/);
  }
});
test('closure on a record that is not a Greenfield-Senior project is GF-INIT-1', () => {
  const { tmpProject } = require('./helpers');
  const plain = tmpProject();
  refuses(() => closure.recordDispatch(plain.store, plain.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['x'] }), 'GF-INIT-1', /not a Greenfield-Senior project/);
});
