'use strict';
// S3.1 I6: the hidden acceptance suite can never be read by an agent. A configured hidden path (project config
// gf.hiddenSuite.path, and/or env ECCODE_GF_HIDDEN) is denied by the PreToolUse guard to every agent, main session
// and subagents, for Read, Grep, Glob, NotebookRead, the file-writing tools and Bash commands that reference it (after
// normalisation: relative paths, `..`, symlinks, `cd`, glob prefixes), rule GF-HID-1, each denial logged once in the
// rejection log (I4). Only the engine's acceptance runner function reads it. The group kernel sandbox masks it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { gfProject } = require('./fixtures/gf/flow');
const { loadConfig } = require('../lib/config');
const sandbox = require('../lib/greenfield/sandbox');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const CANARY = 'HIDDEN-SUITE-CANARY-4417';
const hidden = () => require('../lib/greenfield/hidden');
const entries = (dir) => { const f = path.join(dir, '.eccode', 'rejections.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

/** A project whose config names `acceptance-hidden/` as the hidden suite, holding one file with a canary. */
function hiddenProject() {
  const ctx = gfProject();
  const dir = path.join(ctx.dir, 'acceptance-hidden');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.py'), `# ${CANARY}\n`);
  fs.writeFileSync(path.join(dir, 'sub', 'y.py'), `# ${CANARY}\n`);
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'app', 'main.py'), 'print("app")\n');
  const file = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.gf = { ...(cfg.gf || {}), hiddenSuite: { path: 'acceptance-hidden' } };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  ctx.config = loadConfig(ctx.dir);
  ctx.hidden = dir;
  return ctx;
}

