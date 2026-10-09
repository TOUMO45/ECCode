'use strict';
// Independent review, finding F2 (an omitted or later-added file can escape review and delivery)
// and the release-risk half of F5 (open critical risks do not block release).
//
// Controls under test:
//   - claim() refuses a task whose ownership already holds uncommitted changes (DIRTY_OWNERSHIP), so
//     every owned byte the phase reviews is either the base commit or a change the task declares;
//   - gate.submitted records the commit and tree digest the submission was made at, and
//     unreviewedChanges reports every file git shows changed since the last approved gate's commit
//     (added, modified, deleted, renamed, untracked) that no approved gate pinned;
//   - deliver() refuses a dirty working tree, records the release commit, and refuses while a risk of
//     a blocking severity (config.release.blockRiskSeverities) is open.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const runs = require('../lib/runs');
const delivery = require('../lib/delivery');
const { Store } = require('../lib/store');
const { DEFAULT_CONFIG, loadConfig } = require('../lib/config');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(dir, msg = 'work') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/** An approval whose criteria carry the ids the gate rules require: [id, evidenceRefs][] */
function review(criteria, extra = {}) {
  return {
    decision: 'approve',
    summary: 'All criteria verified against the submitted artifacts.',
    criteria: criteria.map(([id, evidence]) => ({ id, description: `criterion ${id}`, met: true, evidence })),
    findings: [],
    ...extra,
  };
}

const PHASE_FILES = [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']];
const DELIVERABLES = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];

function completePhase(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE_FILES) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', review([['phase:core', [`ev:${ev.id}`]], ['task:api', [`ev:${ev.id}`]], ['task:ui', [`ev:${ev.id}`]], ['task:tests', [`ev:${ev.id}`]]]));
}

function verify(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: DELIVERABLES });
  const ev = passCheck(store, 'security-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'security-reviewer', review([['AC1', [`ev:${ev.id}`, 'artifact:.eccode/artifacts/verification.md']]]));
}

/**
 * A project ready to deliver: a base commit with a file no task owns, the phase approved, its work
 * committed, verification approved on that commit. With commit:false the phase work stays uncommitted.
 */
function deliverable({ commit = true, configOverrides } = {}) {
  const ctx = tmpProject({ configOverrides });
  write(ctx.dir, 'docs/guide.md', '# Guide\nbase content\n');
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  if (commit) commitAll(ctx.dir, 'phase work');
  verify(ctx);
  return ctx;
}

const problems = (err) => err.details.problems;

test('F2 a file inside the task ownership that is already dirty at claim time is refused (DIRTY_OWNERSHIP)', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  approveThroughPlan(ctx);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  write(dir, 'src/server/stale.js', '// written before the claim, never to be declared\n');
  write(dir, 'notes.md', 'user notes outside every ownership\n');
  const err = expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'DIRTY_OWNERSHIP');
  assert.match(err.message, /src\/server\/stale\.js/);
  assert.match(err.message, /commit or revert/i);
  assert.doesNotMatch(err.message, /notes\.md/, 'files outside the ownership are not the task\'s problem');
  assert.strictEqual(store.state().tasks.api.status, 'pending');
  // Committed: it is part of the base commit the phase starts from, and the claim goes through.
  git(dir, 'add', 'src/server/stale.js');
  git(dir, 'commit', '-q', '-m', 'stale committed');
  // A tracked owned file deleted before the claim is dirty too.
  fs.unlinkSync(path.join(dir, 'src/server/stale.js'));
  assert.match(expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'DIRTY_OWNERSHIP').message, /src\/server\/stale\.js/);
  git(dir, 'checkout', '--', 'src/server/stale.js');
  tasks.claim(store, config, 'api', 'backend-engineer');
  assert.deepStrictEqual(Object.keys(store.state().tasks.api.claim.dirtyAtClaim), ['notes.md']);
  assert.strictEqual(store.audit().ok, true);
});

