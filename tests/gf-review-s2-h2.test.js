'use strict';
// Regression tests for S2.2 (the owner's narrow fix of 2026-11-08): the S2.1 critique (security-reviewer, review
// rev-mw7pnwrk-01ed3bc1, tree 9340a06), named by finding id. Each failed before its fix.
//   H2-1  the runner is the only route by which a group role runs a project command: the frozen command tools of its
//         role-locked server (evidence_run, fix_verify, mutate and the lab's command tools) are refused to a group role
//         in a Greenfield-Senior project, and task completion accepts the runner's run of the task's pinned command.
//   H2-2  the runner hashes .eccode/ with the rest of the real tree, except the three files the frozen record window
//         restores (and that window's own lock files): an absolute-path write to drafts, an evidence log or a guard
//         config fails the run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('./fixtures/gf/close');
const mcp = require('../lib/mcp');
const runner = require('../lib/greenfield/runner');
const wrap = require('../lib/greenfield/wrap');
const { closeProject, commitAll, F, git } = X;

const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const read = (ctx, rel) => { try { return fs.readFileSync(path.join(ctx.dir, rel), 'utf8'); } catch { return null; } };
const head = (ctx) => git(ctx.dir, 'rev-parse', 'HEAD');
const tool = (name) => mcp.tools().find((t) => t.name === name);
const call = (name, args, ctx, actor) => tool(name).handler(args, { store: ctx.store, config: ctx.config, actor });
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const COMMAND = 'pytest -q tests/test_h2.py';
const PY = 'import os, subprocess\nREAL = os.path.dirname(os.environ.get("ECCODE_EVIDENCE", "."))\ndef git(*a):\n    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True)\n';
const COMMAND_TOOLS = ['evidence_run', 'fix_verify', 'mutate', 'lab_repro', 'lab_hypothesis_test', 'lab_localize', 'lab_bisect', 'lab_trace'];

