'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const lean = require('../lib/lean');
const { deliver } = require('../lib/delivery');
const { leanSummary } = require('../lib/memory/metrics');
const { loadConfig, DEFAULT_CONFIG } = require('../lib/config');
const { writeJson } = require('../lib/util');
const { tmpProject, write, approveThroughPlan, samplePlan, passCheck, handoffFor, approval, expectCode } = require('./helpers');

// Built by concatenation so this file never shows up in the toolkit's own debt ledger.
const JS_MARK = '// short' + 'cut: ';
const PY_MARK = '# short' + 'cut: ';

function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'baseline'], { cwd: dir });
}

/** Project at the given lean level with phase:core open; `seed` writes committed baseline files. */
function leanProject(level, { seed, tweak } = {}) {
  const ctx = tmpProject({ configOverrides: { lean: { level } } });
  const plan = samplePlan();
  if (tweak) tweak(plan);
  approveThroughPlan(ctx, plan);
  if (seed) seed(ctx.dir);
  commitAll(ctx.dir);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  return ctx;
}

function completeApi(ctx, files, extra = {}) {
  const ev = passCheck(ctx.store, 'backend-engineer');
  return tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', { ...handoffFor('api', 'backend-engineer', [ev.id], files), ...extra });
}

const pkg = (deps) => JSON.stringify({ name: 'svc', dependencies: deps }, null, 2);

test('manifest parsing: npm, pip, pyproject (PEP 621 + poetry), go.mod, Cargo.toml', () => {
  assert.deepStrictEqual(lean.dependencyNames('package.json', JSON.stringify({ dependencies: { express: '^5' }, devDependencies: { vitest: '1' }, peerDependencies: { react: '*' } })), ['express', 'react', 'vitest']);
  assert.deepStrictEqual(lean.dependencyNames('package.json', '{ not json'), []);
  assert.deepStrictEqual(lean.dependencyNames('requirements-dev.txt', '# tools\nRequests[socks]>=2.0  # http\n-r base.txt\n-e .\nzope.interface==6\n\n'), ['requests', 'zope-interface']);
  const pyproject = [
    '[project]',
    'name = "svc"',
    'dependencies = [',
    '  "uvicorn[standard]>=0.30",',
    "  'httpx',",
    ']',
    '[project.optional-dependencies]',
    'dev = ["pytest>=8", "ruff"]',
    '[tool.poetry.dependencies]',
    'python = "^3.12"',
    'Django_Ninja = "1.0"',
    '[tool.ruff]',
    'line-length = 100',
  ].join('\n');
  assert.deepStrictEqual(lean.dependencyNames('pyproject.toml', pyproject), ['django-ninja', 'httpx', 'pytest', 'ruff', 'uvicorn']);
  const gomod = 'module x\n\ngo 1.23\n\nrequire github.com/a/b v1.2.3\nrequire (\n\tgithub.com/c/d v0.1.0\n\tgolang.org/x/sys v0.20.0 // indirect\n)\n';
  assert.deepStrictEqual(lean.dependencyNames('go.mod', gomod), ['github.com/a/b', 'github.com/c/d']);
  const cargo = '[package]\nname = "x"\nversion = "0.1.0"\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1"\n[dev-dependencies]\nproptest = "1"\n[target.\'cfg(unix)\'.dependencies]\nnix = "0.29"\n[dependencies.reqwest]\nversion = "0.12"\n';
  assert.deepStrictEqual(lean.dependencyNames('Cargo.toml', cargo), ['nix', 'proptest', 'reqwest', 'serde', 'tokio']);
});

test('markers: comment-prefixed only, any comment style; trigger detection', () => {
  const text = [
    `const cache = new Map(); ${JS_MARK}in-memory only, move to Redis when we run more than one instance`,
    `${PY_MARK}no retry`,
    '/* short' + 'cut: fixed 30s timeout */',
    '<!-- short' + 'cut: static list, load from the API once it exists -->',
    '-- short' + 'cut: no index on email, add one past 1M rows',
    'The word shortcut: in prose is not a marker.',
  ].join('\n');
  const found = lean.markersIn(text);
  assert.deepStrictEqual(found.map((m) => m.line), [1, 2, 3, 4, 5]);
  assert.strictEqual(found[2].text, 'fixed 30s timeout');
  assert.strictEqual(found[3].text, 'static list, load from the API once it exists');
  assert.deepStrictEqual(found.map((m) => lean.hasTrigger(m.text)), [true, false, false, true, true]);
});

