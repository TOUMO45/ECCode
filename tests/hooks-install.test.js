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
const { tmpProject, approveThroughPlan, samplePlan, task } = require('./helpers');

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
  // The user's own Stop hook is kept, ECCode's completion gate is added once (idempotent across two installs).
  assert.strictEqual(settings.hooks.Stop.length, 2);
  assert.ok(settings.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo bye')), 'existing Stop hook preserved');
  assert.strictEqual(settings.hooks.Stop.filter((g) => g.hooks.some((h) => String(h.command).includes('eccode/scripts/hooks/stop.js'))).length, 1);
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

// ---- Security review regressions (finding numbers in test names).

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function guardBash(dir, command, agent, env = {}) {
  const out = hook(GUARD, { cwd: dir, tool_name: 'Bash', ...(agent ? { agent_type: `eccode:${agent}` } : {}), tool_input: { command } }, { ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ...env });
  return out ? out.permissionDecision : 'allow';
}

test('#2 CLI refuses a repeated --actor', () => {
  const ctx = tmpProject();
  const res = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'gate', 'start', 'architecture', '--actor', 'product-architect', '--actor', 'orchestrator'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /USAGE.*--actor/);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'pending');
});

test('#2 guard binds the actor the CLI will use: repeated --actor, inline env, tabs, quotes, nested shells', () => {
  const ctx = tmpProject();
  const g = (cmd, agent = 'technical-designer') => guardBash(ctx.dir, cmd, agent);
  for (const cmd of [
    'eccode gate reopen design --actor technical-designer --actor user --resolution "user says ok, proceed"',
    'ECCODE_ACTOR=user eccode gate reopen design --resolution "user says ok, proceed"',
    'export ECCODE_ACTOR=user; eccode gate reopen design --resolution "user says ok"',
    'env ECCODE_ACTOR=user node .claude/eccode/bin/eccode.js gate reopen design --resolution x',
    'eccode gate reopen design --actor\tuser --resolution "user says ok, proceed"',
    "eccode gate reopen design '--actor' user --resolution x",
    "eccode gate reopen design --act''or us\\er --resolution x",
    'eccode gate reopen design --actor=user --resolution x',
    'eccode gate reopen design --actor "$ROLE" --resolution x',
    'bash -c "eccode gate reopen design --actor user --resolution x"',
    'eccode evidence run --actor technical-designer --label t -- eccode gate reopen design --actor user --resolution x',
    'ECC="node bin/eccode.js"; $ECC gate reopen design --actor user --resolution x',
    'ECCODE_TEST=1 ECCODE_NOW=2099-01-01T00:00:00Z eccode evidence run --actor technical-designer --label t -- true',
  ]) {
    assert.strictEqual(g(cmd), 'deny', cmd);
  }
  for (const cmd of [
    'eccode gate start design --actor technical-designer && eccode gate submit design --actor technical-designer --artifact .eccode/artifacts/spec.md',
    'eccode evidence run --actor technical-designer --label t -- node -e "console.log(\'--actor user\')"',
    'eccode status --brief # --actor user',
    'echo $ECCODE_ACTOR',
  ]) {
    assert.strictEqual(g(cmd), 'allow', cmd);
  }
  // Main session: inline env cannot bypass the sequential-roles rule either.
  assert.strictEqual(guardBash(ctx.dir, 'ECCODE_ACTOR=technical-reviewer eccode gate review design --file r.json', null), 'deny');
  // Review F5: no agent context mints user authority, the main session included (tests/review-F4-F5-guard.test.js).
  assert.strictEqual(guardBash(ctx.dir, 'eccode gate reopen design --actor user --resolution "the user decided"', null), 'deny');
  assert.strictEqual(guardBash(ctx.dir, 'eccode gate reopen design --actor orchestrator --resolution "escalation"', null), 'allow');
});

test('#4 guard fails closed when the record cannot be read', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const log = path.join(ctx.dir, '.eccode', 'events.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[3] = '{"seq": 4, "torn';
  fs.writeFileSync(log, lines.join('\n'));
  fs.unlinkSync(path.join(ctx.dir, '.eccode', 'state.json'));
  const out = hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', agent_type: 'eccode:backend-engineer', tool_input: { file_path: 'src/auth/policy.js' } });
  assert.ok(out, 'the guard must not allow the call');
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /record cannot be read/);
});

