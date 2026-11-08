'use strict';
// H2-2 reproduction (security-reviewer, S2 critique). Run from inside the reviewer's copy of the tree.
// Design 18.4 (S2.1), step (1): the wrapper hashes every file of the real tree, "the project's `.eccode/` excepted (the
// frozen record window covers it, G1-1 in 18.1)"; 18.1: "a change through the record's absolute path (the frozen
// runner gives every command `ECCODE_EVIDENCE`, which names it) is put back by the frozen record window, which fails
// the run (exit 99 ...)"; 18.0: detection covers "a write that reaches the real tree another way (an absolute path
// ...)". The frozen record window (lib/evidence.js RECORD_FILES) snapshots and puts back three files only:
// events.jsonl, state.json and config.json. Each test asserts the design's claim for another part of `.eccode/`,
// written by project code through ECCODE_EVIDENCE during a runner run, and fails when the claim does not hold.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const runner = require(path.join(ROOT, 'lib/greenfield/runner'));
const wrap = require(path.join(ROOT, 'lib/greenfield/wrap'));
const { closeProject, commitAll, F } = X;

const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const read = (ctx, rel) => { try { return fs.readFileSync(path.join(ctx.dir, rel), 'utf8'); } catch { return null; } };
const PY = 'import os\nREC = os.environ["ECCODE_EVIDENCE"]\ndef put(rel, text):\n    p = os.path.join(REC, rel)\n    os.makedirs(os.path.dirname(p), exist_ok=True)\n    open(p, "w").write(text)\n';

/** A sealed project with claimed tasks, a test whose body is `body`; the backend's run of it through the runner. */
function runTest(body, setup = () => {}) {
  const ctx = closeProject();
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'tests/test_h2.py', `${PY}\ndef test_h2():\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  commitAll(ctx, 'a page and a test');
  const before = setup(ctx);
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'h2', command: 'pytest -q tests/test_h2.py' });
  return { ctx, r, before };
}
const show = (r) => JSON.stringify({ status: r.status, exitCode: r.exitCode, problems: r.problems, tail: r.outputTail });

test('H2-2a: project code that writes another group\'s drafts (.eccode/drafts/frontend/) through ECCODE_EVIDENCE fails the run or is put back', () => {
  const { ctx, r } = runTest('put("drafts/frontend/notes.md", "backend wrote this\\n")', (c) => { put(c, '.eccode/drafts/frontend/notes.md', 'frontend notes\n'); });
  const now = read(ctx, '.eccode/drafts/frontend/notes.md');
  assert.ok(r.exitCode === 99 || now === 'frontend notes\n', `the frontend group's draft is now ${JSON.stringify(now)}; run ${show(r)}`);
});

test('H2-2b: project code that overwrites an evidence log of the record (.eccode/evidence/) through ECCODE_EVIDENCE fails the run or is put back', () => {
  let logRel;
  const { ctx, r, before } = runTest('import glob\nfor p in glob.glob(os.path.join(REC, "evidence", "*.log")):\n    open(p, "w").write("rewritten by a test\\n")', (c) => {
    const e = require(path.join(ROOT, 'lib/evidence')).runCommand(c.store, 'orchestrator', { label: 'baseline', command: 'true' });
    logRel = e.log;
    return read(c, logRel);
  });
  const now = read(ctx, logRel);
  assert.ok(r.exitCode === 99 || now === before, `evidence log ${logRel} is now ${JSON.stringify(now)} (was ${JSON.stringify(before && before.slice(0, 40))}); run ${show(r)}`);
});

test('H2-2c: project code that writes a guard configuration (.eccode/guards.json, which no group role may write: GF-CONF-1) fails the run or is put back', () => {
  const { ctx, r, before } = runTest('put("guards.json", "{}\\n")', (c) => read(c, '.eccode/guards.json'));
  const now = read(ctx, '.eccode/guards.json');
  assert.ok(r.exitCode === 99 || now === before, `.eccode/guards.json is now ${JSON.stringify(now)} (was ${before === null ? 'absent' : JSON.stringify(before.slice(0, 40))}); run ${show(r)}`);
});