test('config: lean defaults to full and rejects unknown levels', () => {
  assert.strictEqual(DEFAULT_CONFIG.lean.level, 'full');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lean-cfg-'));
  writeJson(path.join(dir, '.eccode', 'config.json'), { lean: { level: 'ultra' } });
  expectCode(() => loadConfig(dir), 'INVALID_CONFIG');
});

test('full: a new dependency must be declared with a reason; existing ones are not counted', () => {
  const ctx = leanProject('full', { seed: (dir) => write(dir, 'src/server/package.json', pkg({ 'left-pad': '1' })) });
  const { store, config, dir } = ctx;
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/package.json', pkg({ 'left-pad': '1', dayjs: '1' }));
  write(dir, 'src/server/app.test.js', 'test');
  const files = ['src/server/package.json', 'src/server/app.test.js'];
  const err = expectCode(() => completeApi(ctx, files), 'INVALID_HANDOFF');
  assert.match(err.message, /lean: new dependency "dayjs" in src\/server\/package\.json is not declared/);
  assert.doesNotMatch(err.message, /left-pad/);
  completeApi(ctx, files, { newDependencies: [{ name: 'dayjs', reason: 'Timezone-aware parsing the platform Intl API lacks', alternativesChecked: ['codebase: no date helper in src/lib', 'stdlib: Intl.DateTimeFormat cannot parse'] }] });
  assert.deepStrictEqual(store.state().tasks.api.lean.newDependencies, [{ name: 'dayjs', manifest: 'src/server/package.json' }]);
});

test('strict: new dependencies must be pre-approved in the plan and markers must name an upgrade trigger', () => {
  const declared = { newDependencies: [{ name: 'dayjs', reason: 'Timezone-aware parsing needed by R4', alternativesChecked: ['stdlib Intl checked'] }] };
  const ctx = leanProject('strict', { seed: (dir) => write(dir, 'src/server/package.json', pkg({})) });
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  write(ctx.dir, 'src/server/package.json', pkg({ dayjs: '1' }));
  write(ctx.dir, 'src/server/app.js', `const ttl = 30; ${JS_MARK}fixed ttl\n`);
  write(ctx.dir, 'src/server/app.test.js', 'test');
  const files = ['src/server/package.json', 'src/server/app.js', 'src/server/app.test.js'];
  const shortcuts = [{ file: 'src/server/app.js', limit: 'fixed TTL', upgradeWhen: 'when tenants need their own TTL' }];
  const err = expectCode(() => completeApi(ctx, files, { ...declared, shortcuts }), 'INVALID_HANDOFF');
  assert.match(err.message, /"dayjs" is not pre-approved in the plan/);
  assert.match(err.message, /names no upgrade trigger: "fixed ttl"/);

  const ok = leanProject('strict', {
    seed: (dir) => write(dir, 'src/server/package.json', pkg({})),
    tweak: (plan) => (plan.tasks[0].allowedDependencies = ['dayjs']),
  });
  tasks.claim(ok.store, ok.config, 'api', 'backend-engineer');
  write(ok.dir, 'src/server/package.json', pkg({ dayjs: '1' }));
  write(ok.dir, 'src/server/app.js', `const ttl = 30; ${JS_MARK}fixed ttl, make it per-tenant when tenants ask\n`);
  write(ok.dir, 'src/server/app.test.js', 'test');
  completeApi(ok, files, { ...declared, shortcuts });
  assert.strictEqual(ok.store.state().tasks.api.status, 'done');
});

test('full: new shortcut markers must be declared; markers that existed at claim time are not', () => {
  const ctx = leanProject('full', { seed: (dir) => write(dir, 'src/server/old.js', `x(); ${JS_MARK}legacy, rewrite when touched\n`) });
  const { store, config, dir } = ctx;
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', `a(); ${JS_MARK}no pagination, add it past 1k rows\nb(); ${JS_MARK}sync write, queue it under load\n`);
  write(dir, 'src/server/app.test.js', 'test');
  const files = ['src/server/app.js', 'src/server/app.test.js'];
  const one = [{ file: 'src/server/app.js', limit: 'no pagination', upgradeWhen: 'past 1k rows' }];
  const err = expectCode(() => completeApi(ctx, files, { shortcuts: one }), 'INVALID_HANDOFF');
  assert.match(err.message, /src\/server\/app\.js adds 2 shortcut marker\(s\) but handoff\.shortcuts declares 1/);
  assert.doesNotMatch(err.message, /old\.js/);
  completeApi(ctx, files, { shortcuts: [...one, { file: 'src/server/app.js', limit: 'sync write', upgradeWhen: 'under load' }] });
  assert.strictEqual(store.state().tasks.api.lean.shortcuts.length, 2);
});

