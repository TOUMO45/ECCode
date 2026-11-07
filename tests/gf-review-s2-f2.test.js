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

test('F2-1: a run whose project code changes a tracked file another group has claimed fails, and names the file', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_cross.py', 'def test_cross():\n    open("web/index.html", "a").write("<!-- injected by backend -->")\n');
  commitAll(ctx, 'a frontend page and a test that changes it');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'cross', command: 'pytest -q tests/test_cross.py' });
  assert.strictEqual(r.status, 'failed', JSON.stringify({ status: r.status, ok: r.ok, problems: r.problems }));
  assert.ok(r.problems.some((p) => /web\/index\.html/.test(p.message)), JSON.stringify(r.problems));
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
