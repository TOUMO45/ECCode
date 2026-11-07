'use strict';
// Readiness probe (architecture-reviewer, R3): facts about the GF-RUN-2 runner as it behaves on this machine,
// asserted as they are (this file is expected to pass). COPY is the review copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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

test('fact: with no claim of db, backend-engineer\'s "ruff format app/db" changes db\'s tracked file and the frozen integrity window fails the run (exit 99)', () => {
  const ctx = team();
  put(ctx, 'app/db/models.py', 'x=1\n');
  commitAll(ctx, 'an unformatted db file');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'fmt', command: 'ruff format app/db' });
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'app/db/models.py'), 'utf8'), 'x = 1\n', 'the write happened');
});

test('fact: with db\'s claim, the same run passes, the runner reports no problem, and the frozen record names the file only as "concurrent"', () => {
  const ctx = team();
  put(ctx, 'app/db/models.py', 'x=1\n');
  commitAll(ctx, 'an unformatted db file');
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'fmt', command: 'ruff format app/db' });
  assert.strictEqual(r.status, 'passed');
  assert.deepStrictEqual(r.problems, []);
  const ev = ctx.store.readEvents().find((e) => e.type === 'evidence.recorded' && `ev:${e.data.id}` === r.evidence);
  assert.strictEqual(ev.actor, 'backend-engineer');
  assert.deepStrictEqual(ev.data.concurrent, ['app/db/models.py']);
});

test('fact: on this machine\'s PATH, alembic is not on PATH, so the pinned alembic form is "unverifiable here" (design 18.4 lists alembic as installed here)', () => {
  const ctx = team();
  const r = runner.run(ctx.store, ctx.config, 'database-engineer', { label: 'alembic', command: 'alembic current' });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.problems.map((p) => p.message).join(' '), /unverifiable here: alembic is not installed/);
});

test('fact: project code run by a pinned pytest form that changes a tracked file of a group holding a claim passes; the frozen record names it only as "concurrent" (18.3 and L-GF-29 say such a run fails)', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_t.py', 'def test_t():\n    open("web/index.html", "a").write("changed")\n');
  commitAll(ctx, 'a page and a test that changes it');
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 't', command: 'pytest -q tests/test_t.py' });
  assert.strictEqual(r.status, 'passed', r.outputTail);
  assert.strictEqual(r.exitCode, 0);
  assert.deepStrictEqual(r.problems, []);
  const ev = ctx.store.readEvents().find((e) => e.type === 'evidence.recorded' && `ev:${e.data.id}` === r.evidence);
  assert.deepStrictEqual(ev.data.concurrent, ['web/index.html']);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'web/index.html'), 'utf8'), /changed/);
});
