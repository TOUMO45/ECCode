'use strict';
// Rework: a defect found after a phase was approved (or after delivery) gets
// its own phase gate with a scoped task, an independent review and a
// re-delivery. Approved gates are never reopened silently, and the scope of a
// rework is bounded.
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
const evidence = require('../lib/evidence');
const { deliver } = require('../lib/delivery');
const { openRework } = require('../lib/rework');
const { write, samplePlan, passCheck, handoffFor, approval, coverage, expectCode, tmpProject, approveThroughPlan, initRepo } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

/** The delivery pins the release tree: reviewed work is committed before every `deliver`. */
function commitAll(dir, msg = 'reviewed work') {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg], { cwd: dir });
}

/** A change-profile project that has been delivered once. */
function deliveredProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rework-'));
  initRepo(dir);
  const store = init(dir, { name: 'Fix totals', idea: 'Invoice totals are wrong when a shipping fee is present', profile: 'change' });
  const config = loadConfig(dir);
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverage({ dir, store, config }, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage({ dir, store, config }, 'phase:core', [`ev:${ev.id}`]));
  commitAll(dir);
  deliver(store, 'orchestrator');
  return { dir, store, config };
}

test('rework: a defect found after delivery is fixed under a new phase gate, reviewed independently, and re-delivered', () => {
  const ctx = deliveredProject();
  const { dir, store, config } = ctx;
  // Without a rework the approved files are locked: editing them by hand breaks the audit.
  assert.strictEqual(store.audit().ok, true);

  const repro = evidence.runCommand(store, 'backend-engineer', { label: 'repro: QA check fails', command: 'node -e "process.exit(1)"', purpose: 'reproduction' });
  const rw = openRework(store, config, 'orchestrator', { reason: 'QA: totals still wrong when a discount applies', files: ['src/server/**', 'tests/**'], owner: 'backend-engineer', evidence: [`ev:${repro.id}`] });
  assert.strictEqual(rw.id, 'rework-1');
  assert.strictEqual(rw.gate, 'phase:rework-1');
  let st = store.state();
  assert.deepStrictEqual(st.gateOrder, ['plan', 'phase:core', 'phase:rework-1']);
  assert.strictEqual(st.gates['phase:core'].status, 'approved', 'approved gates stay approved');
  assert.strictEqual(st.gates['phase:rework-1'].status, 'in_progress');
  assert.strictEqual(st.tasks['rework-1'].owner, 'backend-engineer');

  // Only the owner may claim; edits outside the scope are refused at completion.
  expectCode(() => tasks.claim(store, config, 'rework-1', 'frontend-engineer'), 'OWNERSHIP');
  tasks.claim(store, config, 'rework-1', 'backend-engineer');
  write(dir, 'src/server/a.js', '// api, fixed\n');
  write(dir, 'src/web/b.js', '// ui, edited outside the rework scope\n');
  const ev1 = passCheck(store, 'backend-engineer');
  expectCode(() => tasks.complete(store, config, 'rework-1', 'backend-engineer', handoffFor('rework-1', 'backend-engineer', [ev1.id], ['src/server/a.js', 'src/web/b.js'])), 'INVALID_HANDOFF');
  fs.writeFileSync(path.join(dir, 'src/web/b.js'), '// ui\n'); // restore the file that the rework may not touch
  const ev1b = passCheck(store, 'backend-engineer'); // the tree changed since ev1 ran, so the check runs again
  tasks.complete(store, config, 'rework-1', 'backend-engineer', handoffFor('rework-1', 'backend-engineer', [ev1b.id], ['src/server/a.js']));

  // Independent review: the owner can neither submit-and-approve nor approve.
  gates.submit(store, config, 'phase:rework-1', 'delivery-lead');
  const bad = passCheck(store, 'backend-engineer');
  expectCode(() => gates.recordReview(store, config, 'phase:rework-1', 'backend-engineer', approval([[`ev:${bad.id}`]])), 'REVIEW_REJECTED');
  const ev2 = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:rework-1', 'technical-reviewer', coverage({ dir, store, config }, 'phase:rework-1', [`ev:${ev2.id}`]));
  assert.strictEqual(store.state().gates['phase:rework-1'].status, 'approved');

  // Re-delivery produces a second verified handoff; the first stays.
  expectCode(() => deliver(store, 'orchestrator'), 'DELIVERY_BLOCKED'); // the fix is not committed yet
  commitAll(dir, 'rework-1');
  const res = deliver(store, 'orchestrator');
  assert.match(res.report, /final-handoff-2\.md$/);
  assert.ok(fs.existsSync(path.join(dir, '.eccode/delivery/final-handoff.md')));
  assert.ok(fs.existsSync(path.join(dir, res.report)));
  assert.strictEqual(store.audit().ok, true);
  expectCode(() => deliver(store, 'orchestrator'), 'ALREADY_DELIVERED');
});

