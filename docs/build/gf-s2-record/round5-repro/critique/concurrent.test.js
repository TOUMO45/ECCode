'use strict';
// F2 repro: 18.3 and L-GF-29 claim the frozen integrity window "fails a run that changes a tracked file
// outside the caller's claimed ownership". This probes a tracked file that belongs to ANOTHER group's
// CLAIMED task: the frozen window calls that "concurrent", not a violation, so the run passes.
const test = require('node:test');
const assert = require('node:assert');
const { closeProject, F, commitAll, put } = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/tests/fixtures/gf/close');
const { gateStart } = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/lib/greenfield/wrap');
const runner = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/lib/greenfield/runner');

test('runner writing another group\'s CLAIMED tracked file: run status', () => {
  const ctx = closeProject();
  gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' }); // frontend claims web/**
  // a frontend-owned tracked file
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  // backend's own test (backend claimed s0-app) that writes into web/ (frontend's claimed area)
  put(ctx, 'app/test_cross.py', 'def test_cross():\n    open("web/index.html", "a").write("INJECTED-BY-BACKEND")\n');
  commitAll(ctx, 'frontend page + backend test that writes it');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'x', command: 'pytest -q app/test_cross.py' });
  console.log('status=%s exit=%s ok=%s problems=%j', r.status, r.exitCode, r.ok, r.problems);
  const fs = require('fs'); const path = require('path');
  console.log('file now:', JSON.stringify(fs.readFileSync(path.join(ctx.dir, 'web/index.html'), 'utf8')));
  // The claim: 18.3 says this run is FAILED by the integrity window. Observe what actually happens:
  assert.strictEqual(r.status, 'passed', 'if this passes, the integrity window did NOT stop the cross-group write');
});

const CC = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/tests/fixtures/gf/close');
test('inspect the recorded evidence event for the concurrent write', () => {
  const ctx = CC.closeProject();
  require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  CC.F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  CC.F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  CC.put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  CC.put(ctx, 'app/test_cross.py', 'def test_cross():\n    open("web/index.html","a").write("X")\n');
  CC.commitAll(ctx, 'c');
  const r = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-f2/copy/lib/greenfield/runner').run(ctx.store, ctx.config, 'backend-engineer', { label: 'x', command: 'pytest -q app/test_cross.py' });
  const ev = ctx.store.readEvents().reverse().find((e) => e.type === 'evidence.recorded' && `ev:${e.data.id}` === r.evidence);
  console.log('runner-returned:', JSON.stringify({ status: r.status, ok: r.ok, problems: r.problems }));
  console.log('event.status=%s integrity=%j concurrent=%j', ev.data.status, ev.data.integrity || null, ev.data.concurrent || null);
  assert.ok(true);
});
