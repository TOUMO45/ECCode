'use strict';
// Regression tests for the round-4 critique of S2 (security-reviewer, review rev-mw6rx0pf-01727481 on tree bceec2c),
// each named by its finding id (node --test --test-name-pattern "^E2-3" tests/gf-review-s2-e2.test.js). E2-1 to E2-4
// are shell forms the hook did not model; the owner's round-5 decision closes that class structurally (GF-RUN-1: a
// group role has no shell), so each test now expects the shell call denied. This file uses only modules that exist
// at the reviewed commit, so each test fails there on its assertion. Each failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const closure = require('../lib/greenfield/closure');
const preflight = require('../lib/greenfield/preflight');
const { install } = require('../lib/install');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const X = require('./fixtures/gf/close');
const { closeProject, F } = X;

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const CLI = path.join(ROOT, 'bin/eccode-gf.js');
const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
function hook(ctx, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: tool, agent_type: `eccode:${role}`, tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
function team() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  for (const [rel, text] of [['web/index.html', '<h1>Tasks</h1>\n'], ['app/main.py', 'print("app")\n']]) {
    fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, rel), text);
  }
  return ctx;
}
const denied = (ctx, role, command) => {
  const r = hook(ctx, role, 'Bash', { command });
  assert.strictEqual(r.decision, 'deny', `${role}: ${command}: ${r.reason || 'allowed'}`);
  assert.match(r.reason, /GF-RUN-1/);
};

test('E2-1: a group role\'s mv of another group\'s file, a guard config or a sealed contract out of the project is denied', () => {
  const ctx = team();
  for (const src of ['web/index.html', '.eccode/security.json', 'contracts/openapi.json']) denied(ctx, 'backend-engineer', `mv ${src} /tmp/e2-1-moved`);
});
test('E2-2: a hard link cannot be made from a group role\'s shell, and a file with more than one link is refused to the file tools', () => {
  const ctx = team();
  denied(ctx, 'backend-engineer', 'ln -f web/index.html app/main.py');
  denied(ctx, 'backend-engineer', 'cp -l contracts/openapi.json app/main.py');
  fs.linkSync(path.join(ctx.dir, 'web/index.html'), path.join(ctx.dir, 'app/linked.py')); // made earlier, by anyone
  const r = hook(ctx, 'backend-engineer', 'Write', { file_path: path.join(ctx.dir, 'app/linked.py'), content: 'x' });
  assert.strictEqual(r.decision, 'deny', r.reason);
  assert.match(r.reason, /hard link/);
});
test('E2-3: a cd followed by ; or a newline, and pushd, cannot lead a group role\'s write into another group', () => {
  const ctx = team();
  denied(ctx, 'backend-engineer', 'cd app; echo x > ../web/index.html');
  denied(ctx, 'backend-engineer', 'cd app\necho y >> ../web/index.html');
  denied(ctx, 'backend-engineer', 'pushd app && echo z >> ../web/index.html');
});
test('E2-4: a subagent\'s git apply, git mv and git rm are not available to a group role', () => {
  const ctx = team();
  denied(ctx, 'backend-engineer', 'git apply /tmp/e2-4.diff');
  denied(ctx, 'backend-engineer', 'git mv web/index.html app/index.html');
  denied(ctx, 'backend-engineer', 'git rm contracts/openapi.json');
});
test('E2-5: GF-OWN-4 attribution sees both names of a committed cross-group rename', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'web/index.html'), '<h1>Tasks</h1>\n<ul id="tasks"></ul>\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'sealed, with a frontend page');
  const base = gitIn(ctx.dir, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  gitIn(ctx.dir, 'mv', 'web/index.html', 'app/main.py');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'backend work');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.completed', 'backend-engineer', { task: 's0-app', handoffId: 'ho-s0-app', filesChanged: ['app/main.py'] });
  const r = spawnSync(process.execPath, [CLI, 'attribute', '--base', base, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  assert.match(`${r.stdout}${r.stderr}`, /web\/index\.html was changed but no completed task of frontend declares it/);
});
test('E2-6: a dispatch input that is a hard link to the event log is refused, like the symlink form', () => {
  const ctx = gfProject();
  fs.mkdirSync(path.join(ctx.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'docs/brief.md'), '# brief\n');
  fs.writeFileSync(path.join(ctx.dir, '.gitignore'), 'docs/*.jsonl\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'docs');
  fs.linkSync(path.join(ctx.dir, '.eccode/events.jsonl'), path.join(ctx.dir, 'docs/hard.jsonl'));
  let err;
  try { closure.recordDispatch(ctx.store, ctx.config, 'orchestrator', { scope: 'S9', role: 'security-reviewer', step: 'critique', inputs: ['docs/brief.md', 'docs/hard.jsonl'] }); } catch (e) { err = e; }
  assert.ok(err, 'the hard-linked input was recorded');
  assert.match(err.message, /docs\/hard\.jsonl .*hard link/);
});
test('E2-7: .git/info/exclude and core.excludesFile, which are outside the tree, do not hide an untracked file from the clean-tree check', () => {
  const ctx = gfProject();
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'app/main.py'), 'from app.override import handler\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'app');
  fs.writeFileSync(path.join(ctx.dir, 'app/override.py'), 'def handler():\n    return "not in the reviewed tree"\n');
  fs.appendFileSync(path.join(ctx.dir, '.git/info/exclude'), 'app/override.py\n');
  assert.ok(closure.treeState(ctx.dir).dirty, '.git/info/exclude hid it');
  fs.writeFileSync(path.join(ctx.dir, '.git/info/exclude'), '');
  const excl = path.join(ctx.dir, '.git', 'my-excludes');
  fs.writeFileSync(excl, 'app/override.py\n');
  gitIn(ctx.dir, 'config', 'core.excludesFile', excl);
  assert.ok(closure.treeState(ctx.dir).dirty, 'core.excludesFile hid it');
});
for (const [name, apply] of [
  ['env ECCODE_HOOKS=off in .claude/settings.json', (dir) => { const f = path.join(dir, '.claude/settings.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.env = { ...(s.env || {}), ECCODE_HOOKS: 'off' }; fs.writeFileSync(f, JSON.stringify(s)); }],
  ['disableAllHooks in .claude/settings.json', (dir) => { const f = path.join(dir, '.claude/settings.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.disableAllHooks = true; fs.writeFileSync(f, JSON.stringify(s)); }],
  ['disableAllHooks in .claude/settings.local.json', (dir) => fs.writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }))],
]) {
  test(`E2-8: ${name} makes the preflight report the text-level regime with a warning`, () => {
    const saved = process.env.ECCODE_HOOKS;
    delete process.env.ECCODE_HOOKS;
    try {
      const ctx = gfProject();
      install({ target: ctx.dir, profile: 'sandbox' });
      assert.strictEqual(preflight.preflight(ctx.dir).regime, 'managed-path', 'control: a fresh sandbox install');
      apply(ctx.dir);
      const r = preflight.preflight(ctx.dir);
      assert.strictEqual(r.regime, 'text-level');
      assert.ok(r.warnings.some((w) => /hooks/i.test(w)), JSON.stringify(r.warnings));
    } finally { if (saved !== undefined) process.env.ECCODE_HOOKS = saved; }
  });
}