test('F2 a rejected attempt may stay on disk for the retry: content the phase submission pins is not unaccounted dirt', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  approveThroughPlan(ctx);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE_FILES) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const { event } = gates.recordReview(store, config, 'phase:core', 'technical-reviewer', require('./helpers').rejection('F1'));
  tasks.reset(store, 'api', 'orchestrator', 'F1: rate limiting missing');
  // The rejected version of a.js is pinned by the submission the reviewer saw: the retry may start from it.
  tasks.claim(store, config, 'api', 'backend-engineer');
  tasks.fail(store, config, 'api', 'backend-engineer', 'interrupted before any edit');
  // Edited by hand between attempts (no submission pins this content): refused.
  write(dir, 'src/server/a.js', '// api, edited behind the record\n');
  assert.match(expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'DIRTY_OWNERSHIP').message, /src\/server\/a\.js/);
  write(dir, 'src/server/a.js', '// api\n');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// api with rate limiting\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js']));
  gates.submit(store, config, 'phase:core', 'delivery-lead', { respondsTo: event.data.reviewId });
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', review([['phase:core', [`ev:${ev.id}`]], ['task:api', [`ev:${ev.id}`]], ['task:ui', [`ev:${ev.id}`]], ['task:tests', [`ev:${ev.id}`]]], { resolvedFindings: [{ id: 'F1', resolution: 'rate limiting added', evidence: ['artifact:src/server/a.js'] }] }));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), []);
});

test('F2 submissions record the commit and tree digest; the delivery records the release commit and the handoff states it', () => {
  const ctx = deliverable();
  const { store, dir } = ctx;
  const head = git(dir, 'rev-parse', 'HEAD');
  const sub = store.state().gates.verification.submissions[0];
  assert.strictEqual(sub.commit, head);
  assert.match(sub.tree, DIGEST);
  const phaseSub = store.state().gates['phase:core'].submissions[0];
  assert.match(phaseSub.commit, SHA);
  assert.notStrictEqual(phaseSub.commit, head, 'the phase was submitted before its work was committed');
  // The digest covers the working tree outside .eccode/: a stray file changes it, removing it restores it.
  const before = delivery.submissionTreeDigest(dir);
  assert.strictEqual(before, delivery.submissionTreeDigest(dir));
  write(dir, 'stray.txt', 'x');
  assert.notStrictEqual(delivery.submissionTreeDigest(dir), before);
  fs.unlinkSync(path.join(dir, 'stray.txt'));
  assert.strictEqual(delivery.submissionTreeDigest(dir), before);
  write(dir, '.eccode/drafts/scratch.txt', 'x');
  assert.strictEqual(delivery.submissionTreeDigest(dir), before, '.eccode/ is not part of the release tree');

  const res = delivery.deliver(store, 'delivery-lead', { config: ctx.config });
  assert.strictEqual(res.commit, head);
  const st = store.state();
  assert.strictEqual(st.delivery.commit, head);
  assert.match(st.delivery.tree, DIGEST);
  const report = fs.readFileSync(path.join(dir, res.report), 'utf8');
  assert.match(report, new RegExp(`Release commit:\\*\\* \`${head}\``));
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.eccode/delivery/final-handoff.json'), 'utf8'));
  assert.strictEqual(json.release.commit, head);
  assert.strictEqual(store.audit().ok, true);
  assert.deepStrictEqual(new Store(dir).rebuild().delivery, st.delivery, 'the snapshot replays');
});

