'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const standards = require('../lib/standards');
const { Memory, current } = require('../lib/memory/records');
const { loadSchema } = require('../lib/schema');
const { tmpProject, write } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function gitCommit(dir, subject) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', subject], { cwd: dir });
}

/**
 * A throwaway repository with a known history and a known layout: twelve
 * conventional commits plus one outlier, a Python package with a FastAPI
 * flavour and a pytest layout, a ruff/pytest pyproject, a camelCase JS
 * module with an eslint config.
 */
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-standards-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, 'pkg/__init__.py', '');
  write(
    dir,
    'pkg/errors.py',
    [
      'class AppError(Exception):',
      '    """Base class for the service."""',
      '',
      'class NotFoundError(AppError):',
      '    pass',
      '',
      'class ValidationError(AppError):',
      '    pass',
      '',
    ].join('\n'),
  );
  write(
    dir,
    'pkg/api_handlers.py',
    [
      'from fastapi import FastAPI, HTTPException',
      'from .errors import NotFoundError, ValidationError',
      '',
      'app = FastAPI()',
      '',
      'def load_item(item_id):',
      '    if item_id < 0:',
      '        raise ValidationError("negative id")',
      '    return {"id": item_id}',
      '',
      'def get_item(item_id):',
      '    try:',
      '        return load_item(item_id)',
      '    except NotFoundError:',
      '        raise HTTPException(status_code=404, detail="not found")',
      '    except ValidationError:',
      '        raise HTTPException(status_code=422, detail="bad id")',
      '',
      'def delete_item(item_id):',
      '    try:',
      '        load_item(item_id)',
      '    except Exception:',
      '        pass',
      '    raise HTTPException(status_code=204)',
      '',
    ].join('\n'),
  );
  write(dir, 'pkg/stock_levels.py', 'def compute_total(items):\n    return sum(items)\n\n\ndef low_stock(items, limit):\n    return [i for i in items if i < limit]\n');
  write(dir, 'tests/__init__.py', '');
  write(dir, 'tests/conftest.py', 'import pytest\n\n@pytest.fixture\ndef sample_items():\n    return [1, 2, 3]\n');
  write(dir, 'tests/test_stock_levels.py', 'from pkg.stock_levels import compute_total, low_stock\n\ndef test_compute_total(sample_items):\n    assert compute_total(sample_items) == 6\n\ndef test_low_stock(sample_items):\n    assert low_stock(sample_items, 2) == [1]\n');
  write(dir, 'tests/test_api_handlers.py', 'def test_get_item():\n    assert True\n');
  write(
    dir,
    'pyproject.toml',
    ['[project]', 'name = "pkg"', '', '[tool.ruff]', 'line-length = 100', 'select = ["E", "F", "B"]', 'ignore = ["E501"]', '', '[tool.pytest.ini_options]', 'testpaths = ["tests"]', ''].join('\n'),
  );
  write(dir, 'web/cart-view.js', ['function renderCart(items) {', '  return items.map(formatLine);', '}', 'const formatLine = (item) => `${item.name}`;', 'function totalPrice(items) {', '  return items.reduce((a, b) => a + b.price, 0);', '}', 'module.exports = { renderCart, totalPrice };', ''].join('\n'));
  write(dir, '.eslintrc.json', JSON.stringify({ extends: 'eslint:recommended', rules: { 'no-console': 'error', eqeqeq: ['error', 'always'], 'prefer-const': 'warn' } }, null, 2));
  gitCommit(dir, 'feat: initial package layout');
  for (const subject of ['fix: reject negative ids', 'feat(api): add the item endpoint', 'fix(api): map NotFoundError to 404', 'feat: compute stock totals', 'fix: low stock boundary', 'feat(web): render the cart', 'fix(web): total price with no items', 'feat: pytest layout', 'fix: ruff configuration', 'feat: eslint configuration', 'fix: conftest fixtures']) {
    gitCommit(dir, subject);
  }
  gitCommit(dir, 'Updated the readme and some notes'); // the outlier
  return dir;
}

