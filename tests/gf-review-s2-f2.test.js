'use strict';
// Regression tests for round 5 of S2 (critique rev-mw6yrxry-0131c96f and the readiness no-go rev-mw6ysv8z-017ebfc2,
// tree 154055e), named by finding id (node --test --test-name-pattern "^F2-1" ...). The three engine reproductions
// archived after round 5 became these tests; each failed before its fix. Also F1-1 (the hook's identity check), pinned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('./fixtures/gf/close');
const runner = require('../lib/greenfield/runner');
const { closeProject, commitAll, F } = X;
const ROOT = path.join(__dirname, '..');
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
function team() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}

test('F2-1: a run whose project code changes a tracked file another group has claimed leaves the real file unchanged, and names it as discarded (S2.1: the copy)', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_cross.py', 'def test_cross():\n    open("web/index.html", "a").write("<!-- injected by backend -->")\n');
  commitAll(ctx, 'a frontend page and a test that changes it');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'cross', command: 'pytest -q tests/test_cross.py' });
  assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'web/index.html'), 'utf8'), '<h1>Tasks</h1>\n', JSON.stringify({ status: r.status, problems: r.problems }));
  assert.ok(r.discarded.some((d) => d.path === 'web/index.html' && d.owner === 'frontend'), JSON.stringify(r.discarded));
});
test('F2-1: a run that changes only the caller\'s own group\'s files passes', () => {
  const ctx = team();
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'tests/test_own.py', 'def test_own():\n    open("app/main.py", "a").write("# touched by backend\\n")\n');
  commitAll(ctx, 'backend code and a test that changes it');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'own', command: 'pytest -q tests/test_own.py' });
  assert.strictEqual(r.status, 'passed', `${r.outputTail} ${JSON.stringify(r.problems)}`);
});
test('F2-2: the runner accepts only the plan-pinned sources 18.4 names, not a lab reproduction', () => {
  const store = { root: ROOT, state: () => ({ tasks: {}, work: {}, lab: { repro: { command: 'bash -c curl_evil_example' } } }) };
  assert.ok(runner.formProblems(store, {}, 'backend-engineer', 'bash -c curl_evil_example').length > 0, 'a pinned lab reproduction bypassed every pinned-form check');
});
test('R3-1: a writing form refuses a directory that holds another group\'s paths, and accepts one that holds only the caller\'s', () => {
  const ctx = closeProject();
  for (const dir of ['app/db', 'app/', 'app/auth', 'app']) {
    const p = runner.formProblems(ctx.store, ctx.config, 'backend-engineer', `ruff format ${dir}`);
    assert.ok(p.length > 0, `backend-engineer may run "ruff format ${dir}"`);
  }
  assert.deepStrictEqual(runner.formProblems(ctx.store, ctx.config, 'backend-engineer', 'ruff format app/main.py'), []);
  assert.deepStrictEqual(runner.formProblems(ctx.store, ctx.config, 'frontend-engineer', 'ruff format web'), []);
});

// F1-1: the hook's identity check for a call without agent_type (the main session, i.e. the orchestrator), as 18.3 states.
function mainSession(dir, command, env = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/hooks/guard.js')], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ...env } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
test('F1-1 (pinned): the main session may not record a review under a reviewer role through a command the hook can read', () => {
  const ctx = closeProject();
  const r = mainSession(ctx.dir, 'eccode-gf close review --scope S2 --step critique --actor security-reviewer --dispatch d --summary-file s.txt');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /dispatch the security-reviewer subagent/);
  assert.strictEqual(mainSession(ctx.dir, 'eccode-gf close review --actor $WHO --scope S2').decision, 'ask');
  assert.notStrictEqual(mainSession(ctx.dir, 'eccode-gf close review --scope S2 --actor security-reviewer', { ECCODE_SEQUENTIAL_ROLES: '1' }).decision, 'deny');
});
test('F1-1 (pinned) RESIDUAL (L-GF-33): a command that hides the CLI from the text is not read by the identity check', () => {
  const ctx = closeProject();
  assert.strictEqual(mainSession(ctx.dir, 'node scripts/record-review.js').decision, 'allow');
});

// ------------------------------------------------------------------ the seventh engine battery (round 6, tree 539add4)
test('battery 7: a readiness no-go on the closing tree is reported once', () => {
  const ctx = closeProject();
  X.battery(ctx);
  for (const [step, role] of [['comprehension', 'technical-reviewer'], ['critique', 'security-reviewer']]) {
    const d = X.dispatch(ctx, step, role);
    X.review(ctx, role, { scope: 'S2', step, dispatch: d.id, summary: X.LONG, findings: [] });
  }
  const d = X.dispatch(ctx, 'readiness', 'architecture-reviewer');
  X.review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: d.id, summary: X.LONG, verdict: 'no-go', evidence: ['docs/design.md:1'] });
  X.battery(ctx);
  let err;
  try { X.closeIt(ctx); } catch (e) { err = e; }
  const n = ((err && err.details && err.details.problems) || []).filter((p) => /a readiness no-go was recorded on the closing tree/.test(p.message)).length;
  assert.strictEqual(n, 1, err && err.message);
});
test('battery 7: GF-RUN-1 names a value thrown without a message, and still denies', () => {
  const ctx = team();
  const { Store } = require('../lib/store');
  const original = Store.prototype.readEvents;
  Store.prototype.readEvents = () => { throw 'the log is on fire'; }; // eslint-disable-line no-throw-literal
  try {
    const d = require('../lib/greenfield/permissions').shellDenial(ctx.dir, 'backend-engineer');
    assert.match(d, /GF-RUN-1: .*the log is on fire/);
  } finally { Store.prototype.readEvents = original; }
});
test('battery 7: a plan-pinned command that starts with an environment assignment runs through the shell', () => {
  const ctx = team();
  put(ctx, 'tests/test_ok.py', 'def test_ok():\n    assert 1 == 1\n');
  commitAll(ctx, 'a test');
  const command = 'PYTHONDONTWRITEBYTECODE=1 pytest -q tests/test_ok.py';
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command, reason: 'the check runs without bytecode files', from: ['app/main.py', 'app/__init__.py'] });
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'pinned', command });
  assert.strictEqual(r.status, 'passed', `${r.outputTail} ${JSON.stringify(r.problems)}`);
});
