'use strict';
// Independent review findings F1 and F3 (docs/evidence/review-bundle/ECCode-independent-review.md):
//   F1 - an approval had to cover nothing in particular ("the document has a title") and could cite a
//        section that does not exist. Now every gate derives the criteria an approval must cover, and
//        artifact anchors are checked against the file.
//   F3 - any passing command authorised a completion or a phase approval, whatever the task declared, on
//        whatever tree, and a deleted or rewritten log stayed citable. Now the declared command must have
//        passed on the current tree, and logs are integrity-checked whenever they are cited.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { treeDigest } = require('../lib/project');
const { inspect } = require('../lib/reconcile');
const { Store } = require('../lib/store');
const { sha256 } = require('../lib/util');
const { tmpProject, write, approval, coverage, approveThroughPlan, samplePlan, task, passCheck, handoffFor, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const BRIEF = `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
- R2 rate limit the classifier endpoint
## Acceptance Criteria
- AC1 category returned for every ticket
- AC2 (R2): 429 returned above the configured rate
## Architecture
Single Node service.
## Assumptions
- A1
## Open Questions
- Q1
## Risks
- RISK1
`;
const PASS = 'node -e "process.exit(0)"';
const DECLARED = 'node -e "process.exit(0)" api-check'; // passes, but is not the command passCheck runs

function submitBrief(ctx) {
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, BRIEF_REL, BRIEF);
  return gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
}

function criterion(id, evidenceRefs, description = `${id} holds as written in the brief`) {
  return { id, description, met: true, evidence: evidenceRefs };
}

function review(criteria, extra = {}) {
  return { decision: 'approve', summary: 'Every acceptance criterion was checked against the submitted brief.', criteria, findings: [], ...extra };
}

/** A plan whose api task declares DECLARED; ui and tests keep the helper default. */
function planWithDeclared() {
  const plan = samplePlan();
  plan.tasks[0].verification = { method: 'run the api checks', command: DECLARED };
  return plan;
}

/** Complete every task of the sample phase with its declared command, then submit the phase. */
function finishPhase(ctx, plan = samplePlan()) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const command = plan.tasks.find((t) => t.id === id).verification.command;
    const ev = evidence.runCommand(store, owner, { label: `${id} check`, command });
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  return gates.submit(store, config, 'phase:core', 'delivery-lead');
}

// ---------------------------------------------------------------------------------------------- F1

test('F1 the probe: approving "the document has a title" against a non-existent section is refused', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  const bogus = `artifact:${BRIEF_REL}#this-section-does-not-exist`;
  // The anchor alone, checked the way reviews check it.
  const res = evidence.resolveRef(ctx.store.state(), ctx.dir, bogus, { allowedArtifacts: [BRIEF_REL], validateAnchor: true });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /anchor "#this-section-does-not-exist" not found in .*brief\.md \(headings: .*acceptance criteria/);
  // Without validateAnchor (handoffs and other callers) the reference still resolves as before.
  assert.strictEqual(evidence.resolveRef(ctx.store.state(), ctx.dir, bogus, { allowedArtifacts: [BRIEF_REL] }).ok, true);

  const required = gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'architecture');
  assert.deepStrictEqual(required.map((c) => c.id), ['AC1', 'AC2']);
  assert.match(required[1].description, /429 returned above the configured rate/);
  assert.match(required[0].source, /brief\.md#Acceptance Criteria/);

  const err = expectCode(
    () => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', review([criterion('C1', [bogus], 'The document has a title')])),
    'REVIEW_REJECTED',
  );
  assert.match(err.message, /does not cover the required criteria: AC1, AC2/);
  assert.match(err.message, /eccode gate show architecture/);
  assert.match(err.message, /anchor "#this-section-does-not-exist" not found/);
  const state = ctx.store.state();
  assert.strictEqual(state.gates.architecture.status, 'submitted');
  assert.strictEqual(state.rejectedReviews.length, 1);
});

test('F1 full coverage with real anchors (heading text or slug, any case) is approved', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', review([
    criterion('AC1', [`artifact:${BRIEF_REL}#Acceptance Criteria`]),
    criterion('AC2', [`artifact:${BRIEF_REL}#acceptance-criteria`, `artifact:${BRIEF_REL}#REQUIREMENTS`]),
    criterion('C1', [`artifact:${BRIEF_REL}#Risks`], 'Free-form extra criteria stay allowed'),
  ]));
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
});

