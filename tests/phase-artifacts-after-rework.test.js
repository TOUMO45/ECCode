'use strict';
// TK-1 (RescueStock pilot): a phase submission pins the files its tasks changed. A task that is reset
// after a review and completed again records only the files the rework touched in its latest handoff
// (its base commit already holds the first attempt's files, so git shows nothing else changed), and
// the next phase submission silently dropped the other files from the review set. The pinned set must
// be the union of every completion the task recorded.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { unreviewedChanges } = require('../lib/delivery');
const { tmpProject, write, approveThroughPlan, samplePlan, task, passCheck, handoffFor, coverage } = require('./helpers');

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg], { cwd: dir });
}

test('a phase submission pins every file a task changed across a reset and re-completion, not only the rework handoff', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx, {
    phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }],
    tasks: [task('api', 'backend-engineer', ['src/server/**'])],
  });
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');

  // First attempt: A and B.
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// a v1\n');
  write(dir, 'src/server/b.js', '// b v1\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js', 'src/server/b.js']));
  assert.deepStrictEqual(store.state().tasks.api.filesChanged, ['src/server/a.js', 'src/server/b.js']);

  // The review requests changes; the first attempt is committed (a claim refuses dirty ownership) and
  // the task is reset for rework.
  commitAll(dir, 'api v1');
  tasks.reset(store, 'api', 'orchestrator', 'PB-1: concurrent start fails');

  // Rework: only B changes, C is new. A is untouched since the rework's base commit, so the handoff
  // correctly lists B and C only (declaring A would be refused as unchanged since the claim).
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/b.js', '// b v2\n');
  write(dir, 'src/server/c.js', '// c v1\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/b.js', 'src/server/c.js']));
  assert.strictEqual(store.state().tasks.api.status, 'done');

  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const g = store.state().gates['phase:core'];
  const pinned = g.submissions[g.submissions.length - 1].artifacts.map((a) => a.path).sort();
  assert.deepStrictEqual(pinned, ['src/server/a.js', 'src/server/b.js', 'src/server/c.js'], 'A (first attempt), B and C (rework) are all pinned');
});

test('a phase submission does not pin a file an earlier completion changed and the rework deleted', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx, {
    phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }],
    tasks: [task('api', 'backend-engineer', ['src/server/**'])],
  });
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// a v1\n');
  write(dir, 'src/server/old.js', '// to be removed\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js', 'src/server/old.js']));
  commitAll(dir, 'api v1');
  tasks.reset(store, 'api', 'orchestrator', 'drop the old module');
  tasks.claim(store, config, 'api', 'backend-engineer');
  require('fs').rmSync(require('path').join(dir, 'src/server/old.js'));
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/old.js']));
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const g = store.state().gates['phase:core'];
  assert.deepStrictEqual(g.submissions[g.submissions.length - 1].artifacts.map((a) => a.path), ['src/server/a.js'], 'A stays pinned; the deleted file has nothing to pin');
});

test('a deletion recorded by a task\'s first completion stays reviewed work after a reset whose rework handoff does not repeat it', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  // The file exists at the baseline commit (the first approved submission's commit), so its deletion shows
  // in the release-tree diff and must be attributed to the approved phase's task.
  write(dir, 'src/server/old.js', '// obsolete\n');
  commitAll(dir, 'old module');
  approveThroughPlan(ctx, samplePlan());
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  require('fs').rmSync(require('path').join(dir, 'src/server/old.js'));
  write(dir, 'src/server/a.js', '// a v1\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/old.js', 'src/server/a.js']));
  commitAll(dir, 'api v1');
  tasks.reset(store, 'api', 'orchestrator', 'review found a defect in a.js');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// a v2\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js']));
  for (const [id, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${passCheck(store, 'technical-reviewer').id}`]));
  assert.deepStrictEqual(unreviewedChanges(store.state(), dir), [], 'the deletion of old.js was recorded by api\'s first completion and reviewed with the phase');
});