test('rework: who may open it, with what scope, and how often', () => {
  const ctx = deliveredProject();
  const { store, config } = ctx;
  const base = { reason: 'QA found a defect after delivery', files: ['src/**'], owner: 'backend-engineer' };
  expectCode(() => openRework(store, config, 'backend-engineer', base), 'ROLE_NOT_ALLOWED'); // agents cannot open their own rework
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, reason: '' }), 'INVALID_INPUT');
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, files: [] }), 'INVALID_INPUT');
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, files: ['.eccode/config.json'] }), 'INVALID_INPUT'); // never the record
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, files: ['**/*'] }), 'INVALID_INPUT'); // never the whole tree
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, owner: 'nobody' }), 'INVALID_INPUT');
  expectCode(() => openRework(store, config, 'orchestrator', { ...base, evidence: ['ev:does-not-exist'] }), 'INVALID_EVIDENCE');
  openRework(store, config, 'user', base);
  expectCode(() => openRework(store, config, 'orchestrator', base), 'INVALID_TRANSITION'); // one open rework at a time
});

test('rework: bounded by limits.maxReworks', () => {
  const ctx = deliveredProject();
  const { dir, store } = ctx;
  const cfgFile = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.limits.maxReworks = 1;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const config = loadConfig(dir);
  const base = { reason: 'QA found a defect', files: ['src/**'], owner: 'backend-engineer' };
  openRework(store, config, 'orchestrator', base);
  tasks.claim(store, config, 'rework-1', 'backend-engineer');
  write(dir, 'src/server/a.js', '// fixed\n');
  tasks.complete(store, config, 'rework-1', 'backend-engineer', handoffFor('rework-1', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js']));
  gates.submit(store, config, 'phase:rework-1', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:rework-1', 'technical-reviewer', coverage({ dir, store, config }, 'phase:rework-1', [`ev:${ev.id}`]));
  // Past the cap the decision is the user's: a USER_AUTH_REQUIRED refusal that names the cap and both ways forward (F5).
  const err = expectCode(() => openRework(store, config, 'orchestrator', base), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /limits.maxReworks=1/);
  assert.match(err.message, /eccode rework open --actor user/);
  assert.match(err.message, /eccode delegate grant --actor user --to orchestrator --action rework.open --target rework-2/);
});

test('rework in a full delivery: refused once verification is approved unless the user reopens that gate first', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage({ dir, store, config }, 'phase:core', [`ev:${passCheck(store, 'technical-reviewer').id}`]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage({ dir, store, config }, 'verification', [`ev:${passCheck(store, 'security-reviewer').id}`, 'artifact:.eccode/artifacts/verification.md']));
  const base = { reason: 'QA found a defect after verification', files: ['src/**'], owner: 'backend-engineer' };
  const err = expectCode(() => openRework(store, config, 'orchestrator', base), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /gate reopen verification/);
});

test('CLI: eccode rework open prints the ids; status shows the next action; metrics count reworks', () => {
  const ctx = deliveredProject();
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a, '--root', ctx.dir], { encoding: 'utf8' });
  const res = cli('rework', 'open', '--actor', 'orchestrator', '--reason', 'QA: list endpoint returns a bare array', '--files', 'src/**', '--files', 'tests/**', '--owner', 'backend-engineer');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /rework-1/);
  assert.match(res.stdout, /phase:rework-1/);
  const status = cli('status', '--brief');
  assert.match(status.stdout, /NEXT: dispatch-tasks|rework-1/);
  const m = cli('metrics', '--json');
  assert.strictEqual(JSON.parse(m.stdout).summary.reworksOpened, 1);
  const bad = cli('rework', 'open', '--actor', 'backend-engineer', '--reason', 'x', '--files', 'src/**', '--owner', 'backend-engineer');
  assert.strictEqual(bad.status, 2);
});

