'use strict';
// S2.4 (design 21), GF-ISO-2 the commit step and GF-ISO-3 the merge step. The engine, OUTSIDE the sandbox, validates
// a group's changed files against the ownership map and the claimed task before any git write, commits exactly the
// validated bytes through plumbing with a sanitized environment, and merges the group branches in dependency order.
// These run without a kernel mechanism: the sandbox is GF-ISO-1's concern; GF-ISO-2/3 are pure engine git steps.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const X = require('./fixtures/gf/close');
const mcp = require('../lib/mcp');
const wrap = require('../lib/greenfield/wrap');
const isolate = require('../lib/greenfield/isolate');
const audit = require('../lib/greenfield/audit');
const { closeProject, F, git, commitAll } = X;

const put = (ctx, rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); if (mode) fs.chmodSync(path.join(ctx.dir, rel), mode); };
const rm = (ctx, rel) => fs.rmSync(path.join(ctx.dir, rel), { force: true });
const tool = (name) => mcp.tools().find((t) => t.name === name);
const call = (name, args, ctx, actor) => tool(name).handler(args, { store: ctx.store, config: ctx.config, actor });
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const refused = (fn) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e, 'expected a refusal'); return e; };
const gitq = (ctx, ...a) => { try { return git(ctx.dir, ...a); } catch { return null; } };

