'use strict';
// S2.4 rule-removal battery backing (P3): each GF-ISO guard has at least two tests that ONLY it catches, so removing
// the guard makes two or more tests fail. These isolate a single check per case: the file is otherwise valid (owned,
// in-task, a regular file, one link), so the only thing that refuses it is the guard under test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('./fixtures/gf/close');
const isolate = require('../lib/greenfield/isolate');
const sandbox = require('../lib/greenfield/sandbox');
const audit = require('../lib/greenfield/audit');
const wrap = require('../lib/greenfield/wrap');
const { closeProject, F, commitAll } = X;

const put = (ctx, rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); if (mode) fs.chmodSync(path.join(ctx.dir, rel), mode); };
const rm = (ctx, rel) => fs.rmSync(path.join(ctx.dir, rel), { force: true });
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const refused = (fn) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e, 'expected a refusal'); return e; };
const commit = (ctx, actor, task) => isolate.commit(ctx.store, ctx.config, actor, { task });

/** A sealed project; backend owns app/ (minus app/db, app/auth), task s0-app's files set to `files`. */
function project(files = ['app/**']) {
  const ctx = closeProject({ isolation: 'kernel' });
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'app/db/models.py', '# models\n');
  put(ctx, 'migrations/env.py', '# env\n');
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  commitAll(ctx, 'base');
  F(ctx, 'task.rescoped', 'orchestrator', { task: 's0-app', files, reason: 'set files' });
  return ctx;
}

// ---- GF-ISO-2 ownership check (two tests) ----
test('GF-ISO-2 ownership #1: a new file of another group placed in the own prefix is refused', () => {
  const ctx = project(['app/**']);
  put(ctx, 'app/db/new.py', 'tampered\n'); // app/db is db's; backend's prefix app/ reaches it
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2')); assert.match(e.message, /belongs to db/);
});
test('GF-ISO-2 ownership #2: a modified file of another group within the own prefix is refused', () => {
  const ctx = project(['app/**']);
  put(ctx, 'app/db/models.py', 'changed by backend\n');
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /belongs to db/);
});

// ---- GF-ISO-2 task-membership check (two tests) ----
test('GF-ISO-2 task #1: an owned file outside the claimed task\'s files is refused', () => {
  const ctx = project(['app/main.py']);
  put(ctx, 'app/extra.py', 'x\n'); // owned by backend, but task files are only app/main.py
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /outside task s0-app's files/);
});
test('GF-ISO-2 task #2: a second owned file outside the task is refused even when the first is in-task', () => {
  const ctx = project(['app/main.py']);
  put(ctx, 'app/main.py', 'ok\n'); put(ctx, 'app/other.py', 'y\n');
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /app\/other\.py is outside task/);
});

// ---- GF-ISO-2 symlink-resolve check (two tests) ----
// A REGULAR file reached through a symlinked parent directory: only the resolve check catches it (it is a regular file,
// so the regular-file check passes; it is under app/, so the ownership and task checks pass; its real path is elsewhere).
test('GF-ISO-2 symlink #1: a regular file reached through a symlinked directory that leaves the own path is refused', () => {
  const ctx = project(['app/**']);
  // app/into is a symlink to web/ (another group); app/into/x.py is a regular file whose real path is web/x.py
  fs.symlinkSync(path.join(ctx.dir, 'web'), path.join(ctx.dir, 'app/into'));
  fs.writeFileSync(path.join(ctx.dir, 'web', 'x.py'), 'regular\n');
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2')); assert.match(e.message, /through a symlink|resolves/);
});
test('GF-ISO-2 symlink #2: a regular file reached through a symlinked directory that leaves the project is refused', () => {
  const ctx = project(['app/**']);
  const outside = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gf-out-'));
  fs.writeFileSync(path.join(outside, 'x.py'), 'regular\n');
  fs.symlinkSync(outside, path.join(ctx.dir, 'app/out'));
  const e = refused(() => commit(ctx, 'backend-engineer', 's0-app'));
  assert.ok(rulesOf(e).includes('GF-ISO-2')); assert.match(e.message, /outside the project|through a symlink/);
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---- GF-ISO-2 hard-link check (two tests) ----
test('GF-ISO-2 hardlink #1: an owned, in-task file with two hard links is refused', () => {
  const ctx = project(['app/**']);
  put(ctx, 'app/a.py', 'shared\n');
  fs.linkSync(path.join(ctx.dir, 'app/a.py'), path.join(ctx.dir, 'app/b.py'));
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /hard link/i);
});
test('GF-ISO-2 hardlink #2: a hard link to an existing own file is refused (both names share an inode)', () => {
  const ctx = project(['app/**']);
  fs.linkSync(path.join(ctx.dir, 'app/main.py'), path.join(ctx.dir, 'app/alias.py'));
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /hard link/i);
});

