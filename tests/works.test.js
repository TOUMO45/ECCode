'use strict';
// Work items and tracks: many deliveries on one record, each sized to its risk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const works = require('../lib/works');
const evidence = require('../lib/evidence');
const { deliver } = require('../lib/delivery');
const { Store } = require('../lib/store');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, approval, task, expectCode } = require('./helpers');

const commit = (dir, msg) => {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg], { cwd: dir });
};

function runTask(ctx, id, owner, file, content = `// ${id}\n`) {
  tasks.claim(ctx.store, ctx.config, id, owner);
  write(ctx.dir, file, content);
  const ev = passCheck(ctx.store, owner);
  tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [ev.id], [file]));
}

function approvePhase(ctx, gateId) {
  gates.submit(ctx.store, ctx.config, gateId, 'delivery-lead');
  const ev = passCheck(ctx.store, 'technical-reviewer');
  gates.recordReview(ctx.store, ctx.config, gateId, 'technical-reviewer', approval([[`ev:${ev.id}`]]));
}

function approveVerification(ctx, artifacts, n = '') {
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, `.eccode/artifacts/verify${n}.md`, '# Verification\nAll green.\n');
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [`.eccode/artifacts/verify${n}.md`, ...artifacts] });
  const ev = passCheck(ctx.store, 'security-reviewer');
  gates.recordReview(ctx.store, ctx.config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, `artifact:.eccode/artifacts/verify${n}.md`]]));
}

/** Greenfield w1 delivered end to end, repo committed. */
function deliveredProject() {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  runTask(ctx, 'api', 'backend-engineer', 'src/server/a.js');
  runTask(ctx, 'ui', 'frontend-engineer', 'src/web/b.js');
  runTask(ctx, 'tests', 'test-engineer', 'tests/c.test.js');
  approvePhase(ctx, 'phase:core');
  approveVerification(ctx, ['src/server/a.js', 'src/web/b.js', 'tests/c.test.js']);
  deliver(ctx.store, 'delivery-lead');
  commit(ctx.dir, 'w1 delivered');
  return ctx;
}

test('a second work item runs on the same record: quick track, own base, own delivery', () => {
  const ctx = deliveredProject();
  const { store, config, dir } = ctx;
  expectCode(() => works.startWork(store, config, 'frontend-engineer', { track: 'quick', title: 'Fix the label' }), 'ROLE_NOT_ALLOWED');
  works.startWork(store, config, 'orchestrator', {
    track: 'quick',
    title: 'Fix the button label',
    quick: { owner: 'frontend-engineer', files: 'src/web/**', command: 'node -e "process.exit(0)"' },
  });
  let st = store.state();
  assert.strictEqual(st.work.id, 'w2');
  assert.deepStrictEqual(st.gateOrder, ['phase:change', 'verification']);
  assert.strictEqual(st.pastWorks.w1.work.status, 'delivered');
  // another work cannot start while w2 is active
  expectCode(() => works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Another one now' }), 'WORK_ACTIVE');
  gates.startGate(store, config, 'phase:change', 'orchestrator');
  runTask(ctx, 'change', 'frontend-engineer', 'src/web/b.js', '// new label\n');
  approvePhase(ctx, 'phase:change');
  approveVerification(ctx, ['src/web/b.js'], 2);
  const { report } = deliver(store, 'delivery-lead');
  assert.strictEqual(report, '.eccode/delivery/final-handoff-w2.md');
  assert.match(fs.readFileSync(path.join(dir, report), 'utf8'), /w2 \(quick\): Fix the button label/);
  st = store.state();
  assert.strictEqual(st.work.status, 'delivered');
  // the record stays consistent after all of it
  assert.strictEqual(new Store(dir).audit().ok, true);
});

test('fix track: verification needs the same check failing before the fix and passing after', () => {
  const ctx = deliveredProject();
  const { store, config, dir } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Crash on empty ticket' });
  assert.deepStrictEqual(store.state().gateOrder, ['plan', 'verification']);
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/fixplan.json', JSON.stringify({
    phases: [{ id: 'fix', name: 'Fix', goal: 'stop the crash on empty tickets', acceptanceCriteria: ['no crash on empty input'] }],
    tasks: [task('bugfix', 'backend-engineer', ['src/server/**'], [], 'fix')],
  }));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/fixplan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/fixplan.json']]));
  gates.startGate(store, config, 'phase:fix', 'orchestrator');
  runTask(ctx, 'bugfix', 'backend-engineer', 'src/server/a.js', '// fixed\n');
  approvePhase(ctx, 'phase:fix');
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verify3.md', '# V\nok\n');
  const submitV = () => gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verify3.md', 'src/server/a.js'] });
  assert.match(expectCode(submitV, 'TRACK_RULE').message, /no reproduction pair/);
  const repro = 'node -e "process.exit(process.env.FIXED ? 0 : 1)"';
  evidence.runCommand(store, 'backend-engineer', { label: 'repro: crash', command: repro, purpose: 'reproduction' });
  expectCode(submitV, 'TRACK_RULE'); // reproduced, but never shown passing
  process.env.FIXED = '1';
  try {
    evidence.runCommand(store, 'backend-engineer', { label: 'fix verified', command: repro });
  } finally {
    delete process.env.FIXED;
  }
  submitV();
  const ev = passCheck(store, 'security-reviewer');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/verify3.md']]));
  deliver(store, 'delivery-lead');
});