test('rework: a file deleted by an approved rework is not an audit failure, one deleted behind the gates still is', () => {
  const ctx = deliveredProject();
  const { dir, store, config } = ctx;
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'delivered state'], { cwd: dir });

  // Behind the gates: audit fails.
  fs.unlinkSync(path.join(dir, 'src/web/b.js'));
  assert.ok(store.audit().ok && require('../lib/delivery').unreviewedChanges(store.state(), dir).some((c) => c.path === 'src/web/b.js' && c.problem === 'deleted after approval'));
  execFileSync('git', ['checkout', '--', 'src/web/b.js'], { cwd: dir });

  // Through a rework: the deletion is part of the task's recorded changes and of the reviewed gate.
  const repro = evidence.runCommand(store, 'backend-engineer', { label: 'repro', command: 'node -e "process.exit(1)"', purpose: 'reproduction' });
  openRework(store, config, 'orchestrator', { reason: 'The old api module is obsolete and must go', files: ['src/server/**'], owner: 'backend-engineer', evidence: [`ev:${repro.id}`] });
  tasks.claim(store, config, 'rework-1', 'backend-engineer');
  fs.unlinkSync(path.join(dir, 'src/server/a.js'));
  write(dir, 'src/server/a2.js', '// replacement\n'); // a phase needs at least one file to put under review
  const ev1 = passCheck(store, 'backend-engineer');
  tasks.complete(store, config, 'rework-1', 'backend-engineer', handoffFor('rework-1', 'backend-engineer', [ev1.id], ['src/server/a.js', 'src/server/a2.js']));
  gates.submit(store, config, 'phase:rework-1', 'delivery-lead');
  const ev2 = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:rework-1', 'technical-reviewer', coverage({ dir, store, config }, 'phase:rework-1', [`ev:${ev2.id}`]));
  assert.deepStrictEqual(require('../lib/delivery').unreviewedChanges(store.state(), dir), []);
  commitAll(dir, 'rework-1');
  assert.deepStrictEqual(require('../lib/delivery').unreviewedChanges(store.state(), dir), [], 'the committed deletion is reviewed work');
  assert.doesNotThrow(() => deliver(store, 'orchestrator'));
});

test('delivery profile: a defect found after delivery needs the user to reopen verification, then a rework past the cap, re-verification and re-delivery', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxReworks: 1 } } });
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage({ dir, store, config }, 'phase:core', [`ev:${passCheck(store, 'technical-reviewer').id}`]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  const deliverables = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: deliverables });
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage({ dir, store, config }, 'verification', [`ev:${passCheck(store, 'security-reviewer').id}`, 'artifact:.eccode/artifacts/verification.md']));
  commitAll(dir);
  deliver(store, 'delivery-lead');

  // Found after delivery: the orchestrator cannot open a rework (verification is approved), and nobody but the user can reopen it.
  const open = { reason: 'UI renders the text "null" under the title', files: ['src/web/**'], owner: 'frontend-engineer' };
  expectCode(() => openRework(store, config, 'orchestrator', open), 'USER_AUTH_REQUIRED');
  expectCode(() => gates.reopenGate(store, 'verification', 'orchestrator', 'reopen for the UI fix'), 'USER_AUTH_REQUIRED');
  expectCode(() => gates.reopenGate(store, 'phase:core', 'user', 'reopen the phase instead'), 'INVALID_TRANSITION'); // approved phases change through reworks only
  expectCode(() => gates.reopenGate(store, 'verification', 'user', 'reopen for the UI fix', { waive: 'all' }), 'INVALID_INPUT');
  gates.reopenGate(store, 'verification', 'user', 'User authorised a rework for the UI defect; verification will be redone');
  let st = store.state();
  assert.strictEqual(st.gates.verification.status, 'in_progress');
  assert.strictEqual(st.gates.verification.approvedBy, null);
  assert.strictEqual(st.gates.verification.previousApprovals.length, 1);
  assert.strictEqual(st.gates.verification.previousApprovals[0].approvedBy, 'security-reviewer');

  // The cap (1) binds the orchestrator, not the user: the first rework is the orchestrator's, the second the user's.
  const first = openRework(store, config, 'orchestrator', { reason: 'typo in the UI copy found after delivery', files: ['src/web/**'], owner: 'frontend-engineer' });
  tasks.claim(store, config, first.task, 'frontend-engineer');
  write(dir, 'src/web/b.js', '// ui, copy fixed\n');
  tasks.complete(store, config, first.task, 'frontend-engineer', handoffFor(first.task, 'frontend-engineer', [passCheck(store, 'frontend-engineer').id], ['src/web/b.js']));
  gates.submit(store, config, first.gate, 'delivery-lead');
  gates.recordReview(store, config, first.gate, 'technical-reviewer', coverage({ dir, store, config }, first.gate, [`ev:${passCheck(store, 'technical-reviewer').id}`]));
  expectCode(() => openRework(store, config, 'orchestrator', open), 'USER_AUTH_REQUIRED'); // past the cap: the user's decision (F5)
  const rw = openRework(store, config, 'user', open);
  st = store.state();
  assert.strictEqual(rw.id, 'rework-2');
  assert.deepStrictEqual(st.gateOrder.slice(-3), ['phase:rework-1', 'phase:rework-2', 'verification']);
  assert.strictEqual(st.reworks[1].afterDelivery, true);

  // The fix goes through claim, handoff and an independent phase review like any work.
  tasks.claim(store, config, rw.task, 'frontend-engineer');
  write(dir, 'src/web/b.js', '// ui, null child filtered\n');
  tasks.complete(store, config, rw.task, 'frontend-engineer', handoffFor(rw.task, 'frontend-engineer', [passCheck(store, 'frontend-engineer').id], ['src/web/b.js']));
  gates.submit(store, config, rw.gate, 'delivery-lead');
  gates.recordReview(store, config, rw.gate, 'technical-reviewer', coverage({ dir, store, config }, rw.gate, [`ev:${passCheck(store, 'technical-reviewer').id}`]));

  // Verification is redone on the final files and the build is delivered again.
  expectCode(() => deliver(store, 'delivery-lead'), 'DELIVERY_BLOCKED');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green after rework-2.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: deliverables });
  gates.recordReview(store, config, 'verification', 'security-reviewer', coverage({ dir, store, config }, 'verification', [`ev:${passCheck(store, 'security-reviewer').id}`, 'artifact:.eccode/artifacts/verification.md']));
  commitAll(dir, 'reworks');
  const res = deliver(store, 'delivery-lead');
  assert.strictEqual(res.report, '.eccode/delivery/final-handoff-2.md');
  const report = fs.readFileSync(path.join(dir, res.report), 'utf8');
  assert.match(report, /`gate.reopened` verification reopened: User authorised a rework/);
  assert.match(report, /`rework.opened` rework rework-2 opened: UI renders the text "null"/);
  assert.strictEqual(store.audit().ok, true);
  assert.deepStrictEqual(require('../lib/delivery').unreviewedChanges(store.state(), dir), []);
});