test('full: changed code needs a changed test file or a stated reason; tests-only tasks pass', () => {
  const ctx = leanProject('full');
  const { store, config, dir } = ctx;
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = (a) => (a > 1 ? a : 1);\n');
  let err = expectCode(() => completeApi(ctx, ['src/server/app.js']), 'INVALID_HANDOFF');
  assert.match(err.message, /lean: code changed \(src\/server\/app\.js\) but no test file did/);
  err = expectCode(() => completeApi(ctx, ['src/server/app.js'], { testsNotNeeded: 'short' }), 'INVALID_HANDOFF');
  assert.match(err.message, /testsNotNeeded/); // schema: >= 10 characters
  completeApi(ctx, ['src/server/app.js'], { testsNotNeeded: 'covered by task tests (test-engineer, depends on api)' });
  const t = store.state().tasks.api;
  assert.deepStrictEqual([t.lean.codeFiles, t.lean.testFiles, t.lean.linesAdded], [1, 0, 1]);

  tasks.claim(store, config, 'tests', 'test-engineer');
  write(dir, 'tests/app.test.js', 'assert(true);\n');
  const ev = passCheck(store, 'test-engineer');
  tasks.complete(store, config, 'tests', 'test-engineer', handoffFor('tests', 'test-engineer', [ev.id], ['tests/app.test.js']));
  assert.strictEqual(store.state().tasks.tests.lean.testFiles, 1);
});

test('a failed attempt cannot launder a dependency: the baseline is the first claim', () => {
  const ctx = leanProject('full', { seed: (dir) => write(dir, 'src/server/package.json', pkg({})) });
  const { store, config, dir } = ctx;
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/package.json', pkg({ moment: '2' }));
  tasks.fail(store, config, 'api', 'backend-engineer', 'gave up after adding a package');
  tasks.claim(store, config, 'api', 'backend-engineer'); // retry: the baseline must not include moment
  write(dir, 'src/server/app.test.js', 'test');
  const err = expectCode(() => completeApi(ctx, ['src/server/package.json', 'src/server/app.test.js']), 'INVALID_HANDOFF');
  assert.match(err.message, /new dependency "moment"/);
  for (const reason of ['rework after review', 'rework again']) {
    // Rework keeps the baseline too, and a reset drops the stale lean record.
    completeApi(ctx, ['src/server/package.json', 'src/server/app.test.js'], { newDependencies: [{ name: 'moment', reason: 'legacy date parsing used by R2', alternativesChecked: ['Intl checked'] }] });
    assert.ok(store.state().tasks.api.lean);
    tasks.reset(store, 'api', 'orchestrator', reason);
    assert.strictEqual(store.state().tasks.api.lean, undefined);
    tasks.claim(store, config, 'api', 'backend-engineer');
  }
  expectCode(() => completeApi(ctx, ['src/server/package.json', 'src/server/app.test.js']), 'INVALID_HANDOFF');
});

test('lite measures and warns without refusing; off records nothing', () => {
  const ctx = leanProject('lite', { seed: (dir) => write(dir, 'src/server/package.json', pkg({})) });
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  write(ctx.dir, 'src/server/package.json', pkg({ lodash: '4' }));
  write(ctx.dir, 'src/server/app.js', `x(); ${JS_MARK}hack\n`);
  completeApi(ctx, ['src/server/package.json', 'src/server/app.js']);
  const l = ctx.store.state().tasks.api.lean;
  assert.strictEqual(l.warnings.length, 4); // undeclared dependency, undeclared marker, no test, no affected test by import index
  assert.strictEqual(l.impact.dependents, 0);
  assert.deepStrictEqual(leanSummary(ctx.store.state()), {
    tasks: 1,
    linesAdded: 4, // package.json: "dependencies": {} becomes 3 lines (+3/−1); new untracked app.js: +1
    linesRemoved: 1,
    newDependencies: ['lodash'],
    shortcutsDeclared: 1,
    codeTasksWithTests: '0/1',
    warnings: 4,
  });

  const off = leanProject('off');
  tasks.claim(off.store, off.config, 'api', 'backend-engineer');
  assert.strictEqual(off.store.state().tasks.api.leanBase, undefined);
  write(off.dir, 'src/server/app.js', 'x();\n');
  completeApi(off, ['src/server/app.js']);
  assert.strictEqual(off.store.state().tasks.api.lean, undefined);
});

