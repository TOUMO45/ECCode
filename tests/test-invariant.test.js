'use strict';
// The test-outcome invariant (Phase 2, follow-up): on the debug and fix tracks
// the pinned command's per-test outcomes are recorded on the claim base, and
// completion refuses a passing test that is now missing, skipped, xfailed or
// failing, unless declared and acknowledged by the reviewer. Test
// infrastructure (conftest, pytest configuration, fixtures) is under the
// test-edit gate, and a test that patches the fixed module is refused.
// Needs the fixture interpreter (ECCODE_PYTHON); skips otherwise, fails under
// ECCODE_REQUIRE_PHASE2=1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { materialize, python } = require('./fixtures/phase2/build');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const lab = require('../lib/lab');
const tasks = require('../lib/tasks');
const gates = require('../lib/gates');
const evidence = require('../lib/evidence');
const { write, expectCode, handoffFor, passCheck, approval } = require('./helpers');

const py = python();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE2 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
if (py.python) process.env.ECCODE_PYTHON = py.python;
const PY = py.python;
const PINNED = () => `${PY} -m pytest tests -q -p no:cacheprovider -W ignore`;

/** The fixture on the debug track, claimed: the baseline is recorded at the claim. */
function claimedDebug() {
  const { dir } = materialize();
  require('../lib/quick').start(dir, 'orchestrator', { request: 'The discount starts above 10 instead of at 10', track: 'debug', command: PINNED() });
  const store = new Store(dir);
  const config = loadConfig(dir);
  tasks.claim(store, config, 'fix', 'backend-engineer');
  return { dir, store, config };
}

/** Pin a reproduction, confirm a hypothesis and declare the root cause so completion reaches the test rules. */
function rootCause(store, config, dir, command) {
  if (!store.state().lab.repro) lab.recordRepro(store, config, 'backend-engineer', { command, task: 'fix' });
  const h = lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The discount boundary excludes ten units', ifTrue: 'bulk_discount(10) is 0.0', ifFalse: 'bulk_discount(10) is 0.1' });
  lab.testHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, command: 'node -e "process.exit(0)"', verdict: 'supports', task: 'fix' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: h.id, status: 'confirmed' });
  lab.declareRootCause(store, config, 'backend-engineer', { hypothesis: h.id, locations: ['shop/pricing.py:8'], explanation: 'bulk_discount compares with > where the rule starts at 10 units, so ten units get no discount.', whyReproFails: 'the regression test asks for bulk_discount(10) and gets 0.0' });
}

function completeWith(store, config, dir, extra = {}) {
  const verify = evidence.runCommand(store, 'backend-engineer', { label: 'verify', command: PINNED(), task: 'fix' });
  const changed = require('../lib/project').gitChangedFiles(dir, store.state().tasks.fix.claim.baseCommit).filter((f) => !f.startsWith('.eccode/'));
  return () => tasks.complete(store, config, 'fix', 'backend-engineer', { ...handoffFor('fix', 'backend-engineer', [verify.id], changed), to: 'technical-reviewer', ...extra });
}

