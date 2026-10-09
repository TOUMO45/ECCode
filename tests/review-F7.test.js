'use strict';
// Review finding F7: the store trusted a snapshot whose seq/lastHash matched the
// log's head without checking its content, so a forged state.json (a gate status
// flipped to approved) let the next transition be committed on top of it. These
// tests pin the repair: state() verifies the snapshot against the log before any
// commit builds on it, a torn snapshot is a lost cache, a rolled-back log stays
// LOG_ROLLBACK, concurrent writers keep a consistent chain, and the two-commit
// transitions (plan submission, task completion) stay recoverable after a crash.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const runs = require('../lib/runs');
const reconcile = require('../lib/reconcile');
const { Store } = require('../lib/store');
const { tmpProject, write, approveThroughPlan, approval, passCheck, handoffFor, samplePlan, expectCode, ARCH_MD, DESIGN_MD } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const cli = (dir, args) => spawnSync(process.execPath, [BIN, ...args, '--root', dir], { encoding: 'utf8' });

function readSnap(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.eccode/state.json'), 'utf8'));
}

function writeSnap(dir, snap) {
  fs.writeFileSync(path.join(dir, '.eccode/state.json'), JSON.stringify(snap, null, 2) + '\n');
}

/** Make the store die right after the commit that precedes `type` (the crash between two commits). */
function crashBefore(store, type) {
  const original = store.commit.bind(store);
  store.commit = (t, ...rest) => {
    if (t === type) throw new Error(`simulated crash before ${t}`);
    return original(t, ...rest);
  };
  return () => {
    store.commit = original;
  };
}

test('F7 a forged snapshot (status flipped, seq/lastHash intact) is refused: no commit builds on it, audit reports it, rebuild repairs it', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  const snap = readSnap(dir);
  assert.strictEqual(snap.gates.architecture.status, 'pending');
  snap.gates.architecture.status = 'approved'; // the reviewer's probe: content only, seq/lastHash untouched
  writeSnap(dir, snap);

  const err = expectCode(() => store.state(), 'SNAPSHOT_DIVERGED');
  assert.match(err.message, /gates\.architecture\.status/);
  assert.match(err.details.recovery, /eccode audit shows the difference; eccode rebuild --actor orchestrator rewrites state\.json from the log/);

  // The transition that needs architecture approved is refused before anything is appended.
  const logFile = path.join(dir, '.eccode/events.jsonl');
  const logBefore = fs.readFileSync(logFile, 'utf8');
  expectCode(() => gates.startGate(store, config, 'design', 'orchestrator'), 'SNAPSHOT_DIVERGED');
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), logBefore, 'nothing was appended');
  assert.strictEqual(readSnap(dir).gates.architecture.status, 'approved', 'the forged snapshot is left for audit to show');

  // The CLI tells the agent what to do next.
  const res = cli(dir, ['gate', 'start', 'design', '--actor', 'orchestrator']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /\[SNAPSHOT_DIVERGED\]/);
  assert.match(res.stderr, /eccode rebuild --actor orchestrator/);
  assert.doesNotMatch(res.stderr, /internal error|TypeError/);

  // audit and rebuild keep working on the diverged snapshot.
  const audit = store.audit();
  assert.strictEqual(audit.ok, false);
  assert.match(audit.errors.join('\n'), /state\.json diverges from a replay of events\.jsonl at state\.gates\.architecture\.status \(snapshot "approved", replay "pending"\)/);
  assert.strictEqual(cli(dir, ['audit']).status, 2);
  const rebuilt = store.rebuildSnapshot({ actor: 'orchestrator' });
  assert.strictEqual(rebuilt.gates.architecture.status, 'pending');
  assert.strictEqual(store.audit().ok, true);
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), logBefore, 'rebuild appends nothing for a plain divergence');

  // The forged approval is gone: design is blocked, the legitimate next step commits.
  expectCode(() => gates.startGate(store, config, 'design', 'orchestrator'), 'GATE_BLOCKED');
  gates.startGate(store, config, 'architecture', 'orchestrator');
  assert.strictEqual(store.state().gates.architecture.status, 'in_progress');
  assert.strictEqual(store.audit().ok, true);
});