test('F2 a new untracked file after the verification approval is an unreviewed change and the delivery is refused', () => {
  const ctx = deliverable();
  const { store, dir, config } = ctx;
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), []);
  write(dir, 'src/server/extra.js', 'module.exports = "slipped in after the review";\n');
  const changes = delivery.unreviewedChanges(store.state(), dir, config);
  assert.deepStrictEqual(changes, [{ path: 'src/server/extra.js', gate: 'verification', problem: 'added after approval' }]);
  const err = expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');
  assert.match(err.message, /src\/server\/extra\.js added after approval \(verification\)/);
  assert.match(err.message, /uncommitted changes: src\/server\/extra\.js; commit or revert them, the delivery pins the release tree/);
  assert.strictEqual(store.state().delivery, null);
  // The audit CLI reports it as a failure, not a pending re-review.
  const audit = spawnSync(process.execPath, [BIN, '--root', dir, 'audit', '--json'], { encoding: 'utf8' });
  assert.strictEqual(audit.status, 2, audit.stdout);
  assert.deepStrictEqual(JSON.parse(audit.stdout).unreviewedChanges.map((c) => c.path), ['src/server/extra.js']);
});

test('F2 files committed after the verification approval are refused: the release tree is pinned at the approved commit', () => {
  const ctx = deliverable();
  const { store, dir, config } = ctx;
  write(dir, 'README-late.md', '# added and committed after the review\n');
  fs.appendFileSync(path.join(dir, 'docs/guide.md'), 'edited after the review, never pinned by any gate\n');
  commitAll(dir, 'late changes');
  const changes = delivery.unreviewedChanges(store.state(), dir, config).sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepStrictEqual(changes, [
    { path: 'README-late.md', gate: 'verification', problem: 'added after approval' },
    { path: 'docs/guide.md', gate: 'verification', problem: 'modified after approval' },
  ]);
  const err = expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');
  assert.match(err.message, /README-late\.md added after approval \(verification\)/);
  assert.match(err.message, /docs\/guide\.md modified after approval \(verification\)/);
  assert.doesNotMatch(err.message, /uncommitted changes/, 'the tree is clean; the changes are refused because nobody reviewed them');
});

test('F2 a deleted and a renamed file after the approval are refused', () => {
  const ctx = deliverable();
  const { store, dir, config } = ctx;
  git(dir, 'rm', '-q', 'docs/guide.md');
  git(dir, 'mv', 'src/web/b.js', 'src/web/b-renamed.js');
  commitAll(dir, 'reshuffle');
  const changes = delivery.unreviewedChanges(store.state(), dir, config);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.strictEqual(byPath['docs/guide.md'].problem, 'deleted after approval');
  assert.strictEqual(byPath['src/web/b.js'].problem, 'deleted after approval', 'the pinned file is gone');
  assert.deepStrictEqual(byPath['src/web/b-renamed.js'], { path: 'src/web/b-renamed.js', from: 'src/web/b.js', gate: 'verification', problem: 'renamed after approval' });
  const err = expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');
  assert.match(err.message, /docs\/guide\.md deleted after approval \(verification\)/);
  assert.match(err.message, /src\/web\/b-renamed\.js renamed after approval \(verification\)/);
  // An uncommitted rename is a deletion plus an untracked file: refused as well.
  const ctx2 = deliverable();
  fs.renameSync(path.join(ctx2.dir, 'tests/c.test.js'), path.join(ctx2.dir, 'tests/d.test.js'));
  const paths = delivery.unreviewedChanges(ctx2.store.state(), ctx2.dir, ctx2.config).map((c) => `${c.path}: ${c.problem}`).sort();
  assert.deepStrictEqual(paths, ['tests/c.test.js: deleted after approval', 'tests/d.test.js: added after approval']);
  expectCode(() => delivery.deliver(ctx2.store, 'delivery-lead', { config: ctx2.config }), 'DELIVERY_BLOCKED');
});

test('F2 config.release.ignore excludes generated paths from the release-tree checks', () => {
  const ctx = deliverable({ configOverrides: { release: { ignore: ['dist/**'] } } });
  const { store, dir, config } = ctx;
  assert.deepStrictEqual(config.release.ignore, ['dist/**']);
  write(dir, 'dist/bundle.js', '// build output\n');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), []);
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir), [], 'the project config is loaded when none is given');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, DEFAULT_CONFIG).map((c) => c.path), ['dist/bundle.js'], 'without the ignore it is a change');
  const res = delivery.deliver(store, 'delivery-lead', { config });
  assert.ok(fs.existsSync(path.join(dir, res.report)));
  assert.strictEqual(store.state().delivery.commit, git(dir, 'rev-parse', 'HEAD'));
});

