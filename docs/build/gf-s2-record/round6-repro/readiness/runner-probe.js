'use strict';
// Probe of GF-RUN-2's before-and-after comparison (design 18.4): does a pinned pytest run whose project code
// changes another group's file always fail? Each case runs as backend-engineer from its own claimed file app/main.py;
// web/** is frontend's.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const COPY = process.argv[2];
const X = require(path.join(COPY, 'tests/fixtures/gf/close'));
const runner = require(path.join(COPY, 'lib/greenfield/runner'));
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
function team() {
  const ctx = closeProject();
  require(path.join(COPY, 'lib/greenfield/wrap')).gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}
const G = 'import subprocess\nG = ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"]\n';
const cases = {
  control_plain_write: 'def test_x():\n    open("web/index.html", "a").write("changed")\n',
  commit_inside_run: G + 'def test_x():\n    open("web/index.html", "a").write("changed")\n    subprocess.run(G + ["commit", "-q", "-am", "x"], check=True)\n',
  assume_unchanged: G + 'def test_x():\n    subprocess.run(G + ["update-index", "--assume-unchanged", "web/index.html"], check=True)\n    open("web/index.html", "a").write("changed")\n',
  info_exclude_new_file: 'import os\ndef test_x():\n    open(".git/info/exclude", "a").write("\\nweb/evil.js\\n")\n    open("web/evil.js", "w").write("x")\n',
};
const results = {};
for (const [name, body] of Object.entries(cases)) {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'app/main.py', body); // backend's own claimed file (task s0-app)
  commitAll(ctx, 'a page and a test');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: name, command: 'pytest -q app/main.py' });
  const changed = fs.readFileSync(path.join(ctx.dir, 'web/index.html'), 'utf8').includes('changed') || fs.existsSync(path.join(ctx.dir, 'web/evil.js'));
  results[name] = { status: r.status, exitCode: r.exitCode, ok: r.ok, frontendFileChanged: changed, problems: r.problems.map((p) => p.message) };
}
console.log(JSON.stringify(results, null, 1));
// The probe passes when every run that changed a frontend file failed, as 18.4 states.
const evaded = Object.entries(results).filter(([, v]) => v.frontendFileChanged && v.status === 'passed').map(([k]) => k);
console.log(evaded.length ? `EVADED: ${evaded.join(', ')}` : 'every run that changed a frontend file failed');
process.exit(evaded.length ? 1 : 0);
