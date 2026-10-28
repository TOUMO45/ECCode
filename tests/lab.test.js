'use strict';
// The Debugging Lab (Phase 2): on the debug and fix tracks a fix needs a
// pinned reproduction, hypotheses with predictions, executed evidence, a
// confirmed root cause and a proof on the pinned command. Each gate has its
// allowed path and its refusal here; the bypass attempts are in
// tests/phase2-bypass.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const lab = require('../lib/lab');
const tasks = require('../lib/tasks');
const gates = require('../lib/gates');
const evidence = require('../lib/evidence');
const { write, expectCode, handoffFor, passCheck, approval, recordLesson } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
const BUGGY = 'module.exports = { price: (n) => (n > 10 ? n * 9 : n * 10) };\n';
const FIXED = 'module.exports = { price: (n) => (n >= 10 ? n * 9 : n * 10) };\n';
const BASE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n";
const REGRESSION = "test('bulk discount from 10 items', () => assert.strictEqual(price(10), 90));\n";
const FAILS = 'node -e "process.exit(1)"';
const PASSES = 'node -e "process.exit(0)"';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lab-'));
  write(dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(dir, 'src/price.js', BUGGY);
  write(dir, 'tests/price.test.js', BASE_TEST);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

/** A debug work item with its task claimed; returns {dir, store, config}. */
function claimed() {
  const dir = repo();
  require('../lib/quick').start(dir, 'orchestrator', { request: 'An order of 10 items gets no bulk discount', track: 'debug' });
  const store = new Store(dir);
  const config = loadConfig(dir);
  tasks.claim(store, config, 'fix', 'backend-engineer');
  return { dir, store, config };
}

const cli = (dir, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir, ECCODE_ACTOR: '' } });

