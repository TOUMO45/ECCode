'use strict';
// Stack packs: detection, real check runs (skipped when a toolchain is absent),
// adoption as policy, and enforcement at the verification gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const stack = require('../lib/stack');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { loadConfig } = require('../lib/config');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, approval, expectCode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
const has = (cmd) => spawnSync('sh', ['-c', cmd], { stdio: 'ignore' }).status === 0;

test('detect and checks: project scripts first, availability honest, multi-stack', () => {
  const { dir } = tmpProject();
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'eslint .' } }));
  write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
  write(dir, 'go.mod', 'module example.com/x\n');
  const cfg = loadConfig(dir);
  assert.deepStrictEqual(stack.detect(dir).map((s) => s.id), ['node', 'python', 'go']);
  const byId = Object.fromEntries(stack.checks(dir, cfg).map((c) => [c.id, c]));
  assert.strictEqual(byId['node-test'].source, 'project-script');
  assert.strictEqual(byId['node-test'].command, 'npm test');
  assert.strictEqual(byId['eccode-secrets'].available, true);
  assert.ok('pytest' in byId && 'go-test' in byId);
  // the npm placeholder script is not a check
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.ok(!stack.checks(dir, cfg).some((c) => c.id === 'node-test'));
});

test('pytest check really runs and really fails (skipped without pytest)', { skip: !has('pytest --version') }, () => {
  const { dir } = tmpProject();
  write(dir, 'pyproject.toml', '[project]\nname = "x"\nversion = "0"\n');
  write(dir, 'test_math.py', 'def test_ok():\n    assert 1 + 1 == 2\n');
  const cfg = loadConfig(dir);
  assert.strictEqual(stack.runCheck(dir, cfg, 'pytest').exitCode, 0);
  write(dir, 'test_math.py', 'def test_broken():\n    assert 1 + 1 == 3\n');
  assert.notStrictEqual(stack.runCheck(dir, cfg, 'pytest').exitCode, 0);
});

test('go test check really runs (skipped without go)', { skip: !has('go version') }, () => {
  const { dir } = tmpProject();
  write(dir, 'go.mod', 'module example.com/x\n\ngo 1.21\n');
  write(dir, 'sum.go', 'package x\n\nfunc Sum(a, b int) int { return a + b }\n');
  write(dir, 'sum_test.go', 'package x\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(1, 2) != 3 {\n\t\tt.Fatal("wrong")\n\t}\n}\n');
  assert.strictEqual(stack.runCheck(dir, loadConfig(dir), 'go-test').exitCode, 0);
});

test('cargo test check really runs (skipped without cargo)', { skip: !has('cargo --version') }, () => {
  const { dir } = tmpProject();
  write(dir, 'Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n');
  write(dir, 'src/lib.rs', 'pub fn sum(a: i32, b: i32) -> i32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::sum(1, 2), 3); }\n}\n');
  assert.strictEqual(stack.runCheck(dir, loadConfig(dir), 'cargo-test').exitCode, 0);
});

test('built-in secrets scan: code hits fail, test-fixture hits only warn, markers suppress', () => {
  const { dir } = tmpProject();
  const key = 'sk-ant-' + 'a'.repeat(24); // assembled so this file never alarms itself
  write(dir, 'src/config.js', `exports.key = "${key}";\n`);
  write(dir, 'tests/fixture.test.js', `const fake = "${key}";\n`);
  const r1 = stack.runCheck(dir, loadConfig(dir), 'eccode-secrets');
  assert.strictEqual(r1.exitCode, 2);
  assert.match(r1.output, /src\/config\.js:1/);
  assert.match(r1.output, /Warnings: .*\n.*tests\/fixture\.test\.js:1/);
  write(dir, 'src/config.js', `exports.key = "${key}"; // eccode-allow-secret: documented test double\n`);
  assert.strictEqual(stack.runCheck(dir, loadConfig(dir), 'eccode-secrets').exitCode, 0);
});

test('adoption is a user decision via the CLI, and unknown or unavailable checks are refused', () => {
  const { dir } = tmpProject();
  const cli = (...a) => spawnSync(process.execPath, [CLI, '--root', dir, ...a], { encoding: 'utf8' });
  let r = cli('stack', 'adopt', '--checks', 'eccode-secrets', '--actor', 'orchestrator');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /USER_AUTH_REQUIRED/);
  r = cli('stack', 'adopt', '--checks', 'no-such-check', '--actor', 'user');
  assert.strictEqual(r.status, 2);
  r = cli('stack', 'adopt', '--checks', 'eccode-secrets', '--actor', 'user');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(loadConfig(dir).stack.required, ['eccode-secrets']);
  r = cli('stack', 'adopt', '--checks', 'eccode-secrets', '--actor', 'user', '--remove');
  assert.deepStrictEqual(loadConfig(dir).stack.required, []);
});

test('a verification approval is refused until the reviewer ran every required check', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, dir } = ctx;
  execFileSync(process.execPath, [CLI, '--root', dir, 'stack', 'adopt', '--checks', 'eccode-secrets', '--actor', 'user']);
  const config = loadConfig(dir); // reload with the requirement
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  let ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/v.md', '# V\nok\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/v.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  ev = passCheck(store, 'security-reviewer');
  const err = expectCode(
    () => gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/v.md']])),
    'REVIEW_REJECTED',
  );
  assert.match(err.message, /required stack check "eccode-secrets" has no passing run by security-reviewer/);
  const run = evidence.runCommand(store, 'security-reviewer', { label: 'secrets scan', command: `${process.execPath} ${JSON.stringify(CLI)} stack run eccode-secrets` });
  assert.strictEqual(run.status, 'passed');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, `ev:${run.id}`, 'artifact:.eccode/artifacts/v.md']]));
  assert.strictEqual(store.state().gates.verification.status, 'approved');
});

test('affected-test runners group files by language', () => {
  assert.deepStrictEqual(
    stack.testRunCommands('.', ['tests/a.test.js', 'pkg/b_test.go', 'tests/test_c.py', 'pkg2/d_test.go']),
    ['node --test tests/a.test.js', 'pytest -q tests/test_c.py', 'go test ./pkg ./pkg2'],
  );
});
