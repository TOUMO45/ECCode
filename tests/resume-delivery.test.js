'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const runs = require('../lib/runs');
const evidence = require('../lib/evidence');
const { deliver } = require('../lib/delivery');
const { Store } = require('../lib/store');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, coverage, expectCode, spawnCli, assertAllExitZero } = require('./helpers');

/** The delivery pins the release tree: reviewed work is committed before `deliver`. */
function commitAll(dir, msg = 'reviewed work') {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg], { cwd: dir });
}

function completePhase(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${ev.id}`]));
}

function verify(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  const ev = passCheck(store, 'security-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${ev.id}`, 'artifact:.eccode/artifacts/verification.md']));
}

test('state survives a lost snapshot and a torn final log line', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const before = ctx.store.state();
  fs.unlinkSync(path.join(ctx.dir, '.eccode/state.json'));
  fs.appendFileSync(path.join(ctx.dir, '.eccode/events.jsonl'), '{"seq": 999, "trunc');
  const fresh = new Store(ctx.dir).state();
  assert.strictEqual(fresh.seq, before.seq);
  assert.deepStrictEqual(fresh.gates, before.gates);
  assert.strictEqual(fresh.gates.plan.status, 'approved');
});

test('interrupted runs are recovered: claims released, attempt counted, work resumable', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  const runId = runs.startRun(store, config, 'backend-engineer', { task: 'api' });
  tasks.claim(store, config, 'api', 'backend-engineer', { runId });
  // Simulate a new session: the previous agent is gone.
  const recovered = runs.recover(store, config, { all: true, actor: 'orchestrator' });
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].released, true);
  const st = store.state();
  assert.strictEqual(st.runs[runId].status, 'interrupted');
  assert.strictEqual(st.tasks.api.status, 'pending');
  assert.strictEqual(st.tasks.api.attempts, 1);
  assert.ok(st.tasks.api.history.some((h) => h.event === 'interrupted'));
  tasks.claim(store, config, 'api', 'backend-engineer'); // resumable
});

test('stale detection only flags runs older than the threshold unless --all', () => {
  const ctx = tmpProject();
  const { store, config } = ctx;
  process.env.ECCODE_TEST = '1'; // ECCODE_NOW is honoured only in test mode
  process.env.ECCODE_NOW = '2026-01-01T00:00:00.000Z';
  try {
    runs.startRun(store, config, 'product-architect');
    process.env.ECCODE_NOW = '2026-01-01T00:10:00.000Z';
    assert.strictEqual(runs.recover(store, config, { actor: 'orchestrator' }).length, 0);
    process.env.ECCODE_NOW = '2026-01-01T03:00:00.000Z';
    assert.strictEqual(runs.recover(store, config, { actor: 'orchestrator' }).length, 1);
  } finally {
    delete process.env.ECCODE_NOW;
    delete process.env.ECCODE_TEST;
  }
});

test('audit detects edits to the event log', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  assert.strictEqual(ctx.store.audit().ok, true);
  const file = path.join(ctx.dir, '.eccode/events.jsonl');
  const tampered = fs.readFileSync(file, 'utf8').replace('"decision":"approve"', '"decision":"approve","note":"x"');
  fs.writeFileSync(file, tampered);
  const res = ctx.store.audit();
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /hash mismatch/);
});

test('delivery is refused until every gate passes and when reviewed files change afterwards', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  expectCode(() => deliver(ctx.store, 'delivery-lead'), 'DELIVERY_BLOCKED');
  completePhase(ctx);
  verify(ctx);
  fs.appendFileSync(path.join(ctx.dir, 'src/server/a.js'), '// unreviewed hotfix\n');
  const err = expectCode(() => deliver(ctx.store, 'delivery-lead'), 'DELIVERY_BLOCKED');
  assert.match(err.message, /src\/server\/a.js modified after approval/);
});

