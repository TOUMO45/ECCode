'use strict';
// Review of the TK-6 repair (cb73d42), round 2.
//
// F2: a null tree digest inside a git repository used to turn tree pinning off without a word: the
// evidence run was recorded without `tree`, the submission without `commit` and `tree`, and the stale
// checks compared nothing. That is how TK-6 stayed hidden for 448 pilot runs. Now such a run or
// submission records `treeUnavailable: true` (a submission keeps its commit), the CLI prints a warning,
// and completion and review refuse to cite a marked run while the current digest is available.
//
// F1: an approved submission without a commit gave the release-tree check (R30) no baseline and was
// skipped silently. `unreviewedChanges` now reports it as a release-baseline gap (a warning, not a
// blocker: nothing can repin a past approval), and the delivery report qualifies its release sentence.
//
// The digest is made unavailable with a corrupt .git/index (`git ls-files` fails, HEAD still resolves);
// a commit-less submission, as 0.3.0-0.3.3 recorded for a nested project, with an unborn HEAD.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, write, approveThroughPlan, coverage, passCheck, handoffFor, expectCode, ARCH_MD, DESIGN_MD, samplePlan } = require('./helpers');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const delivery = require('../lib/delivery');
const { inspect } = require('../lib/reconcile');
const { init, gitHead } = require('../lib/project');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const HEX = /^[0-9a-f]{64}$/;

function withBrokenIndex(dir, fn) {
  const index = path.join(dir, '.git', 'index');
  const saved = fs.existsSync(index) ? fs.readFileSync(index) : null;
  fs.writeFileSync(index, 'not an index');
  try {
    return fn();
  } finally {
    if (saved) fs.writeFileSync(index, saved);
    else fs.rmSync(index, { force: true });
  }
}

function withUnbornHead(dir, fn) {
  const head = path.join(dir, '.git', 'HEAD');
  const saved = fs.readFileSync(head);
  fs.writeFileSync(head, 'ref: refs/heads/eccode-unborn\n');
  try {
    return fn();
  } finally {
    fs.writeFileSync(head, saved);
  }
}

function cli(dir, args) {
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------------------------- F2

test('F2 evidence run inside git with no digest records treeUnavailable; without git it records neither', () => {
  const ctx = tmpProject();
  const blind = withBrokenIndex(ctx.dir, () => passCheck(ctx.store, 'backend-engineer'));
  assert.strictEqual(blind.treeUnavailable, true);
  assert.strictEqual(blind.tree, undefined);
  assert.strictEqual(ctx.store.state().evidence[blind.id].treeUnavailable, true);
  const pinned = passCheck(ctx.store, 'backend-engineer');
  assert.match(pinned.tree, HEX);
  assert.strictEqual(pinned.treeUnavailable, undefined);
  assert.ok(ctx.store.audit().ok);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-nogit-'));
  const store = init(plain, { name: 'No git', idea: 'A project outside any repository' });
  const ev = passCheck(store, 'backend-engineer');
  assert.strictEqual(ev.tree, undefined);
  assert.strictEqual(ev.treeUnavailable, undefined, 'no git: legitimately unpinned, no marker');
});

test('F2 gate submit inside git with no digest keeps the commit and records treeUnavailable', () => {
  const { dir, store, config } = tmpProject();
  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  const { event } = withBrokenIndex(dir, () => gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }));
  assert.strictEqual(event.data.commit, gitHead(dir), 'the commit is the release-tree baseline (R30): a null digest must not drop it');
  assert.strictEqual(event.data.treeUnavailable, true);
  assert.ok(!('tree' in event.data));
  const sub = store.state().gates.architecture.submissions[0];
  assert.strictEqual(sub.commit, gitHead(dir));
  assert.strictEqual(sub.treeUnavailable, true);
  assert.ok(!('tree' in sub));
  assert.ok(store.audit().ok, 'the snapshot replays');
});

test('F2 a check run while the digest was unavailable is refused at completion and at review while the digest is available', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  const blind = withBrokenIndex(dir, () => passCheck(store, 'backend-engineer'));
  const complete = (ids) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));
  const err = expectCode(() => complete([blind.id]), 'INVALID_HANDOFF');
  assert.match(err.message, new RegExp(`ev:${blind.id} ran while the source tree digest was unavailable`));
  complete([passCheck(store, 'backend-engineer').id]);
  assert.strictEqual(store.state().tasks.api.status, 'done');

  for (const [id, owner, file] of [['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const blindReview = withBrokenIndex(dir, () => passCheck(store, 'technical-reviewer'));
  const rejected = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${blindReview.id}`])), 'REVIEW_REJECTED');
  assert.match(rejected.message, new RegExp(`ev:${blindReview.id} ran while the source tree digest was unavailable`));
  const rerun = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${rerun.id}`]));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
});