test('repro: a failing command is pinned with its artifact and fingerprint; a passing one is refused; a second one needs --replace by the orchestrator', () => {
  const { dir, store, config } = claimed();
  expectCode(() => lab.recordRepro(store, config, 'backend-engineer', { command: PASSES }), 'REPRO_PASSED');
  assert.strictEqual(store.state().lab.repro, null);
  assert.strictEqual(Object.values(store.state().evidence).length, 1, 'the passing run stays in the record as a check');
  const r = lab.recordRepro(store, config, 'backend-engineer', { command: FAILS, task: 'fix' });
  const st = store.state();
  assert.strictEqual(st.lab.repro.id, r.repro.id);
  assert.strictEqual(st.lab.repro.failing, true);
  assert.strictEqual(st.lab.repro.exitCode, 1);
  assert.strictEqual(st.evidence[st.lab.repro.evidence].purpose, 'reproduction', 'the debug track\'s reproduction evidence is reused, not duplicated');
  assert.strictEqual(st.lab.repro.logSha256, st.evidence[st.lab.repro.evidence].logSha256);
  assert.ok(st.lab.repro.fingerprint.node && st.lab.repro.fingerprint.platform && st.lab.repro.fingerprint.gitHead, 'environment fingerprint');
  assert.ok(!JSON.stringify(st.lab.repro.fingerprint).includes(os.userInfo().username), 'no username in the fingerprint');
  expectCode(() => lab.recordRepro(store, config, 'backend-engineer', { command: 'node -e "process.exit(2)"' }), 'REPRO_PINNED');
  expectCode(() => lab.recordRepro(store, config, 'backend-engineer', { command: 'node -e "process.exit(2)"', replace: true, reason: 'the owner cannot replace it' }), 'ROLE_NOT_ALLOWED');
  const r2 = lab.recordRepro(store, config, 'orchestrator', { command: 'node -e "process.exit(2)"', replace: true, reason: 'the first command needed a network the sandbox lacks' });
  assert.strictEqual(store.state().lab.repro.id, r2.repro.id);
  assert.strictEqual(store.state().lab.repro.replaces, r.repro.id);
  assert.strictEqual(store.state().lab.repros.length, 2, 'both stay in the record');
  assert.strictEqual(store.audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hypotheses: falsifiable, tested with executed evidence, closed on it; confirmed from prose is refused', () => {
  const { dir, store, config } = claimed();
  expectCode(() => lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary is wrong somewhere', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' }), 'REPRO_REQUIRED');
  lab.recordRepro(store, config, 'backend-engineer', { command: FAILS });
  expectCode(() => lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary is wrong somewhere', ifTrue: 'same', ifFalse: 'same' }), 'INVALID_INPUT');
  expectCode(() => lab.openHypothesis(store, config, 'technical-reviewer', { statement: 'The boundary is wrong somewhere', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' }), 'ROLE_NOT_ALLOWED');
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  assert.strictEqual(h.id, 'h1');
  // Prose alone: no evidence, no confirmation.
  assert.match(expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: 'h1', status: 'confirmed' }), 'EVIDENCE_REQUIRED').message, /cannot be confirmed from prose/);
  // Evidence recorded as pending, marked after reading the artifact.
  const e = lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: 'h1', command: 'node -e "console.log(require(\'./src/price\').price(10))"' });
  assert.strictEqual(e.verdict, 'pending');
  const ev = store.state().evidence[e.evidence];
  assert.strictEqual(ev.hypothesis, 'h1', 'the run carries the hypothesis it was executed for');
  assert.match(fs.readFileSync(path.join(dir, ev.log), 'utf8'), /\n100\n/, 'the artifact holds the observation');
  assert.match(expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: 'h1', status: 'confirmed' }), 'EVIDENCE_REQUIRED').message, /1 recorded run\(s\) are still unmarked/);
  lab.markEvidence(store, config, 'backend-engineer', { evidence: e.id, verdict: 'supports' });
  expectCode(() => lab.markEvidence(store, config, 'backend-engineer', { evidence: e.id, verdict: 'refutes' }), 'INVALID_TRANSITION'); // marked once
  const closed = lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: 'h1', status: 'confirmed' });
  assert.deepStrictEqual(closed.evidence, [e.id]);
  assert.strictEqual(store.state().lab.hypotheses.h1.status, 'confirmed');
  // A refuted close needs refuting evidence too; a withdrawn one needs none and is kept.
  const h2 = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The price list loads the wrong tier table', ifTrue: 'tier table has 11', ifFalse: 'tier table has 10' });
  expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h2.id, status: 'refuted' }), 'EVIDENCE_REQUIRED');
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h2.id, command: PASSES, verdict: 'refutes' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h2.id, status: 'refuted' });
  const h3 = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'A cached price survives between calls', ifTrue: 'second call differs', ifFalse: 'calls agree' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h3.id, status: 'withdrawn' });
  const st = store.state();
  assert.deepStrictEqual(Object.values(st.lab.hypotheses).map((x) => x.status), ['confirmed', 'refuted', 'withdrawn'], 'refuted and withdrawn hypotheses stay');
  assert.match(lab.show(st), /h2 \[refuted\]/);
  assert.match(lab.reportLines(st).join('\n'), /\| h2 \| refuted \|/);
  assert.strictEqual(store.audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a reviewer may challenge evidence: a challenged supports no longer confirms or grounds a root cause', () => {
  const { dir, store, config } = claimed();
  lab.recordRepro(store, config, 'backend-engineer', { command: FAILS });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  const e = lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: PASSES, verdict: 'supports' });
  expectCode(() => lab.challengeEvidence(store, config, 'backend-engineer', { evidence: e.id, reason: 'the owner cannot challenge its own evidence' }), 'ROLE_NOT_ALLOWED');
  lab.challengeEvidence(store, config, 'technical-reviewer', { evidence: e.id, reason: 'the command exits 0 whatever price(10) returns; it observes nothing' });
  expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' }), 'EVIDENCE_REQUIRED');
  const e2 = lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'node -e "process.exit(require(\'./src/price\').price(10) === 100 ? 0 : 1)"', verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  const rc = lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:1'], explanation: 'The condition is n > 10 where the rule starts at 10 items, so the boundary is undiscounted.', whyReproFails: 'price(10) returns 100 instead of 90' });
  assert.deepStrictEqual(rc.evidence, [e2.id]);
  // A later challenge of the only remaining support invalidates the root cause for completion.
  lab.challengeEvidence(store, config, 'security-reviewer', { evidence: e2.id, reason: 'the probe compares against a hard-coded 100 the reviewer disputes' });
  assert.match(lab.rootCauseProblem(store.state(), dir), /no valid executed supporting evidence/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fix cannot complete without a root cause; with one it completes; the proof must run the pinned command', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test', task: 'fix' });
  write(dir, 'src/price.js', FIXED);
  const verify = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  assert.strictEqual(verify.status, 'passed');
  const handoff = () => ({ ...handoffFor('fix', 'backend-engineer', [verify.id], ['src/price.js', 'tests/price.test.js']), to: 'technical-reviewer' });
  const refused = expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', handoff()), 'INVALID_HANDOFF');
  assert.match(refused.message, /lab: no root cause declared/);
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100 before the fix', ifFalse: 'price(10) is 90 before the fix' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'git show HEAD:src/price.js | grep -c "n > 10"', verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  // The proof is refused on another command while the reproduction is pinned.
  expectCode(() => require('../lib/fixverify').verify(store, 'backend-engineer', { task: 'fix', test: 'node --test tests/price.test.js' }), 'REPRO_PINNED');
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:1'], explanation: 'The condition is n > 10 where the rule starts at 10 items, so the boundary is undiscounted.', whyReproFails: 'the regression test prices 10 items and gets 100' });
  tasks.complete(store, config, 'fix', 'backend-engineer', handoff());
  assert.strictEqual(store.state().tasks.fix.status, 'done');
  const proof = require('../lib/fixverify').verify(store, 'backend-engineer', { task: 'fix' });
  assert.strictEqual(proof.verdict, 'proven', 'the proof defaults to the pinned command');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an existing test\'s lines changed by the fix must be declared, and the reviewer must acknowledge it; an appended test is free', () => {
  const { dir, store, config } = claimed();
  // The regression test is appended (free), and an existing assertion is rewritten (declared).
  write(dir, 'tests/price.test.js', BASE_TEST.replace("test('price', () =>", "test('unit price', () =>") + REGRESSION);
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test', task: 'fix' });
  write(dir, 'src/price.js', FIXED);
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: PASSES, verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:1'], explanation: 'The condition is n > 10 where the rule starts at 10 items, so the boundary is undiscounted.', whyReproFails: 'price(10) returns 100' });
  const verify = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  const base = () => ({ ...handoffFor('fix', 'backend-engineer', [verify.id], ['src/price.js', 'tests/price.test.js']), to: 'technical-reviewer' });
  assert.match(expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', base()), 'INVALID_HANDOFF').message, /tests\/price\.test\.js is a test file that existed before the fix, and the fix changed or removed lines of it/);
  tasks.complete(store, config, 'fix', 'backend-engineer', { ...base(), testChanges: [{ file: 'tests/price.test.js', reason: 'the existing test was renamed from price to unit price; its assertion is unchanged' }] });
  assert.strictEqual(require('../lib/fixverify').verify(store, 'backend-engineer', { task: 'fix' }).verdict, 'proven');
  require('../lib/mutate').record(store, 'backend-engineer', { command: 'npm test', base: 'HEAD', score: 1, total: 1, killed: 1, survived: 0, invalid: 0, timeouts: 0, survivors: [] }, { task: 'fix' });
  recordLesson(store);
  gates.submit(store, config, 'phase:fix', 'backend-engineer');
  const ev = passCheck(store, 'technical-reviewer');
  const review = approval([[`ev:${ev.id}`]]);
  assert.match(expectCode(() => gates.recordReview(store, config, 'phase:fix', 'technical-reviewer', review), 'REVIEW_REJECTED').message, /declared a change to the test file or infrastructure tests\/price\.test\.js; approval must acknowledge it/);
  gates.recordReview(store, config, 'phase:fix', 'technical-reviewer', { ...review, acknowledgedTestChanges: [{ file: 'tests/price.test.js', verdict: 'legitimate', reason: 'the assertion change keeps the same expected price; the fix is in src/price.js' }] });
  assert.strictEqual(store.state().gates['phase:fix'].status, 'approved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('budget: after five refuted hypotheses (configurable) a new one is refused until an escalation is recorded; time counts too', () => {
  const { dir, store } = claimed();
  const file = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.lab = { hypothesisBudget: 2, timeBudgetMinutes: 60 };
  fs.writeFileSync(file, JSON.stringify(cfg));
  const config = loadConfig(dir);
  lab.recordRepro(store, config, 'backend-engineer', { command: FAILS });
  for (let i = 1; i <= 2; i++) {
    const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: `Candidate cause number ${i} of the discount miss`, ifTrue: 'observation A', ifFalse: 'observation B' });
    lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: PASSES, verdict: 'refutes' });
    lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'refuted' });
  }
  const over = expectCode(() => lab.openHypothesis(store, config, 'backend-engineer', { statement: 'Candidate cause number 3 of the discount miss', ifTrue: 'observation A', ifFalse: 'observation B' }), 'LAB_BUDGET');
  assert.match(over.message, /2 hypotheses refuted or withdrawn \(budget 2\)/);
  assert.strictEqual(over.details.refuted.length, 2, 'the refusal lists the refuted hypotheses');
  expectCode(() => lab.escalate(store, config, 'technical-reviewer', { kind: 'rescope', reason: 'reviewers do not escalate the investigation' }), 'ROLE_NOT_ALLOWED');
  const esc = lab.escalate(store, config, 'orchestrator', { kind: 'ask-user', reason: 'two likely causes refuted; ask which price list the report used' });
  assert.strictEqual(esc.refuted, 2);
  lab.openHypothesis(store, config, 'backend-engineer', { statement: 'Candidate cause number 3 of the discount miss', ifTrue: 'observation A', ifFalse: 'observation B' });
  // Time budget: the clock is pinned past the budget since the escalation.
  const later = new Date(Date.now() + 61 * 60000).toISOString();
  process.env.ECCODE_NOW = later;
  try {
    assert.match(expectCode(() => lab.openHypothesis(store, config, 'backend-engineer', { statement: 'Candidate cause number 4 of the discount miss', ifTrue: 'observation A', ifFalse: 'observation B' }), 'LAB_BUDGET').message, /minutes since the last escalation \(budget 60\)/);
  } finally {
    delete process.env.ECCODE_NOW;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trace: a probe logs the expression during the reproduction, is recorded as evidence with the values, and is reverted; a leftover probe is refused', () => {
  const { dir, store, config } = claimed();
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  write(dir, 'src/price.js', 'function price(n) {\n  const bulk = n > 10;\n  return bulk ? n * 9 : n * 10;\n}\nmodule.exports = { price };\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'multi-line'], { cwd: dir });
  const before = fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8');
  lab.recordRepro(store, config, 'backend-engineer', { command: 'npm test' });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'bulk is false for n = 10', ifTrue: 'the trace shows bulk=false at n=10', ifFalse: 'the trace shows bulk=true at n=10' });
  const t = lab.trace(store, config, 'backend-engineer', { hypothesis: h.id, at: 'src/price.js:3', expr: '{ n, bulk }' });
  assert.ok(t.values.some((v) => v.includes('"n":10') && v.includes('"bulk":false')), `observed ${JSON.stringify(t.values)}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8'), before, 'the probe was reverted');
  assert.ok(!fs.existsSync(path.join(dir, '.eccode/cache/trace-restore.json')));
  const e = store.state().lab.evidence[t.id];
  assert.strictEqual(e.verdict, 'pending');
  assert.deepStrictEqual(e.trace.file, 'src/price.js');
  lab.markEvidence(store, config, 'backend-engineer', { evidence: t.id, verdict: 'supports' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  // A probe written by hand (the marker left in a changed file) blocks completion and the gate.
  write(dir, 'src/price.js', before.replace('const bulk = n >= 10;', 'const bulk = n >= 10;').replace('const bulk = n > 10;', `  process.stderr.write("x"); // ${lab.PROBE_MARKER} manual\n  const bulk = n >= 10;`));
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['src/price.js:2'], explanation: 'bulk is computed with > so the boundary value is not bulk; the rule starts at 10.', whyReproFails: 'price(10) is 100' });
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: 'npm test', task: 'fix' });
  assert.match(expectCode(() => tasks.complete(store, config, 'fix', 'backend-engineer', { ...handoffFor('fix', 'backend-engineer', [ev.id], ['src/price.js', 'tests/price.test.js']), to: 'technical-reviewer' }), 'INVALID_HANDOFF').message, /trace probe is still in src\/price\.js/);
  assert.match(lab.trackProblems(store.state(), dir).join('\n'), /trace probe is still in src\/price\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: the Lab path through eccode debug, and the handoff report carries it', () => {
  const dir = repo();
  const ok = (args) => {
    const r = cli(dir, args);
    assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  let r = cli(dir, ['debug', 'repro', '--actor', 'backend-engineer', '--task', 'fix', '--', 'node', '-e', 'process.exit(0)']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /REPRO_PASSED/);
  assert.match(ok(['debug', 'repro', '--actor', 'backend-engineer', '--task', 'fix', '--', 'npm', 'test']), /Reproduction pinned: rp-\S+ — npm test failed with exit 1/);
  assert.match(ok(['debug', 'hypothesis', 'add', 'The bulk boundary uses > so exactly 10 items miss the discount', '--if-true', 'price(10) returns 100', '--if-false', 'price(10) returns 90', '--actor', 'backend-engineer']), /Hypothesis h1 opened/);
  const t = ok(['debug', 'hypothesis', 'test', 'h1', '--actor', 'backend-engineer', '--', 'node', '-e', 'console.log(require("./src/price").price(10))']);
  assert.match(t, /verdict pending/);
  const heId = /Evidence (he-\S+) for h1/.exec(t)[1];
  r = cli(dir, ['debug', 'hypothesis', 'close', 'h1', '--status', 'confirmed', '--actor', 'backend-engineer']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /EVIDENCE_REQUIRED/);
  ok(['debug', 'hypothesis', 'mark', heId, '--supports', '--actor', 'backend-engineer']);
  ok(['debug', 'hypothesis', 'close', 'h1', '--status', 'confirmed', '--actor', 'backend-engineer']);
  ok(['debug', 'rootcause', '--hypothesis', 'h1', '--at', 'src/price.js:1', '--explain', 'The discount condition is n > 10 where the price list says from 10 items, so the boundary value is priced without the discount.', '--why-repro-fails', 'the regression test prices 10 items and gets 100 instead of 90', '--actor', 'backend-engineer']);
  assert.match(ok(['debug', 'show']), /h1 \[confirmed\][\s\S]*Root cause: h1 at src\/price\.js:1/);
  write(dir, 'src/price.js', FIXED);
  ok(['evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--', 'npm', 'test']);
  r = cli(dir, ['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix', '--test', 'node --test tests/price.test.js']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /REPRO_PINNED/);
  assert.match(ok(['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']), /PROVEN/);
  ok(['mutate', '--actor', 'backend-engineer', '--task', 'fix', '--test', 'npm test', '--record']);
  const draft = JSON.parse(ok(['handoff', 'draft', '--task', 'fix', '--actor', 'backend-engineer']));
  draft.context = 'Root cause: the bulk boundary used > where the price list says from 10 items.';
  draft.completedWork = 'The boundary is >= 10; a regression test prices 10 items; fix verify and mutate are recorded.';
  write(dir, '.eccode/drafts/handoff-fix.json', JSON.stringify(draft));
  ok(['task', 'complete', 'fix', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-fix.json']);
  recordLesson(new Store(dir));
  ok(['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  const ev = JSON.parse(ok(['evidence', 'run', '--actor', 'technical-reviewer', '--label', 'review', '--gate', 'phase:fix', '--json', '--', 'npm', 'test']));
  const st = new Store(dir).state();
  write(dir, '.eccode/reviews/drafts/phase-fix.json', JSON.stringify({ decision: 'approve', summary: 'Root cause confirmed by executed evidence; the proof runs the pinned reproduction.', criteria: st.tasks.fix.acceptanceCriteria.map((description, i) => ({ id: `C${i + 1}`, description, met: true, evidence: [`ev:${ev.id}`] })), findings: [] }));
  ok(['gate', 'review', 'phase:fix', '--actor', 'technical-reviewer', '--file', '.eccode/reviews/drafts/phase-fix.json']);
  ok(['deliver', '--actor', 'orchestrator']);
  const report = fs.readFileSync(path.join(dir, '.eccode/delivery/final-handoff.md'), 'utf8');
  assert.match(report, /## Debugging Lab/);
  assert.match(report, /\*\*Reproduction \(pinned\):\*\* `npm test` failed with exit 1/);
  assert.match(report, /\| h1 \| confirmed \|/);
  assert.match(report, /\*\*Root cause \(h1, declared by backend-engineer\)/);
  assert.match(report, /\*\*Fix proof:\*\*/);
  assert.strictEqual(new Store(dir).audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit: a tampered Lab artifact or evidence log fails the audit', () => {
  const { dir, store, config } = claimed();
  lab.recordRepro(store, config, 'backend-engineer', { command: FAILS });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The bulk boundary uses > so 10 items miss the discount', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  const e = lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'node -e "console.log(100)"', verdict: 'supports' });
  assert.strictEqual(store.audit().ok, true);
  const log = path.join(dir, store.state().evidence[e.evidence].log);
  fs.appendFileSync(log, '90\n');
  const a = store.audit();
  assert.strictEqual(a.ok, false);
  assert.match(a.errors.join('\n'), /differs from its recorded hash/);
  // And the tampered evidence no longer supports the hypothesis.
  assert.match(expectCode(() => lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' }), 'EVIDENCE_REQUIRED').message, /cannot be confirmed from prose/);
  fs.rmSync(dir, { recursive: true, force: true });
});