test('happy path produces a verified final handoff', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  verify(ctx);
  runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R1', title: 'LLM provider outage', severity: 'medium', mitigation: 'fallback classifier' });
  commitAll(ctx.dir);
  const res = deliver(ctx.store, 'delivery-lead');
  const report = fs.readFileSync(path.join(ctx.dir, res.report), 'utf8');
  assert.match(report, /# Final Handoff — Test/);
  assert.match(report, /\| verification \| delivery-lead \| security-reviewer/);
  assert.match(report, /Open risks carried forward: R1/);
  assert.strictEqual(ctx.store.state().delivery.report, res.report);
  expectCode(() => deliver(ctx.store, 'delivery-lead'), 'ALREADY_DELIVERED');
});

test('evidence logs redact secrets and record exit codes', () => {
  const ctx = tmpProject();
  const ev = evidence.runCommand(ctx.store, 'test-engineer', { label: 'leaky', command: 'node -e "console.log(\'ANTHROPIC key sk-ant-api03-abcdefghijklmnop and api_key=supersecret123\'); process.exit(4)"' });
  assert.strictEqual(ev.exitCode, 4);
  assert.strictEqual(ev.status, 'failed');
  const log = fs.readFileSync(path.join(ctx.dir, ev.log), 'utf8');
  assert.ok(!log.includes('sk-ant-api03-abcdefghijklmnop'));
  assert.ok(!log.includes('supersecret123'));
  assert.match(log, /\[REDACTED\]/);
});

test('handoffs must come from the acting agent and cite real evidence', () => {
  const ctx = tmpProject();
  const ev = passCheck(ctx.store, 'product-architect');
  const h = handoffFor('x', 'product-architect', [ev.id], []);
  delete h.task;
  h.to = 'architecture-reviewer';
  expectCode(() => tasks.recordHandoff(ctx.store, 'technical-designer', h), 'INVALID_HANDOFF');
  expectCode(() => tasks.recordHandoff(ctx.store, 'product-architect', { ...h, evidence: ['ev:nope'] }), 'INVALID_HANDOFF');
  const id = tasks.recordHandoff(ctx.store, 'product-architect', h);
  assert.ok(ctx.store.state().handoffs[id]);
});

test('concurrent writers never corrupt the log', async () => {
  const ctx = tmpProject();
  // stderr is kept (TK-3): on Windows one of these children exited 1 in four CI runs with no message captured.
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => spawnCli(['risk', 'add', '--id', `R${i}`, '--title', `risk ${i}`, '--severity', 'low', '--actor', 'delivery-lead', '--root', ctx.dir])),
  );
  assertAllExitZero(results);
  const st = new Store(ctx.dir).state();
  assert.strictEqual(Object.keys(st.risks).length, 6);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('audit detects a snapshot that diverges from replay; rebuild repairs it', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const file = path.join(ctx.dir, '.eccode/state.json');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  snap.gates.plan.approvedBy = 'nobody';
  fs.writeFileSync(file, JSON.stringify(snap));
  const res = ctx.store.audit();
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /diverges from a replay/);
  ctx.store.rebuildSnapshot();
  assert.strictEqual(ctx.store.audit().ok, true);
  assert.strictEqual(ctx.store.state().gates.plan.approvedBy, 'technical-reviewer');
});

test('run usage corrections are append-only and adjust totals by the delta', () => {
  const ctx = tmpProject();
  const id = runs.startRun(ctx.store, ctx.config, 'technical-reviewer');
  runs.endRun(ctx.store, ctx.config, id, 'orchestrator', { tokens: 120000 });
  runs.correctRun(ctx.store, id, 'orchestrator', { tokens: 100709, reason: 'estimate replaced by reported usage' });
  const st = ctx.store.state();
  assert.strictEqual(st.totals.tokens, 100709);
  assert.strictEqual(st.runs[id].corrections[0].from.tokens, 120000);
  assert.strictEqual(ctx.store.audit().ok, true);
  expectCode(() => runs.correctRun(ctx.store, id, 'orchestrator', { tokens: 1 }), 'INVALID_INPUT');
});