test('F1 duplicate criterion ids are refused, whatever the decision', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  const dup = review([criterion('AC1', [`artifact:${BRIEF_REL}#Acceptance Criteria`]), criterion('AC2', [`artifact:${BRIEF_REL}#Acceptance Criteria`]), criterion('AC1', [`artifact:${BRIEF_REL}#Requirements`])]);
  const err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', dup), 'REVIEW_REJECTED');
  assert.match(err.message, /duplicate criterion id\(s\): AC1/);
  const rejected = {
    decision: 'changes_requested',
    summary: 'The rate limit requirement is not testable as written.',
    criteria: [{ id: 'AC2', description: 'rate limit criterion', met: false, evidence: [] }, { id: 'AC2', description: 'again', met: false, evidence: [] }],
    findings: [{ id: 'F1', severity: 'blocking', title: 'AC2 is not testable', detail: 'No rate is configured anywhere in the brief.', recommendation: 'State the configured rate.' }],
  };
  assert.match(expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', rejected), 'REVIEW_REJECTED').message, /duplicate criterion id/);
});

test('F1 ids that look required but are not (AC9, task:nope) are refused as unknown; C1 and security stay free-form', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  const invented = review([criterion('AC1', [`artifact:${BRIEF_REL}#Acceptance Criteria`]), criterion('AC2', [`artifact:${BRIEF_REL}#Acceptance Criteria`]), criterion('AC9', [`artifact:${BRIEF_REL}#Risks`])]);
  const err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', invented), 'REVIEW_REJECTED');
  assert.match(err.message, /unknown criterion id\(s\): AC9/);

  const ctx2 = tmpProject();
  approveThroughPlan(ctx2);
  finishPhase(ctx2);
  const own = passCheck(ctx2.store, 'technical-reviewer');
  const bad = coverage(ctx2, 'phase:core', [`ev:${own.id}`]);
  bad.criteria.push(criterion('task:nope', [`ev:${own.id}`]));
  assert.match(expectCode(() => gates.recordReview(ctx2.store, ctx2.config, 'phase:core', 'technical-reviewer', bad), 'REVIEW_REJECTED').message, /unknown criterion id\(s\): task:nope/);
  const ok = coverage(ctx2, 'phase:core', [`ev:${own.id}`]);
  ok.criteria.push(criterion('security', [`ev:${own.id}`], 'No secret reaches the record'), criterion('C1', [`ev:${own.id}`], 'Error handling is covered'));
  gates.recordReview(ctx2.store, ctx2.config, 'phase:core', 'technical-reviewer', ok);
  assert.strictEqual(ctx2.store.state().gates['phase:core'].status, 'approved');
});

test('F1 the design review must cover every acceptance criterion of the approved brief', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', [`artifact:${BRIEF_REL}#Acceptance Criteria`]));
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/spec.md', require('./helpers').DESIGN_MD);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  assert.deepStrictEqual(gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'design').map((c) => c.id), ['AC1', 'AC2']);
  const err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md#Components']])), 'REVIEW_REJECTED');
  assert.match(err.message, /does not cover the required criteria: AC1, AC2/);
  gates.recordReview(ctx.store, ctx.config, 'design', 'technical-reviewer', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Components']));
  assert.strictEqual(ctx.store.state().gates.design.status, 'approved');
});

