'use strict';
// Stack packs: detection, real check runs (skipped when a toolchain is absent),
// adoption as policy, and enforcement at the verification gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
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

test('secrets scan still reads .claude/ even though the codebase index skips it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-secrets-claude-'));
  const token = ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // assembled so this file holds no literal token
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { GITHUB_TOKEN: token } }));
  fs.writeFileSync(path.join(dir, '.env'), `TOKEN=${token}\n`);
  const found = stack.scanSecrets(dir);
  const files = found.code.map((x) => x.split(':')[0]);
  assert.ok(files.includes('.claude/settings.json'), JSON.stringify(found));
  assert.ok(files.includes('.env'), JSON.stringify(found));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Node project in a sub-directory is detected, with its own package manager and scripts', () => {
  const { dir } = tmpProject();
  write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
  write(dir, 'frontend/package.json', JSON.stringify({ name: 'web', scripts: { test: 'vitest', 'lint:js': 'eslint .', lint: 'yarn lint:js' } }));
  write(dir, 'frontend/yarn.lock', '# yarn lockfile v1\n');
  write(dir, 'frontend/tsconfig.json', '{}');
  write(dir, 'node_modules/dep/package.json', '{"name":"dep","scripts":{"test":"x"}}');
  const stacks = stack.detect(dir);
  assert.deepStrictEqual(stacks.map((s) => [s.id, s.dir || '', s.evidence]), [['node', 'frontend', 'frontend/package.json'], ['python', '', 'pyproject.toml']]);
  assert.strictEqual(stacks[0].manager, 'yarn');
  const byId = Object.fromEntries(stack.checks(dir, loadConfig(dir)).map((c) => [c.id, c]));
  assert.strictEqual(byId['node-test'].command, 'cd frontend && yarn test');
  assert.strictEqual(byId['node-test'].script, 'vitest', 'the script body names the tool');
  assert.strictEqual(byId['node-lint'].command, 'cd frontend && yarn lint');
  assert.strictEqual(byId['node-lint'].script, 'yarn lint:js → eslint .', 'a script that calls another is followed one step');
  assert.strictEqual(byId.tsc.command, 'cd frontend && npx tsc --noEmit');
  assert.strictEqual(byId['node-test'].dir, 'frontend', 'a sub-project check names its directory');
  assert.strictEqual(byId.pytest.dir, undefined);
});

test('python checks use the arguments the project\'s own task runner gives them, and mypy configured in pyproject', () => {
  const { dir } = tmpProject();
  write(dir, 'pyproject.toml', '[project]\nname = "x"\n\n[tool.mypy]\nstrict_optional = true\n');
  write(dir, 'Taskfile.yml', 'version: "3"\ntasks:\n  py:lint:\n    cmds:\n      - uv run ruff check mealie\n  py:mypy:\n    cmds:\n      - uv run mypy mealie\n  py:test:\n    cmds:\n      - uv run pytest {{ .CLI_ARGS }}\n');
  const byId = Object.fromEntries(stack.checks(dir, loadConfig(dir)).map((c) => [c.id, c]));
  assert.strictEqual(byId.ruff.command, 'ruff check mealie');
  assert.strictEqual(byId.ruff.source, 'project-task');
  assert.strictEqual(byId.mypy.command, 'mypy mealie', 'offered: [tool.mypy] is mypy configuration');
  assert.strictEqual(byId.pytest.command, 'pytest -q', 'template arguments are not copied; the default stays');
  const { dir: plain } = tmpProject();
  write(plain, 'pyproject.toml', '[project]\nname = "y"\n');
  write(plain, 'Makefile', 'lint:\n\tpoetry run ruff check src tests\n');
  assert.strictEqual(stack.checks(plain, loadConfig(plain)).find((c) => c.id === 'ruff').command, 'ruff check src tests');
});

