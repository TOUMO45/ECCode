#!/usr/bin/env node
// Probe (learning-debugger, 2026-10-09): feeds PreToolUse JSON to the INSTALLED guard
// (~/.claude/eccode/scripts/hooks/guard.js) for every example project under examples/ that has its
// own record, with the hook cwd and CLAUDE_PROJECT_DIR both set to the repository root (the outer
// record). Expectation: reviewer and author roles may write their own draft/artifact areas of the
// NESTED record (Write tool, relative and absolute paths; Bash redirects with quoted paths), and are
// denied every record file of the nested record. Nothing is executed: the guard only judges JSON.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const GUARD = path.join(os.homedir(), '.claude', 'eccode', 'scripts', 'hooks', 'guard.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

console.log(`repo root (hook cwd and CLAUDE_PROJECT_DIR): ${REPO}`);
console.log(`installed guard: ${GUARD} sha256 ${sha(GUARD)}`);
console.log(`repo guard:      scripts/hooks/guard.js sha256 ${sha(path.join(REPO, 'scripts/hooks/guard.js'))}`);
console.log(`node ${process.version}`);

const examples = fs
  .readdirSync(path.join(REPO, 'examples'))
  .filter((d) => fs.existsSync(path.join(REPO, 'examples', d, '.eccode', 'events.jsonl')))
  .sort();
console.log(`example projects with their own record: ${examples.join(', ')}`);

const REVIEWERS = ['architecture-reviewer', 'technical-reviewer', 'security-reviewer'];
const AUTHORS = ['product-architect', 'technical-designer', 'delivery-lead'];
const RECORD_FILES = ['state.json', 'events.jsonl', 'config.json', 'memory/records/probe.json', 'handoffs/probe.json', 'evidence/probe.json', 'reviews/probe.json'];

function guard(input) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO };
  delete env.ECCODE_HOOKS;
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO, env, input: JSON.stringify({ cwd: REPO, hook_event_name: 'PreToolUse', ...input }), encoding: 'utf8' });
  let decision = 'allow';
  let reason = '';
  if (r.stdout.trim()) {
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    decision = o.permissionDecision;
    reason = o.permissionDecisionReason;
  }
  return { decision, reason, status: r.status, stderr: r.stderr.trim() };
}

// Forms of one write to `rel` (path relative to the repository root).
function forms(rel) {
  const abs = path.join(REPO, rel);
  return [
    ['Write rel', { tool_name: 'Write', tool_input: { file_path: rel, content: '{}' } }],
    ['Write abs', { tool_name: 'Write', tool_input: { file_path: abs, content: '{}' } }],
    ['Bash > "rel"', { tool_name: 'Bash', tool_input: { command: `echo '{}' > "${rel}"` } }],
    ["Bash >> 'abs'", { tool_name: 'Bash', tool_input: { command: `printf '%s\\n' x >> '${abs}'` } }],
  ];
}

const summary = {};
let failures = 0;
let total = 0;
function expect(project, role, rel, want) {
  for (const [form, input] of forms(rel)) {
    total++;
    const r = guard({ ...input, agent_type: role });
    const ok = r.decision === want && r.status === 0 && !/internal error/.test(r.stderr);
    const s = (summary[project] ||= { pass: 0, fail: 0 });
    ok ? s.pass++ : s.fail++;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} [${project}] ${role} ${form} ${rel} -> ${r.decision} (want ${want})${r.reason && (!ok || want === 'deny') ? ` :: ${r.reason}` : ''}${r.stderr ? ` stderr: ${r.stderr}` : ''}`);
  }
}

for (const ex of examples) {
  const rec = `examples/${ex}/.eccode`;
  console.log(`\n=== ${ex} (drafts dir exists: ${fs.existsSync(path.join(REPO, rec, 'drafts'))}, artifacts: ${fs.existsSync(path.join(REPO, rec, 'artifacts'))}, reviews/drafts: ${fs.existsSync(path.join(REPO, rec, 'reviews/drafts'))})`);
  for (const role of REVIEWERS) {
    expect(ex, role, `${rec}/reviews/drafts/probe-${role}.json`, 'allow');
    expect(ex, role, `${rec}/drafts/probe-${role}.json`, 'allow');
    expect(ex, role, `${rec}/artifacts/probe-${role}.md`, 'deny'); // contrast: not a reviewer area
    for (const f of RECORD_FILES) expect(ex, role, `${rec}/${f}`, 'deny');
  }
  for (const role of AUTHORS) {
    expect(ex, role, `${rec}/artifacts/probe-${role}.md`, 'allow');
    expect(ex, role, `${rec}/drafts/probe-${role}.md`, 'allow');
    expect(ex, role, `${rec}/reviews/drafts/probe-${role}.json`, 'deny'); // contrast: not an author area
    for (const f of RECORD_FILES) expect(ex, role, `${rec}/${f}`, 'deny');
  }
}

console.log('\n=== summary per example project');
for (const ex of examples) console.log(`${ex}: ${summary[ex].pass} pass, ${summary[ex].fail} fail`);
console.log(`total ${total}, failures ${failures}`);
process.exit(failures ? 1 : 0);
