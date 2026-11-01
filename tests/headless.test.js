'use strict';
// Headless friction (Phase 3 follow-up, 0.A item 2). In a headless run nobody
// answers, so every place an agent would stop for the user either continues
// with a recorded assumption or is a blocking ambiguity:
//   - a non-blocking question becomes a request.assumption in the same step;
//   - an ask-user escalation of the Lab carries the assumed answer;
//   - the orchestrator may rescope a reviewed plan's task, recorded as an assumption;
//   - a blocking question still stops planning.
// The bench pre-approves the agent's own git stash/worktree in every sandbox
// (the guard keeps the record out of a stash), and a pre-flight reports a
// pytest basename collision before the Lab starts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const design = require('../lib/design');
const lab = require('../lib/lab');
const preflight = require('../lib/preflight');
const bench = require('../lib/bench');
const { loadConfig } = require('../lib/config');
const { Store } = require('../lib/store');
const { tmpProject, write, approveThroughPlan, expectCode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');

function headlessProject(overrides = {}) {
  const ctx = tmpProject({ configOverrides: overrides });
  const file = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.headless = true;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { ...ctx, config: loadConfig(ctx.dir) };
}

/** A fresh repository with a debug work item started through quick.start (as `eccode debug` does), headless or not. */
function debugProject({ headless, hypothesisBudget = 5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-headless-debug-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, 'src/price.js', 'module.exports = { price: (n) => n * 10 };\n');
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  require('../lib/quick').start(dir, 'orchestrator', { request: 'A bulk order misses the discount', command: 'npm test', track: 'debug' });
  const file = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.headless = Boolean(headless);
  cfg.lab = { ...cfg.lab, hypothesisBudget };
  cfg.lean = { ...cfg.lean, level: 'off' };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { dir, store: new Store(dir), config: loadConfig(dir) };
}

function cli(dir, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir, ECCODE_HOOKS: 'off', ...env } });
}

function guard(dir, command, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '', ...env } });
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

test('headless mode comes from config.json or ECCODE_HEADLESS, off by default', () => {
  const ctx = tmpProject();
  assert.strictEqual(loadConfig(ctx.dir).headless, false);
  const prev = process.env.ECCODE_HEADLESS;
  process.env.ECCODE_HEADLESS = '1';
  try { assert.strictEqual(loadConfig(ctx.dir).headless, true); } finally { if (prev === undefined) delete process.env.ECCODE_HEADLESS; else process.env.ECCODE_HEADLESS = prev; }
  assert.strictEqual(headlessProject().config.headless, true);
});

test('headless: a non-blocking question is recorded with its reading as an assumption and planning continues; a blocking one still stops', () => {
  const ctx = headlessProject();
  const { store, config } = ctx;
  // Without a reading or options the engine cannot invent the answer: refused with the instruction.
  assert.match(expectCode(() => design.ambiguity(store, config, 'orchestrator', [{ id: 'q1', text: 'Which date format does the export use?', blocking: false }]), 'INVALID_INPUT').message, /headless.*reading/);
  const a = design.ambiguity(store, config, 'orchestrator', [
    { id: 'q1', text: 'Which date format does the export use?', blocking: false, reading: 'ISO 8601, as every other export in the project' },
    { id: 'q2', text: 'Should the export include archived items?', blocking: false, options: ['no, as the list view', 'yes'] },
    { id: 'q3', text: 'Which customers may run it at all?', blocking: true },
  ]);
  assert.deepStrictEqual(a.assumed.map((x) => x.question), ['q1', 'q2']);
  const st = store.state();
  assert.strictEqual(st.design.assumptions.length, 2);
  assert.strictEqual(st.design.assumptions[1].reading, 'no, as the list view', 'the first option is the reading');
  assert.ok(st.design.assumptions.every((x) => x.headless === true));
  // q3 blocks planning until it is assumed explicitly or the user clarifies.
  assert.deepStrictEqual(design.openQuestions(st).map((q) => q.id), ['q3']);
  assert.match(expectCode(() => gates.startGate(store, config, 'plan', 'orchestrator'), 'AMBIGUITY_OPEN').message, /q3/);
  design.assume(store, config, 'orchestrator', { question: 'q3', reading: 'the admin role only, as the brief implies', rationale: 'no other role is named anywhere in the request' });
  assert.deepStrictEqual(design.openQuestions(store.state()), []);
  // The assumptions reach every handoff and the report.
  assert.strictEqual(design.assumptionLines(store.state()).length, 3);
  assert.match(design.reportLines(store.state()).join('\n'), /q2: .*\*\*assumed\*\*.*no, as the list view/);
  assert.ok(store.audit().ok);
  // Not headless: the same non-blocking questions are only recorded, nothing is assumed for the user.
  const inter = tmpProject();
  const b = design.ambiguity(inter.store, inter.config, 'orchestrator', [{ id: 'q1', text: 'Which date format does the export use?', blocking: false, reading: 'ISO 8601, as the other exports' }]);
  assert.deepStrictEqual(b.assumed, []);
  assert.strictEqual(inter.store.state().design.assumptions.length, 0);
  for (const c of [ctx, inter]) fs.rmSync(c.dir, { recursive: true, force: true });
});

