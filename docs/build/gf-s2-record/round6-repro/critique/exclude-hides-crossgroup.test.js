'use strict';
// G2 repro: GF-RUN-2's before/after comparison uses `git ls-files --others --exclude-standard`, which honors
// .git/info/exclude. Project code run through the runner can append its own cross-group output path to
// .git/info/exclude (a path the comparison never lists, inside .git) and then write that path. The new untracked
// cross-group file is then invisible to BOTH snapshots, so the run PASSES, defeating 18.3/18.4's claim that a run
// that changed any file outside the caller's group, "tracked or untracked", fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-g2/copy/tests/fixtures/gf/close');
const runner = require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-g2/copy/lib/greenfield/runner');
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };

function team() {
  const ctx = closeProject();
  require('/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-g2/copy/lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}

// Control: without the exclude trick, the F2-1 cross-group write fails (as the suite asserts).
test('CONTROL: a plain cross-group write fails the run', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_plain.py', 'def test_plain():\n    open("web/index.html", "a").write("x")\n');
  commitAll(ctx, 'plain');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'plain', command: 'pytest -q tests/test_plain.py' });
  assert.strictEqual(r.status, 'failed', JSON.stringify(r.problems));
  assert.ok(r.problems.some((p) => /web\/index\.html/.test(p.message)), JSON.stringify(r.problems));
});

// Attack: the run first appends the target path to .git/info/exclude, then writes the cross-group file.
test('ATTACK: a cross-group write hidden via .git/info/exclude passes the run', () => {
  const ctx = team();
  put(ctx, 'tests/test_hide.py', [
    'def test_hide():',
    '    with open(".git/info/exclude", "a") as f:',
    '        f.write("\\nweb/evil.txt\\n")',
    '    import os',
    '    os.makedirs("web", exist_ok=True)',
    '    with open("web/evil.txt", "w") as f:',
    '        f.write("injected by backend into the frontend group\\n")',
    '',
  ].join('\n'));
  commitAll(ctx, 'hide');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'hide', command: 'pytest -q tests/test_hide.py' });
  // The cross-group file really exists on disk...
  assert.ok(fs.existsSync(path.join(ctx.dir, 'web/evil.txt')), 'the write did not happen');
  // ...yet the run reports no outside change and passes.
  console.log('status=%s ok=%s problems=%j', r.status, r.ok, r.problems);
  assert.strictEqual(r.status, 'passed', `expected the run to (wrongly) pass; problems=${JSON.stringify(r.problems)}`);
  assert.strictEqual(r.problems.length, 0, `expected no outside-change problem; got ${JSON.stringify(r.problems)}`);
});
