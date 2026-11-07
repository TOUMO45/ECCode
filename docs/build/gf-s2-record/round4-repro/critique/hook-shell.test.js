'use strict';
// E2 reproductions: the PreToolUse hook (scripts/hooks/guard.js + lib/greenfield/permissions.js) judges only one
// operand of some shell writers it models, so a group role changes another group's file, a sealed contract or a
// guard configuration with plain commands. Each test asks the real hook, then runs the allowed command(s) in the
// throwaway project and checks the effect on disk. Every assertion states the behaviour the design claims; a
// failing assertion is the defect.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const COPY = path.resolve(__dirname, '..', 'copy');
const sample = require(path.join(COPY, 'tests/fixtures/gf/sample'));
const { gfProject, run, WRAPPED } = require(path.join(COPY, 'tests/fixtures/gf/flow'));
const wrap = require(path.join(COPY, 'lib/greenfield/wrap'));

const GUARD = path.join(COPY, 'scripts/hooks/guard.js');
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);

// Same construction as tests/gf-permissions.test.js: sealed project, phase gate started, each group role holds its task.
function team() {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  for (const [role, task] of [['integration-engineer', 's0-contracts'], ['backend-engineer', 's0-app'], ['database-engineer', 's0-db'], ['frontend-engineer', 's0-web'], ['test-engineer', 's0-accept'], ['devops-engineer', 's0-compose']]) {
    F(ctx, 'task.claimed', role, { task, runId: null });
  }
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'web/index.html'), '<p>frontend</p>\n');
  fs.writeFileSync(path.join(ctx.dir, '.eccode/security.json'), '{"roles":["member","admin"]}\n');
  return ctx;
}
function hook(ctx, role, command) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Bash', agent_type: `eccode:${role}`, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' },
  });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
const sh = (ctx, command) => execFileSync('bash', ['-c', command], { cwd: ctx.dir, encoding: 'utf8' });
const read = (ctx, rel) => (fs.existsSync(path.join(ctx.dir, rel)) ? fs.readFileSync(path.join(ctx.dir, rel), 'utf8') : null);
const OUT = path.join(process.env.TMPDIR || path.resolve(__dirname, '..', 'tmp'), 'e2-moved');

test('control: rm of another group\'s file, of a guard config and of a sealed contract is denied', () => {
  const ctx = team();
  assert.strictEqual(hook(ctx, 'backend-engineer', 'rm web/index.html').decision, 'deny');
  assert.strictEqual(hook(ctx, 'backend-engineer', 'rm .eccode/security.json').decision, 'deny');
  assert.strictEqual(hook(ctx, 'backend-engineer', 'rm contracts/openapi.json').decision, 'deny');
});

test('E2-1: mv removes its SOURCE, but the hook judges only the destination (another group\'s file, a guard config, a sealed contract)', () => {
  const ctx = team();
  const cases = [
    ['web/index.html', 'GF-OWN-2: web/index.html belongs to frontend'],
    ['.eccode/security.json', 'GF-CONF-1: no group role may write the guard configs'],
    ['contracts/openapi.json', 'GF-FRZ-1: a sealed contract is the api group\'s'],
  ];
  const observed = [];
  for (const [src] of cases) {
    const cmd = `mv ${src} ${OUT}-${path.basename(src)}`;
    const r = hook(ctx, 'backend-engineer', cmd);
    if (r.decision !== 'deny') sh(ctx, cmd);
    observed.push(`${cmd} -> ${r.decision}; ${src} ${read(ctx, src) === null ? 'is gone' : 'still exists'}`);
  }
  console.log(observed.join('\n'));
  for (const [i, [src, rule]] of cases.entries()) assert.notStrictEqual(read(ctx, src), null, `${rule}; observed: ${observed[i]}`);
});

