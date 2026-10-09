'use strict';
// Regression tests for the fresh-context red-team review of 2026-10-09 (findings RT1-RT9,
// see docs/threat-model.md). Each case reproduced on the engine before its fix.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { deliver, unreviewedChanges } = require('../lib/delivery');
const { openRework } = require('../lib/rework');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const { globToRegExp, matchesAny } = require('../lib/util');
const { tmpProject, write, approveThroughPlan, samplePlan, task, passCheck, handoffFor, approval, expectCode } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');
const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function guard(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env } });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

function claimedApi(ctx) {
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
}

test('RT1 a symlink inside task ownership cannot be declared, and the guard denies writes through it', () => {
  const ctx = tmpProject();
  claimedApi(ctx);
  const { store, config, dir } = ctx;
  fs.mkdirSync(path.join(dir, 'src/server'), { recursive: true });
  fs.symlinkSync('../../.eccode/config.json', path.join(dir, 'src/server/cfg'));
  write(dir, 'src/server/a.js', '// a\n');
  const ev = passCheck(store, 'backend-engineer');
  const err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js', 'src/server/cfg'])), 'INVALID_HANDOFF');
  assert.match(err.message, /src\/server\/cfg is a symbolic link/);
  // Undeclared but inside ownership: still refused (the link itself is unsafe).
  const err2 = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js'])), 'INVALID_HANDOFF');
  assert.match(err2.message, /symbolic link/);
  const w = (p) => guard({ cwd: dir, tool_name: 'Write', agent_type: 'eccode:backend-engineer', tool_input: { file_path: p } });
  assert.match(w('src/server/cfg').permissionDecisionReason, /symbolic link/);
  const b = guard({ cwd: dir, tool_name: 'Bash', agent_type: 'eccode:backend-engineer', tool_input: { command: 'echo "{}" > src/server/cfg' } });
  assert.strictEqual(b.permissionDecision, 'deny');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.eccode/config.json'), 'utf8')).limits.maxCostUsd, 25, 'config untouched');
});

test('RT2 changes inside ownership that the handoff does not declare are refused, so every change is pinned', () => {
  const ctx = tmpProject();
  claimedApi(ctx);
  const { store, config, dir } = ctx;
  write(dir, 'src/server/a.js', '// a\n');
  write(dir, 'src/server/backdoor.js', '// undeclared\n');
  const ev = passCheck(store, 'backend-engineer');
  const err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /inside your ownership that the handoff does not declare.*src\/server\/backdoor\.js/);
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js', 'src/server/backdoor.js']));
  assert.deepStrictEqual(store.state().tasks.api.filesChanged.sort(), ['src/server/a.js', 'src/server/backdoor.js']);
});

test('RT3 plan ids rework-N are reserved, and a rework cannot collide with an existing task or gate', () => {
  const config = loadConfig(os.tmpdir());
  const plan = samplePlan();
  plan.tasks.push(task('rework-1', 'backend-engineer', ['src/x/**']));
  assert.match(tasks.validatePlan(plan, config).join('\n'), /id rework-1 is reserved for engine-opened reworks/);
  const plan2 = samplePlan();
  plan2.phases.push({ id: 'rework-1', name: 'Rework one', goal: 'a phase named like a rework', acceptanceCriteria: ['x ok'] });
  plan2.tasks.push(task('t9', 'backend-engineer', ['src/x/**'], [], 'rework-1'));
  assert.match(tasks.validatePlan(plan2, config).join('\n'), /id rework-1 is reserved/);
});

test('RT4 audit and state report a tampered log as CORRUPT_LOG instead of crashing', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const file = path.join(ctx.dir, '.eccode/events.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  for (const line of ['null', '{"seq":99,"type":"task.claimed","actor":"x","data":{"task":"nope"},"prevHash":"0","hash":"0"}', '{"seq":99,"type":"plan.imported","actor":"x","data":{},"prevHash":"0","hash":"0"}', '{"seq":99,"type":"gate.started","actor":"x","data":"phase","prevHash":"0","hash":"0"}']) {
    fs.writeFileSync(file, original + line + '\n');
    const res = ctx.store.audit();
    assert.strictEqual(res.ok, false, line);
    const cli = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 2, line);
    assert.doesNotMatch(cli.stderr + cli.stdout, /internal error|TypeError/, line);
    fs.rmSync(path.join(ctx.dir, '.eccode/state.json'), { force: true });
    const st = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'status', '--brief'], { encoding: 'utf8' });
    assert.doesNotMatch(st.stderr, /internal error|TypeError/, line);
  }
  fs.writeFileSync(file, original);
});

test('RT5 repeated ** segments are collapsed and plans refuse more than three', () => {
  const deep = 'a/' + '**/'.repeat(12) + 'b';
  const start = Date.now();
  assert.strictEqual(matchesAny('a/' + 'x/'.repeat(25) + 'c', [deep]), false);
  assert.ok(Date.now() - start < 500, 'no catastrophic backtracking');
  assert.strictEqual(String(globToRegExp('src/**/**/**/x.js')), String(globToRegExp('src/**/x.js')));
  const config = loadConfig(os.tmpdir());
  const plan = samplePlan();
  plan.tasks[0].files = ['src/**/a/**/b/**/c/**/d/**'];
  assert.match(tasks.validatePlan(plan, config).join('\n'), /more than three \*\* segments/);
});

