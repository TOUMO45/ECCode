'use strict';
// Adversarial probe 2: can an out-of-band edit hide under a pending task's union (in-flight attribution)
// and escape review? Two phases; phase core approved; phase next's task completes once, is reset, and while
// it is pending its first-attempt file is edited out of band and a core-pinned file is deleted.
// usage: node probe-inflight.js <worktree root>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shared-'));
const LIB = path.resolve(process.argv[2]);
const gates = require(path.join(LIB, 'lib/gates'));
const tasks = require(path.join(LIB, 'lib/tasks'));
const { unreviewedChanges } = require(path.join(LIB, 'lib/delivery'));
const { tmpProject, write, approveThroughPlan, task, passCheck, handoffFor, coverage } = require(path.join(LIB, 'tests/helpers'));
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
const commitAll = (dir, m) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', m); };
const out = [];
const ctx = tmpProject();
const { store, config, dir } = ctx;
approveThroughPlan(ctx, {
  phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }, { id: 'next', name: 'Next', goal: 'Build the next slice', acceptanceCriteria: ['next slice works'] }],
  tasks: [task('api', 'backend-engineer', ['src/server/**']), task('api2', 'backend-engineer', ['src/next/**'], ['api'], 'next')],
});
const done = (id, files) => tasks.complete(store, config, id, 'backend-engineer', handoffFor(id, 'backend-engineer', [passCheck(store, 'backend-engineer').id], files));
const approve = (gate) => gates.recordReview(store, config, gate, 'technical-reviewer', coverage(ctx, gate, [`ev:${passCheck(store, 'technical-reviewer').id}`]));

gates.startGate(store, config, 'phase:core', 'orchestrator');
tasks.claim(store, config, 'api', 'backend-engineer');
write(dir, 'src/server/a.js', '// a\n');
done('api', ['src/server/a.js']);
commitAll(dir, 'core');
gates.submit(store, config, 'phase:core', 'delivery-lead');
approve('phase:core');

gates.startGate(store, config, 'phase:next', 'orchestrator');
tasks.claim(store, config, 'api2', 'backend-engineer');
write(dir, 'src/next/n.js', '// n v1\n');
done('api2', ['src/next/n.js']);
commitAll(dir, 'next v1');
tasks.reset(store, 'api2', 'orchestrator', 'review: rework');

// Out of band, while api2 is pending: edit n.js (first-attempt file) and delete a.js (pinned by core).
write(dir, 'src/next/n.js', '// n edited out of band\n');
fs.rmSync(path.join(dir, 'src/server/a.js'));
out.push('pending rework, out-of-band edits: ' + JSON.stringify(unreviewedChanges(store.state(), dir)));
git(dir, 'checkout', '--', 'src/server/a.js');
out.push('a.js restored: ' + JSON.stringify(unreviewedChanges(store.state(), dir)));

// Rework: the out-of-band n.js edit is dirty in the ownership -> claim refused until committed (the engine's rule).
try { tasks.claim(store, config, 'api2', 'backend-engineer'); out.push('claim with dirty n.js: NOT refused'); } catch (e) { out.push(`claim with dirty n.js: refused ${e.code}`); }
commitAll(dir, 'out of band n.js');
tasks.claim(store, config, 'api2', 'backend-engineer');
write(dir, 'src/next/n2.js', '// n2\n');
done('api2', ['src/next/n2.js']); // the rework handoff names only n2.js
gates.submit(store, config, 'phase:next', 'delivery-lead');
const g = store.state().gates['phase:next'];
const pinned = g.submissions[g.submissions.length - 1].artifacts.map((a) => `${a.path}@${a.sha256.slice(0, 8)}`).sort();
out.push('phase:next pinned: ' + JSON.stringify(pinned) + (pinned.length === 2 ? '  <- n.js (edited bytes) and n2.js both on the reviewer\'s desk' : '  <- n.js NOT pinned: the out-of-band edit is not in the review set'));
approve('phase:next');
out.push('after next approval unreviewedChanges: ' + JSON.stringify(unreviewedChanges(store.state(), dir)));
console.log(out.join('\n'));