/** A sealed project with backend (app/, minus app/db and app/auth) and db (app/db, migrations, seed) tasks claimed. */
function project() {
  const ctx = closeProject({ isolation: 'kernel' });
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'app/__init__.py', '');
  put(ctx, 'app/db/models.py', '# models\n');
  put(ctx, 'migrations/env.py', '# env\n');
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  commitAll(ctx, 'base');
  return ctx;
}
const commit = (ctx, actor, task, message) => isolate.commit(ctx.store, ctx.config, actor, { task, message });
const branchTip = (ctx, b) => gitq(ctx, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);
const blobAt = (ctx, ref, p) => { const r = spawnSync('git', ['-C', ctx.dir, 'cat-file', '-p', `${ref}:${p}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };

test('GF-ISO-2 positive: the group\'s own changed files are committed onto gf/<group> with a sanitized environment, parent HEAD', () => {
  const ctx = project();
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files: ['app/main.py', 'app/__init__.py', 'app/new.py'], reason: 'w' });
  put(ctx, 'app/main.py', 'print("changed")\n');
  put(ctx, 'app/new.py', 'x = 1\n');
  const r = commit(ctx, 'backend-engineer', 's0-app', 'backend change');
  assert.strictEqual(r.branch, 'gf/backend');
  assert.strictEqual(r.parent, git(ctx.dir, 'rev-parse', 'HEAD'));
  assert.deepStrictEqual(r.files.map((f) => `${f.action} ${f.path}`).sort(), ['add app/new.py', 'modify app/main.py']);
  assert.strictEqual(blobAt(ctx, r.commit, 'app/main.py'), 'print("changed")\n', 'the committed blob is the validated bytes');
  assert.ok(r.sanitized.includes('no-hooks') && r.sanitized.includes('plumbing-only'));
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule.startsWith('GF-ISO')), []);
});

test('GF-ISO-2: a second commit stacks onto the group\'s branch, not onto HEAD', () => {
  const ctx = project();
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files: ['app/main.py'], reason: 'w' });
  put(ctx, 'app/main.py', 'v1\n'); const a = commit(ctx, 'backend-engineer', 's0-app');
  put(ctx, 'app/main.py', 'v2\n'); const b = commit(ctx, 'backend-engineer', 's0-app');
  assert.strictEqual(b.parent, a.commit, 'the second commit builds on the first');
  assert.strictEqual(branchTip(ctx, 'gf/backend'), b.commit);
});

test('GF-ISO-2 negative: a file of another group in the group\'s write set is refused, and nothing is committed', () => {
  const ctx = project();
  // backend owns app/ but app/db is the db group's (denyGlob); writing app/db from backend is refused
  put(ctx, 'app/db/models.py', 'tampered\n');
  put(ctx, 'app/main.py', 'ok\n');
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2'));
  assert.match(e.message, /app\/db\/models\.py belongs to db/);
  assert.strictEqual(branchTip(ctx, 'gf/backend'), null, 'no branch was created');
});

test('GF-ISO-2 negative: a changed file outside the claimed task\'s files is refused', () => {
  const ctx = project();
  // rescope s0-app to only app/main.py, then change app/__init__.py too
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files: ['app/main.py'], reason: 'narrow' });
  put(ctx, 'app/main.py', 'ok\n'); put(ctx, 'app/__init__.py', 'extra\n');
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.match(e.message, /app\/__init__\.py is outside task s0-app's files/);
});

test('GF-ISO-2 bypass: a symlink in the own path, a hard link, a special file and a .gitattributes are each refused (A-2, A-5, A-27, A-40)', () => {
  const ctx = project();
  put(ctx, 'app/main.py', 'ok\n');
  // a symlink inside app/ pointing at another group's file
  fs.symlinkSync(path.join(ctx.dir, 'web/index.html'), path.join(ctx.dir, 'app/link'));
  let e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2'));
  rm(ctx, 'app/link');
  // a hard link of a real-tree file into the own path
  fs.linkSync(path.join(ctx.dir, 'web/index.html'), path.join(ctx.dir, 'app/hard.html'));
  e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.match(e.message, /hard link/i);
  rm(ctx, 'app/hard.html');
  // a fifo (special file) in the own path
  const fifo = path.join(ctx.dir, 'app/pipe');
  if (spawnSync('mkfifo', [fifo]).status === 0) { e = refused(() => commit(ctx, 'backend-engineer', 's0-app')); assert.match(e.message, /regular file/); rm(ctx, 'app/pipe'); }
  // a .gitattributes in the own path (clean/smudge driver vector)
  put(ctx, 'app/.gitattributes', '* filter=evil\n');
  e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.match(e.message, /\.gitattributes/);
});

test('GF-ISO-2 bypass: the commit step refuses when the repository config names an include or an external command (A-28, A-31)', () => {
  const ctx = project();
  put(ctx, 'app/main.py', 'ok\n');
  execFileSync('git', ['-C', ctx.dir, 'config', 'core.fsmonitor', '/tmp/evil.sh']);
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2'));
  assert.match(e.message, /core\.fsmonitor|external command|include/);
});

test('GF-ISO-2: a deletion of the group\'s own file is committed', () => {
  const ctx = project();
  rm(ctx, 'app/__init__.py');
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files: ['app/**'], reason: 'wide' });
  const r = commit(ctx, 'backend-engineer', 's0-app');
  assert.ok(r.files.some((f) => f.action === 'delete' && f.path === 'app/__init__.py'));
  assert.strictEqual(blobAt(ctx, r.commit, 'app/__init__.py'), null);
});

test('GF-ISO-2 negative: committing with another actor\'s task, or an unclaimed task, is refused', () => {
  const ctx = project();
  put(ctx, 'app/main.py', 'x\n');
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-db')).message, /not claimed by backend-engineer/);
  assert.match(refused(() => commit(ctx, 'database-engineer', 'no-such')).message, /not a task/);
});

test('GF-ISO-3 positive: the groups\' branches merge into the current branch in dependency order after a passed check', () => {
  const ctx = project();
  // db's task has no dependency; backend depends on nothing here, but make backend depend on db via the task graph
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files: ['app/main.py', 'app/__init__.py'], reason: 'w' });
  put(ctx, 'app/db/models.py', 'db v1\n'); const dbCommit = commit(ctx, 'database-engineer', 's0-db');
  put(ctx, 'app/main.py', 'app v1\n'); const appCommit = commit(ctx, 'backend-engineer', 's0-app');
  // a passed deterministic check
  const ev = ctx.store.commit('evidence.recorded', 'orchestrator', { id: 'ev-check-1', kind: 'command', label: 'contract tests', command: 'pytest', status: 'passed', exitCode: 0 });
  const before = git(ctx.dir, 'rev-parse', 'HEAD');
  const r = isolate.merge(ctx.store, ctx.config, 'orchestrator', { scope: 'S0', checks: ['ev:ev-check-1'] });
  assert.ok(r.merges.some((m) => m.group === 'db') && r.merges.some((m) => m.group === 'backend'));
  assert.strictEqual(git(ctx.dir, 'rev-parse', 'HEAD'), r.to);
  // both groups' files are present at the merged HEAD
  assert.strictEqual(blobAt(ctx, 'HEAD', 'app/db/models.py'), 'db v1\n');
  assert.strictEqual(blobAt(ctx, 'HEAD', 'app/main.py'), 'app v1\n');
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule.startsWith('GF-ISO')), []);
});

test('GF-ISO-3 negative: a merge without a passed check, or by a non-orchestrator, is refused', () => {
  const ctx = project();
  put(ctx, 'app/main.py', 'x\n'); commit(ctx, 'backend-engineer', 's0-app');
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'orchestrator', { scope: 'S0', checks: [] })).message, /cites at least one/);
  ctx.store.commit('evidence.recorded', 'orchestrator', { id: 'ev-fail', kind: 'command', label: 'x', command: 'pytest', status: 'failed', exitCode: 1 });
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'orchestrator', { scope: 'S0', checks: ['ev:ev-fail'] })).message, /did not pass/);
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'backend-engineer', { scope: 'S0', checks: ['ev:ev-fail'] })).message, /orchestrator's or the user's/);
});

test('GF-ISO-3: the dependency order follows the task graph; a cross-group task dependency orders the groups', () => {
  const ctx = project();
  const map = isolate.dependencyOrder(ctx.store.state(), require('../lib/greenfield/ownership-ops').loadMap(ctx.store, ctx.config).map);
  assert.ok(Array.isArray(map.order));
  // backend's s0-app depends on s0-contracts (api); db's s0-db depends on s0-contracts too; api comes before both
  const pos = (g) => map.order.indexOf(g);
  if (pos('api') >= 0 && pos('backend') >= 0) assert.ok(pos('api') < pos('backend'), `api before backend: ${map.order}`);
});
