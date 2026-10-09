'use strict';
// Adversarial probe 1: one task completed three times (rename, deletion, draft, undeclared restoration),
// then phase approval, then tampering checked through unreviewedChanges and the CLI `audit`.
// usage: node probe-lifecycle.js <worktree root holding lib/ tests/ bin/>
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shared-')); // never the real home
const LIB = path.resolve(process.argv[2]);
const gates = require(path.join(LIB, 'lib/gates'));
const tasks = require(path.join(LIB, 'lib/tasks'));
const { unreviewedChanges } = require(path.join(LIB, 'lib/delivery'));
const H = require(path.join(LIB, 'tests/helpers'));
const { tmpProject, write, approveThroughPlan, task, passCheck, handoffFor, coverage } = H;

const git = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
const commitAll = (dir, m) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', m); };
const out = [];
const log = (s) => out.push(s);
function expectRefused(fn, re) {
  try { fn(); return 'NOT refused'; } catch (e) { return re.test(e.message) ? `refused as expected (${e.code})` : `refused for another reason: ${e.message.slice(0, 200)}`; }
}

const ctx = tmpProject();
const { store, config, dir } = ctx;
write(dir, 'src/server/q.js', '// q at baseline\n');
commitAll(dir, 'baseline q');
approveThroughPlan(ctx, { phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }], tasks: [task('api', 'backend-engineer', ['src/server/**'])] });
gates.startGate(store, config, 'phase:core', 'orchestrator');
const complete = (files) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], files));

// Attempt 1: a, b, a draft.
tasks.claim(store, config, 'api', 'backend-engineer');
write(dir, 'src/server/a.js', '// a v1\n');
write(dir, 'src/server/b.js', '// b v1\n');
write(dir, '.eccode/drafts/api-notes.md', 'scratch\n');
log('attempt 1 declaring a draft: ' + expectRefused(() => complete(['src/server/a.js', 'src/server/b.js', '.eccode/drafts/api-notes.md']), /./));
if (store.state().tasks.api.status !== 'done') complete(['src/server/a.js', 'src/server/b.js']);
commitAll(dir, 'v1');
tasks.reset(store, 'api', 'orchestrator', 'review: rename a');

// Attempt 2: rename a -> a2 (staged), modify b, delete q (present at baseline).
tasks.claim(store, config, 'api', 'backend-engineer');
git(dir, 'mv', 'src/server/a.js', 'src/server/a2.js');
write(dir, 'src/server/b.js', '// b v2\n');
fs.rmSync(path.join(dir, 'src/server/q.js'));
complete(['src/server/a.js', 'src/server/a2.js', 'src/server/b.js', 'src/server/q.js']);
commitAll(dir, 'v2');
tasks.reset(store, 'api', 'orchestrator', 'review: drop b, add c');

// Attempt 3: delete b, add c; try to restore q without declaring it.
tasks.claim(store, config, 'api', 'backend-engineer');
fs.rmSync(path.join(dir, 'src/server/b.js'));
write(dir, 'src/server/c.js', '// c v1\n');
write(dir, 'src/server/q.js', '// q at baseline\n'); // restored to its baseline bytes, undeclared
log('attempt 3 restoring q undeclared: ' + expectRefused(() => complete(['src/server/b.js', 'src/server/c.js']), /does not declare|undeclared|inside your ownership/));
fs.rmSync(path.join(dir, 'src/server/q.js'));
complete(['src/server/b.js', 'src/server/c.js']);
log('completions recorded: ' + store.readEvents().filter((e) => e.type === 'task.completed').length);
log('snapshot filesChanged: ' + JSON.stringify(store.state().tasks.api.filesChanged));
if (tasks.filesChangedByTask) log('union: ' + JSON.stringify([...tasks.filesChangedByTask(store.readEvents()).get('api')]));

gates.submit(store, config, 'phase:core', 'delivery-lead');
const g = store.state().gates['phase:core'];
const pinned = g.submissions[g.submissions.length - 1].artifacts.map((a) => a.path).sort();
log('pinned at submit: ' + JSON.stringify(pinned) + (JSON.stringify(pinned) === JSON.stringify(['src/server/a2.js', 'src/server/c.js']) ? '  <- expected {a2, c}' : '  <- UNEXPECTED (expected a2, c)'));
gates.recordReview(store, config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${passCheck(store, 'technical-reviewer').id}`]));
assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
log('after approval unreviewedChanges: ' + JSON.stringify(unreviewedChanges(store.state(), dir)));

const audit = () => {
  const r = spawnSync(process.execPath, [path.join(LIB, 'bin/eccode.js'), 'audit', '--root', dir], { encoding: 'utf8', env: { ...process.env } });
  return `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(0, 4).join(' | ')}`;
};
log('audit clean: ' + audit());
// Tamper 1: edit a pinned file that only the first/second attempt touched.
write(dir, 'src/server/a2.js', '// a tampered\n');
log('tamper a2 (edit): ' + audit());
git(dir, 'checkout', '--', 'src/server/a2.js'); // a2 was committed in v2 at the pinned bytes
// Tamper 2: delete c.
fs.rmSync(path.join(dir, 'src/server/c.js'));
log('tamper c (delete): ' + audit());
write(dir, 'src/server/c.js', '// c v1\n'); // the pinned bytes back (c was never committed)
// Tamper 3: recreate b (deleted by attempt 3).
write(dir, 'src/server/b.js', '// b back\n');
log('tamper b (recreate deleted): ' + audit());
fs.rmSync(path.join(dir, 'src/server/b.js'));
// Tamper 4: recreate a.js (the rename's old path).
write(dir, 'src/server/a.js', '// a back\n');
log('tamper a.js (recreate renamed-from): ' + audit());
fs.rmSync(path.join(dir, 'src/server/a.js'));
// Tamper 5: restore q to its exact baseline bytes (deleted by attempt 2, present at the baseline commit).
write(dir, 'src/server/q.js', '// q at baseline\n');
log('tamper q (restore baseline bytes of a reviewed deletion): ' + audit());
fs.rmSync(path.join(dir, 'src/server/q.js'));
log('audit clean again: ' + audit());
console.log(out.join('\n'));
