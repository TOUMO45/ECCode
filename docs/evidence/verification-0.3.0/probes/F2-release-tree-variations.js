'use strict';
// F2 (omitted / added / deleted / renamed / later-changed files), variations not in tests/review-F2-F5b.test.js:
//   a `git mv` inside the ownership during the claim; a deleted owned file through to delivery; a file the
//   user committed before the claim; and a file ADDED AND COMMITTED BETWEEN the phase approval and the
//   verification submission that no gate lists (the release-tree diff baseline moves to the verification
//   commit once that gate is approved).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, attempt, report, git, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const delivery = require(REPO + '/lib/delivery');
const { tmpProject, write, coverage, approveThroughPlan, passCheck, handoffFor, samplePlan } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const PHASE = [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']];

function completePhase(ctx, { skip = [] } = {}) {
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE) {
    if (skip.includes(id)) continue;
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
}
function approvePhase(ctx) {
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  const ev = passCheck(ctx.store, 'technical-reviewer');
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${ev.id}`]));
  return ctx.store.state().gates['phase:core'].submissions.slice(-1)[0].artifacts.map((a) => a.path);
}
function verify(ctx, artifacts = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js']) {
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: artifacts.filter((p) => fs.existsSync(path.join(ctx.dir, p))) });
  const ev = passCheck(ctx.store, 'security-reviewer');
  gates.recordReview(ctx.store, ctx.config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${ev.id}`]));
}
const deliver = (ctx) => attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config }));