// Final review: the task-file reader took the first "pytest" anywhere (a pip
// line, a description, a comment, an echo) for the project's test command.
test('a task runner gives a tool its arguments only on a command line that runs that tool', () => {
  const probe = (file, text) => {
    const { dir } = tmpProject();
    write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
    write(dir, file, text);
    return Object.fromEntries(stack.checks(dir, loadConfig(dir)).map((c) => [c.id, c])).pytest.command;
  };
  assert.strictEqual(probe('Makefile', 'deps:\n\tpip install pytest pytest-cov\n'), 'pytest -q', 'a pip line installs pytest, it does not run it');
  assert.strictEqual(probe('Taskfile.yml', 'version: "3"\ntasks:\n  test:\n    desc: run pytest against the backend\n    cmds:\n      - echo start\n'), 'pytest -q', 'a description');
  assert.strictEqual(probe('Makefile', '# We use pytest (see docs)\ntest:\n\techo hi\n'), 'pytest -q', 'a comment');
  assert.strictEqual(probe('justfile', 'test:\n    echo "running pytest -x"\n'), 'pytest -q', 'an echo');
  assert.strictEqual(probe('Makefile', 'test:\n\t@poetry run pytest -x tests/unit\n'), 'pytest -x tests/unit', 'a recipe line, after its @ prefix and the runner');
  assert.strictEqual(probe('Taskfile.yml', 'version: "3"\ntasks:\n  test:\n    cmds:\n      - cmd: uv run pytest -q tests\n'), 'pytest -q tests');
  assert.strictEqual(probe('justfile', 'test:\n    python -m pytest -q backend\n'), 'pytest -q backend');
  assert.strictEqual(probe('Makefile', 'test:\n\tpytest -k "slow and not db"\n'), 'pytest -q', 'quoted arguments are not copied');
});

// Mealie pilot, after-fix A7: a Nuxt frontend got `npx tsc --noEmit`, which
// fails on its clean tree: its tsconfig extends the config `nuxt prepare`
// generates, and Nuxt type-checks through vue-tsc. A project that defines no
// typecheck of its own gets none rather than a check that cannot pass.
test('a Nuxt project gets no plain tsc check; a plain TypeScript project keeps it', () => {
  const { dir } = tmpProject();
  write(dir, 'frontend/package.json', JSON.stringify({ name: 'web', scripts: { test: 'vitest' }, dependencies: { nuxt: '^4.4.2' } }));
  write(dir, 'frontend/tsconfig.json', JSON.stringify({ extends: './.nuxt/tsconfig.json' }));
  write(dir, 'lib/package.json', JSON.stringify({ name: 'lib', scripts: { test: 'node --test' } }));
  write(dir, 'lib/tsconfig.json', '{"compilerOptions":{"strict":true}}');
  const ids = stack.checks(dir, loadConfig(dir)).map((c) => `${c.id} ${c.command}`);
  assert.ok(!ids.some((c) => /frontend && npx tsc/.test(c)), ids.join('\n'));
  assert.ok(ids.some((c) => /lib && npx tsc --noEmit/.test(c)), ids.join('\n'));
});

test('a check that times out says so, names --timeout, and is stopped with everything it started', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  const { dir } = tmpProject();
  const late = path.join(dir, 'late.txt');
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node slow.js' } }));
  write(dir, 'slow.js', `require('child_process').spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)", ${JSON.stringify(late)}], { stdio: 'ignore' });\nsetTimeout(() => {}, 10000);\n`);
  const r = stack.runCheck(dir, loadConfig(dir), 'node-test', { timeoutMs: 700 });
  assert.notStrictEqual(r.exitCode, 0);
  assert.strictEqual(r.timedOut, true);
  assert.match(r.output, /timed out after 0\.7 s.*--timeout <seconds>/);
  const until = Date.now() + 2500;
  while (Date.now() < until) { /* wait past the writer's time */ }
  assert.strictEqual(fs.existsSync(late), false, 'the process the check started was stopped with it');
  // The CLI takes --timeout for both paths, and says so in its help.
  const out = spawnSync(process.execPath, [CLI, 'stack', 'run', 'node-test', '--timeout', '0.7'], { cwd: dir, encoding: 'utf8' });
  assert.match(out.stdout, /node-test: TIMED OUT after 0\.7 s/);
  assert.match(execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }), /stack run <id\|all> \[--timeout <s>\]/);
});