// ---- GF-ISO-2 regular-file check (two tests) ----
test('GF-ISO-2 special #1: a fifo in the own, in-task path is refused', { skip: spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0 ? false : 'no mkfifo' }, () => {
  const ctx = project(['app/**']);
  spawnSync('mkfifo', [path.join(ctx.dir, 'app/pipe.py')]);
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /regular file/);
});
test('GF-ISO-2 special #2: a unix socket in the own path is refused', () => {
  const ctx = project(['app/**']);
  const net = require('net'); const sockPath = path.join(ctx.dir, 'app/s.py');
  const srv = net.createServer();
  try {
    srv.listen(sockPath);
    if (!fs.existsSync(sockPath) || !fs.lstatSync(sockPath).isSocket()) return; // platform without unix sockets
    assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /regular file/);
  } finally { srv.close(); try { fs.rmSync(sockPath, { force: true }); } catch { /* */ } }
});

// ---- GF-ISO-2 config-include check (two tests) ----
test('GF-ISO-2 config #1: a repository fsmonitor command blocks the commit', () => {
  const ctx = project(['app/**']); put(ctx, 'app/main.py', 'ok\n');
  spawnSync('git', ['-C', ctx.dir, 'config', 'core.fsmonitor', '/tmp/x.sh']);
  assert.ok(rulesOf(refused(() => commit(ctx, 'backend-engineer', 's0-app'))).includes('GF-ISO-2'));
});
test('GF-ISO-2 config #2: a repository include.path blocks the commit', () => {
  const ctx = project(['app/**']); put(ctx, 'app/main.py', 'ok\n');
  spawnSync('git', ['-C', ctx.dir, 'config', 'include.path', '/tmp/evil.inc']);
  assert.match(refused(() => commit(ctx, 'backend-engineer', 's0-app')).message, /include|external command|config/i);
});

// ---- GF-ISO-0 self-test gate (two tests) ----
function withBrokenSandbox(fn) {
  sandbox._reset();
  const oldPy = process.env.ECCODE_GF_PYTHON; const oldPath = process.env.PATH;
  process.env.ECCODE_GF_PYTHON = '/nonexistent/py'; process.env.PATH = '/nonexistent';
  try { sandbox.selfTest({ fresh: true }); return fn(); }
  finally { if (oldPy === undefined) delete process.env.ECCODE_GF_PYTHON; else process.env.ECCODE_GF_PYTHON = oldPy; process.env.PATH = oldPath; sandbox._reset(); sandbox.selfTest({ fresh: true }); }
}
test('GF-ISO-0 gate #1: groupModeProblems refuses when the self-test fails and no copy fallback is set', () => {
  withBrokenSandbox(() => { const p = sandbox.groupModeProblems({}); assert.strictEqual(p.length, 1); assert.strictEqual(p[0].rule, 'GF-ISO-0'); });
});
test('GF-ISO-0 gate #2: a sandboxed run is refused fail-closed when the self-test fails', () => {
  const ctx = project(['app/main.py']);
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 -c pass', reason: 'p', from: ['app/main.py'] });
  withBrokenSandbox(() => {
    const e = refused(() => isolate.run(ctx.store, ctx.config, 'backend-engineer', { label: 'x', command: 'python3 -c pass', shell: true }));
    assert.ok(rulesOf(e).includes('GF-ISO-0'));
  });
});

