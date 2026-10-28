'use strict';
// Red team of the Phase 2 engine: every attempt to cheat the Debugging Lab
// or the behavior diff must be refused, with the refusal reason asserted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const lab = require('../lib/lab');
const behavior = require('../lib/behavior');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const works = require('../lib/works');
const { write, expectCode, handoffFor, tmpProject } = require('./helpers');
const { sha256 } = require('../lib/util');

const BUGGY = 'module.exports = { price: (n) => (n > 10 ? n * 9 : n * 10) };\n';
const FIXED = 'module.exports = { price: (n) => (n >= 10 ? n * 9 : n * 10) };\n';
const BASE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n";
const REGRESSION = "test('bulk discount from 10 items', () => assert.strictEqual(price(10), 90));\n";
const FAILS = 'node -e "process.exit(1)"';
const PASSES = 'node -e "process.exit(0)"';

function claimed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-bypass-'));
  write(dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(dir, 'src/price.js', BUGGY);
  write(dir, 'tests/price.test.js', BASE_TEST);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  require('../lib/quick').start(dir, 'orchestrator', { request: 'An order of 10 items gets no bulk discount', track: 'debug' });
  const store = new Store(dir);
  const config = loadConfig(dir);
  tasks.claim(store, config, 'fix', 'backend-engineer');
  return { dir, store, config };
}