test('refactor track: the behavior command must be green before the first claim and after the last approval', () => {
  const ctx = deliveredProject();
  expectCode(() => works.startWork(ctx.store, ctx.config, 'orchestrator', { track: 'refactor', title: 'Extract the pricing module' }), 'INVALID_INPUT'); // --behavior is required
  const { store, config, dir } = ctx;
  const behavior = 'node -e "process.exit(0)" # behavior-suite';
  works.startWork(store, config, 'orchestrator', { track: 'refactor', title: 'Extract the pricing module', behavior });
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/rplan.json', JSON.stringify({
    phases: [{ id: 'extract', name: 'Extract', goal: 'move pricing into its own module', acceptanceCriteria: ['behavior unchanged'] }],
    tasks: [task('move', 'backend-engineer', ['src/server/**'], [], 'extract')],
  }));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/rplan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/rplan.json']]));
  gates.startGate(store, config, 'phase:extract', 'orchestrator');
  // Deliberately claim BEFORE recording the baseline run: the gate must catch it.
  runTask(ctx, 'move', 'backend-engineer', 'src/server/a.js', '// moved\n');
  approvePhase(ctx, 'phase:extract');
  evidence.runCommand(store, 'backend-engineer', { label: 'behavior after', command: behavior });
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verify4.md', '# V\nok\n');
  const submitV = () => gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verify4.md', 'src/server/a.js'] });
  assert.match(expectCode(submitV, 'TRACK_RULE').message, /BEFORE the first task claim/);

  // Run 2: baseline recorded first, then the change, then the after-run.
  const ctx2 = deliveredProject();
  works.startWork(ctx2.store, ctx2.config, 'orchestrator', { track: 'refactor', title: 'Extract the pricing module', behavior });
  evidence.runCommand(ctx2.store, 'delivery-lead', { label: 'behavior before', command: behavior });
  gates.startGate(ctx2.store, ctx2.config, 'plan', 'orchestrator');
  write(ctx2.dir, '.eccode/artifacts/rplan.json', JSON.stringify({
    phases: [{ id: 'extract', name: 'Extract', goal: 'move pricing into its own module', acceptanceCriteria: ['behavior unchanged'] }],
    tasks: [task('move', 'backend-engineer', ['src/server/**'], [], 'extract')],
  }));
  gates.submit(ctx2.store, ctx2.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/rplan.json'] });
  gates.recordReview(ctx2.store, ctx2.config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/rplan.json']]));
  gates.startGate(ctx2.store, ctx2.config, 'phase:extract', 'orchestrator');
  runTask(ctx2, 'move', 'backend-engineer', 'src/server/a.js', '// moved\n');
  approvePhase(ctx2, 'phase:extract');
  const submit2 = () => gates.submit(ctx2.store, ctx2.config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verify5.md', 'src/server/a.js'] });
  gates.startGate(ctx2.store, ctx2.config, 'verification', 'orchestrator');
  write(ctx2.dir, '.eccode/artifacts/verify5.md', '# V\nok\n');
  assert.match(expectCode(submit2, 'TRACK_RULE').message, /AFTER the last phase approval/);
  evidence.runCommand(ctx2.store, 'delivery-lead', { label: 'behavior after', command: behavior });
  submit2();
});

test('feature track skips architecture; abandon needs the user and frees the record', () => {
  const ctx = deliveredProject();
  const { store, config } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'feature', title: 'Add CSV export' });
  assert.deepStrictEqual(store.state().gateOrder, ['design', 'plan', 'verification']);
  expectCode(() => works.abandonWork(store, 'orchestrator', 'scope changed under us'), 'USER_AUTH_REQUIRED');
  works.abandonWork(store, 'user', 'scope changed: export moves to the reporting service');
  assert.strictEqual(store.state().work.status, 'abandoned');
  works.startWork(store, config, 'orchestrator', { track: 'quick', title: 'Remove the dead export stub', quick: { owner: 'backend-engineer', files: 'src/server/**', command: 'true' } });
  assert.strictEqual(store.state().work.id, 'w3');
  assert.strictEqual(new Store(ctx.dir).audit().ok, true);
});