test('F1 plan reviews cover phase ids; phase reviews cover task ids; verification covers the acceptance criteria', () => {
  const ctx = tmpProject();
  // approveThroughPlan uses the helper brief (AC1 only).
  approveThroughPlan(ctx);
  assert.deepStrictEqual(gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'plan').map((c) => c.id), ['phase:core']);
  finishPhase(ctx);
  assert.deepStrictEqual(gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'phase:core').map((c) => c.id).sort(), ['phase:core', 'task:api', 'task:tests', 'task:ui']);
  const own = passCheck(ctx.store, 'technical-reviewer');
  const err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', approval([[`ev:${own.id}`, 'artifact:src/server/a.js']])), 'REVIEW_REJECTED');
  assert.match(err.message, /does not cover the required criteria: .*task:api/);
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${own.id}`, 'artifact:src/server/a.js#L1']));
  assert.strictEqual(ctx.store.state().gates['phase:core'].status, 'approved');
  assert.deepStrictEqual(gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, 'verification').map((c) => c.id), ['AC1']);
});

test('F1 anchors in JSON files are dot paths and in other files line ranges', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const state = ctx.store.state();
  const plan = 'artifact:.eccode/artifacts/plan.json';
  const resolve = (ref) => evidence.resolveRef(state, ctx.dir, ref, { validateAnchor: true });
  assert.strictEqual(resolve(`${plan}#phases.0.id`).ok, true);
  assert.strictEqual(resolve(`${plan}#tasks.api.verification`).ok, true, 'array elements can be addressed by their id');
  assert.match(resolve(`${plan}#phases.9`).reason, /anchor "#phases.9" not found in .*plan\.json/);
  write(ctx.dir, 'src/x.js', 'a\nb\nc\n');
  assert.strictEqual(resolve('artifact:src/x.js#L3').ok, true);
  assert.strictEqual(resolve('artifact:src/x.js#L1-L3').ok, true);
  assert.match(resolve('artifact:src/x.js#L4').reason, /anchor "#L4" .*src\/x\.js/);
  assert.match(resolve('artifact:src/x.js#main').reason, /anchor "#main"/);
  assert.strictEqual(resolve('artifact:src/x.js').ok, true, 'a reference without an anchor is unchanged');
});

test('F1 CLI: eccode gate show lists the required criteria with their descriptions', () => {
  const ctx = tmpProject();
  submitBrief(ctx);
  const res = spawnSync(process.execPath, [BIN, 'gate', 'show', 'architecture', '--root', ctx.dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /AC1: category returned for every ticket/);
  assert.match(res.stdout, /AC2: 429 returned above the configured rate/);
  const json = spawnSync(process.execPath, [BIN, 'gate', 'show', 'architecture', '--json', '--root', ctx.dir], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(json.stdout).requiredCriteria.map((c) => c.id), ['AC1', 'AC2']);
  // A brief without ids: coverage cannot be derived, and the output says so instead of listing nothing.
  const ctx2 = tmpProject();
  gates.startGate(ctx2.store, ctx2.config, 'architecture', 'orchestrator');
  write(ctx2.dir, BRIEF_REL, BRIEF.replace('- AC1 category returned for every ticket', '- category returned for every ticket').replace('- AC2 (R2): 429 returned above the configured rate', '- 429 above the rate'));
  gates.submit(ctx2.store, ctx2.config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
  const none = spawnSync(process.execPath, [BIN, 'gate', 'show', 'architecture', '--root', ctx2.dir], { encoding: 'utf8' });
  assert.match(none.stdout, /coverage cannot be checked/i);
});

// ---------------------------------------------------------------------------------------------- F3a

test('F3 completion must cite a passing run of the declared verification command by the actor, after the claim', () => {
  const ctx = tmpProject();
  const plan = planWithDeclared();
  approveThroughPlan(ctx, plan);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  const failing = evidence.runCommand(store, 'backend-engineer', { label: 'declared', command: 'node -e "process.exit(1)"' });
  const unrelated = passCheck(store, 'backend-engineer', 'unrelated');
  const complete = (ids) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));
  let err = expectCode(() => complete([unrelated.id]), 'INVALID_HANDOFF');
  assert.match(err.message, new RegExp(`declared verification command.*${PASS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} api-check`));
  assert.match(err.message, /cited: node -e "process.exit\(0\)" \(passed, by backend-engineer\)/);
  assert.match(err.message, /eccode evidence run --actor backend-engineer --task api/);
  assert.strictEqual(store.state().tasks.api.status, 'claimed');
  // The failing run of the declared command does not help, nor does a run by someone else.
  assert.match(expectCode(() => complete([failing.id, unrelated.id]), 'INVALID_HANDOFF').message, /declared verification command/);
  const byOther = evidence.runCommand(store, 'orchestrator', { label: 'declared, wrong actor', command: DECLARED });
  assert.match(expectCode(() => complete([byOther.id]), 'INVALID_HANDOFF').message, /declared verification command/);
  // The declared command, passing, with incidental whitespace differences, is accepted.
  const ok = evidence.runCommand(store, 'backend-engineer', { label: 'declared', command: 'node   -e "process.exit(0)"  api-check' });
  complete([ok.id, unrelated.id]);
  assert.strictEqual(store.state().tasks.api.status, 'done');
});

