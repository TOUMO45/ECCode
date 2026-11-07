'use strict';
// Readiness probe (architecture-reviewer, R3): design 18.4 says the writing forms of ruff ("ruff check --fix",
// "ruff format") take "at least one path, each inside the caller's group" and write "the named paths". The sample
// map gives backend app/** minus app/db/** (db) and app/auth/** (security). This probe asserts that documented
// behaviour for directory arguments, and checks end to end what a run does when the other group holds a claim.
// Run from the review copy: node --test <this file>, with COPY set to the review copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COPY = process.env.COPY;
const X = require(path.join(COPY, 'tests/fixtures/gf/close'));
const runner = require(path.join(COPY, 'lib/greenfield/runner'));
const wrap = require(path.join(COPY, 'lib/greenfield/wrap'));
const { closeProject, F, commitAll } = X;

function team() {
  const ctx = closeProject();
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  return ctx;
}
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };

// Controls: the check refuses these today.
for (const cmd of ['ruff format web', 'ruff format app', 'ruff check --fix web/x.js']) {
  test(`control: backend-engineer is refused "${cmd}"`, () => {
    const p = runner.formProblems(team().store, team().config, 'backend-engineer', cmd);
    assert.ok(p.length > 0, JSON.stringify(p));
  });
}

// Documented behaviour (18.4): every named path of a writing form is inside the caller's group.
for (const cmd of ['ruff format app/db', 'ruff format app/auth', 'ruff check --fix app/db', 'ruff format app/']) {
  test(`18.4: backend-engineer must be refused "${cmd}" (the path holds another group's files)`, () => {
    const ctx = team();
    const p = runner.formProblems(ctx.store, ctx.config, 'backend-engineer', cmd);
    assert.ok(p.length > 0, `accepted with no problem: ${JSON.stringify(p)}`);
  });
}

// End to end: with db holding its own claim, the frozen integrity window files db's changed file as "concurrent",
// so the run passes and the runner reports no problem, although backend-engineer rewrote db's file.
test('end to end: backend-engineer\'s "ruff format app/db" must not leave db\'s file changed by a passing, problem-free run', () => {
  const ctx = team();
  put(ctx, 'app/db/models.py', 'x=1\n');
  commitAll(ctx, 'an unformatted db file');
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'fmt', command: 'ruff format app/db' });
  const after = fs.readFileSync(path.join(ctx.dir, 'app/db/models.py'), 'utf8');
  const changed = after !== 'x=1\n';
  const diff = execFileSync('git', ['diff', '--name-only'], { cwd: ctx.dir, encoding: 'utf8' }).trim();
  assert.ok(!(changed && r.ok), `run status ${r.status}, exit ${r.exitCode}, ok ${r.ok}, problems ${JSON.stringify(r.problems)}; db file now ${JSON.stringify(after)}; git diff: ${diff}`);
});