test('endurance: ten consecutive work items of mixed tracks deliver on one record', () => {
  const ctx = deliveredProject(); // w1 (greenfield)
  const { store, config, dir } = ctx;
  for (let i = 2; i <= 11; i++) {
    const track = ['quick', 'fix', 'quick', 'feature-abandoned', 'quick'][(i - 2) % 5];
    if (track === 'feature-abandoned') {
      works.startWork(store, config, 'orchestrator', { track: 'feature', title: `Feature attempt ${i} later dropped` });
      works.abandonWork(store, 'user', `scope for item ${i} moved to the next quarter`);
      continue;
    }
    if (track === 'fix') {
      works.startWork(store, config, 'orchestrator', { track: 'fix', title: `Fix defect number ${i}` });
      gates.startGate(store, config, 'plan', 'orchestrator');
      write(dir, `.eccode/artifacts/plan${i}.json`, JSON.stringify({
        phases: [{ id: 'fix', name: 'Fix', goal: `repair defect number ${i}`, acceptanceCriteria: ['defect gone'] }],
        tasks: [task(`bug${i}`, 'backend-engineer', ['src/server/**'], [], 'fix')],
      }));
      gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: [`.eccode/artifacts/plan${i}.json`] });
      gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([[`artifact:.eccode/artifacts/plan${i}.json`]]));
      gates.startGate(store, config, `phase:fix`, 'orchestrator');
      runTask(ctx, `bug${i}`, 'backend-engineer', 'src/server/a.js', `// fix ${i}\n`);
      approvePhase(ctx, 'phase:fix');
      const repro = `node -e "process.exit(process.env.OK${i} ? 0 : 1)"`;
      evidence.runCommand(store, 'backend-engineer', { label: 'repro', command: repro, purpose: 'reproduction' });
      process.env[`OK${i}`] = '1';
      try {
        evidence.runCommand(store, 'backend-engineer', { label: 'fixed', command: repro });
      } finally {
        delete process.env[`OK${i}`];
      }
      approveVerification(ctx, ['src/server/a.js'], i);
    } else {
      works.startWork(store, config, 'orchestrator', { track: 'quick', title: `Quick change number ${i}`, quick: { owner: 'frontend-engineer', files: 'src/web/**', command: 'node -e "process.exit(0)"' } });
      gates.startGate(store, config, 'phase:change', 'orchestrator');
      runTask(ctx, 'change', 'frontend-engineer', 'src/web/b.js', `// change ${i}\n`);
      approvePhase(ctx, 'phase:change');
      approveVerification(ctx, ['src/web/b.js'], i);
    }
    deliver(store, 'delivery-lead');
    commit(dir, `w${i}`);
  }
  const st = store.state();
  assert.strictEqual(st.work.id, 'w11');
  assert.strictEqual(st.work.status, 'delivered');
  const past = Object.values(st.pastWorks);
  assert.strictEqual(past.length, 10);
  assert.strictEqual(past.filter((p) => p.work.status === 'delivered').length, 8); // w1 + seven of w2..w10
  assert.strictEqual(past.filter((p) => p.work.status === 'abandoned').length, 2);
  // The whole multi-delivery history replays and audits clean.
  const audit = new Store(dir).audit();
  assert.strictEqual(audit.ok, true, audit.errors.join('; '));
  assert.ok(audit.events > 150, `expected a long record, got ${audit.events} events`); // 166 events across 11 work items
});

test('snapshots from an older engine schema are stale caches, not tampering', () => {
  const ctx = tmpProject();
  const snap = JSON.parse(fs.readFileSync(path.join(ctx.dir, '.eccode/state.json'), 'utf8'));
  delete snap.stateVersion;
  delete snap.work;
  delete snap.pastWorks;
  fs.writeFileSync(path.join(ctx.dir, '.eccode/state.json'), JSON.stringify(snap));
  const store = new Store(ctx.dir);
  assert.strictEqual(store.audit().ok, true); // old-schema snapshot is not an error
  assert.strictEqual(store.state().work.id, 'w1'); // reads come from replay, not the stale cache
});