test('F3 a task with method-only verification keeps the any-passing-check rule', () => {
  const ctx = tmpProject();
  const plan = samplePlan();
  plan.tasks[0].verification = { method: 'manual inspection of the response shape' };
  approveThroughPlan(ctx, plan);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'any check', command: 'node -e "process.exit(0)" whatever' });
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/app.js']));
  assert.strictEqual(store.state().tasks.api.status, 'done');
});

test('F3 phase approval must cite reviewer runs of every verification command the phase declares', () => {
  const ctx = tmpProject();
  const plan = planWithDeclared();
  approveThroughPlan(ctx, plan);
  const sub = finishPhase(ctx, plan);
  const { store, config } = ctx;
  const onlyPass = passCheck(store, 'technical-reviewer', 'reran the default check');
  let err = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${onlyPass.id}`])), 'REVIEW_REJECTED');
  assert.match(err.message, /every verification command the phase's tasks declare; missing: node -e "process.exit\(0\)" api-check \[api\]/);
  assert.match(err.message, new RegExp(`after submission ${sub.event.data.submissionId}`));
  // Running it is not enough: it has to be cited.
  const declared = evidence.runCommand(store, 'technical-reviewer', { label: 'reran the api check', command: DECLARED });
  err = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${onlyPass.id}`])), 'REVIEW_REJECTED');
  assert.match(err.message, /missing: node -e "process.exit\(0\)" api-check/);
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${onlyPass.id}`, `ev:${declared.id}`]));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
});

test('F3 a check that ran on different bytes than the tree has now is refused at completion and at review', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  const before = passCheck(store, 'backend-engineer');
  assert.strictEqual(before.tree, treeDigest(dir), 'command evidence pins the tree it ran on');
  write(dir, 'src/server/app.js', 'module.exports = 2; // changed after the check\n');
  const complete = (ids) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));
  const err = expectCode(() => complete([before.id]), 'INVALID_HANDOFF');
  assert.match(err.message, new RegExp(`ev:${before.id} ran on different bytes`));
  assert.match(err.message, /run the check again after the last change/);
  const after = passCheck(store, 'backend-engineer');
  complete([after.id]);
  assert.strictEqual(store.state().tasks.api.status, 'done');

  for (const [id, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const reviewerRun = passCheck(store, 'technical-reviewer');
  write(dir, 'scratch.txt', 'an untracked file that appeared after the reviewer ran the checks\n');
  const stale = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${reviewerRun.id}`])), 'REVIEW_REJECTED');
  assert.match(stale.message, new RegExp(`ev:${reviewerRun.id} ran on a different source tree`));
  fs.unlinkSync(path.join(dir, 'scratch.txt'));
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${reviewerRun.id}`]));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
});

test('F3 treeDigest: null without git, stable for the same bytes, blind to the record under .eccode/', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-nogit-'));
  assert.strictEqual(treeDigest(plain), null);
  const ctx = tmpProject();
  const d1 = treeDigest(ctx.dir);
  assert.match(d1, /^[0-9a-f]{64}$/);
  write(ctx.dir, '.eccode/drafts/notes.md', 'scratch\n');
  assert.strictEqual(treeDigest(ctx.dir), d1, 'the record and drafts are not part of the source tree');
  write(ctx.dir, 'src/a.js', '1\n');
  const d2 = treeDigest(ctx.dir);
  assert.notStrictEqual(d2, d1);
  write(ctx.dir, 'src/a.js', '2\n');
  assert.notStrictEqual(treeDigest(ctx.dir), d2);
  fs.unlinkSync(path.join(ctx.dir, 'src/a.js'));
  assert.strictEqual(treeDigest(ctx.dir), d1);
});

// ---------------------------------------------------------------------------------------------- F3b

const ALTERED = '$ node -e "process.exit(1)"\n# cwd: .\n# exit: 1\nFAIL: 3 tests failed\n';

test('F3 a deleted evidence log blocks completion, review and reconciliation', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// api\n');
  const ev = passCheck(store, 'backend-engineer');
  assert.strictEqual(ev.logFileSha256, sha256(fs.readFileSync(path.join(dir, ev.log))));
  fs.rmSync(path.join(dir, ev.log));
  const res = evidence.resolveRef(store.state(), dir, `ev:${ev.id}`);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, new RegExp(`log ${ev.log} was deleted or changed since it was recorded; run the check again \\(eccode evidence run\\)`));
  const err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /was deleted or changed since it was recorded/);
  const fresh = passCheck(store, 'backend-engineer');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [fresh.id], ['src/server/a.js']));
  for (const [id, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const reviewerRun = passCheck(store, 'technical-reviewer');
  fs.rmSync(path.join(dir, reviewerRun.log));
  const rev = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${reviewerRun.id}`])), 'REVIEW_REJECTED');
  assert.match(rev.message, new RegExp(`ev:${reviewerRun.id}.*was deleted or changed`));
  // The log of a check a done task relied on disappears: reconciliation blocks on it.
  fs.rmSync(path.join(dir, fresh.log));
  const issues = inspect(store);
  const tampered = issues.filter((i) => i.kind === 'evidence-tampered');
  assert.strictEqual(tampered.length, 1, JSON.stringify(issues));
  assert.strictEqual(tampered[0].severity, 'blocking');
  assert.strictEqual(tampered[0].evidence, fresh.id);
  assert.match(tampered[0].detail, /task api/);
});