test('run end refuses to close a run without usage unless --no-usage is explicit', () => {
  const ctx = tmpProject();
  const id = runs.startRun(ctx.store, ctx.config, 'technical-reviewer');
  expectCode(() => runs.endRun(ctx.store, ctx.config, id, 'orchestrator', {}), 'USAGE_MISSING');
  assert.strictEqual(ctx.store.state().runs[id].status, 'running');
  // An explicit zero is a reported figure, not a missing one.
  const zero = runs.startRun(ctx.store, ctx.config, 'technical-reviewer');
  runs.endRun(ctx.store, ctx.config, zero, 'orchestrator', { tokens: 0 });
  assert.strictEqual(ctx.store.state().runs[zero].usageReported, true);
  // A crashed agent may report nothing: closing is allowed but the gap stays visible.
  runs.endRun(ctx.store, ctx.config, id, 'orchestrator', { status: 'failed', noUsage: true });
  const st = ctx.store.state();
  assert.strictEqual(st.runs[id].status, 'failed');
  assert.strictEqual(st.runs[id].usageReported, false);
  assert.strictEqual(st.totals.tokens, 0);
  // run correct fills the gap later and marks the usage as reported.
  runs.correctRun(ctx.store, id, 'orchestrator', { tokens: 5000, reason: 'usage arrived after close' });
  assert.strictEqual(ctx.store.state().runs[id].usageReported, true);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('the orchestrator opens a run on behalf of a role (--agent); the run belongs to that role', () => {
  const ctx = tmpProject();
  const id = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'delivery-lead', gate: 'plan' });
  assert.strictEqual(ctx.store.state().runs[id].agent, 'delivery-lead');
  // Without --agent the acting role is the run's agent, as before.
  const own = runs.startRun(ctx.store, ctx.config, 'backend-engineer', {});
  assert.strictEqual(ctx.store.state().runs[own].agent, 'backend-engineer');
  // An unknown role name is refused rather than recorded.
  expectCode(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'not a role!' }), 'INVALID_INPUT');
  // Recovery still releases the claim of the role the run was opened for.
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('CLI: run start --actor orchestrator --agent <role> prints a run id and the guard allows the command from the main session', () => {
  const ctx = tmpProject();
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const res = spawnSync(process.execPath, [bin, 'run', 'start', '--actor', 'orchestrator', '--agent', 'technical-reviewer', '--gate', 'plan', '--root', ctx.dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const id = res.stdout.trim();
  assert.strictEqual(ctx.store.state().runs[id].agent, 'technical-reviewer');
  const guard = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');
  const g = spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'eccode run start --actor orchestrator --agent technical-reviewer --gate plan' }, cwd: ctx.dir }), encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: ctx.dir } });
  assert.doesNotMatch(g.stdout, /"deny"/);
});

test('run end --no-usage is accepted by the CLI and a bare run end is refused with exit 2', () => {
  const ctx = tmpProject();
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--root', ctx.dir], { encoding: 'utf8' });
  const id = cli('run', 'start', '--actor', 'test-engineer').stdout.trim();
  let res = cli('run', 'end', id, '--actor', 'orchestrator', '--status', 'ok');
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /USAGE_MISSING|usage/i);
  res = cli('run', 'end', id, '--actor', 'orchestrator', '--status', 'failed', '--no-usage');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(ctx.store.state().runs[id].usageReported, false);
});

test('evidence run preserves argument quoting from the CLI (arguments with spaces and quotes, compound commands)', () => {
  const ctx = tmpProject();
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const run = (args) => spawnSync(process.execPath, [bin, 'evidence', 'run', '--actor', 'test-engineer', '--label', 'q', '--json', '--root', ctx.dir, '--', ...args], { encoding: 'utf8' });
  // Single quotes inside the argument: '\'' escaping on POSIX, plain grouping under cmd.exe.
  let res = run(['node', '-e', "if (!require('fs').existsSync('.eccode')) process.exit(3); console.log('it works')"]);
  assert.strictEqual(res.status, 0, res.stderr);
  let ev = JSON.parse(res.stdout);
  assert.strictEqual(ev.status, 'passed');
  assert.match(ev.outputTail, /it works/);
  // Double quotes inside the argument: the \" path on win32.
  res = run(['node', '-e', 'process.exit(require("fs").existsSync(".eccode") ? 0 : 3)']);
  assert.strictEqual(JSON.parse(res.stdout).status, 'passed');
  res = run(['node -e "console.log(\'one\')" && node -e "console.log(\'two\')"']); // a single argument is a shell command string
  ev = JSON.parse(res.stdout);
  assert.match(ev.outputTail, /one\ntwo/);
});

