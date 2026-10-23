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
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, approval, expectCode } = require('./helpers');

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
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]]));
}

function verify(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  const ev = passCheck(store, 'security-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/verification.md']]));
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
  const recovered = runs.recover(store, config, { all: true });
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
  process.env.ECCODE_NOW = '2026-01-01T00:00:00.000Z';
  try {
    runs.startRun(store, config, 'product-architect');
    process.env.ECCODE_NOW = '2026-01-01T00:10:00.000Z';
    assert.strictEqual(runs.recover(store, config).length, 0);
    process.env.ECCODE_NOW = '2026-01-01T03:00:00.000Z';
    assert.strictEqual(runs.recover(store, config).length, 1);
  } finally {
    delete process.env.ECCODE_NOW;
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
  // node -e instead of shell echo/exit so the same command works under sh and cmd.exe
  const ev = evidence.runCommand(ctx.store, 'test-engineer', { label: 'leaky', command: `node -e "console.log('ANTHROPIC key sk-ant-api03-abcdefghijklmnop and api_key=supersecret123'); process.exit(4)"` });
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
  const { spawn } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const stderr = [];
  const procs = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, 'risk', 'add', '--id', `R${i}`, '--title', `risk ${i}`, '--severity', 'low', '--actor', 'delivery-lead', '--root', ctx.dir]);
      stderr[i] = '';
      p.stderr.on('data', (d) => { stderr[i] += d; });
      p.on('exit', resolve);
    }),
  );
  const codes = await Promise.all(procs);
  assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 0], `writer stderr:\n${stderr.map((e, i) => `#${i}: ${e.trim()}`).join('\n')}`);
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

function evidenceCli(ctx, args) {
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  return spawnSync(process.execPath, [bin, 'evidence', 'run', '--actor', 'test-engineer', '--label', 'q', '--json', '--root', ctx.dir, '--', ...args], { encoding: 'utf8' });
}

test('evidence run preserves argument quoting from the CLI (argv vector)', () => {
  const ctx = tmpProject();
  // Spaces, parentheses and semicolons must survive the platform shell; a
  // payload with embedded double quotes is POSIX-only (next test), because
  // cmd.exe quoting of nested quotes is CRT-dependent.
  let res = evidenceCli(ctx, ['node', '-e', 'const n = 2 + 2; process.exit(n === 4 ? 0 : 3)']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout).status, 'passed');
  res = evidenceCli(ctx, ['echo one && echo two']); // a single argument is a shell command string
  assert.match(JSON.parse(res.stdout).outputTail, /one\s*\ntwo/);
});

// POSIX shell syntax: check commands are written for the shell they run on.
test('evidence run preserves sh -c compound commands and nested quotes (POSIX shells)', { skip: process.platform === 'win32' && 'sh -c semantics' }, () => {
  const ctx = tmpProject();
  let res = evidenceCli(ctx, ['sh', '-c', 'test -d .eccode && echo "it works"']);
  assert.strictEqual(res.status, 0, res.stderr);
  const ev = JSON.parse(res.stdout);
  assert.strictEqual(ev.status, 'passed');
  assert.match(ev.outputTail, /it works/);
  res = evidenceCli(ctx, ['node', '-e', 'process.exit(require("fs").existsSync(".eccode") ? 0 : 3)']);
  assert.strictEqual(JSON.parse(res.stdout).status, 'passed');
});

test('Windows contention errors (EPERM/EACCES/EBUSY) are retried, not fatal', () => {
  // CI on Windows saw a concurrent writer exit 1: a lock file being deleted,
  // or a state file another process holds open, reports EPERM there rather
  // than EEXIST. Simulated deterministically so every OS runs this check.
  const fs = require('fs');
  const util = require('../lib/util');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-win-'));
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  const orig = { openSync: fs.openSync, renameSync: fs.renameSync, readFileSync: fs.readFileSync };
  const failTimes = (name, n, code) => {
    let left = n;
    fs[name] = function (...args) {
      if (left > 0 && (name !== 'openSync' || args[1] === 'wx') && (name !== 'readFileSync' || String(args[0]).endsWith('.json'))) {
        left -= 1;
        throw Object.assign(new Error(`${code}: simulated`), { code });
      }
      return orig[name].apply(fs, args);
    };
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    failTimes('openSync', 3, 'EPERM');
    assert.strictEqual(util.withLock(path.join(dir, '.lock'), () => 'locked'), 'locked');
    failTimes('renameSync', 3, 'EBUSY');
    util.writeFileAtomic(path.join(dir, 'state.json'), '{"ok":true}\n');
    failTimes('readFileSync', 2, 'EACCES');
    assert.deepStrictEqual(util.readJson(path.join(dir, 'state.json')), { ok: true });
    // Non-transient errors still fail fast.
    fs.renameSync = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
    assert.throws(() => util.writeFileAtomic(path.join(dir, 'x.json'), '{}'), /ENOSPC/);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'a failed write leaves no temp file behind');
  } finally {
    Object.assign(fs, orig);
    Object.defineProperty(process, 'platform', plat);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
