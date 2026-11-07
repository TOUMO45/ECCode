'use strict';
// E2 reproduction: GF-OWN-4 (eccode-gf attribute) lists the changed paths with `git diff --name-only <base>`
// (lib/project.js gitChangedFiles), which applies git's rename detection: a file moved from one group's path to
// another's is reported under its NEW name only, so the removal of the other group's file is never attributed.
// Same construction as the bypass test in tests/gf-own-complete.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const COPY = path.resolve(__dirname, '..', 'copy');
const sample = require(path.join(COPY, 'tests/fixtures/gf/sample'));
const { gfProject, run, WRAPPED } = require(path.join(COPY, 'tests/fixtures/gf/flow'));
const wrap = require(path.join(COPY, 'lib/greenfield/wrap'));
const CLI = path.join(COPY, 'bin/eccode-gf.js');
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
const cli = (ctx, ...args) => { const r = spawnSync(process.execPath, [CLI, ...args, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
function done(ctx, role, task, filesChanged) {
  F(ctx, 'task.claimed', role, { task });
  F(ctx, 'task.completed', role, { task, handoffId: `ho-${task}`, filesChanged });
}

test('E2-5: a frontend file moved into a backend path and committed is attributed as a backend file only; the frontend removal disappears', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'web/index.html'), '<!doctype html>\n<html><body>\n<h1>Tasks</h1>\n<ul id="tasks"></ul>\n</body></html>\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'sealed, with a frontend page');
  const base = gitIn(ctx.dir, 'rev-parse', 'HEAD');

  // Control: the same removal without the matching addition is reported.
  fs.renameSync(path.join(ctx.dir, 'web/index.html'), path.join(ctx.dir, 'gone.tmp'));
  const control = cli(ctx, 'attribute', '--base', base);
  fs.renameSync(path.join(ctx.dir, 'gone.tmp'), path.join(ctx.dir, 'web/index.html'));
  assert.match(control.out, /web\/index\.html was changed but no completed task of frontend declares it/, control.out);

  // The move (what `mv web/index.html app/main.py`, allowed by the hook, does), committed; backend declares its own path.
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  gitIn(ctx.dir, 'mv', 'web/index.html', 'app/main.py');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'backend work');
  done(ctx, 'backend-engineer', 's0-app', ['app/main.py']);
  const r = cli(ctx, 'attribute', '--base', base);
  console.log(`git diff --name-only ${base.slice(0, 12)}: ${JSON.stringify(gitIn(ctx.dir, 'diff', '--name-only', '--relative', base))}`);
  console.log(`eccode-gf attribute --base ${base.slice(0, 12)} -> exit ${r.code}: ${r.out.trim()}`);
  assert.match(r.out, /web\/index\.html was changed but no completed task of frontend declares it/, `GF-OWN-4: every path changed since the base is attributed; web/index.html was removed by backend. Observed exit ${r.code}: ${r.out}`);
});