test('F2 delivery refuses a dirty working tree, then records the release commit once it is clean', () => {
  const ctx = deliverable({ commit: false });
  const { store, dir, config } = ctx;
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), [], 'the uncommitted work is exactly what was reviewed');
  const err = expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');
  assert.deepStrictEqual(problems(err), ['uncommitted changes: src/server/a.js, src/web/b.js, tests/c.test.js; commit or revert them, the delivery pins the release tree']);
  const head = commitAll(dir, 'release');
  const res = delivery.deliver(store, 'delivery-lead', { config });
  assert.strictEqual(res.commit, head);
  assert.strictEqual(store.state().delivery.commit, head);
  assert.match(fs.readFileSync(path.join(dir, res.report), 'utf8'), new RegExp(`Release commit:\\*\\* \`${head}\``));
});

test('F2 work in flight is not an unreviewed change: files of claimed tasks and open phases wait for their review', () => {
  const ctx = tmpProject();
  const { store, config, dir } = ctx;
  approveThroughPlan(ctx);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// in progress\n');
  write(dir, 'src/web/early.js', '// inside an unclaimed task of the open phase\n');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), []);
  // A file no task will ever own is reported against the last approved gate.
  write(dir, 'stray.txt', 'nobody owns this\n');
  assert.deepStrictEqual(delivery.unreviewedChanges(store.state(), dir, config), [{ path: 'stray.txt', gate: 'plan', problem: 'added after approval' }]);
});

test('F2 old records are not judged retroactively: a submission without a recorded commit pins only its artifacts', () => {
  for (const rel of ['examples/triage-desk', 'examples/groundwork']) {
    const root = path.join(__dirname, '..', rel);
    const state = new Store(root).rebuild();
    assert.ok(state.gateOrder.every((g) => state.gates[g].submissions.every((s) => s.commit === undefined)), `${rel} predates the release-tree fields`);
    assert.deepStrictEqual(delivery.unreviewedChanges(state, root).filter((c) => !c.pending), []);
  }
});