test('reuse map: top-level names per directory, shared code first, tests skipped, budget respected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-map-'));
  write(dir, 'app/routes/orders.ts', 'export async function listOrders() {}\nexport const ROUTE = 1;\nfunction hidden() {}\n');
  write(dir, 'app/lib/money.ts', 'export function formatMoney() {}\nexport { parseMoney as parse, round }\n');
  write(dir, 'app/lib/money.test.ts', 'export function shouldNotAppear() {}\n');
  write(dir, 'svc/util.py', 'def slugify(s):\n    def inner(): pass\nclass Cache:\n    pass\ndef _private(): pass\n');
  write(dir, 'svc/legacy.js', 'module.exports = {\n  oldHelper,\n  other: 1,\n};\n');
  write(dir, 'node_modules/x/index.js', 'export function vendored() {}\n');
  const map = lean.reuseMap(dir);
  const lines = map.text.split('\n');
  assert.strictEqual(lines[0], 'app/lib/: money.ts(formatMoney, parse, round)'); // shared code first
  assert.match(map.text, /app\/routes\/: orders\.ts\(listOrders, ROUTE\)/);
  assert.match(map.text, /svc\/: legacy\.js\(oldHelper, other\) util\.py\(slugify, Cache\)/);
  assert.doesNotMatch(map.text, /shouldNotAppear|hidden|inner|_private|vendored/);
  assert.deepStrictEqual(lean.reuseMap(dir, { under: 'svc' }).text.split('\n').length, 1);
  const tight = lean.reuseMap(dir, { chars: 60 });
  assert.match(tight.text, /… 2 more directories \(narrow with --path <dir>\)$/);
});

test('debt ledger: markers across the project, prose ignored, missing triggers flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-debt-'));
  write(dir, 'src/a.js', `ok(); ${JS_MARK}polling every 5s, switch to websockets when users complain\n`);
  write(dir, 'src/b.py', `${PY_MARK}no retry\n`);
  write(dir, 'docs/notes.md', `${JS_MARK}documented example, not debt\n`);
  const ledger = lean.debtLedger(dir);
  assert.deepStrictEqual([ledger.total, ledger.withoutTrigger], [2, 1]);
  assert.match(lean.formatLedger(ledger), /src\/b\.py:1 {2}no retry {2}\[no-trigger\]/);
  assert.strictEqual(lean.formatLedger(lean.debtLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-debt0-')))), 'No deferred shortcuts marked in code.');
});

test('the final handoff carries the lean record and the debt ledger', () => {
  const ctx = leanProject('lite');
  const { store, config, dir } = ctx;
  for (const [id, owner, file, body] of [
    ['api', 'backend-engineer', 'src/server/a.js', `a(); ${JS_MARK}single region, add replicas when p95 > 300ms\n`],
    ['ui', 'frontend-engineer', 'src/web/b.js', 'b();\n'],
    ['tests', 'test-engineer', 'tests/c.test.js', 'c();\n'],
  ]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, body);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  let ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  ev = passCheck(store, 'security-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/verification.md']]));
  const { report } = deliver(store, 'delivery-lead');
  const md = fs.readFileSync(path.join(dir, report), 'utf8');
  assert.match(md, /## Lean record \(measured at task completion\)/);
  assert.match(md, /\| api \| \+1 \/ −0 \| — \| 1 \| 0 \| — \|/);
  assert.match(md, /1 marker\(s\), 0 without an upgrade trigger/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.eccode/delivery/final-handoff.json'), 'utf8'));
  assert.deepStrictEqual([json.lean.length, json.debt.total], [3, 1]);
});