test('rework extend: after a review shows the defect reaches another file, the orchestrator widens the scope of the pending rework task', () => {
  const { dir, store, config } = deliveredProject();
  const { extendRework } = require('../lib/rework');
  const rw = openRework(store, config, 'orchestrator', { reason: 'null text rendered under the title', files: ['src/server/**'], owner: 'backend-engineer' });
  tasks.claim(store, config, rw.task, 'backend-engineer');
  expectCode(() => extendRework(store, config, 'orchestrator', { id: rw.id, files: ['src/web/**'], reason: 'same defect in the web view' }), 'INVALID_TRANSITION'); // claimed
  write(dir, 'src/server/a.js', '// fixed here only\n');
  tasks.complete(store, config, rw.task, 'backend-engineer', handoffFor(rw.task, 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js']));
  gates.submit(store, config, rw.gate, 'delivery-lead');
  const { event } = gates.recordReview(store, config, rw.gate, 'technical-reviewer', require('./helpers').rejection('R1', { findings: [{ id: 'R1', severity: 'major', title: 'Same defect in src/web', detail: 'The web view has the same null child.', recommendation: 'Extend the rework to src/web/**.' }] }));
  tasks.reset(store, rw.task, 'orchestrator', 'R1: scope too narrow');
  expectCode(() => extendRework(store, config, 'backend-engineer', { id: rw.id, files: ['src/web/**'], reason: 'same defect in the web view' }), 'ROLE_NOT_ALLOWED');
  expectCode(() => extendRework(store, config, 'orchestrator', { id: rw.id, files: ['**'], reason: 'same defect in the web view' }), 'INVALID_INPUT');
  extendRework(store, config, 'orchestrator', { id: rw.id, files: ['src/web/**'], reason: 'R1: same defect in the web view' });
  let st = store.state();
  assert.deepStrictEqual(st.tasks[rw.task].files, ['src/server/**', 'src/web/**']);
  assert.strictEqual(st.reworks[0].extensions.length, 1);
  tasks.claim(store, config, rw.task, 'backend-engineer');
  write(dir, 'src/web/b.js', '// fixed in the web view too\n');
  tasks.complete(store, config, rw.task, 'backend-engineer', handoffFor(rw.task, 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server/a.js', 'src/web/b.js']));
  gates.submit(store, config, rw.gate, 'delivery-lead', { respondsTo: event.data.reviewId });
  gates.recordReview(store, config, rw.gate, 'technical-reviewer', coverage({ dir, store, config }, rw.gate, [`ev:${passCheck(store, 'technical-reviewer').id}`], { resolvedFindings: [{ id: 'R1', resolution: 'src/web fixed in the extended scope.', evidence: ['artifact:src/web/b.js'] }] }));
  st = store.state();
  assert.strictEqual(st.gates[rw.gate].status, 'approved');
  assert.strictEqual(store.audit().ok, true);
  const cli = spawnSync(process.execPath, [BIN, '--root', dir, 'rework', 'extend', rw.id, '--actor', 'orchestrator', '--files', 'tests/**', '--reason', 'another file'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 2); // gate approved: no longer extendable
});
