'use strict';
// Regression tests for the independent security review (findings #1–#22).
// Each test reproduces a defect that the engine used to accept; the finding
// number is in the test name. Guard-hook findings live in hooks-install.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const runs = require('../lib/runs');
const util = require('../lib/util');
const { tmpProject, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function cli(dir, args, env = {}) {
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function risk(store, id) {
  return runs.recordRisk(store, 'delivery-lead', { id, title: `risk ${id}`, severity: 'low' });
}

// ---------------------------------------------------------------- #4 torn line

test('#4 a torn final line is repaired before the next append, so the log never becomes permanently corrupt', () => {
  const ctx = tmpProject();
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  fs.appendFileSync(log, '{"seq": 2, "trunc'); // process died mid-append
  risk(ctx.store, 'R1');
  risk(ctx.store, 'R2');
  const fresh = new Store(ctx.dir);
  const st = fresh.state();
  assert.deepStrictEqual(Object.keys(st.risks).sort(), ['R1', 'R2']);
  assert.strictEqual(fresh.audit().ok, true, JSON.stringify(fresh.audit().errors));
  assert.ok(!fs.readFileSync(log, 'utf8').includes('trunc'), 'the torn fragment is dropped');
});

test('#4 a complete final event that only lost its newline is kept', () => {
  const ctx = tmpProject();
  risk(ctx.store, 'R1');
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/\n$/, ''));
  risk(ctx.store, 'R2');
  const st = new Store(ctx.dir).state();
  assert.deepStrictEqual(Object.keys(st.risks).sort(), ['R1', 'R2']);
  assert.strictEqual(ctx.store.audit().ok, true);
});

// ------------------------------------------------------------ #5 log rollback

test('#5 a log rolled back behind its snapshot is refused (LOG_ROLLBACK) until the user accepts it', () => {
  const ctx = tmpProject();
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  risk(ctx.store, 'R1');
  const older = fs.readFileSync(log, 'utf8');
  risk(ctx.store, 'R2');
  risk(ctx.store, 'R3');
  fs.writeFileSync(log, older); // e.g. `git checkout -- .eccode/events.jsonl`
  expectCode(() => ctx.store.state(), 'LOG_ROLLBACK');
  expectCode(() => risk(ctx.store, 'R4'), 'LOG_ROLLBACK');
  expectCode(() => ctx.store.rebuildSnapshot(), 'LOG_ROLLBACK');
  let res = cli(ctx.dir, ['audit']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /rolled back|behind/i);
  res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'orchestrator']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
  res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'user']);
  assert.strictEqual(res.status, 0, res.stderr);
  const st = ctx.store.state();
  assert.deepStrictEqual(Object.keys(st.risks), ['R1']);
  const last = ctx.store.readEvents().pop();
  assert.strictEqual(last.type, 'record.rollback_accepted');
  assert.strictEqual(last.actor, 'user');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('#5 a log replaced by a different history is refused; a snapshot that is merely behind is still rebuilt', () => {
  const a = tmpProject();
  const b = tmpProject();
  for (const id of ['R1', 'R2', 'R3']) risk(b.store, id);
  risk(a.store, 'A1');
  fs.copyFileSync(path.join(b.dir, '.eccode/events.jsonl'), path.join(a.dir, '.eccode/events.jsonl'));
  expectCode(() => a.store.state(), 'LOG_ROLLBACK');

  // Crash between append and snapshot write: snapshot behind, same history.
  const snapFile = path.join(b.dir, '.eccode/state.json');
  const behind = fs.readFileSync(snapFile, 'utf8');
  risk(b.store, 'R4');
  fs.writeFileSync(snapFile, behind);
  assert.ok(b.store.state().risks.R4);
});

// ----------------------------------------------------------- #9 ECCODE_NOW