test('headless: an ask-user escalation of the Lab carries the assumed answer and the investigation continues', () => {
  const ctx = debugProject({ headless: true, hypothesisBudget: 1 });
  const { store, config } = ctx;
  tasks.claim(store, config, 'fix', 'backend-engineer');
  lab.recordRepro(store, config, 'backend-engineer', { command: 'node -e "process.exit(1)"', task: 'fix' });
  lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The boundary check uses > instead of >=', ifTrue: 'price(10) is 100', ifFalse: 'price(10) is 90' });
  lab.closeHypothesis(store, config, 'backend-engineer', { hypothesis: 'h1', status: 'withdrawn' });
  expectCode(() => lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The discount table is loaded lazily', ifTrue: 'the first call sees an empty table', ifFalse: 'the first call sees the full table' }), 'LAB_BUDGET');
  // Headless, nobody answers: the escalation needs the assumed answer.
  assert.match(expectCode(() => lab.escalate(store, config, 'backend-engineer', { kind: 'ask-user', reason: 'Is the discount meant to apply from 10 items or above 10?' }), 'INVALID_INPUT').message, /--reading/);
  const e = lab.escalate(store, config, 'backend-engineer', { kind: 'ask-user', reason: 'Is the discount meant to apply from 10 items or above 10?', reading: 'from 10 items inclusive, as the price list says "from 10"' });
  assert.strictEqual(e.headless, true);
  assert.strictEqual(e.assumption.question, 'ask-1');
  const st = store.state();
  assert.strictEqual(st.lab.escalations.length, 1);
  assert.strictEqual(st.design.assumptions.length, 1);
  assert.match(design.assumptionLines(st)[0], /from 10 items inclusive/);
  // The budget is reset by the escalation: the investigation goes on.
  lab.openHypothesis(store, config, 'backend-engineer', { statement: 'The discount table is loaded lazily and empty on the first call', ifTrue: 'the first call sees an empty table', ifFalse: 'the first call sees the full table' });
  assert.ok(store.audit().ok);
  // Interactive: no reading needed, nothing assumed; a rescope never needs one.
  const inter = debugProject({ headless: false, hypothesisBudget: 1 });
  tasks.claim(inter.store, inter.config, 'fix', 'backend-engineer');
  lab.recordRepro(inter.store, inter.config, 'backend-engineer', { command: 'node -e "process.exit(1)"', task: 'fix' });
  const e2 = lab.escalate(inter.store, inter.config, 'backend-engineer', { kind: 'ask-user', reason: 'Is the discount meant to apply from 10 items or above 10?' });
  assert.strictEqual(e2.headless, undefined);
  assert.strictEqual(inter.store.state().design.assumptions.length, 0);
  lab.escalate(store, config, 'backend-engineer', { kind: 'rescope', reason: 'the reproduction needs the fixtures module too' });
  for (const c of [ctx, inter]) fs.rmSync(c.dir, { recursive: true, force: true });
});

test('headless: the orchestrator may rescope a reviewed plan\'s task, recorded as an assumption; interactive it is still the user\'s', () => {
  const ctx = headlessProject();
  approveThroughPlan(ctx);
  const r = tasks.rescope(ctx.store, ctx.config, 'api', 'orchestrator', { files: 'src/server/**,src/shared/**', reason: 'the api task needs the shared types the plan missed' });
  assert.strictEqual(r.event.data.headless, true);
  const st = ctx.store.state();
  assert.deepStrictEqual(st.tasks.api.files, ['src/server/**', 'src/shared/**']);
  assert.strictEqual(st.design.assumptions.length, 1);
  assert.match(st.design.assumptions[0].reading, /files src\/server\/\*\*, src\/shared\/\*\*; command unchanged/);
  assert.match(design.reportLines(st).join('\n'), /rescoped without the user/);
  const inter = tmpProject();
  approveThroughPlan(inter);
  expectCode(() => tasks.rescope(inter.store, inter.config, 'api', 'orchestrator', { files: 'src/**', reason: 'widen the api task please' }), 'ROLE_NOT_ALLOWED');
  for (const c of [ctx, inter]) fs.rmSync(c.dir, { recursive: true, force: true });
});

test('pre-flight: two test files with one basename outside a package are a finding; packages, importlib mode and a check that names one file are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-preflight-'));
  write(dir, 'tests/unit/test_migrations.py', 'def test_a():\n    pass\n');
  write(dir, 'tests/integration/test_migrations.py', 'def test_b():\n    pass\n');
  write(dir, 'tests/unit/test_other.py', 'def test_c():\n    pass\n');
  write(dir, '.venv/lib/site-packages/x/test_migrations.py', 'def test_d():\n    pass\n');
  let f = preflight.pytestBasenameCollisions(dir);
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0].files, ['tests/integration/test_migrations.py', 'tests/unit/test_migrations.py']);
  assert.match(f[0].message, /import file mismatch/);
  // A pinned check that collects only one of them is no finding; one that collects both is.
  assert.deepStrictEqual(preflight.pytestBasenameCollisions(dir, { command: 'python -m pytest -q tests/unit' }), []);
  assert.strictEqual(preflight.pytestBasenameCollisions(dir, { command: 'pytest tests/unit/test_migrations.py tests/integration' }).length, 1);
  assert.deepStrictEqual(preflight.pytestBasenameCollisions(dir, { command: 'pytest --import-mode=importlib tests' }), []);
  // Packages name their modules by path: no clash.
  write(dir, 'tests/unit/__init__.py', '');
  assert.deepStrictEqual(preflight.pytestBasenameCollisions(dir), []);
  fs.rmSync(path.join(dir, 'tests/unit/__init__.py'));
  assert.strictEqual(preflight.pytestBasenameCollisions(dir).length, 1);
  write(dir, 'pyproject.toml', '[tool.pytest.ini_options]\naddopts = "--import-mode=importlib"\n');
  assert.deepStrictEqual(preflight.pytestBasenameCollisions(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pre-flight: eccode debug records the finding before the Lab starts, prints it, and status shows it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-preflight-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, 'src/app.py', 'def f():\n    return 1\n');
  write(dir, 'tests/unit/test_app.py', 'def test_a():\n    pass\n');
  write(dir, 'tests/api/test_app.py', 'def test_b():\n    pass\n');
  write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  const r = cli(dir, ['debug', 'The app returns 1 instead of 2', '--actor', 'orchestrator', '--command', 'python -m pytest -q tests']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENVIRONMENT \(pytest-basename-collision\): pytest cannot collect tests\/api\/test_app\.py and tests\/unit\/test_app\.py/);
  const st = new Store(dir).state();
  assert.strictEqual(st.environment.findings.length, 1);
  assert.strictEqual(st.environment.findings[0].command, 'python -m pytest -q tests');
  assert.match(cli(dir, ['status', '--brief']).stdout, /ENVIRONMENT \(pytest-basename-collision\)/);
  assert.ok(new Store(dir).audit().ok);
  // The finding never blocks: the owner claims as usual.
  assert.strictEqual(cli(dir, ['task', 'claim', 'fix', '--actor', 'backend-engineer']).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bench: every sandbox pre-approves the agent\'s git stash and worktree, and the agent runs headless', () => {
  const task = bench.listTasks(bench.DEFAULT_SUITE).find((t) => t.id === 'csv-sum');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-agent-')), 'agent.js');
  fs.writeFileSync(file, "'use strict';\nconst fs = require('fs');\nconst s = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));\nfs.writeFileSync('seen.json', JSON.stringify({ allow: s.permissions.allow, headless: process.env.ECCODE_HEADLESS }));\n");
  const r = bench.runOnce(task, { agentCmd: `${process.execPath} ${JSON.stringify(file)}`, variant: 'without', keep: true });
  try {
    const seen = JSON.parse(fs.readFileSync(path.join(r.sandbox, 'seen.json'), 'utf8'));
    for (const rule of bench.SANDBOX_PREAPPROVED) assert.ok(seen.allow.includes(rule), rule);
    assert.strictEqual(seen.headless, '1');
    // The settings are part of the fixture commit, not of the measured change.
    assert.ok(!r.patch.includes('settings.json'));
  } finally {
    fs.rmSync(r.sandbox, { recursive: true, force: true });
  }
});

test('guard: a stash never carries the record away; the agent\'s own paths may be stashed', () => {
  const ctx = tmpProject();
  const deny = (cmd) => { const o = guard(ctx.dir, cmd); assert.ok(o && o.permissionDecision === 'deny', `${cmd} should be denied`); assert.match(o.permissionDecisionReason, /record/); };
  const allow = (cmd) => assert.strictEqual(guard(ctx.dir, cmd), null, `${cmd} should be allowed`);
  // The record is untracked in a fresh project: -u / -a would stash it.
  deny('git stash -u');
  deny('git stash push --include-untracked -m wip');
  deny('git stash --all');
  deny('git stash push -u -- src/x.js');
  allow('git stash');
  allow('git stash push -m "before the proof" -- src/price.js tests/price.test.js');
  allow('git stash pop');
  allow('git stash list');
  allow('git worktree add /tmp/eccode-wt-x HEAD');
  // Once the record is tracked and modified, a plain stash would roll it back.
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'record'], { cwd: ctx.dir });
  allow('git stash');
  fs.appendFileSync(path.join(ctx.dir, '.eccode', 'events.jsonl'), '');
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator'); // a new event: the record is modified
  deny('git stash');
  deny('git stash push -- .eccode');
  allow('git stash push -- src/x.js');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
