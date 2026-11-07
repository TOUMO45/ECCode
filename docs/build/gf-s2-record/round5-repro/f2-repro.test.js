'use strict';
// Reproductions of the round-5 critique findings (security-reviewer, review rev-mw6yrxry-0131c96f on tree 154055e).
// Each asserts what design 18.3 and 18.4 claim, so each FAILS on that tree. They live outside tests/ (the suite stays
// green while S2 waits for the owner's decision). Run from the repository root:
//   TMPDIR=<absolute scratch> GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false node --test docs/build/gf-s2-record/round5-repro/f2-repro.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../../..');
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const runner = require(path.join(ROOT, 'lib/greenfield/runner'));
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };

test('F2-1: a run whose project code changes a tracked file of another group, while that group holds a claim on it, fails or is reported (18.3, L-GF-29)', () => {
  const ctx = closeProject();
  require(path.join(ROOT, 'lib/greenfield/wrap')).gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_cross.py', 'def test_cross():\n    open("web/index.html", "a").write("<!-- injected by backend -->")\n');
  commitAll(ctx, 'a frontend page and a test that changes it');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'cross', command: 'pytest -q tests/test_cross.py' });
  assert.ok(r.status === 'failed' || r.problems.some((p) => /web\/index\.html/.test(p.message)), `the run passed silently: ${JSON.stringify({ status: r.status, ok: r.ok, problems: r.problems })}`);
});
test('F2-2: the runner accepts only the plan-pinned sources 18.4 names (task checks, the behaviour command, detected stack checks), not a lab reproduction', () => {
  const store = { root: ROOT, state: () => ({ tasks: {}, work: {}, lab: { repro: { command: 'bash -c curl_evil_example' } } }) };
  const p = runner.formProblems(store, {}, 'backend-engineer', 'bash -c curl_evil_example');
  assert.ok(p.length > 0, 'a pinned lab reproduction bypassed every pinned-form check');
});
test('R3-1 (the round-5 readiness no-go, rev-mw6ysv8z-017ebfc2): a writing form refuses a directory that holds another group\'s paths (18.4: "each inside the caller\'s group")', () => {
  const ctx = closeProject();
  for (const dir of ['app/db', 'app/', 'app/auth']) {
    const p = runner.formProblems(ctx.store, ctx.config, 'backend-engineer', `ruff format ${dir}`);
    assert.ok(p.length > 0, `backend-engineer may run "ruff format ${dir}", which reaches db's or security's files`);
  }
});