test('audit distinguishes an edit submitted for re-review in a later gate from an unreviewed edit', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  const { store, config, dir } = ctx;
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const { spawnSync } = require('child_process');
  const audit = () => spawnSync(process.execPath, [bin, '--root', dir, 'audit', '--json'], { encoding: 'utf8' });
  // Verification submits the final version of a file the phase approved (the TriageDesk VER-2 situation).
  fs.appendFileSync(path.join(dir, 'src/server/a.js'), '// clarifying edit for the release\n');
  let res = audit();
  assert.strictEqual(res.status, 2);
  assert.strictEqual(JSON.parse(res.stdout).unreviewedChanges.length, 1);
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js'] });
  res = audit();
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepStrictEqual(out.unreviewedChanges, []);
  assert.strictEqual(out.pendingReview[0].pending, 'verification');
  // A further edit after the submission is unreviewed again (and the review would be refused as stale).
  fs.appendFileSync(path.join(dir, 'src/server/a.js'), '// sneaky\n');
  assert.strictEqual(audit().status, 2);
  expectCode(() => deliver(store, 'delivery-lead'), 'DELIVERY_BLOCKED');
});

test('the final handoff lists every --actor user event as entered on the user\'s behalf', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  verify(ctx);
  runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-12', title: 'Fallback recall below floor', severity: 'high' });
  runs.recordRisk(ctx.store, 'user', { id: 'RISK-12', status: 'accepted' });
  runs.recordDecision(ctx.store, 'user', { title: 'OPERATOR (not the human user): amend SC2', decision: 'Accept 0.571 recall on the holdout', rationale: 'Fallback is a labelled safety net' });
  commitAll(ctx.dir);
  const res = deliver(ctx.store, 'delivery-lead');
  const report = fs.readFileSync(path.join(ctx.dir, res.report), 'utf8');
  assert.match(report, /## User decisions \(recorded with `--actor user`, or under a delegation\)/);
  assert.match(report, /Records written by earlier engine versions carry no such proof: whoever ran the CLI entered them/);
  assert.match(report, /`risk.recorded` RISK-12 accepted/);
  assert.match(report, /`decision.recorded` OPERATOR \(not the human user\): amend SC2: Accept 0.571 recall/);
});

test('JSON inputs resolve from the project root as well as the cwd, and a missing file is a clean refusal', () => {
  const ctx = tmpProject();
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  write(ctx.dir, '.eccode/drafts/plan.json', JSON.stringify(require('./helpers').samplePlan()));
  let res = spawnSync(process.execPath, [bin, '--root', ctx.dir, 'plan', 'validate', '.eccode/drafts/plan.json'], { encoding: 'utf8', cwd: require('os').tmpdir() });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Plan valid/);
  res = spawnSync(process.execPath, [bin, '--root', ctx.dir, 'plan', 'validate', 'nope.json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /\[NOT_FOUND\] File not found: nope.json/);
  assert.doesNotMatch(res.stderr, /internal error/);
  // Globs into .eccode/ are reported as warnings: they never grant ownership.
  const plan = require('./helpers').samplePlan();
  plan.tasks[0].files = ['.eccode/artifacts/report/**'];
  write(ctx.dir, '.eccode/drafts/plan2.json', JSON.stringify(plan));
  res = spawnSync(process.execPath, [bin, '--root', ctx.dir, 'plan', 'validate', '.eccode/drafts/plan2.json', '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).warnings.join('\n'), /api: ownership glob \.eccode\/artifacts\/report\/\*\* never grants ownership/);
});