test('RT6 implementer shell writes obey ownership: redirects, tee, cp and sed -i outside the claim are denied, .git metadata always', () => {
  const ctx = tmpProject();
  claimedApi(ctx);
  const bash = (command) => guard({ cwd: ctx.dir, tool_name: 'Bash', agent_type: 'eccode:backend-engineer', tool_input: { command } });
  for (const cmd of ['echo x > .env', 'echo x >> src/web/injected.js', 'cat a | tee src/web/x.js', 'cp src/server/a.js src/web/b.js', 'sed -i s/a/b/ src/web/b.js', 'echo "*.log" >> .git/info/exclude', 'echo x > .claude/settings.json']) {
    const out = bash(cmd);
    assert.ok(out && out.permissionDecision === 'deny', `${cmd} should be denied: ${JSON.stringify(out)}`);
  }
  for (const cmd of ['echo x > src/server/out.txt', 'cat src/server/a.js | tee src/server/copy.js', 'echo note >> .eccode/drafts/notes.md', 'echo done', 'npm test > /dev/null']) {
    assert.strictEqual(bash(cmd), null, `${cmd} should be allowed`);
  }
});

test('RT7 .claude/ and .git/ are never owned: plans refuse globs reaching them, completion refuses the files', () => {
  const config = loadConfig(os.tmpdir());
  const plan = samplePlan();
  plan.tasks[0].files = ['.claude/**'];
  assert.match(tasks.validatePlan(plan, config).join('\n'), /names \.claude\//);
  plan.tasks[0].files = ['**/*.json']; // broad globs stay valid; the engine refuses the .claude/ edits themselves
  assert.deepStrictEqual(tasks.validatePlan(plan, config), []);
  assert.match(tasks.recordGlobWarnings(plan.tasks).join('\n'), /reaches \.claude\/ or \.git\//);
  assert.strictEqual(tasks.owns(['**/*.json', '.claude/**'], '.claude/settings.json'), false);
  assert.strictEqual(tasks.owns(['**'], '.git/HEAD'), false);
  assert.strictEqual(tasks.owns(['**/*.json'], 'config/app.json'), true);
  const w = guard({ cwd: tmpProject().dir, tool_name: 'Write', agent_type: 'eccode:devops-engineer', tool_input: { file_path: '.claude/settings.json' } });
  assert.strictEqual(w.permissionDecision, 'deny');
});

test('RT8 secrets in labels, notes, handoffs and reviews are redacted before they reach the record', () => {
  const ctx = tmpProject();
  const secret = 'sk-ant-api03-SUPERSECRETVALUE1234567890';
  const ev = evidence.runCommand(ctx.store, 'test-engineer', { label: `check with ${secret}`, command: 'true' });
  assert.ok(!ev.label.includes(secret));
  write(ctx.dir, 'x.txt', 'x');
  const fe = evidence.recordFile(ctx.store, 'test-engineer', { file: 'x.txt', note: `token=${secret}` });
  assert.ok(!fe.note.includes(secret));
  const h = handoffFor('x', 'product-architect', [ev.id], []);
  delete h.task;
  h.completedWork = `Configured the client with api_key=${secret} for the demo.`;
  const id = tasks.recordHandoff(ctx.store, 'product-architect', h);
  const log = fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'), 'utf8');
  assert.ok(!log.includes(secret), 'events.jsonl holds no raw secret');
  assert.ok(!fs.readFileSync(path.join(ctx.dir, `.eccode/handoffs/${id}.json`), 'utf8').includes(secret));
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', require('./helpers').ARCH_MD);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const review = approval([['artifact:.eccode/artifacts/brief.md']], { summary: `Verified the brief; test key password=${secret} was used locally only.` });
  const { event } = gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', review);
  gates.archiveReview(ctx.store, event.data.reviewId, review);
  assert.ok(!fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'), 'utf8').includes(secret));
  assert.ok(!fs.readFileSync(path.join(ctx.dir, `.eccode/reviews/${event.data.reviewId}.json`), 'utf8').includes(secret));
});

test('RT9 a blocking finding raised and marked resolved in the same review needs evidence', () => {
  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', require('./helpers').ARCH_MD);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const bad = approval([['artifact:.eccode/artifacts/brief.md']], {
    findings: [{ id: 'F1', severity: 'blocking', title: 'Auth design missing', detail: 'No authn section in the brief.', recommendation: 'Add it.', status: 'resolved' }],
  });
  const err = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', bad), 'REVIEW_REJECTED');
  assert.match(err.message, /F1 is marked resolved without evidence/);
  const ok = approval([['artifact:.eccode/artifacts/brief.md']], {
    findings: [{ id: 'F1', severity: 'blocking', title: 'Auth design missing', detail: 'Fixed in the same pass.', recommendation: 'No further action needed.', status: 'resolved', evidence: ['artifact:.eccode/artifacts/brief.md#Architecture'] }],
  });
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ok);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'approved');
});