test('F7 a snapshot forged to a non-existent event (seq/lastHash) stays LOG_ROLLBACK, as before', () => {
  const ctx = tmpProject();
  const { store, dir } = ctx;
  runs.recordRisk(store, 'delivery-lead', { id: 'R1', title: 'one', severity: 'low' });
  const good = readSnap(dir);
  // Ahead of the log.
  writeSnap(dir, { ...good, seq: good.seq + 1, lastHash: 'ab'.repeat(32) });
  expectCode(() => store.state(), 'LOG_ROLLBACK');
  expectCode(() => runs.recordRisk(store, 'delivery-lead', { id: 'R2', title: 'two', severity: 'low' }), 'LOG_ROLLBACK');
  // Same seq, a hash that is not in the log.
  writeSnap(dir, { ...good, lastHash: 'cd'.repeat(32) });
  expectCode(() => store.state(), 'LOG_ROLLBACK');
  assert.match(store.audit().errors.join('\n'), /not in events\.jsonl/);
  // A snapshot that is merely behind the log (crash between append and snapshot write) is rebuilt.
  writeSnap(dir, good);
  runs.recordRisk(store, 'delivery-lead', { id: 'R2', title: 'two', severity: 'low' });
  writeSnap(dir, good);
  assert.ok(new Store(dir).state().risks.R2);
  assert.match(store.audit().errors.join('\n'), /diverges from a replay .* at state\.seq/);
  runs.recordRisk(store, 'delivery-lead', { id: 'R3', title: 'three', severity: 'low' });
  assert.strictEqual(store.audit().ok, true);
});

test('F7 a truncated (torn) state.json is a lost cache: state() rebuilds it and the next commit writes it back', () => {
  const ctx = tmpProject();
  const { store, dir } = ctx;
  runs.recordRisk(store, 'delivery-lead', { id: 'R1', title: 'one', severity: 'low' });
  const file = path.join(dir, '.eccode/state.json');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
  const st = new Store(dir).state();
  assert.deepStrictEqual(st, store.rebuild());
  assert.ok(st.risks.R1);
  const audit = store.audit();
  assert.strictEqual(audit.ok, false);
  assert.match(audit.errors.join('\n'), /state\.json is not valid JSON/);
  runs.recordRisk(store, 'delivery-lead', { id: 'R2', title: 'two', severity: 'low' });
  assert.deepStrictEqual(Object.keys(readSnap(dir).risks), ['R1', 'R2']);
  assert.strictEqual(store.audit().ok, true);
});

test('F7 two concurrent writers produce one consistent chain under the snapshot check', async () => {
  const ctx = tmpProject();
  const procs = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN, 'risk', 'add', '--id', `R${i}`, '--title', `risk ${i}`, '--severity', 'low', '--actor', 'delivery-lead', '--root', ctx.dir]);
      p.on('exit', resolve);
    }),
  );
  const codes = await Promise.all(procs);
  assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 0]);
  const st = new Store(ctx.dir).state();
  assert.deepStrictEqual(Object.keys(st.risks).sort(), ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  assert.strictEqual(ctx.store.audit().ok, true);
  const events = ctx.store.readEvents();
  assert.strictEqual(events.length, st.seq);
  assert.deepStrictEqual(st, ctx.store.rebuild(events));
  // A snapshot forged after the race is still caught.
  const snap = readSnap(ctx.dir);
  snap.risks.R3.severity = 'critical';
  writeSnap(ctx.dir, snap);
  expectCode(() => runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R9', title: 'nine', severity: 'low' }), 'SNAPSHOT_DIVERGED');
});

