'use strict';
// H2-1 reproduction (security-reviewer, S2 critique). Run from inside the reviewer's copy of the tree.
// Design 18.1 (GF-RUN-2): "a group role's commands run through the runner, which ... runs it in a throwaway copy of
// the tree ..., copies back only the files the caller's group owns, and fails a run that changed any file of the real
// tree outside the caller's group, `.git/` included". Design 18.3: a group role has no shell (GF-RUN-1) and "A runs
// project code through the runner" is the managed-path vector for project code.
// Each test below asserts that claim for a plan-pinned command that a group role runs on its OWN role-locked MCP
// server, and fails when the claim does not hold.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd(); // the reviewer's copy of the tree
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const mcp = require(path.join(ROOT, 'lib/mcp'));
const wrap = require(path.join(ROOT, 'lib/greenfield/wrap'));
const { closeProject, commitAll, F, git } = X;

const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const read = (ctx, rel) => { try { return fs.readFileSync(path.join(ctx.dir, rel), 'utf8'); } catch { return null; } };
const head = (ctx) => git(ctx.dir, 'rev-parse', 'HEAD');
// The tool a group role's role-locked server exposes (lib/mcp.js tools(): no per-role filtering; install.js
// giveRoleTools lists every tool of the role's own server in the agent's frontmatter).
const tool = (name) => mcp.tools().find((t) => t.name === name);
const call = (name, args, ctx, actor) => tool(name).handler(args, { store: ctx.store, config: ctx.config, actor });

const COMMAND = 'pytest -q tests/test_h2.py';
const PY = 'import subprocess\ndef git(*a):\n    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True)\n';

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
  // The plan pins the task's verification command (as tests/gf-runner-copy.test.js does it).
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: COMMAND, reason: 'the task check the plan pins', from: ['app/main.py', 'app/__init__.py'] });
  return ctx;
}

test('precondition: the group role\'s own server lists evidence_run, fix_verify and mutate next to gf_run', () => {
  for (const n of ['gf_run', 'evidence_run', 'fix_verify', 'mutate']) assert.ok(tool(n), `${n} is a tool of every role-locked server`);
  const ctx = project('assert True');
  assert.ok(mcp.approvedCommands(ctx.store, ctx.config).includes(COMMAND), 'the pinned command is approved for evidence_run');
});

test('H2-1a: a plan-pinned command a group role runs on its managed surface does not leave a new file in another group\'s area of the real tree', () => {
  const ctx = project('open("web/evil.js", "w").write("// written by backend\'s test\\n")');
  const r = call('evidence_run', { label: 'verify', command: COMMAND, task: 's0-app' }, ctx, 'backend-engineer');
  const leaked = fs.existsSync(path.join(ctx.dir, 'web/evil.js'));
  assert.ok(r.exitCode === 99 || !leaked, `GF-RUN-2 claims the run is kept in a copy or fails; got status ${r.status}, exit ${r.exitCode}, and web/evil.js (frontend's) ${leaked ? 'EXISTS in the real tree' : 'absent'}`);
});

test('H2-1b: a plan-pinned command a group role runs on its managed surface cannot commit another group\'s file into the real repository undetected', () => {
  const ctx = project('open("web/index.html", "a").write("<!-- backend -->")\ngit("commit", "-qam", "hidden")');
  const before = head(ctx);
  const r = call('evidence_run', { label: 'verify', command: COMMAND, task: 's0-app' }, ctx, 'backend-engineer');
  const moved = head(ctx) !== before;
  const changed = read(ctx, 'web/index.html') !== '<h1>Tasks</h1>\n';
  assert.ok(r.exitCode === 99 || (!moved && !changed), `GF-RUN-2 claims a change of .git or of another group's file fails the run; got status ${r.status}, exit ${r.exitCode}, HEAD ${moved ? 'MOVED' : 'unchanged'}, web/index.html ${changed ? 'CHANGED' : 'unchanged'}`);
});

test('H2-1c (why an agent takes that route): the runner\'s passing run of the task\'s pinned command is accepted when the task is completed', () => {
  const ctx = project('assert True');
  const r = call('gf_run', { label: 'verify', command: COMMAND, task: 's0-app' }, ctx, 'backend-engineer');
  assert.strictEqual(r.status, 'passed', JSON.stringify(r));
  const handoff = (ev) => ({ task: 's0-app', from: 'backend-engineer', to: 'orchestrator', objective: 'the skeleton app module', context: 'phase skeleton, task s0-app', inputs: [], expectedOutput: 'app runs', acceptanceCriteria: ['the pinned check passes'], completedWork: 'nothing changed in this probe', filesChanged: [], evidence: [ev], remainingIssues: [], nextAction: 'review the phase' });
  const refusal = (ev) => { try { call('task_complete', { task: 's0-app', handoff: handoff(ev) }, ctx, 'backend-engineer'); return ''; } catch (e) { return e.message; } };
  const viaRunner = refusal(r.evidence);
  assert.doesNotMatch(viaRunner, /staged verification/, `the completion refuses the runner's evidence as the task's pinned run (its recorded command is the wrapper's, not the pinned one: ${r.evidence}) and tells the agent to run it through evidence run instead: ${viaRunner}`);
});
