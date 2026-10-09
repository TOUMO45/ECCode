'use strict';
// The "change" profile: a change request on an existing codebase goes through
// plan -> phase gates only (no architecture/design gates), with the same
// enforcement: independent plan review, owned tasks with evidence, and a
// phase review that re-runs checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { deliver } = require('../lib/delivery');
const { write, samplePlan, passCheck, handoffFor, approval, coverage, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function changeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-change-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = init(dir, { name: 'Fix invoice totals', idea: 'Invoice totals concatenate strings instead of adding', profile: 'change' });
  return { dir, store, config: loadConfig(dir) };
}

test('change profile: plan is the first gate and no verification gate follows the phases', () => {
  const ctx = changeProject();
  const { dir, store, config } = ctx;
  assert.deepStrictEqual(store.state().gateOrder, ['plan']);
  assert.strictEqual(store.state().project.profile, 'change');
  gates.startGate(store, config, 'plan', 'orchestrator'); // no predecessor to wait for
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  // The author still cannot approve their own plan.
  expectCode(() => gates.recordReview(store, config, 'plan', 'delivery-lead', approval([['artifact:.eccode/artifacts/plan.json']])), 'REVIEW_REJECTED');
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
  assert.deepStrictEqual(store.state().gateOrder, ['plan', 'phase:core']);

  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${ev.id}`]));
  // The delivery pins the release tree: the reviewed work is committed first.
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'reviewed work'], { cwd: dir });
  const res = deliver(store, 'delivery-lead');
  assert.ok(fs.existsSync(path.join(dir, res.report)));
  assert.strictEqual(store.state().delivery.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  assert.strictEqual(store.audit().ok, true);
});

test('default profile is unchanged and unknown profiles are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-prof-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const store = init(dir, { name: 'App', idea: 'A full delivery of a product idea' });
  assert.deepStrictEqual(store.state().gateOrder, ['architecture', 'design', 'plan', 'verification']);
  assert.strictEqual(store.state().project.profile, undefined); // old snapshots stay identical
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-prof-'));
  expectCode(() => init(dir2, { name: 'X', idea: 'some idea text', profile: 'yolo' }), 'INVALID_INPUT');
});

test('CLI: init --profile change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-prof-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const res = spawnSync(process.execPath, [BIN, 'init', '--name', 'Fix', '--idea', 'Fix the refund limit check', '--profile', 'change', '--root', dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.eccode', 'state.json'), 'utf8'));
  assert.deepStrictEqual(st.gateOrder, ['plan']);
});
