'use strict';
// Review probe 3: the guard through its hook interface, new (cde0b84) vs old (5da8913, copied to scripts/hooks/guard-old.js
// for the run and deleted afterwards). Each case is run in three configurations:
//   old        : parent commit, this platform (linux)
//   new        : cde0b84, this platform (linux)
//   new/win32  : cde0b84 with ECCODE_TEST=1 ECCODE_GUARD_PLATFORM=win32 (the tokenizer's win32 branch; path.resolve stays posix
//                here, so for `..`-style targets the win32 resolution is also computed with path.win32 by probe-tokenizer.js)
// Run: node docs/evidence/verification-0.3.0/guard-win32-review/probe-hook.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..', '..');
const { tmpProject, write } = require(path.join(ROOT, 'tests', 'helpers'));
const NEW = path.join(ROOT, 'scripts', 'hooks', 'guard.js');
const OLD = path.join(ROOT, 'scripts', 'hooks', 'guard-old.js');

function hook(guard, payload, env = {}) {
  const res = spawnSync(process.execPath, [guard], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ECCODE_TEST: '', ECCODE_GUARD_PLATFORM: '', ...env },
  });
  if (res.status !== 0 || res.stderr.trim()) return `ERROR ${res.stderr.trim()}`;
  if (!res.stdout) return 'allow';
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return `${o.permissionDecision}: ${o.permissionDecisionReason.slice(0, 90)}`;
}
const ctx = tmpProject();
write(ctx.dir, 'src/server.js', 'module.exports = {};\n');
const bash = (guard, command, role, env) => hook(guard, { cwd: ctx.dir, tool_name: 'Bash', ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: { command } }, env);

