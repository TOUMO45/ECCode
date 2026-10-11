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
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, approveThroughPlan, coverage, passCheck, handoffFor, expectCode, ARCH_MD, DESIGN_MD, samplePlan, initRepo } = require('./helpers');
const { loadConfig } = require('../lib/config');
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

/** The project outside any git work tree for a while (a record begun without git, or by an older engine). */
function withoutGit(dir, fn) {
  const dotGit = path.join(dir, '.git');
  const away = path.join(dir, '.git-away');
  fs.renameSync(dotGit, away);
  try {
    return fn();
  } finally {
    fs.renameSync(away, dotGit);
  }
}

function cli(dir, args) {
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8' });
}

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}

/** A project in a fresh repository whose HEAD is unborn (no commit yet). */
function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-fresh-'));
  initRepo(dir, { firstCommit: false });
  const store = init(dir, { name: 'Fresh', idea: 'A project before its first commit' });
  return { dir, store, config: loadConfig(dir) };
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
  // Outside git the engine records no commit, as an engine older than 0.3.0 or TK-6's null digest did.
  withoutGit(dir, () => {
    approve('architecture', 'product-architect', 'architecture-reviewer', '.eccode/artifacts/brief.md', ARCH_MD, 'Acceptance Criteria');
    approve('design', 'technical-designer', 'technical-reviewer', '.eccode/artifacts/spec.md', DESIGN_MD, 'Testing Strategy');
  });
  const plan = () => approve('plan', 'delivery-lead', 'technical-reviewer', '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2), 'phases');
  if (planCommitless) withoutGit(dir, plan);
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

// ------------------------------------------------------------------------- review of 30061e5 (round 3)
// R2-1: "inside git" is a work tree, not a HEAD that resolves. A fresh repository before its first commit,
// or one `git checkout --orphan` away, used to read as "outside git": no tree, no marker, no warning, and
// a commit-less submission, which also bypassed the F2 refusal.

test('R2-1 evidence run on an unborn HEAD records the tree (and the marker when there is no digest), with no warning', () => {
  const { dir, store } = freshProject();
  const run = passCheck(store, 'backend-engineer');
  assert.match(String(run.tree), HEX, 'a fresh repository is inside git: the run is pinned');
  assert.strictEqual(run.treeUnavailable, undefined);
  const blind = withBrokenIndex(dir, () => passCheck(store, 'backend-engineer'));
  assert.strictEqual(blind.treeUnavailable, true, 'inside a work tree with no digest: marked, even with HEAD unborn');
  const res = cli(dir, ['evidence', 'run', '--actor', 'backend-engineer', '--label', 'fresh', '--json', '--', 'node -e "process.exit(0)"']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).tree, HEX);
  assert.doesNotMatch(res.stderr, /tree pinning/);
});

test('R2-1 gate submit on an unborn HEAD is refused (fresh repository, orphan HEAD) and records nothing', () => {
  const fresh = freshProject();
  gates.startGate(fresh.store, fresh.config, 'architecture', 'orchestrator');
  write(fresh.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  const submit = (ctx) => gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const err = expectCode(() => submit(fresh), 'NO_COMMIT');
  assert.match(err.message, /HEAD does not resolve/);
  assert.match(err.message, /make the first commit/);
  assert.strictEqual(fresh.store.state().gates.architecture.submissions.length, 0);
  git(fresh.dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  assert.strictEqual(submit(fresh).event.data.commit, gitHead(fresh.dir));

  const ctx = tmpProject();
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/brief.md', ARCH_MD);
  expectCode(() => withUnbornHead(ctx.dir, () => submit(ctx)), 'NO_COMMIT');
  assert.strictEqual(ctx.store.state().gates.architecture.submissions.length, 0);
});

test('R2-1 a run recorded after git checkout --orphan is pinned: switched back and edited, completion refuses it as stale', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = "bytes A";\n');
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(dir, 'checkout', '-q', '--orphan', 'side');
  const run = passCheck(store, 'backend-engineer');
  git(dir, 'checkout', '-q', branch);
  write(dir, 'src/server/app.js', 'module.exports = "bytes B";\n');
  const complete = (ids) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));
  const err = expectCode(() => complete([run.id]), 'INVALID_HANDOFF'); // 0.3.4 round 2 accepted it: the run had no tree
  assert.match(err.message, new RegExp(`ev:${run.id} ran on different bytes`));
  assert.match(String(run.tree), HEX, 'the run on the orphan HEAD is pinned');
  complete([passCheck(store, 'backend-engineer').id]);
  assert.strictEqual(store.state().tasks.api.status, 'done');
});