test('the claim records the per-test baseline on the claim base; an intact run completes; a lost, skipped or failing test is refused until declared and acknowledged', { skip }, () => {
  const { dir, store, config } = claimedDebug();
  const t = store.state().tasks.fix;
  assert.strictEqual(t.testsBaseline.status, 'recorded');
  assert.strictEqual(t.testsBaseline.collected, 15);
  assert.strictEqual(t.testsBaseline.passed, 15);
  assert.strictEqual(t.testsBaseline.outcomes['tests.test_pricing::test_no_discount_below_ten'], 'passed');
  assert.ok(fs.existsSync(path.join(dir, t.testsBaseline.artifact)), 'the outcomes are an artifact');
  assert.strictEqual(store.audit().ok, true);
  // The bug is seeded now (as if it were the code under repair), with a regression test appended.
  write(dir, 'shop/pricing.py', fs.readFileSync(path.join(dir, 'shop/pricing.py'), 'utf8').replace('    if quantity >= 10:\n', '    if quantity > 10:\n'));
  write(dir, 'tests/test_regression.py', 'from shop.pricing import bulk_discount\n\n\ndef test_discount_starts_at_ten():\n    assert bulk_discount(10) == 0.1\n');
  rootCause(store, config, dir, `${PY} -m pytest tests/test_regression.py -q -p no:cacheprovider`);
  // The "fix" skips the two tests that now fail, through conftest (the regression test and the order total).
  write(dir, 'tests/conftest.py', fs.readFileSync(path.join(dir, 'tests/conftest.py'), 'utf8') + '\n\ndef pytest_collection_modifyitems(items):\n    for item in items:\n        if item.name in ("test_order_total", "test_discount_starts_at_ten"):\n            item.add_marker(pytest.mark.skip(reason="flaky"))\n');
  const refused = expectCode(completeWith(store, config, dir), 'INVALID_HANDOFF');
  assert.match(refused.message, /tests\/conftest\.py is test infrastructure/);
  assert.match(refused.message, /1 test\(s\) that passed on the baseline[\s\S]*tests\.test_api::test_order_total is skipped/);
  // Declaring both, the owner completes; the reviewer must acknowledge both, by file and by test.
  const declared = { testChanges: [{ file: 'tests/conftest.py', reason: 'the order-total test is marked flaky while the fixture data is reworked' }, { test: 'tests.test_api::test_order_total', reason: 'skipped with the conftest marker above, pending fixture data' }] };
  completeWith(store, config, dir, declared)();
  require('../lib/mutate').record(store, 'backend-engineer', { command: PINNED(), base: 'HEAD', score: 1, total: 1, killed: 1, survived: 0, invalid: 0, timeouts: 0, survivors: [] }, { task: 'fix' });
  require('./helpers').recordLesson(store);
  // fix verify on the pinned repro: the regression test is skipped by conftest, so it cannot prove anything here;
  // the track rule for the proof is covered elsewhere. Submit the phase for the review rule.
  const fv = require('../lib/fixverify').verify(store, 'backend-engineer', { task: 'fix' });
  assert.notStrictEqual(fv.verdict, 'proven', 'a skipped regression test proves nothing (fix verify)');
  // The review acknowledgement rule, checked directly on the state (the phase cannot be submitted without a proof).
  const review = approval([['ev:x']]);
  const problems = lab.reviewProblems({ ...store.state(), tasks: Object.fromEntries(Object.entries(store.state().tasks).map(([k, v]) => [k, { ...v, status: 'done' }])) }, 'phase:fix', review);
  assert.strictEqual(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /tests\/conftest\.py/);
  assert.match(problems[1], /tests\.test_api::test_order_total \(passed on the baseline/);
  const acked = { ...review, acknowledgedTestChanges: [{ file: 'tests/conftest.py', verdict: 'legitimate', reason: 'checked: the marker names the two tests and the fixture rework is tracked' }, { test: 'tests.test_api::test_order_total', verdict: 'legitimate', reason: 'the order fixture needs new data; tracked' }] };
  assert.deepStrictEqual(lab.reviewProblems({ ...store.state(), tasks: Object.fromEntries(Object.entries(store.state().tasks).map(([k, v]) => [k, { ...v, status: 'done' }])) }, 'phase:fix', acked), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: deselecting a test through pytest configuration is refused (missing from the run, and the config is infrastructure)', { skip }, () => {
  const { dir, store, config } = claimedDebug();
  write(dir, 'shop/pricing.py', fs.readFileSync(path.join(dir, 'shop/pricing.py'), 'utf8').replace('    if quantity >= 10:\n', '    if quantity > 10:\n'));
  write(dir, 'tests/test_regression.py', 'from shop.pricing import bulk_discount\n\n\ndef test_discount_starts_at_ten():\n    assert bulk_discount(10) == 0.1\n');
  rootCause(store, config, dir, `${PY} -m pytest tests/test_regression.py -q -p no:cacheprovider`);
  // "Fix": deselect the two failing tests in pyproject's pytest options, and leave the code wrong.
  write(dir, 'pyproject.toml', fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8').replace('addopts = "-q -p no:cacheprovider"', 'addopts = "-q -p no:cacheprovider --deselect tests/test_api.py::test_order_total --deselect tests/test_regression.py::test_discount_starts_at_ten"'));
  const refused = expectCode(completeWith(store, config, dir), 'INVALID_HANDOFF');
  assert.match(refused.message, /pyproject\.toml is test infrastructure/);
  assert.match(refused.message, /tests\.test_api::test_order_total is missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bypass: a new test file that monkeypatches the fixed module is refused; so is a hidden skip of a baseline test', { skip }, () => {
  const { dir, store, config } = claimedDebug();
  write(dir, 'shop/pricing.py', fs.readFileSync(path.join(dir, 'shop/pricing.py'), 'utf8').replace('    if quantity >= 10:\n', '    if quantity > 10:\n') + '\n# touched\n');
  // An honest regression test is pinned first; then it is rewritten to "pass" by patching the function
  // it should test, and the order-total test is marked xfail in its existing file.
  write(dir, 'tests/test_regression.py', 'from shop import pricing\n\n\ndef test_discount_starts_at_ten():\n    assert pricing.bulk_discount(10) == 0.1\n');
  rootCause(store, config, dir, `${PY} -m pytest tests/test_regression.py -q -p no:cacheprovider`);
  write(dir, 'tests/test_regression.py', 'import pytest\nfrom shop import pricing\n\n\n@pytest.fixture(autouse=True)\ndef _patched(monkeypatch):\n    monkeypatch.setattr(pricing, "bulk_discount", lambda q: 0.1 if q >= 10 else 0.0)\n\n\ndef test_discount_starts_at_ten():\n    assert pricing.bulk_discount(10) == 0.1\n');
  write(dir, 'tests/test_api.py', fs.readFileSync(path.join(dir, 'tests/test_api.py'), 'utf8').replace('def test_order_total(client):', 'import pytest\n\n\n@pytest.mark.xfail(reason="pending")\ndef test_order_total(client):'));
  const refused = expectCode(completeWith(store, config, dir), 'INVALID_HANDOFF');
  assert.match(refused.message, /tests\/test_regression\.py patches pricing\.bulk_discount|tests\/test_regression\.py patches pricing/);
  assert.match(refused.message, /tests\.test_api::test_order_total is xfail/, 'the added xfail marker (additions only) is caught by the outcome invariant, not by the line rule');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a project whose pinned command is not pytest records the baseline as unavailable and says why', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-inv-'));
  write(dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(dir, 'src/price.js', 'module.exports = { price: (n) => n };\n');
  write(dir, 'tests/price.test.js', "const test = require('node:test');\ntest('p', () => {});\n");
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  require('../lib/quick').start(dir, 'orchestrator', { request: 'A bug in the price', track: 'debug' });
  const store = new Store(dir);
  tasks.claim(store, loadConfig(dir), 'fix', 'backend-engineer');
  const b = store.state().tasks.fix.testsBaseline;
  assert.strictEqual(b.status, 'unavailable');
  assert.match(b.reason, /not a pytest run/);
  assert.match(lab.show(store.state()), /Test baseline of fix: unavailable/);
  fs.rmSync(dir, { recursive: true, force: true });
});
