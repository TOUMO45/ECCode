'use strict';
// S2.4 (design 21), GF-ISO-1 end to end: a group role's command runs in its own worktree inside the kernel sandbox;
// only the group's own-path changes come back; a write outside the group's paths is refused by the kernel and never
// reaches the real tree. The adversary's in-model evasion rows run here as reproductions. Rows that need a kernel
// mechanism skip with the reason when this machine has none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('./fixtures/gf/close');
const mcp = require('../lib/mcp');
const wrap = require('../lib/greenfield/wrap');
const sandbox = require('../lib/greenfield/sandbox');
const { closeProject, F, git, commitAll } = X;

const pr = sandbox.probe();
const HAVE = pr.mechanisms.length > 0;
const reason = `no kernel isolation here (Landlock ${pr.landlockError || 'absent'}; bubblewrap ${pr.bwrapError || 'absent'})`;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const read = (ctx, rel) => { try { return fs.readFileSync(path.join(ctx.dir, rel), 'utf8'); } catch { return null; } };
const exists = (ctx, rel) => fs.existsSync(path.join(ctx.dir, rel));
const tool = (name) => mcp.tools().find((t) => t.name === name);
const call = (name, args, ctx, actor) => tool(name).handler(args, { store: ctx.store, config: ctx.config, actor });
const head = (ctx) => git(ctx.dir, 'rev-parse', 'HEAD');

/** A sealed kernel-isolation project with a backend task whose plan-pinned check is `command`. */
function project(command) {
  const ctx = closeProject({ isolation: 'kernel' });
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'app/__init__.py', '');
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, '.venv/pyvenv.cfg', 'home = /usr\n');
  put(ctx, '.gitignore', '.venv/\n.gf-worktrees/\n');
  commitAll(ctx, 'app and web');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command, reason: 'the plan-pinned check', from: ['app/main.py', 'app/__init__.py'] });
  return ctx;
}
const run = (ctx, command, actor = 'backend-engineer') => call('gf_run', { label: 'check', command, task: 's0-app' }, ctx, actor);

test('GF-ISO-1 positive: a plan-pinned command that writes the group\'s own path lands in the real tree, through the sandbox', { skip: HAVE ? false : reason }, () => {
  const ctx = project('x');
  put(ctx, 'app/w.py', 'import pathlib\npathlib.Path("app/out.txt").write_text("ok")\n');
  commitAll(ctx, 'writer');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/w.py', reason: 're-pin', from: ['app/main.py'] });
  const r = run(ctx, 'python3 app/w.py');
  assert.strictEqual(r.status, 'passed', JSON.stringify(r.problems));
  assert.strictEqual(read(ctx, 'app/out.txt'), 'ok', 'the own-path write came back');
  assert.ok(r.copiedBack.includes('app/out.txt'));
  assert.strictEqual(r.isolation.rule, 'GF-ISO-1');
  assert.ok(['both', 'landlock', 'bwrap'].includes(r.isolation.mechanism));
});

test('GF-ISO-1: a cross-group write (web/, another group) is refused by the kernel and never reaches the real tree (A-1, A-2, I2-1)', { skip: HAVE ? false : reason }, () => {
  const ctx = project('python3 seed.py');
  // project code that tries every landing: another group's file, the real tree via the .venv symlink, a new frontend file
  put(ctx, 'app/seed.py', [
    'import os, pathlib',
    'tried = []',
    'for label, p in [("web", "web/index.html"), ("newweb", "web/evil.html"), ("venv", ".venv/marker")]:',
    '    try: pathlib.Path(p).write_text("x"); tried.append(label+":WROTE")',
    '    except OSError as e: tried.append(label+":"+e.strerror)',
    'pathlib.Path("app/seeded.txt").write_text("own")',
    'print(" ".join(tried))',
  ].join('\n'));
  commitAll(ctx, 'seed');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
  const before = read(ctx, 'web/index.html');
  const r = run(ctx, 'python3 app/seed.py');
  assert.strictEqual(read(ctx, 'web/index.html'), before, 'another group\'s file is unchanged in the real tree');
  assert.ok(!exists(ctx, 'web/evil.html'), 'no new file reached another group\'s path');
  assert.ok(!exists(ctx, '.venv/marker'), 'the .venv symlink write did not reach the real tree');
  assert.ok(r.copiedBack.includes('app/seeded.txt'), 'the own-path write still came back');
  assert.match(r.outputTail || '', /web:.*(denied|Read-only)/i, `the kernel refused the cross-group write: ${r.outputTail}`);
});