/** A sealed Greenfield-Senior project; backend-engineer has claimed s0-app, whose pinned check is COMMAND. */
function project(body) {
  const ctx = closeProject();
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'tests/test_h2.py', `${PY}\ndef test_h2():\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  commitAll(ctx, 'two pages and a test');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: COMMAND, reason: 'the task check the plan pins', from: ['app/main.py', 'app/__init__.py'] });
  return ctx;
}
function refusedRun(fn) { let err = null; try { fn(); } catch (e) { err = e; } return err; }

// ------------------------------------------------------------------ H2-1: the runner is the only route
test('H2-1 (the R2 reproduction, permanent): a backend test run through evidence_run cannot commit a frontend file: the tool is refused to a group role and the real tree and HEAD are unchanged', () => {
  const ctx = project('open("web/index.html", "a").write("<!-- backend -->")\ngit("commit", "-qam", "hidden")');
  const before = head(ctx);
  const err = refusedRun(() => call('evidence_run', { label: 'verify', command: COMMAND, task: 's0-app' }, ctx, 'backend-engineer'));
  assert.strictEqual(head(ctx), before, 'HEAD moved');
  assert.strictEqual(read(ctx, 'web/index.html'), '<h1>Tasks</h1>\n', 'the frontend file changed');
  assert.ok(rulesOf(err).includes('GF-RUN-2'), err ? err.message : 'evidence_run ran for a group role');
  assert.match(err.message, /gf_run/);
});
test('H2-1: every frozen command tool of a role-locked server is refused to every group role in a Greenfield-Senior project, and nothing is recorded', () => {
  const ctx = project('assert True');
  for (const role of ['backend-engineer', 'frontend-engineer', 'test-engineer', 'devops-engineer']) {
    for (const name of COMMAND_TOOLS) {
      assert.ok(tool(name), `${name} is a tool of the role servers`);
      const n = ctx.store.readEvents().length;
      const err = refusedRun(() => call(name, { label: 'x', command: COMMAND, test: COMMAND, task: 's0-app', base: 'HEAD' }, ctx, role));
      assert.ok(rulesOf(err).includes('GF-RUN-2'), `${role} ${name}: ${err ? err.message : 'not refused'}`);
      assert.strictEqual(ctx.store.readEvents().length, n, `${role} ${name} recorded something`);
    }
  }
});
test('H2-1 negative: the orchestrator and a role in no group keep the frozen command tools', () => {
  const ctx = project('assert True');
  for (const role of ['orchestrator', 'technical-reviewer']) {
    const r = call('evidence_run', { label: 'verify', command: COMMAND }, ctx, role);
    assert.strictEqual(r.status, 'passed', `${role}: ${JSON.stringify(r).slice(0, 300)}`);
  }
});
test('H2-1 negative: outside a Greenfield-Senior project a group role keeps evidence_run (the frozen engine is unchanged)', () => {
  const { tmpProject } = require('./helpers');
  const p = tmpProject();
  const err = refusedRun(() => tool('evidence_run').handler({ label: 'x', command: 'node -e 0' }, { store: p.store, config: p.config || {}, actor: 'backend-engineer' }));
  assert.ok(err === null || !/TypeError/.test(err.name), err && err.message);
  assert.ok(!rulesOf(err).includes('GF-RUN-2'), err && err.message);
});
test('H2-1: task completion accepts the runner\'s passing run of the task\'s pinned command as the pinned run', () => {
  const ctx = project('assert True');
  const r = call('gf_run', { label: 'verify', command: COMMAND, task: 's0-app' }, ctx, 'backend-engineer');
  assert.strictEqual(r.status, 'passed', JSON.stringify(r));
  const ev = ctx.store.state().evidence[r.evidence.slice(3)];
  assert.strictEqual(ev.command, COMMAND, 'the evidence records the pinned command it ran');
  assert.match(ev.runner.executed, /run-check\.js/, 'and says the runner\'s wrapper executed it');
  const handoff = { task: 's0-app', from: 'backend-engineer', to: 'orchestrator', objective: 'the skeleton app module', context: 'phase skeleton, task s0-app', inputs: [], expectedOutput: 'app runs', acceptanceCriteria: ['the pinned check passes'], completedWork: 'nothing changed in this probe', filesChanged: [], evidence: [r.evidence], risks: [], openQuestions: [], nextSteps: [] };
  let msg = '';
  try { call('task_complete', { task: 's0-app', handoff }, ctx, 'backend-engineer'); } catch (e) { msg = e.message; }
  assert.doesNotMatch(msg, /staged verification/, msg);
});

// ------------------------------------------------------------------ H2-2: .eccode/ is part of the real tree
const runTest = (body) => { const ctx = project(body); return { ctx, r: runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'h2', command: COMMAND }) }; };
const named = (r, re) => assert.ok(r.problems.some((p) => re.test(p.message)), JSON.stringify({ status: r.status, exitCode: r.exitCode, problems: r.problems }));
test('H2-2 (the R2 reproduction, permanent): an absolute-path write to another group\'s drafts fails the run and names the file', () => {
  const { r } = runTest('os.makedirs(os.path.join(REAL, ".eccode/drafts/frontend"), exist_ok=True)\nopen(os.path.join(REAL, ".eccode/drafts/frontend/note.md"), "w").write("from backend")');
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r.problems));
  named(r, /\.eccode\/drafts\/frontend\/note\.md/);
});
test('H2-2: an absolute-path write to a new guard config fails the run', () => {
  const { r } = runTest('open(os.path.join(REAL, ".eccode/guards.json"), "w").write("{}")');
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r.problems));
  named(r, /\.eccode\/guards\.json/);
});
test('H2-2: an absolute-path change to an existing evidence log fails the run', () => {
  const ctx = project('import glob\nfor f in glob.glob(os.path.join(REAL, ".eccode/evidence/*.log")):\n    open(f, "a").write("forged")');
  put(ctx, '.eccode/evidence/ev-earlier.log', '$ an earlier check\n');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'h2', command: COMMAND });
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r.problems));
  named(r, /\.eccode\/evidence\/ev-earlier\.log/);
});
test('H2-2 negative: the three files the frozen record window restores are left to it (it puts them back and fails the run itself)', () => {
  const { ctx, r } = runTest('open(os.path.join(REAL, ".eccode/state.json"), "a").write(" ")');
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r));
  assert.ok(!r.problems.some((p) => /state\.json/.test(p.message)), 'the runner does not report it; the frozen window does');
  assert.match(r.outputTail, /changed the ECCode record \(\.eccode\/state\.json\)/);
  assert.doesNotThrow(() => JSON.parse(read(ctx, '.eccode/state.json')));
});
test('H2-2 negative: another agent waiting for the record lock during a run does not fail it (the frozen lock\'s own files)', () => {
  const { ctx, r } = runTest('open(os.path.join(REAL, ".eccode/.lock.waiting-424242"), "w").write("")');
  assert.strictEqual(r.status, 'passed', JSON.stringify({ problems: r.problems, tail: r.outputTail }));
  fs.rmSync(path.join(ctx.dir, '.eccode/.lock.waiting-424242'), { force: true });
});
