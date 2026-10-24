'use strict';
// eccode fix verify: the regression test must fail on the pre-fix code (a
// temporary worktree at the base with the new tests copied in) and pass on
// the fix. A pre-fix failure caused by new API or a load error proves nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const fixverify = require('../lib/fixverify');
const works = require('../lib/works');
const { tmpProject, write, expectCode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
const BUGGY = 'function total(items) {\n  let s = 0;\n  for (let i = 1; i < items.length; i++) s += items[i];\n  return s;\n}\nmodule.exports = { total };\n';
const FIXED = BUGGY.replace('let i = 1', 'let i = 0');
const HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\n";

/** A record whose base commit has the bug; returns the context and the base sha. */
function project() {
  const ctx = tmpProject();
  write(ctx.dir, 'package.json', '{"name":"shop","version":"1.0.0","scripts":{"test":"node --test"}}');
  write(ctx.dir, 'src/cart.js', BUGGY);
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('empty', () => assert.strictEqual(total([]), 0));\n`);
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'cart with the bug'], { cwd: ctx.dir });
  return { ...ctx, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.dir, encoding: 'utf8' }).trim() };
}

function worktrees(dir) {
  return execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length;
}

test('proven: the regression test fails on the pre-fix code and passes on the fix; the evidence pair satisfies the fix track', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', FIXED);
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('empty', () => assert.strictEqual(total([]), 0));\ntest('counts the first item', () => assert.strictEqual(total([1, 2, 3]), 6));\n`);
  const r = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(r.verdict, 'proven', JSON.stringify(r, null, 1));
  assert.deepStrictEqual(r.tests, ['tests/cart.test.js']);
  assert.deepStrictEqual(r.sources, ['src/cart.js']);
  const ev = ctx.store.state().evidence;
  assert.strictEqual(ev[r.pre.id].status, 'failed');
  assert.strictEqual(ev[r.pre.id].purpose, 'reproduction');
  assert.match(ev[r.pre.id].cwd, /^pre-fix@/);
  assert.strictEqual(ev[r.post.id].status, 'passed');
  assert.strictEqual(ev[r.post.id].command, ev[r.pre.id].command);
  assert.strictEqual(worktrees(ctx.dir), 1, 'temporary worktree removed');
  // The fix track's rule: a failing reproduction and the same command passing later.
  const state = { ...ctx.store.state(), work: { track: 'fix', startedAt: '0' } };
  assert.deepStrictEqual(works.checkTrackRules(state), []);
});

test('not proven: a test that passes without the fix does not catch the bug', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', FIXED);
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('empty', () => assert.strictEqual(total([]), 0));\ntest('still empty', () => assert.strictEqual(total([]), 0));\n`);
  const r = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(r.verdict, 'tests-pass-without-fix');
  assert.match(r.reason, /pass on the pre-fix code/);
  assert.notStrictEqual(ctx.store.state().evidence[r.pre.id].purpose, 'reproduction');
  assert.strictEqual(worktrees(ctx.dir), 1);
});

test('inconclusive: a pre-fix failure caused by API the fix adds proves nothing about the bug', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', `${FIXED}function sum(items) { return total(items); }\nmodule.exports.sum = sum;\n`);
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { sum } = require('../src/cart');\ntest('sum', () => assert.strictEqual(sum([1, 2, 3]), 6));\n`);
  const r = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(r.verdict, 'inconclusive', JSON.stringify(r.pre));
  assert.match(r.reason, /sum/);
  assert.strictEqual(ctx.store.state().evidence[r.pre.id].purpose, 'check', 'not counted as a reproduction');
});

test('not proven: the fix fails its own regression test', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', BUGGY.replace('return s;', 'return s + 0;'));
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('counts the first item', () => assert.strictEqual(total([1, 2, 3]), 6));\n`);
  const r = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(r.verdict, 'fix-fails-tests');
});

test('a fix needs both a changed test and a changed source file', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', FIXED);
  expectCode(() => fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base }), 'NO_REGRESSION_TEST');
  execFileSync('git', ['checkout', '--', 'src/cart.js'], { cwd: ctx.dir });
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}test('x', () => {});\n`);
  expectCode(() => fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base }), 'NO_FIX');
});