test('F2 the CLI warns when tree pinning is off for a run or a submission, and only then', () => {
  const { dir, store, config } = tmpProject();
  const run = ['evidence', 'run', '--actor', 'backend-engineer', '--label', 'blind', '--', 'node -e "process.exit(0)"'];
  const blind = withBrokenIndex(dir, () => cli(dir, run));
  assert.strictEqual(blind.status, 0, blind.stderr);
  assert.match(blind.stderr, /warning: tree pinning is off for this run/);
  const normal = cli(dir, run);
  assert.strictEqual(normal.status, 0, normal.stderr);
  assert.doesNotMatch(normal.stderr, /tree pinning/);

  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  const sub = withBrokenIndex(dir, () => cli(dir, ['gate', 'submit', 'architecture', '--actor', 'product-architect', '--artifact', '.eccode/artifacts/brief.md']));
  assert.strictEqual(sub.status, 0, sub.stderr);
  assert.match(sub.stderr, /warning: tree pinning is off for this submission/);
});

// ---------------------------------------------------------------------------------------------- F1

/** Architecture and design approved on commit-less submissions (as 0.3.0-0.3.3 recorded for a nested project), the plan on a commit. */
function recordWithCommitlessApprovals({ planCommitless = false } = {}) {
  const ctx = tmpProject();
  const { dir, store, config } = ctx;
  const approve = (gate, author, reviewer, file, content, anchor) => {
    gates.startGate(store, config, gate, 'orchestrator');
    write(dir, file, content);
    gates.submit(store, config, gate, author, { artifacts: [file] });
    gates.recordReview(store, config, gate, reviewer, coverage(ctx, gate, [`artifact:${file}#${anchor}`]));
  };
  withUnbornHead(dir, () => {
    approve('architecture', 'product-architect', 'architecture-reviewer', '.eccode/artifacts/brief.md', ARCH_MD, 'Acceptance Criteria');
    approve('design', 'technical-designer', 'technical-reviewer', '.eccode/artifacts/spec.md', DESIGN_MD, 'Testing Strategy');
  });
  const plan = () => approve('plan', 'delivery-lead', 'technical-reviewer', '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2), 'phases');
  if (planCommitless) withUnbornHead(dir, plan);
  else plan();
  return ctx;
}

test('F1 an approved submission without a commit is reported as a release-baseline gap, not skipped', () => {
  const ctx = recordWithCommitlessApprovals();
  const { dir, store, config } = ctx;
  const state = store.state();
  assert.strictEqual(state.gates.architecture.submissions[0].commit, undefined);
  const planCommit = state.gates.plan.submissions[0].commit;
  assert.ok(planCommit, 'the plan submission recorded the baseline');

  const gaps = delivery.unreviewedChanges(state, dir).filter((c) => c.unpinned);
  assert.deepStrictEqual(gaps.map((g) => g.gate), ['architecture', 'design']);
  for (const g of gaps) {
    assert.match(g.problem, /recorded no commit/);
    assert.match(g.problem, new RegExp(`the release-tree diff starts at plan's commit ${planCommit.slice(0, 12)}`));
  }

  // A warning everywhere, not a blocker: a past approval cannot be repinned.
  const pre = delivery.preconditions(store, config);
  assert.deepStrictEqual(pre.problems.filter((p) => /recorded no commit/.test(p)), []);
  assert.deepStrictEqual(pre.baselineGaps.map((g) => g.gate), ['architecture', 'design']);
  const issues = inspect(store).filter((i) => i.kind === 'release-baseline');
  assert.deepStrictEqual(issues.map((i) => i.severity), ['warning', 'warning']);
  const audit = cli(dir, ['audit']);
  assert.strictEqual(audit.status, 0, audit.stdout + audit.stderr);
  assert.match(audit.stdout, /Release-tree baseline gaps \(warnings\)/);
  assert.match(audit.stdout, /architecture/);
});

test('F1 with no approved commit at all the gap says the release tree is compared with nothing; a record that never pinned anything is read as an older engine\'s', () => {
  const ctx = recordWithCommitlessApprovals({ planCommitless: true });
  assert.deepStrictEqual(delivery.unreviewedChanges(ctx.store.state(), ctx.dir).filter((c) => c.unpinned), [], 'no tree or commit anywhere: an older engine, as before');
  passCheck(ctx.store, 'technical-reviewer'); // the engine pins trees here: the missing commits are gaps
  const gaps = delivery.unreviewedChanges(ctx.store.state(), ctx.dir).filter((c) => c.unpinned);
  assert.deepStrictEqual(gaps.map((g) => g.gate), ['architecture', 'design', 'plan']);
  for (const g of gaps) assert.match(g.problem, /no approved submission recorded one: the release tree is not compared with any reviewed commit/);
});

test('F1 the delivery report qualifies its release sentence when the baseline has gaps', () => {
  const ctx = recordWithCommitlessApprovals();
  const state = ctx.store.state();
  const release = { commit: 'c'.repeat(40), tree: 'd'.repeat(64) };
  const plain = delivery.buildReport(state, { events: 1 }, { release, events: [] });
  assert.match(plain, /Every file in it is either older than the first reviewed submission or was pinned by an approved review\./);
  const gaps = delivery.unreviewedChanges(state, ctx.dir).filter((c) => c.unpinned);
  const report = delivery.buildReport(state, { events: 1 }, { release, events: [], baselineGaps: gaps });
  assert.doesNotMatch(report, /Every file in it is either older than the first reviewed submission/);
  assert.match(report, /approved on submissions that recorded no commit \(architecture, design\)/);
  assert.match(report, /changes made before .* that no approval pinned were not compared/);
  assert.match(report, /## Limitations and unverified items[\s\S]*Release-tree baseline gaps: architecture, design/);
});