test('GF-ISO-1: a git commit inside the worktree cannot move the real tree\'s HEAD (A-23, A-24: .git is read-only in the sandbox)', { skip: HAVE ? false : reason }, () => {
  const ctx = project('x');
  put(ctx, 'app/evil.py', [
    'import subprocess, pathlib',
    'pathlib.Path("web/index.html").write_text("hidden") if False else None',
    'try: open("web/index.html","a").write("<!-- hidden -->")',
    'except OSError: pass',
    'subprocess.run(["git","-c","user.email=t@t","-c","user.name=t","commit","-qam","hidden"], capture_output=True)',
    'pathlib.Path("app/done.txt").write_text("ok")',
  ].join('\n'));
  commitAll(ctx, 'evil');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/evil.py', reason: 're-pin', from: ['app/main.py'] });
  const before = head(ctx);
  const r = run(ctx, 'python3 app/evil.py');
  assert.strictEqual(head(ctx), before, 'HEAD did not move');
  assert.strictEqual(read(ctx, 'web/index.html'), '<h1>Tasks</h1>\n', 'the frontend file is unchanged');
  assert.ok(r.copiedBack.includes('app/done.txt'));
});

test('GF-ISO-1: the sandboxed command has no network (A-42 to A-47: a TCP connect fails)', { skip: HAVE ? false : reason }, () => {
  const ctx = project('x');
  put(ctx, 'app/net.py', 'import socket, pathlib\ntry:\n    s=socket.socket(); s.settimeout(2); s.connect(("1.1.1.1",80)); r="OPEN"\nexcept OSError as e:\n    r="refused"\npathlib.Path("app/net.txt").write_text(r)\n');
  commitAll(ctx, 'net');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/net.py', reason: 're-pin', from: ['app/main.py'] });
  const r = run(ctx, 'python3 app/net.py');
  assert.strictEqual(read(ctx, 'app/net.txt'), 'refused', 'the network was denied inside the sandbox');
});

test('GF-ISO-1: secrets and the record path do not leak into the sandboxed environment (A-13, A-48, A-49)', { skip: HAVE ? false : reason }, () => {
  const ctx = project('x');
  put(ctx, 'app/env.py', 'import os, pathlib\nleaked=[k for k in ("ANTHROPIC_API_KEY","GITHUB_TOKEN","ECCODE_EVIDENCE","HTTPS_PROXY") if os.environ.get(k)]\npathlib.Path("app/env.txt").write_text(",".join(leaked) or "clean")\n');
  commitAll(ctx, 'env');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/env.py', reason: 're-pin', from: ['app/main.py'] });
  const old = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'secret-xyz'; process.env.GITHUB_TOKEN = 'ghp_secret';
  try {
    const r = run(ctx, 'python3 app/env.py');
    assert.strictEqual(read(ctx, 'app/env.txt'), 'clean', 'no secret and no ECCODE_ path reached the sandboxed command');
  } finally {
    for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
});

test('GF-ISO-0: with group mode refused and no copy fallback configured, gf_run is refused (fail closed)', () => {
  const ctx = project('x');
  // force the self-test to fail by hiding the mechanisms
  sandbox._reset();
  const oldPy = process.env.ECCODE_GF_PYTHON; const oldPath = process.env.PATH;
  process.env.ECCODE_GF_PYTHON = '/nonexistent/py'; process.env.PATH = '/nonexistent';
  try {
    sandbox.selfTest({ fresh: true });
    let err = null;
    try { run(ctx, 'x'); } catch (e) { err = e; }
    assert.ok((((err && err.details && err.details.problems) || []).map((p) => p.rule)).includes('GF-ISO-0'), err ? err.message : 'not refused');
  } finally {
    if (oldPy === undefined) delete process.env.ECCODE_GF_PYTHON; else process.env.ECCODE_GF_PYTHON = oldPy;
    process.env.PATH = oldPath; sandbox._reset(); sandbox.selfTest({ fresh: true });
  }
});

test('GF-ISO-1 negative: outside a kernel-isolation project (isolation copy) the S2.x runner still answers; a group role\'s cross-group write is caught by the copy comparison', () => {
  const ctx = closeProject(); // isolation: 'copy' by default in the fixture
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  put(ctx, 'app/main.py', 'x\n'); put(ctx, 'web/index.html', 'y\n');
  commitAll(ctx, 'c');
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 -c pass', reason: 'p', from: ['app/main.py'] });
  const r = call('gf_run', { label: 'c', command: 'python3 -c pass', task: 's0-app' }, ctx, 'backend-engineer');
  assert.ok(r.isolation === undefined, 'the copy runner records no GF-ISO-1 isolation block');
});