test('E2-2: a hard link (ln without -s, cp -l) shares the source inode; the hook judges only the link name, so a later write to the group\'s own path rewrites the other file', () => {
  const ctx = team();
  const before = { web: read(ctx, 'web/index.html'), sec: read(ctx, '.eccode/security.json'), oas: read(ctx, 'contracts/openapi.json') };
  const steps = [
    'ln -f web/index.html app/main.py',
    'echo "<p>written by backend</p>" >> app/main.py',
    'ln -f .eccode/security.json app/__init__.py',
    'echo "{}" > app/__init__.py',
  ];
  const observed = [];
  for (const cmd of steps) {
    const r = hook(ctx, 'backend-engineer', cmd);
    observed.push(`${cmd} -> ${r.decision}${r.reason ? ` (${r.reason.slice(0, 80)})` : ''}`);
    if (r.decision !== 'deny') sh(ctx, cmd);
  }
  // The same with `cp -l` onto a sealed contract, and a file tool's in-place write (fs.writeFileSync) to the link.
  fs.rmSync(path.join(ctx.dir, 'app/main.py'));
  const cpl = 'cp -l contracts/openapi.json app/main.py';
  const r = hook(ctx, 'backend-engineer', cpl);
  observed.push(`${cpl} -> ${r.decision}`);
  if (r.decision !== 'deny') {
    sh(ctx, cpl);
    const w = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Write', agent_type: 'eccode:backend-engineer', tool_input: { file_path: path.join(ctx.dir, 'app/main.py') } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir } });
    observed.push(`Write app/main.py -> ${w.stdout ? JSON.parse(w.stdout).hookSpecificOutput.permissionDecision : 'allow'}`);
    if (!w.stdout) fs.writeFileSync(path.join(ctx.dir, 'app/main.py'), '{"openapi":"3.1.0","paths":{}}\n');
  }
  observed.push(`web/index.html changed: ${read(ctx, 'web/index.html') !== before.web}`);
  observed.push(`.eccode/security.json changed: ${read(ctx, '.eccode/security.json') !== before.sec}`);
  observed.push(`contracts/openapi.json changed: ${read(ctx, 'contracts/openapi.json') !== before.oas}`);
  console.log(observed.join('\n'));
  assert.strictEqual(read(ctx, 'web/index.html'), before.web, `GF-OWN-2: a backend role must not change frontend's file; observed:\n${observed.join('\n')}`);
  assert.strictEqual(read(ctx, '.eccode/security.json'), before.sec, `GF-CONF-1: no group role may write the guard configs; observed:\n${observed.join('\n')}`);
  assert.strictEqual(read(ctx, 'contracts/openapi.json'), before.oas, `GF-FRZ-1: a non-api role must not change a sealed contract; observed:\n${observed.join('\n')}`);
});

test('E2-3: a cd followed by ; or a newline (or pushd) is dropped, so a ../ target that lands in another group is judged as outside the project', () => {
  const ctx = team();
  const control = hook(ctx, 'backend-engineer', 'cd app && echo x > ../web/index.html');
  assert.strictEqual(control.decision, 'deny', 'control: the && form is denied');
  const before = read(ctx, 'web/index.html');
  const observed = [];
  for (const cmd of ['cd app; echo x > ../web/index.html', 'cd app\necho y >> ../web/index.html', 'pushd app >/dev/null && echo z >> ../web/index.html']) {
    const r = hook(ctx, 'backend-engineer', cmd);
    observed.push(`${JSON.stringify(cmd)} -> ${r.decision}`);
    if (r.decision !== 'deny') sh(ctx, cmd);
  }
  observed.push(`web/index.html now: ${JSON.stringify(read(ctx, 'web/index.html'))}`);
  console.log(observed.join('\n'));
  assert.strictEqual(read(ctx, 'web/index.html'), before, `GF-OWN-2; observed:\n${observed.join('\n')}`);
});

test('E2-4: a subagent\'s git rm / git mv / git apply write the working tree and are not modelled', () => {
  const ctx = team();
  sh(ctx, 'git add -A web contracts && git -c user.email=t@t -c user.name=t commit -qm base');
  fs.writeFileSync(path.join(ctx.dir, 'app/p.patch'), ['--- a/web/index.html', '+++ b/web/index.html', '@@ -1 +1 @@', '-<p>frontend</p>', '+<p>patched by backend</p>', ''].join('\n'));
  const observed = [];
  for (const cmd of ['git apply app/p.patch', 'git mv web/index.html app/main.py', 'git rm -q contracts/openapi.json']) {
    const r = hook(ctx, 'backend-engineer', cmd);
    observed.push(`${cmd} -> ${r.decision}`);
    if (r.decision !== 'deny') { try { sh(ctx, cmd); } catch (e) { observed.push(`  (ran: ${String(e.message).split('\n')[0]})`); } }
  }
  observed.push(`web/index.html: ${JSON.stringify(read(ctx, 'web/index.html'))}; app/main.py: ${JSON.stringify(read(ctx, 'app/main.py'))}; contracts/openapi.json exists: ${read(ctx, 'contracts/openapi.json') !== null}`);
  console.log(observed.join('\n'));
  assert.ok(observed.slice(0, 3).every((l) => l.endsWith('deny')), `each writes another group's file or a sealed contract; observed:\n${observed.join('\n')}`);
});