const { step, finish } = report('F2-release-tree-variations');
const dirs = [];
try {
  // ---- A. git mv inside the ownership during the claim.
  let ctx = tmpProject();
  dirs.push(ctx.dir);
  write(ctx.dir, 'src/server/old.js', '// old\n');
  commitAll(ctx.dir, 'base with old.js');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  git(ctx.dir, 'mv', 'src/server/old.js', 'src/server/new.js');
  let ev = passCheck(ctx.store, 'backend-engineer');
  const base = ctx.store.state().tasks.api.claim.baseCommit;
  step('F2.rename.gitView', 'what git shows the engine after a staged git mv: diff --name-only folds the rename into the new path', 'documented', { ok: true, value: { nameOnly: git(ctx.dir, 'diff', '--name-only', base).split('\n'), noRenames: git(ctx.dir, 'diff', '--name-only', '--no-renames', base).split('\n') } });
  const newOnly = attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/new.js'])));
  step('F2.rename.newOnly', 'handoff declares only the new path of a git mv (the old path is gone from the tree)', 'documented', newOnly, newOnly.ok ? 'NEW (non-blocking): the source path of a staged rename is never declared, pinned or reviewed; lib/project.js gitChangedFiles runs git diff --name-only without --no-renames' : 'refused');
  if (!newOnly.ok) step('F2.rename.both', 'handoff declares both paths (old deleted, new added)', 'ok', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/old.js', 'src/server/new.js']))));
  for (const [id, owner, file] of PHASE.slice(1)) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  step('F2.rename.phasePins', 'phase submission pins the files that exist (a deleted path is not an artifact)', 'documented', { ok: true, value: attempt(() => approvePhase(ctx)) });
  commitAll(ctx.dir, 'phase work');
  verify(ctx, ['.eccode/artifacts/verification.md', 'src/server/new.js', 'src/web/b.js', 'tests/c.test.js']);
  step('F2.rename.unreviewed', 'unreviewedChanges after a reviewed rename', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  const renameDeliver = deliver(ctx);
  step('F2.rename.deliver', 'delivery after the rename (new path pinned by the phase; the old path was never declared)', 'documented', renameDeliver, renameDeliver.ok ? 'delivered: src/server/old.js disappeared from the release tree without any handoff or review naming it' : 'blocked');

  // ---- B. A deleted owned file, declared, through to delivery.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  write(ctx.dir, 'src/web/legacy.js', '// legacy\n');
  commitAll(ctx.dir, 'base with legacy.js');
  approveThroughPlan(ctx);
  completePhase(ctx, { skip: ['ui'] });
  tasks.claim(ctx.store, ctx.config, 'ui', 'frontend-engineer');
  fs.unlinkSync(path.join(ctx.dir, 'src/web/legacy.js'));
  write(ctx.dir, 'src/web/b.js', '// ui\n');
  ev = passCheck(ctx.store, 'frontend-engineer');
  step('F2.delete.undeclared', 'owned file deleted during the claim but not declared', 'refused:INVALID_HANDOFF', attempt(() => tasks.complete(ctx.store, ctx.config, 'ui', 'frontend-engineer', handoffFor('ui', 'frontend-engineer', [ev.id], ['src/web/b.js']))));
  step('F2.delete.declared', 'deletion declared in the handoff', 'ok', attempt(() => tasks.complete(ctx.store, ctx.config, 'ui', 'frontend-engineer', handoffFor('ui', 'frontend-engineer', [ev.id], ['src/web/b.js', 'src/web/legacy.js']))));
  step('F2.delete.phase', 'phase approval with a deleted file among the task changes', 'ok', attempt(() => approvePhase(ctx)));
  commitAll(ctx.dir, 'phase work');
  verify(ctx);
  step('F2.delete.unreviewed', 'unreviewedChanges: the reviewed deletion is not reported', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  step('F2.delete.deliver', 'delivery after a reviewed deletion (overblocking check)', 'ok', deliver(ctx));

  // ---- C. The user commits inside the ownership before the claim: not dirty, and part of the base.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  write(ctx.dir, 'src/server/pre.js', '// committed by the user before the claim\n');
  step('F2.userDirty.claim', 'claim with an uncommitted owned file written by the user', 'refused:DIRTY_OWNERSHIP', attempt(() => tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer')));
  commitAll(ctx.dir, 'user commit');
  step('F2.userCommitted.claim', 'claim after the user committed it', 'ok', attempt(() => tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer')));
  write(ctx.dir, 'src/server/a.js', '// api\n');
  ev = passCheck(ctx.store, 'backend-engineer');
  step('F2.userCommitted.complete', 'completion declares only the task\'s own change (pre.js is base)', 'ok', attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js']))));

  // ---- D. release.ignore vs not; a new untracked file after approval (sanity of the shipped rule).
  ctx = tmpProject({ configOverrides: { release: { ignore: ['dist/**'] } } });
  dirs.push(ctx.dir);
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  approvePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  verify(ctx);
  write(ctx.dir, 'dist/bundle.js', '// generated\n');
  write(ctx.dir, 'src/server/extra.js', '// slipped in after the review\n');
  step('F2.ignore.unreviewed', 'dist/** ignored, src/server/extra.js reported', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  step('F2.ignore.deliver', 'delivery with an untracked unreviewed file', 'refused:DELIVERY_BLOCKED', deliver(ctx));
  fs.unlinkSync(path.join(ctx.dir, 'src/server/extra.js'));
  step('F2.ignore.deliverClean', 'delivery once the file is removed (dist/ stays, ignored)', 'ok', deliver(ctx));

  // ---- E. NEW candidate: a file added and committed BETWEEN the phase approval and the verification
  // submission, listed by no gate. Before the verification approval it is reported; after it, the diff
  // baseline is the verification commit and the file is invisible.
  ctx = tmpProject();
  dirs.push(ctx.dir);
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  approvePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  write(ctx.dir, 'src/server/backdoor.js', 'module.exports = "never reviewed";\n');
  commitAll(ctx.dir, 'added between the phase approval and the verification submission');
  step('F2.between.beforeVerification', 'unreviewedChanges before the verification gate is approved', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  verify(ctx); // the verification artifacts list verification.md and the three reviewed files only
  const after = delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config);
  step('F2.between.afterVerification', 'unreviewedChanges after the verification approval (the file is in none of its artifacts)', 'documented', { ok: true, value: after }, after.length ? 'reported' : 'NEW: the file vanished from the report');
  const d = deliver(ctx);
  step('F2.between.deliver', 'delivery with src/server/backdoor.js committed and reviewed by no gate', 'documented', d, d.ok ? 'NEW (blocking for F2\'s acceptance): an added deliverable file reached the release without a review' : 'blocked');
  if (d.ok) {
    const audit = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
    step('F2.between.audit', 'eccode audit after that delivery', 'documented', { ok: audit.status === 0, exit: audit.status, value: audit.stdout.trim().split('\n')[0] });
    const pinned = new Set(ctx.store.state().gateOrder.flatMap((g) => { const gate = ctx.store.state().gates[g]; const s = gate.submissions.find((x) => x.id === gate.approvedSubmission); return s ? s.artifacts.map((a) => a.path) : []; }));
    step('F2.between.pinned', 'is backdoor.js pinned by any approved submission?', 'documented', { ok: true, value: { pinned: pinned.has('src/server/backdoor.js'), releaseCommit: ctx.store.state().delivery.commit, inTree: git(ctx.dir, 'ls-tree', '--name-only', 'HEAD', 'src/server/').split('\n') } });
  }
} finally {
  cleanup(...dirs);
}
finish();