test('F3 an altered evidence log is refused wherever it is cited', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'ui', 'frontend-engineer');
  write(dir, 'src/web/b.js', '// ui\n');
  const ev = passCheck(store, 'frontend-engineer');
  fs.writeFileSync(path.join(dir, ev.log), ALTERED);
  const res = evidence.resolveRef(store.state(), dir, `ev:${ev.id}`);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /was deleted or changed since it was recorded/);
  assert.match(expectCode(() => tasks.complete(store, config, 'ui', 'frontend-engineer', handoffFor('ui', 'frontend-engineer', [ev.id], ['src/web/b.js'])), 'INVALID_HANDOFF').message, /deleted or changed/);
  // The record itself is untouched: only the file on disk was rewritten.
  assert.strictEqual(store.state().evidence[ev.id].status, 'passed');
  assert.strictEqual(store.audit().ok, true);
});

test('F3 records written before logFileSha256 existed are checked against the output digest, header stripped', () => {
  const ctx = tmpProject();
  const { store, dir } = ctx;
  const old = (id, command, output) => {
    const log = `.eccode/evidence/${id}.log`;
    const content = `$ ${command}\n# cwd: .\n# exit: 0\n${output}`;
    write(dir, log, content);
    store.commit('evidence.recorded', 'backend-engineer', { id, kind: 'command', label: 'old-style record', command, cwd: '.', purpose: 'check', exitCode: 0, status: 'passed', timedOut: false, durationMs: 1, log, logSha256: sha256(output), outputTail: output, gate: null, task: null });
    return log;
  };
  const single = old('ev-old00001-01aaaaaa', 'npm test', 'ok 1\nok 2\n');
  assert.strictEqual(evidence.resolveRef(store.state(), dir, 'ev:ev-old00001-01aaaaaa').ok, true);
  // A command spanning lines (the Groundwork record has one): the header is what the record describes, not three lines.
  old('ev-old00002-01bbbbbb', 'node -e \'\nconsole.log(1)\n\'', '1\n');
  assert.strictEqual(evidence.resolveRef(store.state(), dir, 'ev:ev-old00002-01bbbbbb').ok, true);
  fs.appendFileSync(path.join(dir, single), 'ok 3\n');
  const res = evidence.resolveRef(store.state(), dir, 'ev:ev-old00001-01aaaaaa');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /deleted or changed since it was recorded/);
});

test('F3 the shipped records still resolve every command evidence an approved review cited', () => {
  for (const rel of ['examples/groundwork', 'examples/triage-desk']) {
    const root = path.join(__dirname, '..', rel);
    const state = new Store(root).state();
    const refs = new Set();
    const walk = (v) => {
      if (typeof v === 'string') {
        if (v.startsWith('ev:')) refs.add(v);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const gateId of state.gateOrder) {
      const g = state.gates[gateId];
      if (g.status !== 'approved') continue;
      for (const rid of g.reviews) {
        const r = state.reviews[rid];
        if (r.decision === 'approve') walk([r.criteria, r.findings, r.resolvedFindings]);
      }
    }
    const commands = [...refs].filter((ref) => (state.evidence[ref.slice(3)] || {}).kind === 'command');
    assert.ok(commands.length >= 30, `${rel}: ${commands.length} cited command checks`);
    const failed = commands.map((ref) => ({ ref, res: evidence.resolveRef(state, root, ref) })).filter((x) => !x.res.ok);
    assert.deepStrictEqual(failed.map((x) => `${x.ref}: ${x.res.reason}`), []);
  }
});