function hook(ctx, toolName, toolInput, { agent, cwd, env = {} } = {}) {
  const input = { tool_name: toolName, tool_input: toolInput, cwd: cwd || ctx.dir, ...(agent ? { agent_type: agent } : {}) };
  const e = { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_HOOKS: '', ...env };
  delete e.ECCODE_SEED_KEY;
  if (!('ECCODE_GF_HIDDEN' in env)) delete e.ECCODE_GF_HIDDEN;
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

/** Assert a denial with GF-HID-1 that added exactly one GF-HID-1 log entry. */
function denied(ctx, ...args) {
  const before = entries(ctx.dir).length;
  const out = hook(ctx, ...args);
  assert.ok(out && out.permissionDecision === 'deny' && /GF-HID-1/.test(out.permissionDecisionReason), `${JSON.stringify(args)} -> ${JSON.stringify(out)}`);
  const log = entries(ctx.dir);
  assert.strictEqual(log.length, before + 1, `${JSON.stringify(args)}: exactly one entry`);
  assert.strictEqual(log[log.length - 1].rule, 'GF-HID-1');
  assert.ok(!JSON.stringify(log).includes(CANARY));
  return log[log.length - 1];
}
function allowed(ctx, ...args) {
  const before = entries(ctx.dir).length;
  const out = hook(ctx, ...args);
  assert.ok(!out || out.permissionDecision !== 'deny', `${JSON.stringify(args)} -> ${JSON.stringify(out)}`);
  assert.strictEqual(entries(ctx.dir).length, before, `${JSON.stringify(args)}: no entry`);
}

test('I6: a Read of a file in the hidden dir is denied (main session and subagent) and logged once with GF-HID-1', () => {
  const ctx = hiddenProject();
  const e = denied(ctx, 'Read', { file_path: path.join(ctx.hidden, 'x.py') });
  assert.strictEqual(e.actor, 'orchestrator');
  assert.strictEqual(e.action, 'hook.Read');
  const s = denied(ctx, 'Read', { file_path: 'acceptance-hidden/sub/y.py' }, { agent: 'eccode:test-engineer' });
  assert.strictEqual(s.actor, 'test-engineer');
  denied(ctx, 'NotebookRead', { notebook_path: path.join(ctx.hidden, 'n.ipynb') });
  denied(ctx, 'Edit', { file_path: path.join(ctx.hidden, 'x.py'), old_string: 'a', new_string: 'b' });
  denied(ctx, 'Write', { file_path: path.join(ctx.hidden, 'new.py'), content: '' });
});

test('I6: Bash commands that reference the hidden path are denied: cat, relative, ../ traversal, cd, glob prefix, recursive readers', () => {
  const ctx = hiddenProject();
  denied(ctx, 'Bash', { command: `cat ${ctx.hidden}/x.py` });
  denied(ctx, 'Bash', { command: 'cat acceptance-hidden/x.py' });
  denied(ctx, 'Bash', { command: 'head -1 app/../acceptance-hidden/x.py' });
  denied(ctx, 'Bash', { command: 'cat ../acceptance-hidden/x.py' }, { cwd: path.join(ctx.dir, 'app') });
  denied(ctx, 'Bash', { command: 'cd app && cat ../acceptance-hidden/sub/y.py' });
  denied(ctx, 'Bash', { command: 'cat accept*/x.py' });
  denied(ctx, 'Bash', { command: 'python3 -c "print(open(\'acceptance-hidden/x.py\').read())"' });
  denied(ctx, 'Bash', { command: 'grep -r CANARY .' });
  denied(ctx, 'Bash', { command: 'tar cf - . | wc -c' });
  allowed(ctx, 'Bash', { command: 'cat app/main.py' });
  allowed(ctx, 'Bash', { command: 'grep -r print app' });
});

test('I6: a ../ traversal and a symlink into the hidden dir are denied for the file tools', () => {
  const ctx = hiddenProject();
  denied(ctx, 'Read', { file_path: path.join(ctx.dir, 'app', '..', 'acceptance-hidden', 'x.py') });
  denied(ctx, 'Read', { file_path: '../acceptance-hidden/x.py' }, { cwd: path.join(ctx.dir, 'app') });
  fs.symlinkSync(ctx.hidden, path.join(ctx.dir, 'innocent'));
  denied(ctx, 'Read', { file_path: path.join(ctx.dir, 'innocent', 'x.py') });
  denied(ctx, 'Bash', { command: 'cat innocent/x.py' });
});

test('I6: Grep and Glob over the hidden dir, or over a directory that contains it, are denied', () => {
  const ctx = hiddenProject();
  denied(ctx, 'Grep', { pattern: 'CANARY', path: ctx.hidden });
  denied(ctx, 'Grep', { pattern: 'CANARY' });
  denied(ctx, 'Grep', { pattern: 'CANARY', path: ctx.dir });
  denied(ctx, 'Glob', { pattern: 'acceptance-hidden/**' });
  denied(ctx, 'Glob', { pattern: '**/*.py' });
  allowed(ctx, 'Grep', { pattern: 'print', path: path.join(ctx.dir, 'app') });
  allowed(ctx, 'Glob', { pattern: 'app/*.py' });
});

test('I6: a read of a non-hidden file is allowed and not logged; ECCODE_GF_HIDDEN adds a hidden path', () => {
  const ctx = hiddenProject();
  allowed(ctx, 'Read', { file_path: path.join(ctx.dir, 'app', 'main.py') });
  allowed(ctx, 'Read', { file_path: path.join(ctx.dir, 'acceptance-hidden-not', 'z.py') });
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hidden-env-'));
  fs.writeFileSync(path.join(extra, 'h.py'), CANARY);
  allowed(ctx, 'Read', { file_path: path.join(extra, 'h.py') });
  denied(ctx, 'Read', { file_path: path.join(extra, 'h.py') }, { env: { ECCODE_GF_HIDDEN: extra } });
  assert.strictEqual(entries(ctx.dir).length, 1);
});

test('I6: the engine acceptance runner function reads the hidden suite; it reads nothing outside it', () => {
  const ctx = hiddenProject();
  assert.ok(hidden().readForAcceptance(ctx.dir, ctx.config, 'x.py').includes(CANARY));
  assert.ok(hidden().readForAcceptance(ctx.dir, ctx.config, 'sub/y.py').includes(CANARY));
  assert.throws(() => hidden().readForAcceptance(ctx.dir, ctx.config, '../app/main.py'), /GF-HID-1/);
});

test('I6: the hooks matcher sends Read, Grep and Glob to the guard (plugin hooks.json and the project install)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse.map((g) => g.matcher).join('|').split('|');
  for (const t of ['Read', 'Grep', 'Glob', 'NotebookRead', 'Bash']) assert.ok(m.includes(t), `hooks.json matcher lacks ${t}`);
  const src = fs.readFileSync(path.join(ROOT, 'lib/install.js'), 'utf8');
  assert.match(src, /PreToolUse: \{ matcher: '[^']*\bRead\|Grep\|Glob\b/);
});

