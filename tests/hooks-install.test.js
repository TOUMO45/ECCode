'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { install, agentsMd } = require('../lib/install');
const { tmpProject, approveThroughPlan } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');
const START = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');

function hook(script, payload, env = {}) {
  const res = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env } });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

test('guard: no opinion outside ECCode projects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.strictEqual(hook(GUARD, { tool_name: 'Write', cwd: dir, tool_input: { file_path: 'x.js' } }), null);
});

test('guard: binds --actor to the running subagent and blocks impersonation', () => {
  const ctx = tmpProject();
  const deny = (p, env) => hook(GUARD, { cwd: ctx.dir, ...p }, env);
  let out = deny({ tool_name: 'Bash', agent_type: 'eccode:backend-engineer', tool_input: { command: 'eccode gate review phase:core --actor technical-reviewer --file r.json' } });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Identity mismatch/);
  out = deny({ tool_name: 'Bash', agent_type: 'eccode:technical-reviewer', tool_input: { command: 'node .claude/eccode/bin/eccode.js gate reopen design --actor user --resolution ok' } });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(deny({ tool_name: 'Bash', agent_type: 'eccode:technical-reviewer', tool_input: { command: 'eccode evidence run --actor technical-reviewer --label t -- npm test' } }), null);
  // Main session acting as a reviewer is refused unless sequential mode is declared.
  out = deny({ tool_name: 'Bash', tool_input: { command: 'eccode gate review design --actor technical-reviewer --file r.json' } });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(deny({ tool_name: 'Bash', tool_input: { command: 'eccode gate review design --actor technical-reviewer --file r.json' } }, { ECCODE_SEQUENTIAL_ROLES: '1' }), null);
  assert.strictEqual(deny({ tool_name: 'Bash', tool_input: { command: 'eccode gate start design --actor orchestrator' } }), null);
});

test('guard: protects the record from direct edits', () => {
  const ctx = tmpProject();
  let out = hook(GUARD, { cwd: ctx.dir, tool_name: 'Bash', tool_input: { command: 'echo {} >> .eccode/events.jsonl' } });
  assert.strictEqual(out.permissionDecision, 'deny');
  out = hook(GUARD, { cwd: ctx.dir, tool_name: 'Edit', tool_input: { file_path: path.join(ctx.dir, '.eccode/state.json') } });
  assert.strictEqual(out.permissionDecision, 'deny');
  out = hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', tool_input: { file_path: '.eccode/config.json' } });
  assert.strictEqual(out.permissionDecision, 'deny');
});

test('guard: implementers edit only inside their claimed task ownership; reviewers write drafts only', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const w = (agent, file) => hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', agent_type: `eccode:${agent}`, tool_input: { file_path: file } });
  assert.match(w('backend-engineer', 'src/server/app.js').permissionDecisionReason, /no claimed task/);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  assert.strictEqual(w('backend-engineer', 'src/server/app.js'), null);
  assert.match(w('backend-engineer', 'src/web/index.html').permissionDecisionReason, /outside the ownership/);
  assert.strictEqual(w('backend-engineer', '.eccode/drafts/handoff-api.json'), null);
  assert.strictEqual(w('technical-reviewer', '.eccode/reviews/drafts/core-1.json'), null);
  assert.match(w('technical-reviewer', 'src/server/app.js').permissionDecisionReason, /does not edit project files/);
  assert.strictEqual(w('backend-engineer', '/tmp/scratch.txt'), null);
});

test('guard: ECCODE_HOOKS=off disables it', () => {
  const ctx = tmpProject();
  assert.strictEqual(hook(GUARD, { cwd: ctx.dir, tool_name: 'Edit', tool_input: { file_path: '.eccode/state.json' } }, { ECCODE_HOOKS: 'off' }), null);
});

test('session-start injects the resume brief only for ECCode projects', () => {
  const ctx = tmpProject();
  const out = hook(START, { cwd: ctx.dir, hook_event_name: 'SessionStart' });
  assert.strictEqual(out.hookEventName, 'SessionStart');
  assert.match(out.additionalContext, /NEXT: start-gate \[architecture\]/);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.strictEqual(hook(START, { cwd: plain }), null);
});

test('project install copies components, rewrites paths, merges hooks idempotently and the installed CLI works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
  install({ target: dir });
  install({ target: dir }); // idempotent
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(npm test)'] }, 'existing settings preserved');
  assert.strictEqual(settings.hooks.Stop.length, 1);
  assert.strictEqual(settings.hooks.PreToolUse.length, 1);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'technical-reviewer.md')));
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'eccode-orchestrate', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: eccode-orchestrate$/m);
  assert.ok(!skill.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.match(skill, /node \.claude\/eccode\/bin\/eccode\.js/);
  const run = spawnSync(process.execPath, ['.claude/eccode/bin/eccode.js', 'init', '--name', 'X', '--idea', 'installed cli works'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const status = spawnSync(process.execPath, ['.claude/eccode/bin/eccode.js', 'status', '--brief'], { cwd: dir, encoding: 'utf8' });
  assert.match(status.stdout, /NEXT: start-gate/);
});

test('AGENTS.md export covers every role and the workflow for other harnesses', () => {
  const md = agentsMd();
  for (const role of ['product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'delivery-lead', 'learning-debugger', 'security-reviewer']) {
    assert.match(md, new RegExp(`### ${role}`));
  }
  assert.match(md, /sequentially in one context/);
});

test('guard: implementers cannot write approved artifacts; document authors can', () => {
  const ctx = tmpProject();
  const w = (agent, file) => hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', agent_type: `eccode:${agent}`, tool_input: { file_path: file } });
  assert.strictEqual(w('product-architect', '.eccode/artifacts/architecture/brief.md'), null);
  assert.strictEqual(w('backend-engineer', '.eccode/artifacts/plan/checks/scaffold-check.js').permissionDecision, 'deny');
  assert.strictEqual(w('technical-reviewer', '.eccode/artifacts/design/spec.md').permissionDecision, 'deny');
});