test('F5 an open critical or high risk blocks delivery and the message names the user command; mitigated and accepted risks pass', () => {
  const ctx = deliverable();
  const { store, dir, config } = ctx;
  assert.deepStrictEqual(config.release.blockRiskSeverities, ['critical', 'high']);
  runs.recordRisk(store, 'delivery-lead', { id: 'RISK-X', title: 'Data loss on restart', severity: 'critical' });
  runs.recordRisk(store, 'delivery-lead', { id: 'RISK-Y', title: 'Auth bypass on stale token', severity: 'high' });
  runs.recordRisk(store, 'delivery-lead', { id: 'RISK-Z', title: 'Slow cold start', severity: 'medium' });
  const pre = delivery.preconditions(store, config).problems;
  assert.deepStrictEqual(pre, [
    'RISK-X [critical] is open: mitigate it (eccode risk update --id RISK-X --status mitigated --mitigation "<how>" --actor <role>) or have the user accept it (eccode risk update --id RISK-X --status accepted --actor user, run by the user)',
    'RISK-Y [high] is open: mitigate it (eccode risk update --id RISK-Y --status mitigated --mitigation "<how>" --actor <role>) or have the user accept it (eccode risk update --id RISK-Y --status accepted --actor user, run by the user)',
  ]);
  const err = expectCode(() => delivery.deliver(store, 'delivery-lead', { config }), 'DELIVERY_BLOCKED');
  assert.match(err.message, /RISK-X \[critical\] is open/);
  assert.match(err.message, /--status accepted --actor user, run by the user/);
  assert.strictEqual(store.state().delivery, null);
  // Agents cannot accept a risk; the user can. Mitigation is any role's work.
  expectCode(() => runs.recordRisk(store, 'delivery-lead', { id: 'RISK-Y', status: 'accepted' }), 'USER_AUTH_REQUIRED');
  runs.recordRisk(store, 'delivery-lead', { id: 'RISK-X', status: 'mitigated', mitigation: 'write-ahead log replayed on boot' });
  runs.recordRisk(store, 'user', { id: 'RISK-Y', status: 'accepted' });
  assert.deepStrictEqual(delivery.preconditions(store, config).problems, []);
  const res = delivery.deliver(store, 'delivery-lead', { config });
  const report = fs.readFileSync(path.join(dir, res.report), 'utf8');
  assert.match(report, /RISK-Y\*\* \[high, accepted\] Auth bypass on stale token — accepted by user at \d{4}-/);
  assert.match(report, /Accepted risks .*RISK-Y \(accepted by user/);
  assert.match(report, /Open risks carried forward: RISK-Z/);
  assert.doesNotMatch(report, /Open risks carried forward: .*RISK-[XY]/);
  // The policy is configurable: with only critical blocking, an open high risk is carried forward.
  const lax = deliverable({ configOverrides: { release: { blockRiskSeverities: ['critical'] } } });
  runs.recordRisk(lax.store, 'delivery-lead', { id: 'RISK-H', title: 'High but tolerated', severity: 'high' });
  assert.deepStrictEqual(delivery.preconditions(lax.store, lax.config).problems, []);
  runs.recordRisk(lax.store, 'delivery-lead', { id: 'RISK-C', title: 'Critical', severity: 'critical' });
  assert.match(delivery.preconditions(lax.store, lax.config).problems.join('\n'), /^RISK-C \[critical\] is open/);
});

test('F5 the probe scenario: a deliverable project with an open critical risk is refused by the library and by the CLI', () => {
  // Library path, as the probe ran it: deliver without a config argument loads the project config.
  const ctx = deliverable();
  runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-X', title: 'Data loss on restart', severity: 'critical', status: 'open' });
  runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-Y', title: 'Auth bypass on stale token', severity: 'high', status: 'open' });
  const err = expectCode(() => delivery.deliver(ctx.store, 'delivery-lead'), 'DELIVERY_BLOCKED');
  assert.ok(problems(err).some((p) => p.startsWith('RISK-X [critical] is open')));
  assert.ok(problems(err).some((p) => p.startsWith('RISK-Y [high] is open')));
  assert.strictEqual(ctx.store.state().delivery, null);
  assert.strictEqual(ctx.store.readEvents().slice(-1)[0].type, 'risk.recorded', 'nothing was delivered');

  // CLI path.
  const ctx2 = deliverable();
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args, '--root', ctx2.dir], { encoding: 'utf8' });
  assert.strictEqual(cli('risk', 'add', '--id', 'RISK-X', '--title', 'Data loss on restart', '--severity', 'critical', '--actor', 'delivery-lead').status, 0);
  let res = cli('deliver', '--actor', 'delivery-lead', '--json');
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /DELIVERY_BLOCKED/);
  assert.match(res.stderr, /RISK-X \[critical\] is open/);
  assert.strictEqual(ctx2.store.state().delivery, null);
  // Acceptance is the user's: without a terminal the CLI refuses it (F5); the suite's switch stands in for the person.
  assert.strictEqual(cli('risk', 'update', '--id', 'RISK-X', '--status', 'accepted', '--actor', 'user').status, 2);
  const asUser = spawnSync(process.execPath, [BIN, 'risk', 'update', '--id', 'RISK-X', '--status', 'accepted', '--actor', 'user', '--root', ctx2.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_TEST: '1' } });
  assert.strictEqual(asUser.status, 0, asUser.stderr);
  res = cli('deliver', '--actor', 'delivery-lead');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /release commit [0-9a-f]{40}/);
  assert.strictEqual(ctx2.store.state().delivery.commit, git(ctx2.dir, 'rev-parse', 'HEAD'));
  assert.strictEqual(loadConfig(ctx2.dir).release.blockRiskSeverities.length, 2);
});
