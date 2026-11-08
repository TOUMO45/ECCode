'use strict';
// G2 repro: GF-RUN-2's before/after comparison (run-check.js) and the frozen integrity window both use
// `git diff HEAD` / `git ls-files --others`. If project code run through the runner COMMITS its cross-group
// change, HEAD advances to contain it, so after the run neither `git diff HEAD` (nothing differs from the new
// HEAD) nor `git ls-files --others` (it is now tracked) lists the file. The run PASSES, leaving a cross-group
// change committed into the tree -- defeating 18.3/18.4 ("a run that changed any file outside the caller's
// group ... fails") and L-GF-29 ("the runner's own comparison fails a run that changed a file outside the
// caller's group").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const B = '/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-g2/copy';
const X = require(B + '/tests/fixtures/gf/close');
const runner = require(B + '/lib/greenfield/runner');
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim();

function team() {
  const ctx = closeProject();
  require(B + '/lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}

test('ATTACK: a run whose project code COMMITS a cross-group write passes, and the change is committed', () => {
  const ctx = team();
  put(ctx, 'tests/test_commit.py', [
    'import os, subprocess',
    'def test_commit():',
    '    os.makedirs("web", exist_ok=True)',
    '    open("web/evil.html", "w").write("injected by backend\\n")',
    '    env = dict(os.environ, GIT_AUTHOR_NAME="x", GIT_AUTHOR_EMAIL="x@x", GIT_COMMITTER_NAME="x", GIT_COMMITTER_EMAIL="x@x")',
    '    subprocess.run(["git", "add", "web/evil.html"], check=True, env=env)',
    '    subprocess.run(["git", "commit", "-q", "-m", "backend edits frontend"], check=True, env=env)',
    '',
  ].join('\n'));
  commitAll(ctx, 'a test that commits a cross-group file');
  const head0 = git(ctx.dir, 'rev-parse', 'HEAD');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'commit', command: 'pytest -q tests/test_commit.py' });
  const head1 = git(ctx.dir, 'rev-parse', 'HEAD');
  console.log('status=%s ok=%s problems=%j headMoved=%s', r.status, r.ok, r.problems, head0 !== head1);
  // the cross-group file is committed into the tree...
  assert.ok(git(ctx.dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes('web/evil.html'), 'the file was not committed');
  // ...and the frozen integrity window did not see it either (no integrity violation recorded)...
  // ...and the run passes with no outside-change problem.
  assert.strictEqual(r.status, 'passed', `expected a (wrong) pass; problems=${JSON.stringify(r.problems)}`);
  assert.strictEqual(r.problems.length, 0, `expected no outside-change problem; got ${JSON.stringify(r.problems)}`);
});
