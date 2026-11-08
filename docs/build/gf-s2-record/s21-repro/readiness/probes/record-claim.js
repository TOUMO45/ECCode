'use strict';
// Probe of design 18.4 step (1) and 18.7 (S2.1): "the real-tree hash leaves out .eccode/ (the frozen record window
// puts back and fails a change there)", and of GF-RUN-2 (18.1): the runner "fails a run that changed any file of the
// real tree outside the caller's group". A backend-engineer run (pinned form `pytest -q`) whose test writes by absolute
// path ($ECCODE_EVIDENCE, which the frozen runner gives every command) into .eccode/. Exit 0 only if every such run fails.
const C = '/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-h3/copy';
const X = require(C + '/tests/fixtures/gf/close');
const runner = require(C + '/lib/greenfield/runner');
const audit = require(C + '/lib/greenfield/audit');
const pin = require(C + '/lib/greenfield/pin');
const permissions = require(C + '/lib/greenfield/permissions');
const fs = require('fs'); const path = require('path');
const { closeProject, commitAll, F } = X;
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const PY = 'import os\nREC = os.environ["ECCODE_EVIDENCE"]\n';
let broken = 0;
function probe(name, body, { prePin = false, expectFail = true } = {}) {
  const ctx = closeProject();
  require(C + '/lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  if (prePin) { put(ctx.dir, '.eccode/security.json', '{"strict": true}\n'); pin.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'probe', reason: 'pin the guard configuration for the probe' }); }
  put(ctx.dir, 'app/main.py', 'print("app")\n');
  put(ctx.dir, 'tests/test_p.py', `${PY}\ndef test_p():\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  commitAll(ctx, 'probe');
  const hookOnFileTool = permissions.policy(ctx.dir, 'backend-engineer', name.includes('drafts') ? '.eccode/drafts/frontend/note.md' : '.eccode/security.json');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: name, command: 'pytest -q tests/test_p.py' });
  const a = audit.run(ctx.store, ctx.config);
  const conf = (a.errors || []).filter((e) => e.rule === 'GF-CONF-1').map((e) => e.message.slice(0, 120));
  const failedRun = r.status === 'failed';
  if (expectFail && !failedRun) broken++;
  console.log(`${failedRun ? 'run FAILED (claim holds)' : 'run PASSED (claim does not hold)'} | ${name} | exit ${r.exitCode} | hook on the same path through a file tool: ${hookOnFileTool && hookOnFileTool.denial ? 'denied: ' + hookOnFileTool.denial.slice(0, 90) : 'no denial'} | audit GF-CONF-1: ${conf.length ? conf.join(' / ') : 'none'}`);
}
probe('backend run writes frontend drafts .eccode/drafts/frontend/note.md', 'os.makedirs(os.path.join(REC, "drafts/frontend"), exist_ok=True)\nopen(os.path.join(REC, "drafts/frontend/note.md"), "w").write("planted by backend")');
probe('backend run creates guard config .eccode/security.json, no pin yet', 'open(os.path.join(REC, "security.json"), "w").write("{}")');
probe('backend run loosens pinned guard config .eccode/security.json', 'open(os.path.join(REC, "security.json"), "w").write("{}")', { prePin: true });
probe('control: backend run appends to .eccode/events.jsonl', 'open(os.path.join(REC, "events.jsonl"), "a").write("\\n")');
console.log(broken ? `${broken} run(s) changed .eccode/ outside events.jsonl, state.json and config.json and passed: the frozen record window covers only those three files (lib/evidence.js RECORD_FILES), so 18.4(1)/18.7's claim does not hold` : 'every run that changed .eccode/ failed');
process.exit(broken ? 1 : 0);