// R2-2: the gap states what is known (no commit recorded) and the possible causes, not TK-6 as the cause.
test('R2-2 the gap text and the release sentence list the possible causes instead of asserting TK-6', () => {
  const ctx = recordWithCommitlessApprovals();
  const state = ctx.store.state();
  const gaps = delivery.unreviewedChanges(state, ctx.dir).filter((c) => c.unpinned);
  assert.strictEqual(gaps.length, 2);
  for (const g of gaps) {
    assert.match(g.problem, /recorded no commit \(possible causes: /);
    assert.match(g.problem, /the project was not in a git work tree or HEAD did not resolve/);
    assert.match(g.problem, /an engine older than 0\.3\.0/);
    assert.match(g.problem, /0\.3\.0-0\.3\.3 dropped the commit with an unavailable tree digest \(TK-6, nested projects\)/);
    assert.doesNotMatch(g.problem, /the tree digest was unavailable when it was submitted/);
  }
  const report = delivery.buildReport(state, { events: 1 }, { release: { commit: 'c'.repeat(40), tree: 'd'.repeat(64) }, events: [], baselineGaps: gaps });
  assert.doesNotMatch(report, /because the tree digest was unavailable/);
  assert.match(report, /recorded no commit \(architecture, design\); possible causes: /);
});

// R2-3: the baseline is the earliest approved commit in approval order and the gaps are the commit-less
// approvals made before it in that order. Rework gates sit after every plan phase in gateOrder, so gate
// order misplaced a rework approved before a later phase. Synthetic states over a real history.
function history() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-order-'));
  initRepo(dir);
  const commit = (files, msg) => {
    for (const [f, c] of Object.entries(files)) write(dir, f, c);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  };
  commit({ 'app.js': 'v1\n' }, 'c0');
  const C1 = commit({ 'app.js': 'v2\n' }, 'c1');
  const C2 = commit({ 'app.js': 'v3, never reviewed\n', 'other.js': 'never reviewed\n' }, 'c2');
  return { dir, C1, C2 };
}

function syntheticState(gateList) {
  const gate = ([id, commit, at]) => ({ id, status: 'approved', approvedAt: at, authors: [], approvedBy: 'r', iterations: 0, reviews: [], openFindings: [], submissions: [{ id: `sub-${id}`, artifacts: [], ...(commit ? { commit } : {}) }], approvedSubmission: `sub-${id}` });
  return { gateOrder: gateList.map((g) => g[0]), gates: Object.fromEntries(gateList.map((g) => [g[0], gate(g)])), tasks: {}, evidence: { ev1: { id: 'ev1', kind: 'command', tree: 'f'.repeat(64) } } };
}

const RELEASE = { release: { ignore: [] } };

test('R2-3 a rework approved with a commit before a phase approved later is the release-tree baseline', () => {
  const { dir, C1, C2 } = history();
  // gateOrder puts phase:e before the rework; the rework was approved first, on C1.
  const state = syntheticState([['architecture', null, '2026-10-09T10:00:00.000Z'], ['phase:e', C2, '2026-10-13T10:00:00.000Z'], ['phase:rework-4', C1, '2026-10-12T10:00:00.000Z']]);
  const all = delivery.unreviewedChanges(state, dir, RELEASE);
  assert.deepStrictEqual(all.filter((c) => !c.unpinned).map((c) => `${c.path} ${c.problem}`).sort(), ['app.js modified after approval', 'other.js added after approval'], 'the C1→C2 changes no approval pinned are reported');
  const gaps = all.filter((c) => c.unpinned);
  assert.deepStrictEqual(gaps.map((g) => g.gate), ['architecture']);
  assert.match(gaps[0].problem, new RegExp(`phase:rework-4's commit ${C1.slice(0, 12)}`));
});

test('R2-3 commit-less reworks approved before a pinned phase are listed as gaps, in approval order', () => {
  const { dir, C2 } = history();
  const state = syntheticState([
    ['architecture', null, '2026-10-09T10:00:00.000Z'],
    ['phase:d', null, '2026-10-11T10:00:00.000Z'],
    ['phase:e', C2, '2026-10-13T10:00:00.000Z'],
    ['phase:rework-1', null, '2026-10-10T10:00:00.000Z'],
    ['phase:rework-3', null, '2026-10-12T10:00:00.000Z'],
  ]);
  const gaps = delivery.unreviewedChanges(state, dir, RELEASE).filter((c) => c.unpinned);
  assert.deepStrictEqual(gaps.map((g) => g.gate), ['architecture', 'phase:rework-1', 'phase:d', 'phase:rework-3']);
});

test('R2-3 approval order comes from the event sequence of the approving reviews (timestamps may tie)', () => {
  const { dir, C1, C2 } = history();
  const at = '2026-10-12T10:00:00.000Z'; // the same millisecond for every approval
  const state = syntheticState([['architecture', null, at], ['phase:e', C2, at], ['phase:rework-4', C1, at]]);
  const approval = (seq, gate) => JSON.stringify({ seq, type: 'review.recorded', actor: 'technical-reviewer', data: { gate, reviewId: `rev-${gate}`, submissionId: `sub-${gate}`, review: { decision: 'approve' } } });
  write(dir, '.eccode/events.jsonl', [approval(2, 'architecture'), approval(5, 'phase:rework-4'), approval(9, 'phase:e')].join('\n') + '\n');
  const all = delivery.unreviewedChanges(state, dir, RELEASE);
  assert.deepStrictEqual(all.filter((c) => !c.unpinned).map((c) => c.path).sort(), ['app.js', 'other.js']);
  assert.deepStrictEqual(all.filter((c) => c.unpinned).map((c) => c.gate), ['architecture']);
});

// R2-6: runs recorded with tree pinning off are counted where a person looks.
test('R2-6 audit counts the command runs recorded with tree pinning off', () => {
  const { dir, store } = tmpProject();
  withBrokenIndex(dir, () => passCheck(store, 'backend-engineer'));
  passCheck(store, 'backend-engineer');
  const res = cli(dir, ['audit']);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Command runs recorded with tree pinning off \(treeUnavailable\): 1/);
  const json = JSON.parse(cli(dir, ['audit', '--json']).stdout);
  assert.deepStrictEqual(json.treeUnavailableRuns.length, 1);
});
