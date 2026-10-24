'use strict';
// eccode bugs: high-precision bug patterns on the lines a change adds, the
// installed analyzers' findings on the same lines, and the completion gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const bugs = require('../lib/bugs');
const tasks = require('../lib/tasks');
const gates = require('../lib/gates');
const evidence = require('../lib/evidence');
const { tmpProject, approveThroughPlan, write, task, handoffFor } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

/** Rules that fire on one line of a file with the given name. */
function rulesOn(file, text) {
  return bugs.checkText(file, text).map((f) => `${f.rule}@${f.line}`);
}

test('masking blanks string contents and comments but keeps delimiters and line numbers', () => {
  const js = "const a = 'it.only(' + \"debugger;\"; // debugger;\n/* x === NaN\n */ const t = `a ${b === NaN} c`;\n";
  const m = bugs.mask(js, 'js');
  assert.strictEqual(m.split('\n').length, js.split('\n').length);
  assert.strictEqual(m.length, js.length);
  assert.doesNotMatch(m, /it\.only|debugger|NaN \*/);
  assert.match(m, /\$\{b === NaN\}/, 'template expressions stay code');
  const py = 's = """\nbreakpoint()\n"""  # pdb.set_trace()\nx = f"{y}" if a is 1 else r\'\\d\'\n';
  const mp = bugs.mask(py, 'py');
  assert.doesNotMatch(mp, /breakpoint|set_trace/);
  assert.match(mp, /a is 1/);
  const go = 'var s = `t.Skip(\n)` // t.Skip()\nt.Skip("x")\n';
  assert.deepStrictEqual(bugs.mask(go, 'go').split('\n').map((l) => /t\.Skip/.test(l)), [false, false, true, false]);
});

test('JS/TS rules: each fires on the bug and not on its near miss', () => {
  const cases = [
    ['a.test.js', 'it.only("x", () => {});', 'js/focused-test'],
    ['a.test.js', 'fdescribe("x", () => {});', 'js/focused-test'],
    ['src/a.js', 'debugger;', 'js/debugger'],
    ['src/a.ts', 'if (x === NaN) return;', 'js/nan-compare'],
    ['src/a.js', "if (typeof x === 'undefind') return;", 'js/typeof-typo'],
    ['src/a.js', 'items.forEach(async (i) => { await save(i); });', 'js/async-foreach'],
    ['src/a.js', 'if (user.role = "admin") grant();', 'js/assign-in-condition'],
    ['src/a.js', 'return new Promise(async (resolve) => resolve(1));', 'js/async-promise-executor'],
    ['src/a.js', 'try { f(); } catch (e) {}', 'js/empty-catch'],
    ['a.test.js', 'it.skip("x", () => {});', 'js/skipped-test'],
  ];
  for (const [file, line, rule] of cases) assert.deepStrictEqual(rulesOn(file, `${line}\n`), [`${rule}@1`], `${rule}: ${line}`);
  const misses = [
    ['src/a.js', 'it.only("x", () => {});'], // focused tests only matter in test files
    ['src/a.js', "const s = 'debugger;'; // debugger;"],
    ['src/a.js', 'const debuggerMode = true;'],
    ['src/a.ts', 'if (Number.isNaN(x)) return;'],
    ['src/a.js', "if (typeof x === 'undefined' || typeof y !== 'bigint') return;"],
    ['src/a.js', 'for (const i of items) await save(i);'],
    ['src/a.js', 'if (x == 5 || y === 6 || z <= 7 || w != 8 || v >= 9) go();'],
    ['src/a.js', 'if ((m = re.exec(s))) go(m);'],
    ['src/a.js', 'const f = (x) => (x => x);'],
    ['src/a.js', 'try { f(); } catch (e) { log(e); }'],
    ['src/a.js', 'try { f(); } catch { /* best effort: the file may be gone */ }'],
    ['src/a.js', 'if (match = data.name.match(/^@/)) use(match);'], // assigning a call result is an idiom
    ['src/a.js', 'const n = parseInt(s);'], // ES5 removed octal guessing: not a bug, not flagged
  ];
  for (const [file, line] of misses) assert.deepStrictEqual(rulesOn(file, `${line}\n`), [], line);
});