const cases = [
  // [label, command, role, expectation-by-the-reviewer]
  ['win path memory write (CI 133 shape)', 'echo "{}" > C:\\Users\\me\\.eccode\\memory\\records\\mem-sd-x.json', null, 'deny'],
  ['win path memory write, reviewer', 'echo "{}" > C:\\Users\\me\\.eccode\\memory\\records\\mem-sd-x.json', 'technical-reviewer', 'deny'],
  ['cd then absolute win path outside (CI 131 shape)', 'cd /tmp && echo x > C:\\Users\\me\\eccode-outside-ab\\notes.txt', 'technical-reviewer', 'allow'],
  ['doubled separator', 'echo x > .eccode\\\\state.json', 'technical-reviewer', 'deny'],
  ['doubled separator, main', 'echo x > .eccode\\\\state.json', null, 'deny'],
  ['dot segment, reviewer', 'echo x > .eccode/./state.json', 'technical-reviewer', 'deny'],
  ['dot segment, main', 'echo x > .eccode/./state.json', null, 'deny (pre-existing gap expected)'],
  ['drafts/.. to record, reviewer', 'echo x > .eccode/drafts/../state.json', 'technical-reviewer', 'deny'],
  ['drafts/.. to record, main', 'echo x > .eccode/drafts/../state.json', null, 'deny (pre-existing gap expected)'],
  ['drafts/.\\. to record (Git Bash reads .\\. as ..), reviewer', 'echo x > .eccode/drafts/.\\./state.json', 'technical-reviewer', 'deny'],
  ['drafts/.\\. to record, backend-engineer', 'echo x > .eccode/drafts/.\\./state.json', 'backend-engineer', 'deny'],
  ['drafts/.\\./.\\. to src/server.js, reviewer', 'echo x > .eccode/drafts/.\\./.\\./src/server.js', 'technical-reviewer', 'deny'],
  ['$HOME win path', 'echo x > $HOME\\.eccode\\memory\\records\\x.json', 'learning-debugger', 'deny'],
  ['%USERPROFILE% win path', 'echo x > %USERPROFILE%\\.eccode\\memory\\records\\x.json', 'learning-debugger', 'deny'],
  ['quoted path with space', 'echo x > "C:\\Users\\me dir\\.eccode\\memory\\records\\x.json"', 'learning-debugger', 'deny'],
  ['UNC path', 'echo x > \\\\server\\share\\.eccode\\state.json', 'learning-debugger', 'deny'],
  ['uppercase .ECCODE outside (same file on NTFS/APFS)', 'echo x > ~/.ECCODE/memory/records/x.json', 'learning-debugger', 'deny on case-insensitive FS (pre-existing gap expected)'],
  ['uppercase .ECCODE in project, main', 'echo x > .ECCODE/state.json', null, 'deny on case-insensitive FS (pre-existing gap expected)'],
  ['rm -rf .eccode, main', 'rm -rf .eccode', null, 'deny (pre-existing gap expected)'],
  ['rm -rf .eccode/memory, main', 'rm -rf .eccode/memory', null, 'deny (pre-existing gap expected)'],
  ['eccode.cmd shim --actor user', 'eccode.cmd gate reopen design --actor user --resolution ok', null, 'deny (pre-existing gap expected)'],
  ['eccode.cmd identity mismatch', 'eccode.cmd task complete api --actor backend-engineer --handoff h.json', 'technical-reviewer', 'deny (pre-existing gap expected)'],
  ['win path eccode.js --actor user', 'node C:\\proj\\.claude\\eccode\\bin\\eccode.js gate reopen design --actor user --resolution ok', null, 'deny'],
  ['escaped blank target in project', 'echo x > src/ser\\ ver.js', 'technical-reviewer', 'deny'],
  ['escaped $ not dynamic', 'echo \\$x > .eccode/drafts/a.txt', 'technical-reviewer', 'allow'],
  ['inline ECCODE_TEST=1', 'ECCODE_TEST=1 eccode gate reopen design --actor user --resolution ok', null, 'deny'],
  ['inline ECCODE_TEST=1 with override', 'ECCODE_TEST=1 ECCODE_GUARD_PLATFORM=linux eccode gate start design --actor orchestrator', null, 'deny'],
  ['reading a record', 'cat C:\\Users\\me\\.eccode\\memory\\records\\x.json', 'learning-debugger', 'allow'],
  ['draft with backslash', 'echo x > .eccode\\drafts\\a.json', 'technical-reviewer', 'allow'],
];
const WIN = { ECCODE_TEST: '1', ECCODE_GUARD_PLATFORM: 'win32' };
const NOTEST = { ECCODE_TEST: '', ECCODE_GUARD_PLATFORM: 'win32' };
for (const [label, cmd, role, want] of cases) {
  console.log(`\n# ${label}  [${role || 'main'}]  want: ${want}\n  $ ${cmd}`);
  console.log(`  old        : ${bash(OLD, cmd, role, {})}`);
  console.log(`  new        : ${bash(NEW, cmd, role, {})}`);
  console.log(`  new/win32  : ${bash(NEW, cmd, role, WIN)}`);
}
console.log('\n# platform override without ECCODE_TEST=1 must be ignored (target would read as relative + cd => deny if win32 were honoured... no: on linux a bare C:\\ path tokenizes to C:Users..., which path.posix treats as relative; with a cd that is a deny)');
const probe = 'cd /tmp && echo x > C:\\Users\\me\\notes.txt';
console.log(`  $ ${probe}  [technical-reviewer]`);
console.log(`  new, ECCODE_GUARD_PLATFORM=win32, ECCODE_TEST unset : ${bash(NEW, probe, 'technical-reviewer', NOTEST)}   (expected: deny = linux reading, override ignored)`);
console.log(`  new, ECCODE_GUARD_PLATFORM=win32, ECCODE_TEST=1     : ${bash(NEW, probe, 'technical-reviewer', WIN)}   (expected: allow = win32 reading)`);
console.log(`  new, ECCODE_GUARD_PLATFORM=linux, ECCODE_TEST=1     : ${bash(NEW, probe, 'technical-reviewer', { ECCODE_TEST: '1', ECCODE_GUARD_PLATFORM: 'linux' })}   (expected: deny)`);
