'use strict';
// The debug track: `eccode debug "<bug>"` sets up one task (fix) whose phase
// is the track's only gate. The phase is submitted only after fix verify has
// proven the regression test (it fails on the code before the fix and passes
// with it) and a mutation run on the changed lines is recorded; one
// independent review approves it, and the orchestrator delivers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const { write, expectCode, recordLesson } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

// The bug: an order of 10 or more items gets no bulk discount.
const BUGGY = 'module.exports = { price: (n) => (n > 10 ? n * 9 : n * 10) };\n';
const FIXED = 'module.exports = { price: (n) => (n >= 10 ? n * 9 : n * 10) };\n';
const BASE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n";
const REGRESSION = "test('bulk discount from 10 items', () => assert.strictEqual(price(10), 90));\n";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-debug-'));
  write(dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(dir, 'src/price.js', BUGGY);
  write(dir, 'tests/price.test.js', BASE_TEST);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

const cli = (dir, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir, ECCODE_ACTOR: '' } });
const okIn = (dir) => (args) => {
  const r = cli(dir, args);
  assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

/** Claim, reproduce, fix and complete the task; returns the ok() helper. */
function fixedAndCompleted(dir) {
  const ok = okIn(dir);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  // The Debugging Lab (Phase 2): the reproduction is pinned, a hypothesis is
  // tested with an executed command, and the root cause is declared before the fix.
  const repro = JSON.parse(ok(['debug', 'repro', '--actor', 'backend-engineer', '--task', 'fix', '--json', '--', 'npm', 'test']));
  assert.strictEqual(repro.evidence.status, 'failed', 'the regression test fails before the fix');
  ok(['debug', 'hypothesis', 'add', 'The bulk boundary uses > so exactly 10 items miss the discount', '--if-true', 'price(10) returns 100', '--if-false', 'price(10) returns 90', '--actor', 'backend-engineer']);
  ok(['debug', 'hypothesis', 'test', 'h1', '--supports', '--actor', 'backend-engineer', '--', 'node', '-e', 'process.exit(require("./src/price").price(10) === 100 ? 0 : 1)']);
  ok(['debug', 'hypothesis', 'close', 'h1', '--status', 'confirmed', '--actor', 'backend-engineer']);
  ok(['debug', 'rootcause', '--hypothesis', 'h1', '--at', 'src/price.js:1', '--explain', 'The discount condition is n > 10 where the price list says from 10 items, so the boundary value is priced without the discount.', '--why-repro-fails', 'the regression test prices 10 items and gets 100 instead of 90', '--actor', 'backend-engineer']);
  write(dir, 'src/price.js', FIXED);
  ok(['evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--', 'npm', 'test']);
  const draft = JSON.parse(ok(['handoff', 'draft', '--task', 'fix', '--actor', 'backend-engineer']));
  assert.strictEqual(draft.to, 'technical-reviewer', 'on the debug track the reviewer is next, not a delivery lead');
  assert.match(draft.context, /^TODO: the root cause/);
  draft.context = 'Root cause: the bulk boundary used > where the price list says from 10 items.';
  draft.completedWork = 'The boundary is >= 10; a regression test prices 10 items; fix verify and mutate are recorded.';
  write(dir, '.eccode/drafts/handoff-fix.json', JSON.stringify(draft));
  ok(['task', 'complete', 'fix', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-fix.json']);
  recordLesson(new Store(dir));
  return ok;
}

test('debug sets up one task whose phase is the only gate, and prints the debugging path', () => {
  const dir = repo();
  const out = okIn(dir)(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  const st = new Store(dir).state();
  assert.strictEqual(st.work.track, 'debug');
  assert.deepStrictEqual(st.gateOrder, ['phase:fix'], 'no verification gate on the debug track');
  assert.strictEqual(st.gates['phase:fix'].status, 'in_progress');
  assert.strictEqual(st.tasks.fix.verification.command, 'npm test');
  assert.match(st.tasks.fix.acceptanceCriteria[0], /fails on the code before the fix/);
  for (const step of [/debug repro --actor backend-engineer --task fix/, /debug rootcause --hypothesis h1/, /fix verify --actor backend-engineer --task fix/, /mutate --actor backend-engineer --task fix/, /deliver --actor orchestrator/]) assert.match(out, step);
  assert.doesNotMatch(out, /delivery-lead|security-reviewer/, 'no delivery ceremony');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the phase is refused until fix verify proves the test and a mutation run is recorded; then one review and the orchestrator deliver', () => {
  const dir = repo();
  const ok = fixedAndCompleted(dir);
  let r = cli(dir, ['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no proven fix verification/);
  assert.match(r.stderr, /no mutation run recorded/);
  // A reproduction pair alone (the fix track's rule) is not enough here.
  assert.match(ok(['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']), /PROVEN/);
  r = cli(dir, ['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  assert.notStrictEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /no proven fix verification/);
  assert.match(r.stderr, /no mutation run recorded/);
  ok(['mutate', '--actor', 'backend-engineer', '--task', 'fix', '--test', 'npm test', '--record']);
  assert.match(ok(['status', '--brief']), /gate submit phase:fix --actor backend-engineer/, 'the owner submits a one-task phase');
  ok(['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  const ev = JSON.parse(ok(['evidence', 'run', '--actor', 'technical-reviewer', '--label', 'review', '--gate', 'phase:fix', '--json', '--', 'npm', 'test']));
  const st = new Store(dir).state();
  const criteria = st.tasks.fix.acceptanceCriteria.map((description, i) => ({ id: `C${i + 1}`, description, met: true, evidence: [`ev:${ev.id}`] }));
  write(dir, '.eccode/reviews/drafts/phase-fix.json', JSON.stringify({ decision: 'approve', summary: 'Root cause fixed at the boundary; the regression test is proven and kills the boundary mutant.', criteria, findings: [] }));
  ok(['gate', 'review', 'phase:fix', '--actor', 'technical-reviewer', '--file', '.eccode/reviews/drafts/phase-fix.json']);
  assert.match(ok(['status', '--brief']), /deliver --actor orchestrator/);
  ok(['deliver', '--actor', 'orchestrator']);
  const done = new Store(dir);
  assert.strictEqual(done.state().work.status, 'delivered');
  assert.strictEqual(done.audit().ok, true);
  const report = fs.readFileSync(path.join(dir, '.eccode/delivery/final-handoff.md'), 'utf8');
  assert.match(report, /\*\*Fix proof:\*\* the regression test `npm test` failed on the code before the fix \(ev:\S+, exit [1-9]\d*\) and passed with it/);
  assert.match(report, /\*\*Mutation run on the changed lines\*\* \(ev:\S+\): \d+\/\d+ mutants killed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fix verification that did not prove its test does not satisfy the debug track', () => {
  const dir = repo();
  const ok = okIn(dir);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  // A "regression test" that passes on the buggy code as well: it proves nothing.
  write(dir, 'tests/price.test.js', BASE_TEST + "test('bulk discount', () => assert.strictEqual(price(11), 99));\n");
  write(dir, 'src/price.js', FIXED);
  ok(['evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--', 'npm', 'test']);
  const r = cli(dir, ['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']);
  assert.notStrictEqual(r.status, 0, 'a proof that failed is a refusal');
  assert.match(r.stdout + r.stderr, /NOT PROVEN \(tests-pass-without-fix\)/);
  const state = new Store(dir).state();
  assert.deepStrictEqual(require('../lib/works').provenFixVerifications(state), []);
  assert.match(require('../lib/works').checkTrackRules(state).join('\n'), /no proven fix verification/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('debug: the orchestrator may correct ownership; init and work start need the one task; MCP takes no free-form command', async () => {
  const dir = repo();
  const ok = okIn(dir);
  let r = cli(dir, ['init', '--name', 'shop', '--idea', 'a bug', '--track', 'debug']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /eccode debug/);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator', '--files', 'src/**']);
  ok(['task', 'rescope', 'fix', '--files', 'src/**,tests/**', '--actor', 'orchestrator', '--reason', 'the regression test lives in tests/']);
  assert.deepStrictEqual(new Store(dir).state().tasks.fix.files, ['src/**', 'tests/**']);
  const { store } = require('../lib/project').openProject(dir);
  const { loadConfig } = require('../lib/config');
  require('../lib/works').abandonWork(store, 'user', 'superseded by a reproduction elsewhere');
  expectCode(() => require('../lib/works').startWork(store, loadConfig(dir), 'orchestrator', { track: 'debug', title: 'Another bug here' }), 'INVALID_INPUT');
  const t = require('../lib/mcp').tools().find((x) => x.name === 'debug');
  assert.ok(t, 'debug is served over MCP');
  assert.ok(!('command' in t.schema), 'no free-form command over MCP: it would make the allowlist a shell');
  assert.ok(!('command' in require('../lib/mcp').tools().find((x) => x.name === 'task_rescope').schema), 'nor through rescope');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an inconclusive fix verification (the test calls API the fix adds) is no proof either', () => {
  const dir = repo();
  const ok = okIn(dir);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST.replace("const { price }", "const { price, bulk }") + "test('bulk', () => assert.strictEqual(bulk(10), 90));\n");
  write(dir, 'src/price.js', 'const price = (n) => (n >= 10 ? n * 9 : n * 10);\nmodule.exports = { price, bulk: price };\n');
  const r = cli(dir, ['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']);
  assert.match(r.stdout + r.stderr, /NOT PROVEN \(inconclusive\)/);
  const state = new Store(dir).state();
  assert.ok(Object.values(state.evidence).some((e) => e.fixVerify && e.fixVerify.phase === 'pre-fix' && e.status === 'failed'), 'the pre-fix run failed');
  assert.deepStrictEqual(require('../lib/works').provenFixVerifications(state), [], 'but not as a reproduction: it failed on the missing name');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the debug phase is the last gate: every changed file must be submitted, and --artifact adds to the task\'s files', () => {
  const dir = repo();
  const ok = fixedAndCompleted(dir);
  ok(['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']);
  ok(['mutate', '--actor', 'backend-engineer', '--task', 'fix', '--test', 'npm test', '--record']);
  write(dir, 'docs/notes.md', '# Why the boundary moved\n');
  let r = cli(dir, ['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not covered by any approved gate or by this submission[\s\S]*docs\/notes\.md/);
  ok(['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer', '--artifact', 'docs/notes.md']);
  const sub = new Store(dir).state().gates['phase:fix'].submissions[0];
  assert.deepStrictEqual(sub.artifacts.map((a) => a.path).sort(), ['docs/notes.md', 'src/price.js', 'tests/price.test.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fix that still fails its regression test (fix-fails-tests) is no proof', () => {
  const dir = repo();
  const ok = okIn(dir);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  write(dir, 'src/price.js', 'module.exports = { price: (n) => (n > 11 ? n * 9 : n * 10) };\n'); // changed, still wrong
  const r = cli(dir, ['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']);
  assert.match(r.stdout + r.stderr, /NOT PROVEN \(fix-fails-tests\)/);
  const state = new Store(dir).state();
  assert.ok(Object.values(state.evidence).some((e) => e.fixVerify && e.fixVerify.phase === 'pre-fix' && e.purpose === 'reproduction'), 'the pre-fix run reproduced the bug');
  assert.deepStrictEqual(require('../lib/works').provenFixVerifications(state), [], 'but the fix never passed it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pinned check that cannot pass for an unrelated reason is re-pinned by the orchestrator, after release, and recorded', () => {
  const dir = repo();
  const ok = okIn(dir);
  // A suite with a failure that predates the bug: the pinned command can never pass.
  write(dir, 'tests/legacy.test.js', "const test = require('node:test');\ntest('already broken', () => { throw new Error('unrelated'); });\n");
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'legacy'], { cwd: dir });
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  let r = cli(dir, ['task', 'rescope', 'fix', '--command', 'node --test tests/price.test.js', '--actor', 'orchestrator', '--reason', 'tests/legacy.test.js fails before any change']);
  assert.notStrictEqual(r.status, 0, 'not while claimed');
  assert.match(r.stderr, /release it first/);
  ok(['task', 'fail', 'fix', '--actor', 'orchestrator', '--reason', 'the pinned suite has an unrelated failing test']);
  r = cli(dir, ['task', 'rescope', 'fix', '--command', 'node --test tests/price.test.js', '--actor', 'backend-engineer', '--reason', 'tests/legacy.test.js fails before any change']);
  assert.notStrictEqual(r.status, 0, 'the owner cannot move its own goalposts');
  expectCode(() => require('../lib/tasks').rescope(require('../lib/project').openProject(dir).store, require('../lib/config').loadConfig(dir), 'fix', 'orchestrator', { reason: 'nothing to change here' }), 'INVALID_INPUT');
  ok(['task', 'rescope', 'fix', '--command', 'node --test tests/price.test.js', '--actor', 'orchestrator', '--reason', 'tests/legacy.test.js fails before any change']);
  const t = new Store(dir).state().tasks.fix;
  assert.strictEqual(t.verification.command, 'node --test tests/price.test.js');
  assert.deepStrictEqual(t.files, ['src/**', 'tests/**', 'package.json'], 'files unchanged when only the command is given');
  const h = t.history.find((x) => x.event === 'rescoped');
  assert.strictEqual(h.fromCommand, 'npm test', 'the record keeps what was pinned before, and why it changed');
  assert.match(h.reason, /legacy/);
  // The new pin is what completion now needs.
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  write(dir, 'src/price.js', FIXED);
  ok(['evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--', 'node', '--test', 'tests/price.test.js']);
  const draft = JSON.parse(ok(['handoff', 'draft', '--task', 'fix', '--actor', 'backend-engineer']));
  assert.strictEqual(draft.evidence.length, 1, 'the passing run of the new pinned command is cited');
  fs.rmSync(dir, { recursive: true, force: true });
});
