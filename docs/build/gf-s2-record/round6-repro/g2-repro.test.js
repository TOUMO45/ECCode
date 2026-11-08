'use strict';
// Reproductions of the round-6 engine findings (critique rev-mw72ghco-016e0dcd, readiness no-go rev-mw728omo-01fe3d2f,
// tree 067cb70). Each asserts what design 18.4 claims (a run that changed any file outside the caller's group fails),
// so each FAILS on that tree. They live outside tests/ (S2 is stopped by the owner's stop rule, not fixed). Run from the
// repository root: TMPDIR=<absolute scratch> GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false node --test docs/build/gf-s2-record/round6-repro/g2-repro.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../../..');
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const runner = require(path.join(ROOT, 'lib/greenfield/runner'));
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
function team() {
  const ctx = closeProject();
  require(path.join(ROOT, 'lib/greenfield/wrap')).gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  return ctx;
}
const GIT = 'import subprocess\ndef git(*a):\n    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True)\n';
const runAs = (ctx, test) => { put(ctx, 'tests/test_e.py', test); commitAll(ctx, 'a frontend page and a test'); return runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'evasion', command: 'pytest -q tests/test_e.py' }); };
const failed = (r) => assert.strictEqual(r.status, 'failed', `the run passed: ${JSON.stringify({ status: r.status, ok: r.ok, problems: r.problems })}`);

test('G2-1: a run whose code commits its change to another group\'s file fails', () => {
  const ctx = team();
  failed(runAs(ctx, `${GIT}\ndef test_e():\n    open("web/index.html", "a").write("<!-- backend -->")\n    git("commit", "-qam", "hidden")\n`));
});
test('G2-2: a run whose code hides a new file of another group in .git/info/exclude fails', () => {
  const ctx = team();
  failed(runAs(ctx, 'import os\n\ndef test_e():\n    open(".git/info/exclude", "a").write("\\nweb/evil.txt\\n")\n    open("web/evil.txt", "w").write("x")\n'));
});
test('R3 (round 6): a run whose code marks another group\'s file assume-unchanged before changing it fails', () => {
  const ctx = team();
  failed(runAs(ctx, `${GIT}\ndef test_e():\n    git("update-index", "--assume-unchanged", "web/index.html")\n    open("web/index.html", "a").write("<!-- backend -->")\n`));
});
