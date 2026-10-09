'use strict';
// Resume must not trust the record blindly: a fresh session reconciles what
// the record says against the working tree and re-runs the recorded checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const runs = require('../lib/runs');
const evidence = require('../lib/evidence');
const { reconcile } = require('../lib/reconcile');
const { tmpProject, write, approveThroughPlan, samplePlan, handoffFor } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const CHECK = 'node -e "process.exit(require(\'fs\').existsSync(\'src/server/a.js\') ? 0 : 1)"';

/** A phase with one done task (with a passing check) and one task interrupted mid-work. */
function interruptedProject() {
  const ctx = tmpProject();
  const { dir, store, config } = ctx;
  const plan = samplePlan();
  plan.tasks[0].verification = { method: 'check that the server file exists', command: CHECK }; // the check the api task must cite
  approveThroughPlan(ctx, plan);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', 'module.exports = 1;\n');
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'server file present', command: CHECK, task: 'api' });
  assert.strictEqual(ev.status, 'passed');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js']));
  const runId = runs.startRun(store, config, 'frontend-engineer', { task: 'ui' });
  tasks.claim(store, config, 'ui', 'frontend-engineer', { runId });
  write(dir, 'src/web/partial.js', '// half done\n');
  // The session dies here: the run stays open and the claim is held.
  return { ...ctx, runId, ev };
}

test('reconcile reports interrupted claims with their partial work and open runs, without blocking', () => {
  const ctx = interruptedProject();
  const rep = reconcile(ctx.store, ctx.config, 'orchestrator');
  assert.strictEqual(rep.ok, true, JSON.stringify(rep.issues));
  const claimed = rep.issues.find((i) => i.kind === 'claimed-task');
  assert.ok(claimed, 'claimed task reported');
  assert.strictEqual(claimed.task, 'ui');
  assert.deepStrictEqual(claimed.partialFiles, ['src/web/partial.js']);
  assert.ok(rep.issues.some((i) => i.kind === 'open-run' && i.run === ctx.runId));
  const st = ctx.store.state();
  assert.strictEqual(st.reconciliations.length, 1);
  assert.strictEqual(st.reconciliations[0].blocking, 0);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('reconcile blocks on approved artifacts changed after approval and on checks that no longer pass', () => {
  const ctx = interruptedProject();
  write(ctx.dir, '.eccode/artifacts/spec.md', '# edited after approval\n');
  fs.unlinkSync(path.join(ctx.dir, 'src/server/a.js'));
  const rep = reconcile(ctx.store, ctx.config, 'orchestrator', { verify: true });
  assert.strictEqual(rep.ok, false);
  const art = rep.issues.find((i) => i.kind === 'approved-artifact');
  assert.ok(art && art.severity === 'blocking');
  assert.match(art.detail, /spec\.md modified after approval/);
  const reg = rep.issues.find((i) => i.kind === 'check-regressed');
  assert.ok(reg && reg.severity === 'blocking', JSON.stringify(rep.issues));
  assert.strictEqual(reg.previous, ctx.ev.id);
  // The re-run is itself on the record as evidence.
  const rerun = ctx.store.state().evidence[reg.rerun];
  assert.strictEqual(rerun.status, 'failed');
  assert.match(rerun.label, /^reconcile: /);
  assert.strictEqual(ctx.store.state().reconciliations[0].blocking, 2);
});

test('verify re-runs recorded checks that still pass and reports them as confirmed', () => {
  const ctx = interruptedProject();
  const rep = reconcile(ctx.store, ctx.config, 'orchestrator', { verify: true });
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.checks.length, 1);
  assert.strictEqual(rep.checks[0].previous, ctx.ev.id);
  assert.strictEqual(ctx.store.state().evidence[rep.checks[0].rerun].status, 'passed');
});

test('CLI: reconcile exits 3 on blocking issues; resume shows reconciliation read-only', () => {
  const ctx = interruptedProject();
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args, '--root', ctx.dir], { encoding: 'utf8' });
  const before = ctx.store.state().seq;
  let res = cli('resume');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /RECONCILE/);
  assert.match(res.stdout, /ui.*src\/web\/partial\.js/);
  assert.strictEqual(ctx.store.state().seq, before, 'resume must not write to the record');
  res = cli('reconcile', '--actor', 'orchestrator', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout).ok, true);
  write(ctx.dir, '.eccode/artifacts/brief.md', '# changed\n');
  res = cli('reconcile', '--actor', 'orchestrator');
  assert.strictEqual(res.status, 3);
  assert.match(res.stdout, /BLOCKING/);
});