test('bypass: confirming a hypothesis with pasted output instead of an executed command is refused', () => {
  const { dir, store, config } = claimed();
  lab.recordRepro(store, config, 'backend-engineer', { command: FAILS });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  // 1. "Evidence" that is a pinned file (pasted output saved to disk), not a run.
  write(dir, '.eccode/drafts/pasted.txt', '$ node -e ...\n100\n');
  const file = evidence.recordFile(store, 'backend-engineer', { file: '.eccode/drafts/pasted.txt', label: 'pasted output' });
  assert.match(expectCode(() => lab.recordHypothesisEvidence(store, config, 'backend-engineer', { hypothesis: h.id, evidence: file.id, verdict: 'supports' }), 'EVIDENCE_NOT_EXECUTED').message, /is of kind file, not an executed command/);
  // 2. A run executed for nothing in particular (or for another hypothesis), pointed at this one.
  const other = evidence.runCommand(store, 'backend-engineer', { label: 'some check', command: 'node -e "console.log(100)"' });
  assert.match(expectCode(() => lab.recordHypothesisEvidence(store, config, 'backend-engineer', { hypothesis: h.id, evidence: other.id, verdict: 'supports' }), 'EVIDENCE_NOT_EXECUTED').message, /was not run for h1/);
  // 3. A raw event written past the engine, naming evidence that does not exist: the closing gate re-verifies.
  store.commit('hypothesis.evidence', 'backend-engineer', { id: 'he-forged', hypothesis: h.id, evidence: 'ev-nonexistent', verdict: 'supports', command: 'node -e "console.log(100)"', exitCode: 0, logSha256: sha256('100\n') });
  assert.match(expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' }), 'EVIDENCE_REQUIRED').message, /cannot be confirmed from prose/);
  // 4. A raw event naming a real run whose log was then edited to show the wanted value.
  const real = lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'node -e "console.log(90)"', verdict: 'supports' });
  fs.writeFileSync(path.join(dir, store.state().evidence[real.evidence].log), '$ node -e "console.log(90)"\n# cwd: .\n# exit: 0\n100\n');
  assert.match(expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' }), 'EVIDENCE_REQUIRED').message, /cannot be confirmed from prose/);
  assert.strictEqual(store.audit().ok, false, 'and the audit catches the edited log');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: submitting a fix with only refuted (or withdrawn, or open) hypotheses is refused', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test' });
  const h1 = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The price list loads the wrong tier table', ifTrue: 'tier has 11', ifFalse: 'tier has 10' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h1.id, command: PASSES, verdict: 'refutes' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h1.id, status: 'refuted' });
  const h2 = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'A cache survives between calls', ifTrue: 'second call differs', ifFalse: 'calls agree' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h2.id, status: 'withdrawn' });
  lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary uses > where the rule starts at 10', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  write(dir, 'src/price.js', FIXED);
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  const handoff = { ...handoffFor('fix', 'backend-engineer', [ev.id], ['src/price.js', 'tests/price.test.js']), to: 'technical-reviewer' };
  assert.match(expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', handoff), 'INVALID_HANDOFF').message, /lab: no root cause declared[\s\S]*1 hypothesis\(es\) still open/);
  // Declaring the root cause on the refuted one is refused too.
  expectCode(() => lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h1.id, locations: ['src/price.js:1'], explanation: 'The tier table has an off-by-one that the refuted hypothesis named.', whyReproFails: 'price(10) returns 100' }), 'HYPOTHESIS_NOT_CONFIRMED');
  assert.strictEqual(store.state().tasks.fix.status, 'claimed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: changing the repro command between the failing and the passing proof is refused', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test' });
  write(dir, 'src/price.js', FIXED);
  // fix verify on a narrower command that would pass trivially.
  expectCode(() => require('../lib/fixverify').verify(store, 'backend-engineer', { task: 'fix', test: 'node -e "process.exit(0)"' }), 'REPRO_PINNED');
  // The owner cannot re-pin; the orchestrator can, and the record says so.
  expectCode(() => lab.recordRepro(store, config, 'backend-engineer', { command: PASSES, replace: true, reason: 'the owner wants an easier proof' }), 'ROLE_NOT_ALLOWED');
  expectCode(() => lab.recordRepro(store, config, 'orchestrator', { command: PASSES, replace: true, reason: 'a passing command is no reproduction' }), 'REPRO_PASSED');
  // On the fix track: a reproduction pair on another command does not satisfy the pinned reproduction.
  const ctx = tmpProject();
  const { store: s2, config: c2 } = ctx;
  require('../lib/works').abandonWork(s2, 'user', 'start a fix item for this test');
  works.startWork(s2, c2, 'orchestrator', { track: 'fix', title: 'A fix on the fix track' });
  lab.recordRepro(s2, c2, 'backend-engineer', { command: FAILS });
  evidence.runCommand(s2, 'backend-engineer', { label: 'other repro', command: 'node -e "process.exit(3)"', purpose: 'reproduction' });
  evidence.runCommand(s2, 'backend-engineer', { label: 'other pass', command: PASSES });
  const problems = works.checkTrackRules(s2.state(), ctx.dir);
  assert.match(problems.join('\n'), /pinned reproduction "node -e \\"process\.exit\(1\)\\"" has not been recorded passing after the fix/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('bypass: editing an existing test to make the repro pass is refused without a declaration, and the declaration needs the reviewer', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test' });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary uses > where the rule starts at 10', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'node -e "process.exit(require(\'./src/price\').price(10) === 100 ? 0 : 1)"', verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:1'], explanation: 'The condition is n > 10 where the rule starts at 10 items, so the boundary is undiscounted.', whyReproFails: 'price(10) returns 100' });
  // "Fix the test": the existing assertion is rewritten to the buggy value; the code is untouched.
  write(dir, 'tests/price.test.js', BASE_TEST.replace('price(2), 20', 'price(2), 20 /* unchanged */') + REGRESSION.replace('price(10), 90', 'price(10), 100'));
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  assert.strictEqual(ev.status, 'passed', 'the rewritten test passes on the buggy code');
  const handoff = { ...handoffFor('fix', 'backend-engineer', [ev.id], ['tests/price.test.js']), to: 'technical-reviewer' };
  assert.match(expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', handoff), 'INVALID_HANDOFF').message, /tests\/price\.test\.js is a test file that existed before the fix, and the fix changed or removed lines of it/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: leaving a trace probe in the diff is refused at completion and by the track rules', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test' });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary uses > where the rule starts at 10', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: PASSES, verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:1'], explanation: 'The condition is n > 10 where the rule starts at 10 items, so the boundary is undiscounted.', whyReproFails: 'price(10) returns 100' });
  write(dir, 'src/price.js', `process.stderr.write("ECCODE_TRACE x"); // ${lab.PROBE_MARKER} x\n${FIXED}`);
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  const handoff = { ...handoffFor('fix', 'backend-engineer', [ev.id], ['src/price.js', 'tests/price.test.js']), to: 'technical-reviewer' };
  assert.match(expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', handoff), 'INVALID_HANDOFF').message, /trace probe is still in src\/price\.js/);
  assert.match(works.checkTrackRules(store.state(), dir).join('\n'), /trace probe is still in src\/price\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: a behaviour contract declared after seeing the diff is refused; only a reviewer amends', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  works.abandonWork(store, 'user', 'start a feature item for this test');
  works.startWork(store, config, 'orchestrator', { track: 'feature', title: 'Items answer 400' });
  const state = store.state();
  const artifact = '.eccode/behavior/bd-x.json';
  write(dir, artifact, '{}\n');
  store.commit('behavior.routing', 'backend-engineer', { id: 'rt-x', decision: 'run', reasons: ['the change reaches GET /items'], surfaces: [{ kind: 'http', target: 'GET /items' }], changedFiles: [], treeFingerprint: behavior.treeFingerprint(dir, state) });
  store.commit('behavior.diff.result', 'backend-engineer', { id: 'bd-x', base: state.work.baseCommit, head: state.work.baseCommit, treeFingerprint: behavior.treeFingerprint(dir, state), probes: 1, executed: 1, dropped: 0, reached: 1, nondeterministic: [], differences: [{ probe: 'http:GET /items#0', surface: 'http', target: 'GET /items', role: null, input: {}, paths: [{ path: '$.status', baseline: 404, candidate: 400 }], sha256: 'x', classification: 'unexplained', contract: null }], unexplained: 1, expected: 0, coverage: 'ok', coverageNote: null, evidence: [], notes: [], track: 'feature', task: null, artifact, artifactSha256: sha256('{}\n') });
  const entries = [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }];
  assert.match(expectCode(() => behavior.contract(store, config, 'backend-engineer', entries), 'CONTRACT_AFTER_DIFF').message, /declared before the diff runs/);
  assert.match(expectCode(() => behavior.contract(store, config, 'orchestrator', entries), 'CONTRACT_AFTER_DIFF').message, /declared before the diff runs/);
  assert.match(behavior.trackProblems(store.state(), dir).join('\n'), /1 unexplained difference/);
  expectCode(() => behavior.amend(store, config, 'orchestrator', { result: 'bd-x', entries, reason: 'the orchestrator is not a reviewer' }), 'ROLE_NOT_ALLOWED');
  behavior.amend(store, config, 'security-reviewer', { result: 'bd-x', entries, reason: 'the 400 matches the API contract; the reviewer checked the clients' });
  assert.deepStrictEqual(behavior.trackProblems(store.state(), dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: running the diff, then editing code, then delivering is refused as stale', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  works.abandonWork(store, 'user', 'start a fix item for this test');
  works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Clamp accepts strings' });
  write(dir, 'src/a.js', 'module.exports = 1;\n');
  const state = store.state();
  const artifact = '.eccode/behavior/bd-y.json';
  write(dir, artifact, '{}\n');
  store.commit('behavior.routing', 'backend-engineer', { id: 'rt-y', decision: 'run', reasons: ['x'], surfaces: [{ kind: 'function', target: 'src/a.js::x' }], changedFiles: ['src/a.js'], treeFingerprint: behavior.treeFingerprint(dir, state) });
  store.commit('behavior.diff.result', 'backend-engineer', { id: 'bd-y', base: state.work.baseCommit, head: state.work.baseCommit, treeFingerprint: behavior.treeFingerprint(dir, state), probes: 1, executed: 1, dropped: 0, reached: 1, nondeterministic: [], differences: [], unexplained: 0, expected: 0, coverage: 'ok', coverageNote: null, evidence: [], notes: [], track: 'fix', task: null, artifact, artifactSha256: sha256('{}\n') });
  assert.deepStrictEqual(behavior.deliveryProblems(store.state(), dir), []);
  write(dir, 'src/a.js', 'module.exports = 2;\n');
  assert.match(behavior.deliveryProblems(store.state(), dir).join('\n'), /is stale: the tree changed after the diff ran/);
  assert.match(require('../lib/delivery').preconditions(store, 'delivery-lead').problems.join('\n'), /is stale/);
  fs.rmSync(dir, { recursive: true, force: true });
});