// ---- GF-ISO-4 whole-project widening refusal (two tests) ----
test('GF-ISO-4 widen #1: a glob with no directory prefix is refused by writeSet', () => {
  assert.match(sandbox.writeSet({ groups: { g: { globs: ['*.py'], denyGlobs: [] } } }, 'g').problems[0].message, /whole project/);
});
test('GF-ISO-4 widen #2: a bare ** glob is refused by writeSet', () => {
  assert.match(sandbox.writeSet({ groups: { g: { globs: ['**'], denyGlobs: [] } } }, 'g').problems[0].message, /whole project/);
});

// ---- GF-ISO-3 check-passed requirement (two tests) ----
function mergeable() {
  const ctx = project(['app/main.py']);
  put(ctx, 'app/main.py', 'v1\n'); commit(ctx, 'backend-engineer', 's0-app');
  return ctx;
}
test('GF-ISO-3 check #1: a merge citing a failed check is refused', () => {
  const ctx = mergeable();
  ctx.store.commit('evidence.recorded', 'orchestrator', { id: 'ev-f1', kind: 'command', label: 'x', command: 'pytest', status: 'failed', exitCode: 1 });
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'orchestrator', { scope: 'S0', checks: ['ev:ev-f1'] })).message, /did not pass/);
});
test('GF-ISO-3 check #2: a merge citing a non-existent check is refused', () => {
  const ctx = mergeable();
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'orchestrator', { scope: 'S0', checks: ['ev:nope'] })).message, /not (an earlier )?recorded/);
});

// ---- GF-ISO-3 actor restriction (two tests) ----
test('GF-ISO-3 actor #1: a group role cannot merge', () => {
  const ctx = mergeable();
  ctx.store.commit('evidence.recorded', 'orchestrator', { id: 'ev-p', kind: 'command', label: 'x', command: 'pytest', status: 'passed', exitCode: 0 });
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'backend-engineer', { scope: 'S0', checks: ['ev:ev-p'] })).message, /orchestrator's or the user's/);
});
test('GF-ISO-3 actor #2: a reviewer role cannot merge', () => {
  const ctx = mergeable();
  ctx.store.commit('evidence.recorded', 'orchestrator', { id: 'ev-p2', kind: 'command', label: 'x', command: 'pytest', status: 'passed', exitCode: 0 });
  assert.match(refused(() => isolate.merge(ctx.store, ctx.config, 'technical-reviewer', { scope: 'S0', checks: ['ev:ev-p2'] })).message, /orchestrator's or the user's/);
});

// ---- GF-ISO-0 R-1 (S2.4 review): the run uses only a self-test-passing mechanism (two tests) ----
test('R-1 #1: a sandboxed run is refused fail-closed when the self-test marks no mechanism usable, even though one is available', () => {
  const ctx = project(['app/main.py']);
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 -c pass', reason: 'p', from: ['app/main.py'] });
  const realSelfTest = sandbox.selfTest;
  sandbox.selfTest = () => ({ ok: true, usable: [], platform: 'linux', mechanisms: {}, reasons: ['forced: no mechanism contained the canary'], landlock: { abi: 7 }, bwrap: { version: 'x' }, pidns: true });
  try {
    const e = refused(() => isolate.run(ctx.store, ctx.config, 'backend-engineer', { label: 'x', command: 'python3 -c pass', shell: true }));
    assert.ok(rulesOf(e).includes('GF-ISO-0')); assert.match(e.message, /self-test-passing/);
  } finally { sandbox.selfTest = realSelfTest; }
});
test('R-1 #2: choose is called with the self-test usable set, so an available-but-not-usable mechanism is never run', () => {
  // unit-level guarantee behind #1: with landlock available but not usable, choose picks bwrap or null, never landlock
  const both = { mechanisms: ['landlock', 'bwrap'], landlock: { abi: 7 }, bwrap: {} };
  assert.notStrictEqual(sandbox.choose(both, {}, ['bwrap']), 'landlock');
  assert.strictEqual(sandbox.choose({ mechanisms: ['landlock'], landlock: { abi: 7 } }, {}, []), null);
});