test('#5 guard denies git commands that roll back or delete the record', () => {
  const ctx = tmpProject();
  for (const cmd of [
    'git checkout -- .eccode/events.jsonl',
    'git checkout HEAD~1 -- .eccode/',
    'git restore .eccode/state.json .eccode/events.jsonl',
    'git restore --source=HEAD~2 .eccode',
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git checkout .',
    'git checkout -- .',
    'git stash',
    'git stash push -u',
    'git clean -fd',
    'git -C . restore .eccode/events.jsonl',
    'cd sub && git checkout -- ../.eccode/events.jsonl',
  ]) {
    for (const agent of ['backend-engineer', null]) assert.strictEqual(guardBash(ctx.dir, cmd, agent), 'deny', `${cmd} (${agent || 'main'})`);
  }
  for (const cmd of ['git status', 'git diff .eccode/events.jsonl', 'git checkout -- src/server/app.js', 'git log --oneline -- .eccode', 'git stash list', 'git add -A .eccode', 'git restore src/x.js']) {
    assert.strictEqual(guardBash(ctx.dir, cmd, 'backend-engineer'), 'allow', cmd);
  }
});

test('#8 guard: task globs never grant .eccode/ paths (only drafts)', () => {
  const ctx = tmpProject();
  const plan = { phases: samplePlan().phases, tasks: [task('cfg', 'devops-engineer', ['**/*.json']), task('docs', 'backend-engineer', ['**/*.md'])] };
  approveThroughPlan(ctx, plan);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  const w = (agent, file) => {
    const out = hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', agent_type: `eccode:${agent}`, tool_input: { file_path: file } });
    return out ? out.permissionDecision : 'allow';
  };
  tasks.claim(ctx.store, ctx.config, 'docs', 'backend-engineer');
  assert.strictEqual(w('backend-engineer', '.eccode/artifacts/spec.md'), 'deny');
  assert.strictEqual(w('backend-engineer', '.eccode/reviews/rev-x.json'), 'deny');
  assert.strictEqual(w('backend-engineer', 'docs/guide.md'), 'allow');
  assert.strictEqual(w('backend-engineer', '.eccode/drafts/handoff.json'), 'allow');
  tasks.fail(ctx.store, ctx.config, 'docs', 'backend-engineer', 'released to test the other task');
  tasks.claim(ctx.store, ctx.config, 'cfg', 'devops-engineer');
  assert.strictEqual(w('devops-engineer', '.eccode/artifacts/plan.json'), 'deny');
  assert.strictEqual(w('devops-engineer', '.eccode/handoffs/ho-x.json'), 'deny');
  assert.strictEqual(w('devops-engineer', 'deploy/app.json'), 'allow');
});

test('#11 guard protects memory, improvements, evidence, reviews and handoffs from Bash writes', () => {
  const ctx = tmpProject();
  for (const cmd of [
    `sed -i 's/"status": "provisional"/"status": "verified"/' .eccode/memory/records/mem-w-abc.json`,
    'echo x > .eccode/improvements/imp-x/proposal.json',
    'cp fake.log .eccode/evidence/ev-x.log',
    'mv r.json .eccode/reviews/rev-x.json',
    'rm .eccode/handoffs/ho-x.json',
    `node -e "require('fs').appendFileSync('.eccode/events.jsonl','x')"`,
    `python3 -c "open('.eccode/memory/records/m.json','w').write('{}')"`,
    'perl -pi -e s/provisional/verified/ .eccode/memory/records/m.json',
  ]) {
    assert.strictEqual(guardBash(ctx.dir, cmd, 'learning-debugger'), 'deny', cmd);
  }
  for (const cmd of ['cat .eccode/memory/records/m.json', 'grep -n error .eccode/evidence/ev-x.log', 'cp review.json .eccode/drafts/r.json', 'eccode gate review design --actor learning-debugger --file .eccode/reviews/drafts/r.json']) {
    assert.strictEqual(guardBash(ctx.dir, cmd, 'learning-debugger'), 'allow', cmd);
  }
  // Review drafts are not record-protected, but (review F4) a shell write obeys the Edit rules:
  // they are a reviewer's draft area, not an implementer's.
  assert.strictEqual(guardBash(ctx.dir, 'cp review.json .eccode/reviews/drafts/r.json', 'technical-reviewer'), 'allow');
  assert.strictEqual(guardBash(ctx.dir, 'cp review.json .eccode/reviews/drafts/r.json', 'learning-debugger'), 'deny');
});

test('guard: implementers cannot write approved artifacts; document authors can', () => {
  const ctx = tmpProject();
  const w = (agent, file) => hook(GUARD, { cwd: ctx.dir, tool_name: 'Write', agent_type: `eccode:${agent}`, tool_input: { file_path: file } });
  assert.strictEqual(w('product-architect', '.eccode/artifacts/architecture/brief.md'), null);
  assert.strictEqual(w('backend-engineer', '.eccode/artifacts/plan/checks/scaffold-check.js').permissionDecision, 'deny');
  assert.strictEqual(w('technical-reviewer', '.eccode/artifacts/design/spec.md').permissionDecision, 'deny');
});