test('observed rules come with their kind, confidence, examples and source', () => {
  const dir = fixtureRepo();
  const { observed, scanned } = standards.extract(dir);
  const byKind = (k) => observed.filter((r) => r.kind === k);
  const kinds = new Set(observed.map((r) => r.kind));
  for (const k of standards.KINDS) assert.ok(kinds.has(k), `a ${k} rule is observed`);
  for (const r of observed) {
    assert.ok(r.rule.length > 10 && /\.$/.test(r.rule), `rule is a sentence: ${r.rule}`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(Array.isArray(r.examples) && r.examples.length <= 3);
    assert.ok(['git-history', 'source-files'].includes(r.source) || fs.existsSync(path.join(dir, r.source)), `source names a config file or a method: ${r.source}`);
    assert.doesNotMatch(r.rule, /\bmust\b/i, 'nothing is enforced');
  }
  assert.strictEqual(scanned.commits, 13);
  assert.ok(scanned.py >= 5 && scanned.js === 1 && scanned.tests === 2, `__init__.py and conftest.py are not test files: ${JSON.stringify(scanned)}`);
  assert.strictEqual(scanned.configs, 2, 'pyproject.toml and .eslintrc.json');

  // Commit messages: twelve conventional subjects, one outlier.
  const format = byKind('commit-message')[0];
  assert.match(format.rule, /conventional-commits/);
  assert.match(format.rule, /types seen: feat \(6\), fix \(6\)/);
  assert.match(format.rule, /carry a \(scope\)/);
  assert.ok(format.confidence > 0.9 && format.confidence < 1, `12 of 13: ${format.confidence}`);
  assert.strictEqual(format.confidence, Math.round((12 / 13) * 1000) / 1000);
  assert.strictEqual(format.source, 'git-history');
  assert.ok(format.examples.every((e) => /^(feat|fix)/.test(e)));
  const length = byKind('commit-message').find((r) => /characters/.test(r.rule));
  assert.match(length.rule, /90th percentile/);
  assert.ok(length.confidence >= 0.9);
  const mood = byKind('commit-message').find((r) => /imperative/.test(r.rule));
  assert.ok(mood, 'imperative mood observed');
  assert.ok(mood.examples.includes('add') || mood.examples.includes('render') || mood.examples.includes('map'), mood.examples.join());

  // Naming.
  const naming = byKind('naming');
  const pyFuncs = naming.find((r) => /Python function names/.test(r.rule));
  assert.match(pyFuncs.rule, /snake_case/);
  assert.strictEqual(pyFuncs.confidence, 1);
  assert.strictEqual(pyFuncs.source, 'source-files');
  assert.ok(pyFuncs.examples.includes('compute_total') || pyFuncs.examples.includes('load_item'));
  const jsFuncs = naming.find((r) => /JS\/TS function names/.test(r.rule));
  assert.match(jsFuncs.rule, /camelCase/);
  assert.strictEqual(jsFuncs.confidence, 1);
  assert.ok(jsFuncs.examples.includes('renderCart'));
  const classes = naming.find((r) => /Python class names/.test(r.rule));
  assert.match(classes.rule, /PascalCase \(100% of 3 classes\)/);
  const testNames = naming.find((r) => /test_<behaviour>/.test(r.rule));
  assert.match(testNames.rule, /75% of 4 functions in test files; the other one is a helper or fixture/, 'the conftest fixture counts as a non-test function');
  assert.strictEqual(testNames.confidence, 0.75);
  assert.deepStrictEqual(testNames.examples, ['test_get_item', 'test_compute_total', 'test_low_stock']);
  const pyFiles = naming.find((r) => /Python file names/.test(r.rule));
  assert.match(pyFiles.rule, /snake_case/);

  // Test layout.
  const layout = byKind('test-layout');
  const where = layout.find((r) => /Tests live in/.test(r.rule));
  assert.match(where.rule, /tests\/ at the project root \(100% of 2 test files\)/);
  assert.strictEqual(where.confidence, 1);
  const pattern = layout.find((r) => /Test files are named/.test(r.rule));
  assert.match(pattern.rule, /test_<module>\.py \(100%/);
  const runner = layout.find((r) => /pytest/.test(r.rule));
  assert.match(runner.rule, /\[tool\.pytest\.ini_options\] with testpaths tests/);
  assert.strictEqual(runner.confidence, 1);
  assert.strictEqual(runner.source, 'pyproject.toml');
  const fixtures = layout.find((r) => /fixtures/.test(r.rule));
  assert.match(fixtures.rule, /tests\/conftest\.py/);

  // Error handling.
  const errors = byKind('error-handling');
  const hierarchy = errors.find((r) => /Custom Python exceptions/.test(r.rule));
  assert.match(hierarchy.rule, /\(3\); 2 of them derive from AppError \(a project base class deriving from Exception\)/);
  assert.strictEqual(hierarchy.confidence, Math.round((2 / 3) * 1000) / 1000);
  assert.deepStrictEqual(hierarchy.examples, ['NotFoundError(AppError)', 'ValidationError(AppError)']);
  const catches = errors.find((r) => /except Exception/.test(r.rule));
  assert.match(catches.rule, /catches specific exceptions; broad catches .* appear in 1 of 3 except clauses, 1 silently pass/);
  assert.strictEqual(catches.confidence, Math.round((2 / 3) * 1000) / 1000);
  const http = errors.find((r) => /HTTPException/.test(r.rule));
  assert.match(http.rule, /\(FastAPI\): 3 raise HTTPException\(\.\.\.\) calls in 1 file, 75% of the raise statements in those files/);
  assert.strictEqual(http.confidence, 0.75);
  const raised = errors.find((r) => /raised rather than logged/.test(r.rule));
  assert.match(raised.rule, /4 raise statements vs 0 logger/);
  assert.strictEqual(raised.confidence, 1);

  // Stated rules from config files, confidence 1, source = the file.
  const stated = byKind('forbidden-pattern');
  const ruff = stated.find((r) => r.source === 'pyproject.toml');
  assert.match(ruff.rule, /ruff is configured in pyproject\.toml \[tool\.ruff\]: select E, F, B; ignore E501; line-length 100/);
  assert.strictEqual(ruff.confidence, 1);
  assert.deepStrictEqual(ruff.examples, ['E', 'F', 'B']);
  const eslint = stated.find((r) => r.source === '.eslintrc.json');
  assert.match(eslint.rule, /extends eslint:recommended; 2 rules at error level \(no-console, eqeqeq\)/);
  assert.strictEqual(eslint.confidence, 1);

  // Deterministic: the same repository yields the same list.
  assert.deepStrictEqual(standards.extract(dir).observed, observed);
});

test('other stated rules are read: ruff.lint, mypy, flake8, pre-commit, biome, editorconfig, eslint flat config, vitest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-standards-cfg-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, 'pyproject.toml', '[tool.ruff.lint]\nextend-select = ["I"]\n\n[tool.mypy]\nstrict = true\nignore_missing_imports = true\n');
  write(dir, 'setup.cfg', '[flake8]\nmax-line-length = 88\nextend-ignore = E203\n');
  write(dir, '.pre-commit-config.yaml', 'repos:\n  - repo: x\n    hooks:\n      - id: black\n      - id: ruff\n');
  write(dir, 'biome.json', '{ "linter": { "enabled": true, "rules": { "recommended": true } }, "formatter": { "indentStyle": "space" } }');
  write(dir, '.editorconfig', 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\nmax_line_length = 120\n\n[*.md]\nindent_size = 4\n');
  write(dir, 'eslint.config.js', "module.exports = [{ rules: { 'no-var': 'error', 'no-debugger': 2, 'eqeqeq': ['error'] } }];\n");
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }));
  write(dir, 'src/a.test.js', "import { test } from 'vitest';\ntest('a', () => {});\n");
  const { observed } = standards.extract(dir);
  const text = observed.map((r) => `${r.source}: ${r.rule}`).join('\n');
  assert.match(text, /pyproject\.toml: ruff is configured in pyproject\.toml \[tool\.ruff\.lint\]: select I\./);
  assert.match(text, /pyproject\.toml: mypy is configured .*: strict = true, ignore_missing_imports = true/);
  assert.match(text, /setup\.cfg: flake8 is configured in setup\.cfg \[flake8\]: max-line-length 88; extend-ignore E203/);
  assert.match(text, /\.pre-commit-config\.yaml: pre-commit runs 2 hooks before each commit: black, ruff/);
  assert.match(text, /biome\.json: biome is configured in biome\.json: linter enabled, recommended rules; indentStyle space/);
  assert.match(text, /\.editorconfig: EditorConfig applies to every file .*: indent_style = space, indent_size = 2, max_line_length = 120/);
  assert.match(text, /eslint\.config\.js: eslint is configured in eslint\.config\.js: 3 rules at error level \(no-var, no-debugger, eqeqeq\)/);
  assert.match(text, /package\.json: The JS\/TS test runner is vitest/);
  assert.match(text, /Tests live in next to the source files they test/);
  assert.ok(observed.filter((r) => r.kind === 'forbidden-pattern').every((r) => r.confidence === 1));
});

