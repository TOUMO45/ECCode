'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F4-reviewer-shell-write: does scripts/hooks/guard.js deny a REVIEWER's
// shell-based writes to project source files the way it denies Write/Edit?
// The hook is fed PreToolUse payloads on stdin; nothing is actually executed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, write } = require(REPO + '/tests/helpers.js');

const GUARD = REPO + '/scripts/hooks/guard.js';

function hook(payload) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '' },
  });
  if (res.status !== 0) throw new Error(`guard exited ${res.status}: ${res.stderr}`);
  if (res.stderr && res.stderr.trim()) return { decision: 'ERROR', reason: res.stderr.trim() };
  if (!res.stdout) return { decision: 'none', reason: null };
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

const ctx = tmpProject();
try {
  // A real source file so the path exists (realRel resolves it); content irrelevant.
  write(ctx.dir, 'src/server.js', 'module.exports = {};\n');

  const shellCases = [
    { id: 2, label: 'echo redirect', command: 'echo changed > src/server.js' },
    { id: 3, label: 'sed -i', command: 'sed -i s/a/b/ src/server.js' },
    { id: 4, label: 'cp', command: 'cp /tmp/x src/server.js' },
    { id: 5, label: 'node -e writeFileSync', command: `node -e "require('fs').writeFileSync('src/server.js','x')"` },
    { id: 6, label: 'python3 open(w)', command: `python3 -c "open('src/server.js','w').write('x')"` },
  ];

  const results = [];
  for (const role of ['technical-reviewer', 'security-reviewer']) {
    const agent_type = `eccode:${role}`;
    // (1) Direct Write tool: the control case, expected deny.
    const w = hook({ cwd: ctx.dir, tool_name: 'Write', agent_type, tool_input: { file_path: 'src/server.js' } });
    results.push({ id: 1, role, tool: 'Write', target: 'src/server.js', decision: w.decision, reason: w.reason });
    for (const c of shellCases) {
      const r = hook({ cwd: ctx.dir, tool_name: 'Bash', agent_type, tool_input: { command: c.command } });
      results.push({ id: c.id, role, tool: 'Bash', label: c.label, command: c.command, decision: r.decision, reason: r.reason });
    }
  }

  // Sanity: the same shell commands from an implementer WITHOUT a claimed task are denied
  // (shows the ownership path works for implementers and is simply skipped for reviewers).
  const implControl = hook({ cwd: ctx.dir, tool_name: 'Bash', agent_type: 'eccode:backend-engineer', tool_input: { command: 'echo changed > src/server.js' } });

  for (const r of results) {
    console.log(`[${r.role}] #${r.id} ${r.tool}${r.label ? ' ' + r.label : ''}: ${r.decision}${r.reason ? ' -- ' + r.reason : ''}`);
  }
  console.log(`[backend-engineer, no claim] #2 Bash echo redirect: ${implControl.decision} -- ${implControl.reason}`);

  const writeDenied = results.filter((r) => r.tool === 'Write').every((r) => r.decision === 'deny');
  const bashUnchecked = results.filter((r) => r.tool === 'Bash' && r.decision === 'none');
  const bashDenied = results.filter((r) => r.tool === 'Bash' && r.decision === 'deny');
  const reproduces = writeDenied && bashUnchecked.length > 0;

  console.log(JSON.stringify({
    reproduces,
    writeToolDeniedForReviewers: writeDenied,
    bashNoDecision: bashUnchecked.map((r) => `${r.role}: ${r.command}`),
    bashDenied: bashDenied.map((r) => `${r.role}: ${r.command} (${r.reason})`),
    implementerControl: implControl.decision,
    decisionPoint: 'scripts/hooks/guard.js:250 checkBash() -- `if (role && IMPLEMENTERS.has(role))` gates bashWriteTargets()/checkEdit(); reviewers skip it',
  }));
} finally {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}