const pr = sandbox.probe();
const BWRAP = Boolean(pr.bwrap);
test('I6 sandbox: a command in the group sandbox (bubblewrap) cannot read a masked hidden file; the control without the mask can', { skip: BWRAP ? false : 'bubblewrap is not usable here' }, () => {
  const ctx = hiddenProject();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hid-tmp-'));
  const rw = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hid-rw-'));
  const target = path.join(ctx.hidden, 'x.py');
  const go = (spec, mech) => { const a = sandbox.argv(mech, { cwd: rw, rw: [rw], tmp, net: false, probe: pr, ...spec }, ['cat', target]); return spawnSync(a[0], a.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH } }); };
  const control = go({}, 'bwrap');
  assert.ok(control.stdout.includes(CANARY), `control: ${control.stderr}`);
  const masks = hidden().maskTargets(ctx.dir, ctx.config);
  assert.ok(masks.includes(fs.realpathSync(ctx.hidden)), JSON.stringify(masks));
  for (const mech of pr.landlock ? ['bwrap', 'both'] : ['bwrap']) {
    const r = go({ masked: masks }, mech);
    assert.ok(!r.stdout.includes(CANARY), `${mech}: the hidden file was readable: ${r.stdout}`);
  }
  assert.throws(() => sandbox.argv('landlock', { cwd: rw, rw: [rw], tmp, probe: pr, masked: masks }, ['true']), /GF-HID-1/);
});

test('I6 sandbox end to end: a group role\'s gf_run command cannot read the hidden suite (outside or inside the project)', { skip: BWRAP ? false : 'bubblewrap is not usable here' }, () => {
  const X = require('./fixtures/gf/close');
  const mcp = require('../lib/mcp');
  const wrap = require('../lib/greenfield/wrap');
  const ctx = X.closeProject({ isolation: 'kernel' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hidden-out-'));
  fs.writeFileSync(path.join(outside, 'h.py'), CANARY);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
  put('acceptance-hidden/x.py', CANARY);
  const file = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.gf = { ...(cfg.gf || {}), hiddenSuite: { path: [outside, 'acceptance-hidden'] } };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  ctx.config = loadConfig(ctx.dir);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  X.F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  put('app/__init__.py', '');
  put('app/r.py', [
    'import pathlib, sys',
    'out = []',
    `for p in [${JSON.stringify(path.join(outside, 'h.py'))}, "acceptance-hidden/x.py"]:`,
    '    try: out.append("READ:" + pathlib.Path(p).read_text())',
    '    except Exception as e: out.append("DENIED:" + type(e).__name__)',
    'pathlib.Path("app/out.txt").write_text("\\n".join(out))',
  ].join('\n'));
  put('.gitignore', '.eccode/\n.gf-worktrees/\n');
  X.commitAll(ctx, 'reader');
  X.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/r.py', reason: 'the plan-pinned check', from: ['app/main.py', 'app/__init__.py'] });
  const r = mcp.tools().find((t) => t.name === 'gf_run').handler({ label: 'check', command: 'python3 app/r.py', task: 's0-app' }, { store: ctx.store, config: ctx.config, actor: 'backend-engineer' });
  const got = fs.readFileSync(path.join(ctx.dir, 'app', 'out.txt'), 'utf8');
  assert.ok(!got.includes(CANARY), `the sandboxed command read the hidden suite: ${got} (${JSON.stringify(r.isolation)})`);
  assert.strictEqual(got.split('\n').filter((l) => l.startsWith('DENIED:')).length, 2, got);
});