test('brief() labels the section as not enforced and lists every rule; a repository with nothing observed says so', () => {
  const dir = fixtureRepo();
  const result = standards.extract(dir);
  const md = standards.brief(result);
  assert.match(md, /^## Observed project standards \(not enforced\)/);
  for (const r of result.observed) assert.ok(md.includes(r.rule), `brief lists: ${r.rule}`);
  assert.match(md, /confidence 0\.92, source: git-history/);
  assert.match(md, /not enforced by any gate/);
  assert.match(md, /PR review comments are not read/);
  assert.strictEqual(standards.brief(result.observed), md, 'accepts the list or the extract() result');
  assert.match(standards.brief([]), /none observed/);

  const text = standards.show(dir);
  assert.match(text, /Observed project standards for .* \(not enforced\)/);
  assert.match(text, /Scanned: 13 commits/);
  assert.match(text, /conventional-commits .*\[92%, git-history\]/);
  assert.doesNotMatch(text, /\bmust\b/);
});

test('record() stores one project-layer memory record through the Memory API, with its event', () => {
  const ctx = tmpProject();
  const dir = fixtureRepo();
  const result = standards.extract(dir);
  const id = standards.record(ctx.store, ctx.config, 'onboarding', result);
  assert.match(id, /^mem-p/);
  const file = path.join(ctx.dir, '.eccode', 'memory', 'records', `${id}.json`);
  assert.ok(fs.existsSync(file), 'record lands under .eccode/memory/records/');
  const rec = new Memory(ctx.store, ctx.config).get(id);
  assert.strictEqual(rec.layer, 'project');
  assert.strictEqual(rec.scope, 'project');
  assert.strictEqual(rec.status, 'recorded');
  const c = current(rec);
  assert.strictEqual(c.title, 'Observed project standards (not enforced)');
  assert.match(c.body, /observed/);
  assert.match(c.body, /not enforced/);
  assert.doesNotMatch(c.body, /\bmust\b/);
  for (const r of result.observed) assert.ok(c.body.includes(r.rule), `record lists: ${r.rule}`);
  assert.ok(c.tags.includes('observed-standard'));
  assert.ok(c.tags.includes('commit-message') && c.tags.includes('forbidden-pattern'));
  // The project schema's kind enum decides the kind: `standard` once it is allowed, else the `constraint` + marker fallback.
  const allowed = loadSchema('memory-project').properties.kind.enum;
  assert.strictEqual(c.kind, allowed.includes('standard') ? 'standard' : 'constraint');
  assert.strictEqual(standards.recordKind(), c.kind);
  const events = ctx.store.readEvents().filter((e) => e.type === 'memory.recorded');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].data.id, id);
  assert.strictEqual(events[0].data.layer, 'project');
  assert.strictEqual(events[0].actor, 'onboarding');
  // Project records are never promoted (the existing rule); the gaps say they are not reviewed.
  assert.throws(() => new Memory(ctx.store, ctx.config).promote(id, 'technical-reviewer'), /Project memory stays scoped/);
  assert.match(new Memory(ctx.store, ctx.config).verificationGaps(rec, 'technical-reviewer', ctx.store.state()).join(' '), /not reviewed/);
  // Nothing observed: nothing recorded.
  assert.throws(() => standards.record(ctx.store, ctx.config, 'onboarding', []), /NOTHING_OBSERVED|No standards/);
});

test('smoke: extract() on this repository returns a commit-message and a test-layout rule from real history', () => {
  const { observed, scanned } = standards.extract(ROOT, { limit: 200 });
  assert.ok(scanned.commits > 0 && scanned.commits <= 200);
  assert.ok(observed.some((r) => r.kind === 'commit-message' && r.source === 'git-history'));
  const layout = observed.filter((r) => r.kind === 'test-layout');
  assert.ok(layout.some((r) => /Tests live in/.test(r.rule)));
  assert.ok(layout.some((r) => /node:test/.test(r.rule) && r.source === 'package.json'));
  assert.ok(observed.some((r) => r.kind === 'error-handling' && /throws EccodeError/.test(r.rule)));
  for (const r of observed) assert.ok(r.confidence >= 0 && r.confidence <= 1 && r.examples.length <= 3);
  assert.match(standards.brief(observed), /not enforced/);
});