test('Python rules: each fires on the bug and not on its near miss', () => {
  const cases = [
    ['app/a.py', '    breakpoint()', 'py/debugger'],
    ['app/a.py', '    import pdb; pdb.set_trace()', 'py/debugger'],
    ['app/a.py', 'def add(item, into=[]):', 'py/mutable-default'],
    ['app/a.py', 'def f(a, opts={"x": 1}):', 'py/mutable-default'],
    ['app/a.py', 'if count is 1:', 'py/is-literal'],
    ['app/a.py', 'if name is not "":', 'py/is-literal'],
    ['app/a.py', 'assert (total == 3, "total wrong")', 'py/assert-tuple'],
    ['app/a.py', 'except:', 'py/bare-except'],
    ['test_a.py', '@pytest.mark.skip(reason="later")', 'py/skipped-test'],
  ];
  for (const [file, line, rule] of cases) assert.deepStrictEqual(rulesOn(file, `${line}\n`), [`${rule}@1`], `${rule}: ${line}`);
  assert.deepStrictEqual(rulesOn('app/a.py', 'try:\n    f()\nexcept Exception:\n    pass\n'), ['py/except-pass@3']);
  assert.deepStrictEqual(rulesOn('app/a.py', 'try:\n    f()\nexcept:\n    pass\n'), ['py/bare-except@3', 'py/except-pass@3']);
  // Measured on real code: swallowing a specific exception is control flow, and a comment says it is intended.
  assert.deepStrictEqual(rulesOn('app/a.py', 'try:\n    f()\nexcept KeyError:\n    pass\n'), []);
  assert.deepStrictEqual(rulesOn('app/a.py', 'try:\n    f()\nexcept Exception:  # optional plugin\n    pass\n'), []);
  assert.strictEqual(bugs.checkText('app/a.py', 'def f(x, cache={}):\n')[0].severity, 'warning', 'mutable defaults are usually intended caches: a warning');
  const misses = [
    ['app/a.py', '# breakpoint()'],
    ['app/a.py', 's = "pdb.set_trace()"'],
    ['app/a.py', 'def f(a, b=None, c=(), d=0, e=""):'],
    ['app/a.py', 'if x is None or y is not None or z is True:'],
    ['app/a.py', 'assert total == 3, "total wrong"'],
    ['app/a.py', 'assert check(a, b)'],
    ['app/a.py', 'except Exception:'],
    ['test_a.py', '@pytest.mark.skipif(sys.platform == "win32", reason="posix")'],
  ];
  for (const [file, line] of misses) assert.deepStrictEqual(rulesOn(file, `${line}\n`), [], line);
  assert.deepStrictEqual(rulesOn('app/a.py', 'try:\n    f()\nexcept ValueError:\n    log()\n'), []);
});

test('suppression comments and minified bundles are not findings', () => {
  assert.deepStrictEqual(rulesOn('app/a.py', 'breakpoint()  # noqa: T100\n'), []);
  assert.deepStrictEqual(rulesOn('src/a.js', '// eslint-disable-next-line no-debugger\ndebugger;\n'), []);
  assert.deepStrictEqual(rulesOn('src/a.js', 'debugger; // eccode-allow: kept for the demo\n'), []);
  const bundle = `var a=1;${'if(t.c=r||null,!r)x();'.repeat(80)}\n`;
  assert.deepStrictEqual(rulesOn('dist2/vendor.js', bundle), [], 'minified output is generated, not written');
  assert.deepStrictEqual(rulesOn('src/a.js', 'if (a = b) go();\n'), ['js/assign-in-condition@1'], 'ordinary files still checked');
});

test('Go and cross-language rules', () => {
  assert.deepStrictEqual(rulesOn('x_test.go', '\tt.Skip("flaky")\n'), ['go/skipped-test@1']);
  assert.deepStrictEqual(rulesOn('x.go', '\tt.Skip("not a test file")\n'), []);
  assert.deepStrictEqual(rulesOn('x_test.go', '\tif testing.Short() {\n\t\tt.Skip("slow")\n\t}\n\tif runtime.GOOS == "plan9" { t.Skip("no") }\n'), [], 'conditional skips are legitimate');
  assert.deepStrictEqual(rulesOn('src/a.js', 'a();\n<<<<<<< HEAD\nb();\n=======\nc();\n>>>>>>> topic\n'), ['all/merge-marker@2', 'all/merge-marker@4', 'all/merge-marker@6']);
  assert.deepStrictEqual(rulesOn('app/a.py', 'DOC = """\n=======\n"""\n'), [], 'an underline inside a docstring is not a marker');
  assert.deepStrictEqual(rulesOn('README.md', 'debugger;\n'), [], 'only code files are scanned');
});

function gitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-bugs-'));
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return { dir, git };
}

test('a scan covers only the lines added since the base; --all covers whole files', () => {
  const { dir } = gitRepo({ 'src/a.js': 'function f() {\n  debugger;\n}\n' });
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'function g(x) {\n  if (x === NaN) return 0;\n}\n');
  write(dir, 'src/new.js', 'items.forEach(async (i) => i);\n');
  const r = bugs.scan(dir, { external: false });
  assert.deepStrictEqual(r.findings.map((f) => `${f.file}:${f.line} ${f.rule}`), ['src/a.js:5 js/nan-compare', 'src/new.js:1 js/async-foreach']);
  const all = bugs.scan(dir, { all: true, external: false });
  assert.deepStrictEqual(all.findings.map((f) => `${f.file}:${f.line}`), ['src/a.js:2', 'src/a.js:5', 'src/new.js:1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installed analyzers report only on scanned lines (ruff, go vet)', { skip: !(bugs.hasTool('ruff') || bugs.hasTool('go')) && !process.env.ECCODE_REQUIRE_TRACERS && 'neither ruff nor go installed' }, () => {
  if (process.env.ECCODE_REQUIRE_TRACERS) assert.ok(bugs.hasTool('ruff') && bugs.hasTool('go'), 'ECCODE_REQUIRE_TRACERS=1: both analyzers must run here, not be skipped');
  if (bugs.hasTool('ruff')) {
    const { dir } = gitRepo({ 'pkg/a.py': 'import os\n\n\ndef f():\n    return undefined_old\n' });
    fs.appendFileSync(path.join(dir, 'pkg/a.py'), '\n\ndef g():\n    return undefined_new\n');
    const r = bugs.scan(dir, {});
    const ruff = r.findings.filter((f) => f.tool === 'ruff');
    assert.deepStrictEqual(ruff.map((f) => `${f.rule}@${f.line}:${f.severity}`), ['F821@9:error'], JSON.stringify(r.findings));
    assert.ok(r.analyzers.some((a) => a.tool === 'ruff' && a.ran));
    // An analyzer finding equivalent to a built-in one on the same line is shown once (as the built-in).
    fs.appendFileSync(path.join(dir, 'pkg/a.py'), '\n\ndef h(n):\n    return n is 1\n');
    const both = bugs.scan(dir, {}).findings.filter((f) => f.line === 13);
    assert.deepStrictEqual(both.map((f) => `${f.tool}:${f.rule}`), ['eccode:py/is-literal'], JSON.stringify(both));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (bugs.hasTool('go')) {
    const { dir } = gitRepo({ 'go.mod': 'module example.com/m\n\ngo 1.21\n', 'm.go': 'package m\n\nimport "fmt"\n\nfunc A() { fmt.Println("ok") }\n' });
    fs.appendFileSync(path.join(dir, 'm.go'), '\nfunc B() { fmt.Printf("%d\\n", "not a number") }\n');
    const r = bugs.scan(dir, {});
    const vet = r.findings.filter((f) => f.tool === 'go vet');
    assert.strictEqual(vet.length, 1, JSON.stringify(r));
    assert.strictEqual(vet[0].line, 7);
    assert.strictEqual(vet[0].severity, 'error');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function claimed(files = ['src/**', 'tests/**']) {
  const ctx = tmpProject({ configOverrides: { lean: { level: 'full' } } });
  write(ctx.dir, 'src/app.js', 'module.exports = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'code'], { cwd: ctx.dir });
  approveThroughPlan(ctx, { phases: [{ id: 'core', name: 'Core', goal: 'Build the core', acceptanceCriteria: ['works'] }], tasks: [task('t1', 'backend-engineer', files)] });
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 't1', 'backend-engineer');
  return ctx;
}

test('completion refuses an error finding the task added, unless the handoff declares it', () => {
  const ctx = claimed();
  write(ctx.dir, 'src/app.js', 'function f(x) {\n  debugger;\n  return x;\n}\nmodule.exports = f;\n');
  write(ctx.dir, 'tests/app.test.js', "require('node:test')('f', () => {});\n");
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'verify', command: 'node -e "process.exit(0)"', task: 't1' });
  const handoff = handoffFor('t1', 'backend-engineer', [ev.id], ['src/app.js', 'tests/app.test.js']);
  assert.throws(() => tasks.complete(ctx.store, ctx.config, 't1', 'backend-engineer', handoff), (err) => {
    assert.strictEqual(err.code, 'INVALID_HANDOFF');
    assert.match(err.message, /bugs: src\/app\.js:2 js\/debugger/);
    assert.match(err.message, /handoff\.acceptedFindings/);
    return true;
  });
  const declared = { ...handoff, acceptedFindings: [{ rule: 'js/debugger', file: 'src/app.js', reason: 'kept on purpose for the demo build only' }] };
  tasks.complete(ctx.store, ctx.config, 't1', 'backend-engineer', declared);
  const lean = ctx.store.state().tasks.t1.lean;
  assert.strictEqual(ctx.store.state().tasks.t1.status, 'done');
  assert.strictEqual(lean.bugs.errors, 1);
  assert.deepStrictEqual(lean.bugs.accepted, ['js/debugger src/app.js']);
});

test('lite records findings without refusing; strict also requires warnings to be declared', () => {
  for (const level of ['lite', 'strict']) {
    const ctx = claimed();
    ctx.config.lean.level = level;
    write(ctx.dir, 'src/app.js', 'try { run(); } catch (e) {}\nmodule.exports = 1;\n');
    write(ctx.dir, 'tests/app.test.js', "require('node:test')('x', () => {});\n");
    const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'verify', command: 'node -e "process.exit(0)"', task: 't1' });
    const handoff = handoffFor('t1', 'backend-engineer', [ev.id], ['src/app.js', 'tests/app.test.js']);
    if (level === 'lite') {
      tasks.complete(ctx.store, ctx.config, 't1', 'backend-engineer', handoff);
      assert.strictEqual(ctx.store.state().tasks.t1.lean.bugs.warnings, 1);
    } else {
      assert.throws(() => tasks.complete(ctx.store, ctx.config, 't1', 'backend-engineer', handoff), /bugs: src\/app\.js:1 js\/empty-catch/);
    }
  }
});

test('CLI: exit 1 with errors, 0 without, and JSON output', () => {
  const { dir } = gitRepo({ 'src/a.js': 'module.exports = 1;\n' });
  const run = (args) => spawnSync(process.execPath, [CLI, 'bugs', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir } });
  let r = run(['--no-external']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No bug patterns/);
  write(dir, 'src/b.js', 'if (a = b) go();\n');
  r = run(['--no-external']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /ERROR src\/b\.js:1 js\/assign-in-condition/);
  r = run(['--no-external', '--json']);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.findings[0].rule, 'js/assign-in-condition');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ruff reports bug classes only, whatever the project selects; FastAPI parameter defaults are not B008 bugs', { skip: !bugs.hasTool('ruff') && 'ruff not installed' }, () => {
  const { dir } = gitRepo({
    'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["I", "SIM", "B", "ASYNC", "RUF", "F", "PIE"]\n',
    'pkg/__init__.py': '',
    'pkg/a.py': 'def base():\n    return 1\n',
  });
  fs.appendFileSync(path.join(dir, 'pkg/a.py'), [
    'import sys',
    'import os',
    'from fastapi import Depends',
    '',
    '',
    'def route(session=Depends(base)):',
    '    if session:',
    '        if os.sep:',
    '            pass',
    '    return sys.argv',
    '',
    '',
    'def collect(item, acc=[]):',
    '    acc.append(item)',
    '    return acc',
    '',
    '',
    'async def load(p):',
    '    with open(p) as f:',
    '        return f.read() + missing_name',
    '',
  ].join('\n'));
  const r = bugs.scan(dir, {});
  // B006 is shown once, as the equivalent built-in rule (py/mutable-default).
  assert.deepStrictEqual(r.findings.map((f) => `${f.tool}:${f.rule}`).sort(), ['eccode:py/mutable-default', 'ruff:ASYNC230', 'ruff:F821'], JSON.stringify(r.findings));
  fs.rmSync(dir, { recursive: true, force: true });
});
