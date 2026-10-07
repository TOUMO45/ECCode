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
  const ev = evidence.runCommand(ctx.store, 'test-engineer', { label: 'leaky', command: 'echo "ANTHROPIC key sk-ant-api03-abcdefghijklmnop and api_key=supersecret123"; exit 4' });
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
  const procs = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, 'risk', 'add', '--id', `R${i}`, '--title', `risk ${i}`, '--severity', 'low', '--actor', 'delivery-lead', '--root', ctx.dir]);
      p.on('exit', resolve);
    }),
  );
  const codes = await Promise.all(procs);
  assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 0]);
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