test('F7 a crash between task.completed and handoff.recorded does not block the record and the handoff can be recorded afterwards', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// api\n');
  const ev = passCheck(store, 'backend-engineer');
  const handoff = handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js']);
  const restore = crashBefore(store, 'handoff.recorded');
  assert.throws(() => tasks.complete(store, config, 'api', 'backend-engineer', handoff), /simulated crash/);
  restore();

  // What the crash leaves: the task is done and names a handoff the record does not hold.
  let st = store.state();
  assert.strictEqual(st.tasks.api.status, 'done');
  assert.ok(st.tasks.api.handoffId);
  assert.strictEqual(st.handoffs[st.tasks.api.handoffId], undefined);
  assert.ok(!fs.existsSync(path.join(dir, '.eccode/handoffs', `${st.tasks.api.handoffId}.json`)));
  // The record is not blocked: the chain is intact, resume finds nothing blocking, the gap is a warning.
  const audit = store.audit();
  assert.strictEqual(audit.ok, true);
  assert.deepStrictEqual(audit.errors, []);
  assert.match(audit.warnings.join('\n'), /task api is done but its handoff .* is not in the record/);
  assert.match(audit.warnings.join('\n'), /eccode handoff record --actor backend-engineer/);
  assert.deepStrictEqual(reconcile.inspect(store).filter((i) => i.severity === 'blocking'), []);
  assert.strictEqual(cli(dir, ['status', '--brief']).status, 0);

  // Recovery through the existing path: the owner records the handoff it wrote.
  const id = tasks.recordHandoff(store, 'backend-engineer', handoff);
  st = store.state();
  assert.strictEqual(st.handoffs[id].task, 'api');
  assert.deepStrictEqual(store.audit().warnings, []);
  // The phase goes on to review and approval as if nothing had happened.
  for (const [tid, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, tid, owner);
    write(dir, file, `// ${tid}\n`);
    const check = passCheck(store, owner);
    tasks.complete(store, config, tid, owner, handoffFor(tid, owner, [check.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const check = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${check.id}`]]));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
  assert.strictEqual(store.audit().ok, true);
});

test('F7 a crash between gate.submitted and plan.imported refuses approval until the author resubmits', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md#Requirements']]));
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md']]));
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  const restore = crashBefore(store, 'plan.imported');
  assert.throws(() => gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] }), /simulated crash/);
  restore();
  let st = store.state();
  assert.strictEqual(st.gates.plan.status, 'submitted');
  assert.strictEqual(st.plan, null);
  assert.strictEqual(store.audit().ok, true);
  const err = expectCode(() => gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']])), 'REVIEW_REJECTED');
  assert.match(err.message, /was not imported \(the submission was interrupted\)/);
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
  st = store.state();
  assert.strictEqual(st.gates.plan.status, 'approved');
  assert.deepStrictEqual(Object.keys(st.tasks), ['api', 'ui', 'tests']);
  assert.strictEqual(store.audit().ok, true);
});

test('F7 every event the store appends carries the digest of the state it produced; the shipped records (without one) still verify by replay', () => {
  const ctx = tmpProject();
  const { store, dir } = ctx;
  runs.recordRisk(store, 'delivery-lead', { id: 'R1', title: 'one', severity: 'low' });
  const { stateDigest } = require('../lib/store');
  const last = store.readEvents().pop();
  assert.match(last.stateHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(stateDigest(readSnap(dir)), last.stateHash);
  assert.strictEqual(stateDigest(store.rebuild()), last.stateHash);
  // The digest is inside the hash chain: editing it is detected like any other edit.
  const logFile = path.join(dir, '.eccode/events.jsonl');
  const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
  const forged = { ...JSON.parse(lines[lines.length - 1]), stateHash: 'ef'.repeat(32) };
  fs.writeFileSync(logFile, [...lines.slice(0, -1), JSON.stringify(forged)].join('\n') + '\n');
  assert.match(store.audit().errors.join('\n'), /content hash mismatch/);
  // A record written before the digest existed verifies by replay and stays replay-identical.
  const triage = new Store(path.join(__dirname, '..', 'examples/triage-desk'));
  assert.strictEqual(triage.readEvents().pop().stateHash, undefined);
  assert.deepStrictEqual(triage.state(), triage.rebuild());
});