test('#9 ECCODE_NOW is honoured only when ECCODE_TEST=1', () => {
  const saved = { now: process.env.ECCODE_NOW, test: process.env.ECCODE_TEST };
  try {
    process.env.ECCODE_NOW = '2099-01-01T00:00:00.000Z';
    delete process.env.ECCODE_TEST;
    assert.notStrictEqual(util.now().getUTCFullYear(), 2099);
    process.env.ECCODE_TEST = '1';
    assert.strictEqual(util.now().getUTCFullYear(), 2099);
  } finally {
    for (const [k, v] of [['ECCODE_NOW', saved.now], ['ECCODE_TEST', saved.test]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const ctx = tmpProject();
  const env = { ...process.env, ECCODE_NOW: '2099-01-01T00:00:00Z' };
  delete env.ECCODE_TEST;
  const res = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'pre', '--json', '--', 'true'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  const ev = ctx.store.state().evidence[JSON.parse(res.stdout).id];
  assert.ok(!ev.at.startsWith('2099'), `forged timestamp recorded: ${ev.at}`);
});

test('#9 audit reports event timestamps that go backwards', () => {
  const ctx = tmpProject();
  const saved = { now: process.env.ECCODE_NOW, test: process.env.ECCODE_TEST };
  try {
    process.env.ECCODE_TEST = '1';
    process.env.ECCODE_NOW = '2099-01-01T00:00:00.000Z';
    risk(ctx.store, 'R1');
  } finally {
    for (const [k, v] of [['ECCODE_NOW', saved.now], ['ECCODE_TEST', saved.test]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  risk(ctx.store, 'R2');
  const res = ctx.store.audit();
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /timestamp goes backwards/);
});

// ------------------------------------------- #3 prototype-chain id lookups

const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { Memory } = require('../lib/memory/records');
const { write, approval, approveThroughPlan, handoffFor, samplePlan, ARCH_MD } = require('./helpers');

function sharedMemoryDir() {
  process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-shared-'));
  return process.env.ECCODE_SHARED_MEMORY;
}

function knowledge(mem, title, extra = {}) {
  return mem.add('learning-debugger', {
    layer: 'knowledge',
    content: { title, summary: 'The ticket API rate-limits bursts; use exponential backoff.', sources: [{ title: 'docs', url: 'https://example.com/docs', checkedAt: '2026-10-01' }], appliesWhen: ['calling the ticket API'], notApplicableWhen: [], confidence: 'medium', ...extra },
  });
}

test('#3 evidence refs never resolve to inherited properties (ev:constructor, ev:__proto__, ...)', () => {
  const ctx = tmpProject();
  const st = ctx.store.state();
  for (const ref of ['ev:constructor', 'ev:__proto__', 'ev:toString', 'ev:hasOwnProperty']) {
    assert.strictEqual(evidence.resolveRef(st, ctx.dir, ref).ok, false, ref);
  }
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  expectCode(() => gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', approval([['ev:constructor'], ['ev:__proto__']])), 'REVIEW_REJECTED');
  const h = handoffFor('x', 'product-architect', [], []);
  delete h.task;
  h.evidence = ['ev:hasOwnProperty'];
  expectCode(() => tasks.recordHandoff(ctx.store, 'product-architect', h), 'INVALID_HANDOFF');
});

test('#3 memory assess and lesson verification do not accept inherited evidence ids', () => {
  sharedMemoryDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const rec = knowledge(mem, 'Retry policy for the ticket API');
  expectCode(() => mem.assess(rec.id, 'backend-engineer', { verdict: 'does-not-apply', reason: 'no experiment', evidence: ['ev:constructor'] }), 'INVALID_EVIDENCE');
  assert.deepStrictEqual(mem.snapshotEvidence({ evidenceSnapshots: {} }, ['ev:toString'], ctx.store.state()), [{ ref: 'ev:toString', missing: true }]);
});

test('#3 task, run, risk, gate and evidence ids are own-property lookups (no TypeError, no inherited match)', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const id of ['toString', 'constructor', '__proto__']) {
    expectCode(() => tasks.claim(store, config, id, 'backend-engineer'), 'UNKNOWN_TASK');
    expectCode(() => tasks.reset(store, id, 'orchestrator', 'rework'), 'UNKNOWN_TASK');
    expectCode(() => runs.endRun(store, config, id, 'orchestrator', { tokens: 1 }), 'UNKNOWN_RUN');
  }
  expectCode(() => runs.recordRisk(store, 'delivery-lead', { id: 'toString', status: 'closed' }), 'INVALID_INPUT');
  expectCode(() => runs.recordRisk(store, 'delivery-lead', { id: '__proto__', title: 'x', severity: 'low' }), 'INVALID_INPUT');
  for (const args of [['gate', 'show', 'constructor'], ['evidence', 'show', 'constructor'], ['task', 'claim', 'toString', '--actor', 'backend-engineer'], ['run', 'end', 'constructor', '--actor', 'orchestrator', '--tokens', '1']]) {
    const res = cli(ctx.dir, args);
    assert.strictEqual(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.doesNotMatch(res.stderr, /internal error/);
  }
  const bad = samplePlan();
  bad.tasks[0].id = 'constructor';
  assert.match(tasks.validatePlan(bad, config).join('\n'), /reserved/);
});

// ------------------------------------------------ #21 self-supersession

test('#21 a record cannot supersede itself (or be superseded by a superseded/rejected one)', () => {
  sharedMemoryDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const a = knowledge(mem, 'Retry policy one');
  expectCode(() => mem.supersede(a.id, a.id, 'backend-engineer', 'cleanup'), 'INVALID_INPUT');
  assert.strictEqual(mem.get(a.id).status, 'provisional');
  const b = knowledge(mem, 'Retry policy two');
  const c = knowledge(mem, 'Retry policy three');
  mem.supersede(b.id, c.id, 'backend-engineer', 'merged');
  expectCode(() => mem.supersede(a.id, b.id, 'backend-engineer', 'merged into a superseded record'), 'INVALID_TRANSITION');
});

// ------------------------------------------ #22 CLI parsing and validation

test('#22 CLI refuses unexpected positionals instead of dropping them (unquoted glob after --artifact)', () => {
  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, 'brief.md', ARCH_MD);
  write(ctx.dir, 'docs/a.md', '# A\n');
  write(ctx.dir, 'docs/b.md', '# B\n');
  const res = cli(ctx.dir, ['gate', 'submit', 'architecture', '--actor', 'product-architect', '--artifact', 'brief.md', 'docs/a.md', 'docs/b.md']);
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /USAGE.*docs\/a\.md/);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'in_progress');
});

test('#22 CLI input errors are clean EccodeErrors, not internal errors', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'src/x.js', '1');
  const cases = [
    [['evidence', 'file', 'src', '--actor', 'test-engineer'], 2],
    [['evidence', 'run', '--actor', 'test-engineer', '--label', 'l', '--timeout', '5m', '--', 'true'], 1],
    [['memory', 'search', 'x', '--limit', 'many'], 1],
    [['reconcile', '--actor', 'orchestrator', '--max-checks', 'all'], 1],
  ];
  for (const [args, code] of cases) {
    const res = cli(ctx.dir, args);
    assert.strictEqual(res.status, code, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.doesNotMatch(res.stderr, /internal error/, args.join(' '));
  }
});

test('#22 run end/correct usage must be finite non-negative numbers', () => {
  const ctx = tmpProject();
  const { store, config } = ctx;
  for (const usage of [{ tokens: '-800000' }, { tokens: 'abc' }, { tokens: 'Infinity' }, { costUsd: '-1' }, { costUsd: 'NaN' }, { tokens: ' ' }]) {
    const id = runs.startRun(store, config, 'backend-engineer');
    expectCode(() => runs.endRun(store, config, id, 'orchestrator', usage), 'INVALID_INPUT');
    assert.strictEqual(store.state().runs[id].status, 'running');
    runs.endRun(store, config, id, 'orchestrator', { tokens: '10' });
    expectCode(() => runs.correctRun(store, id, 'orchestrator', { ...usage, reason: 'bad figure' }), 'INVALID_INPUT');
  }
  assert.strictEqual(store.state().totals.tokens, 60);
});

test('#22 memory ids are validated before they are used as paths', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'x.json', '{"id":"x","layer":"project","revisions":[{"content":{"title":"t"}}],"reviews":[]}');
  for (const id of ['../../../../x', '../../x', 'mem-d-../../x']) {
    const res = cli(ctx.dir, ['memory', 'show', id]);
    assert.strictEqual(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /INVALID_INPUT/);
  }
});
