'use strict';
// Probe: does a group role's run through the runner fail when its code writes, by absolute path, into the project's
// .eccode/ outside the three files the frozen record window covers (events.jsonl, state.json, config.json)?
const C = '/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-h3/copy';
const X = require(C + '/tests/fixtures/gf/close');
const runner = require(C + '/lib/greenfield/runner');
const audit = require(C + '/lib/greenfield/audit');
const fs = require('fs'); const path = require('path');
const { closeProject, commitAll, F } = X;
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const PY = 'import os\nREC = os.environ["ECCODE_EVIDENCE"]\n';
function probe(name, body, check) {
  const ctx = closeProject();
  require(C + '/lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  put(ctx, 'app/main.py', 'print("app")\n');
  put(ctx, 'tests/test_p.py', `${PY}\ndef test_p():\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  commitAll(ctx, 'probe');
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: name, command: 'pytest -q tests/test_p.py' });
  let auditProblems = [];
  try { const a = audit.run(ctx.store.root ? ctx.store : ctx.store, ctx.config); auditProblems = [...(a.errors || []), ...((a.base && a.base.errors) || []).map((m) => ({ rule: "base", message: typeof m === "string" ? m : JSON.stringify(m) })), ...((a.base && a.base.unreviewed) || []).map((m) => ({ rule: "base-unreviewed", message: JSON.stringify(m) }))].map((p) => `${p.rule}: ${String(p.message).slice(0, 140)}`); } catch (e) { auditProblems = ['audit threw: ' + e.message]; }
  console.log(JSON.stringify({ probe: name, runStatus: r.status, exitCode: r.exitCode, ok: r.ok, problems: r.problems.map((p) => p.message.slice(0, 160)), after: check(ctx), auditProblems: auditProblems.slice(0, 6) }, null, 1));
}
probe('abs write to another group drafts namespace (.eccode/drafts/frontend/)', 'os.makedirs(os.path.join(REC, "drafts/frontend"), exist_ok=True)\nopen(os.path.join(REC, "drafts/frontend/note.md"), "w").write("planted by backend")',
  (ctx) => ({ planted: fs.existsSync(path.join(ctx.dir, '.eccode/drafts/frontend/note.md')) }));
probe('abs write creating a guard config (.eccode/security.json)', 'open(os.path.join(REC, "security.json"), "w").write("{}")',
  (ctx) => ({ planted: fs.existsSync(path.join(ctx.dir, '.eccode/security.json')) }));
probe('abs append to the sealed ownership map (.eccode/artifacts/breakdown.json)', 'open(os.path.join(REC, "artifacts/breakdown.json"), "a").write(" ")',
  (ctx) => ({ breakdownEndsWithSpace: fs.readFileSync(path.join(ctx.dir, '.eccode/artifacts/breakdown.json'), 'utf8').endsWith(' ') }));
probe('control: abs write to events.jsonl (covered by the frozen record window)', 'open(os.path.join(REC, "events.jsonl"), "a").write("\\n")',
  (ctx) => ({ logParses: (() => { try { ctx.store.readEvents(); return true; } catch { return false; } })() }));