test('CLI: exit 0 only when proven', () => {
  const ctx = project();
  write(ctx.dir, 'src/cart.js', FIXED);
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('counts the first item', () => assert.strictEqual(total([1, 2, 3]), 6));\n`);
  const run = () => spawnSync(process.execPath, [CLI, 'fix', 'verify', '--actor', 'backend-engineer', '--base', ctx.base, '--test', 'node --test'], { cwd: ctx.dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: ctx.dir } });
  let r = run();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PROVEN/);
  write(ctx.dir, 'src/cart.js', BUGGY.replace('return s;', 'return s + 0;'));
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /NOT PROVEN/);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('Python: proven, and a test importing a function the fix adds is inconclusive', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not installed' }, () => {
  const ctx = tmpProject();
  write(ctx.dir, 'app/__init__.py', '');
  write(ctx.dir, 'app/cart.py', 'def total(items):\n    return sum(items[1:])\n');
  write(ctx.dir, 'tests/__init__.py', '');
  write(ctx.dir, 'tests/test_cart.py', 'import unittest\nfrom app.cart import total\n\nclass T(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(total([]), 0)\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'py cart'], { cwd: ctx.dir });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.dir, encoding: 'utf8' }).trim();
  const cmd = 'python3 -m unittest discover -s tests -t .';
  write(ctx.dir, 'app/cart.py', 'def total(items):\n    return sum(items)\n');
  write(ctx.dir, 'tests/test_cart.py', 'import unittest\nfrom app.cart import total\n\nclass T(unittest.TestCase):\n    def test_first(self):\n        self.assertEqual(total([1, 2, 3]), 6)\n');
  assert.strictEqual(fixverify.verify(ctx.store, 'backend-engineer', { test: cmd, base }).verdict, 'proven');
  write(ctx.dir, 'app/cart.py', 'def total(items):\n    return sum(items)\n\n\ndef grand_total(items):\n    return total(items)\n');
  write(ctx.dir, 'tests/test_cart.py', 'import unittest\nfrom app.cart import grand_total\n\nclass T(unittest.TestCase):\n    def test_first(self):\n        self.assertEqual(grand_total([1, 2, 3]), 6)\n');
  const r = fixverify.verify(ctx.store, 'backend-engineer', { test: cmd, base });
  assert.strictEqual(r.verdict, 'inconclusive', JSON.stringify(r.pre));
  assert.match(r.reason, /grand_total/);
});

test('a pre-fix failure counts only as an assertion failure or an error inside the fixed code', () => {
  // A crash inside the fixed source is the bug's own symptom: proven.
  const ctx = project();
  write(ctx.dir, 'src/cart.js', FIXED.replace('let s = 0;', 'if (!items) return 0;\n  let s = 0;'));
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('null cart', () => assert.strictEqual(total(null), 0));\n`);
  assert.strictEqual(fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base }).verdict, 'proven');
  // A test that crashes in its own code (here: only in the pre-fix checkout), not in the fixed code: inconclusive.
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const { total } = require('../src/cart');\ntest('own crash', () => { if (process.cwd().includes('pre-fix')) null.x; assert.strictEqual(total([1, 2, 3]), 6); });\n`);
  const own = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(own.verdict, 'inconclusive', JSON.stringify(own.pre));
  assert.match(own.reason, /no test assertion failed/);
  // A file present in the working tree but not in the pre-fix checkout: the environments differ.
  write(ctx.dir, 'local.json', '{"rate": 1}\n');
  fs.appendFileSync(path.join(ctx.dir, '.gitignore'), 'local.json\n');
  write(ctx.dir, 'tests/cart.test.js', `${HEAD}const fs = require('fs');\nconst { total } = require('../src/cart');\ntest('rate', () => { const { rate } = JSON.parse(fs.readFileSync('local.json', 'utf8')); assert.strictEqual(total([1, 2, 3]) * rate, 6); });\n`);
  const env = fixverify.verify(ctx.store, 'backend-engineer', { test: 'node --test', base: ctx.base });
  assert.strictEqual(env.verdict, 'inconclusive', JSON.stringify(env.pre));
  assert.match(env.reason, /local\.json/);
});

test('a missing file is matched however the temp path is spelled (Windows 8.3 short vs long names)', () => {
  const ctx = project();
  write(ctx.dir, 'local.json', '{}\n');
  const out = (p) => `Error: ENOENT: no such file or directory, open '${p}'`;
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\eccode-fixverify-Ab12\\pre-fix\\local.json';
  for (const p of [long, '/tmp/eccode-fixverify-Ab12/pre-fix/local.json', 'local.json']) {
    assert.match(fixverify.inconclusiveReason(out(p), ctx.dir, ctx.base, ['src/cart.js'], '') || '', /local\.json/, p);
  }
  assert.match(fixverify.inconclusiveReason(out('C:\\x\\pre-fix\\app\\local.json'), ctx.dir, ctx.base, ['src/cart.js'], 'app/') || '', /local\.json/, 'project in a subdirectory of the repo');
  assert.doesNotMatch(fixverify.inconclusiveReason(`${out('/etc/nothing-here.json')}\nAssertionError`, ctx.dir, ctx.base, ['src/cart.js'], '') || '', /nothing-here/);
});

test('an error raised in the fixed code counts when pytest prints its frame as a relative path', () => {
  // Found by the Mealie pilot's development run: pytest prints traceback
  // frames relative to its rootdir, at the start of a line, so a crash in the
  // fixed file (the bug's own symptom) read as "no error in the fixed code".
  const ctx = project();
  const sources = ['mealie/routes/groups/controller_labels.py'];
  const out = [
    'tests/integration_tests/test_labels.py:31: in test_duplicate_label',
    '    response = api_client.post(api_routes.groups_labels, json=data)',
    'mealie/routes/groups/controller_labels.py:57: in create_one',
    '    return self.mixins.create_one(data)',
    'E   sqlalchemy.exc.IntegrityError: (sqlite3.IntegrityError) UNIQUE constraint failed',
  ].join('\n');
  assert.strictEqual(fixverify.inconclusiveReason(out, ctx.dir, ctx.base, sources, ''), null, 'the failure went through the fixed code');
  assert.match(fixverify.inconclusiveReason(out.replace(/controller_labels/g, 'controller_tags'), ctx.dir, ctx.base, sources, '') || '', /no test assertion failed/, 'a frame of another file is not the fixed code');
  assert.match(fixverify.inconclusiveReason(out.replace('mealie/routes/groups/controller_labels.py:57', 'other/mealie/routes/groups/controller_labels.py.bak:57'), ctx.dir, ctx.base, sources, '') || '', /no test assertion failed/, 'a longer path that merely contains the file is not it');
});

test('an error that names a definition of the fixed code counts, though a library raised it', () => {
  // Found by the Mealie pilot's A4: pydantic raised the bug's ValidationError
  // for a model the fix changes; the traceback has no frame in the fixed file.
  const ctx = project();
  write(ctx.dir, 'mealie/schema/recipe_ingredient.py', 'class IngredientFood:\n    pass\n\n\ndef get(x):\n    return x\n');
  const sources = ['mealie/schema/recipe_ingredient.py'];
  const out = [
    'tests/unit_tests/schema_tests/test_ingredient_food.py:48: in test_food_with_null_description_validates',
    '    food = IngredientFood.model_validate(_food_row(None))',
    'E   pydantic_core._pydantic_core.ValidationError: 1 validation error for IngredientFood',
    'E   description',
  ].join('\n');
  assert.strictEqual(fixverify.inconclusiveReason(out, ctx.dir, ctx.base, sources, ''), null);
  assert.match(fixverify.inconclusiveReason(out.replace(/IngredientFood/g, 'RecipeTool'), ctx.dir, ctx.base, sources, '') || '', /no test assertion failed/, 'another class is not the fixed code');
  assert.match(fixverify.inconclusiveReason('E   KeyError: get', ctx.dir, ctx.base, sources, '') || '', /no test assertion failed/, 'a short common name is not evidence');
});
