'use strict';
// Review F9 / F4 follow-up (Windows CI job on 5da8913, 2 of 233 failed): the guard's record patterns
// and CLI word pattern accepted only "/" separators, so a native Windows path in a command
// (C:\Users\me\.eccode\memory\records\x.json, or the CLI at C:\proj\bin\eccode.js) was neither a
// record write nor an eccode invocation to the guard. Repairs pinned here, all platform-independent:
//   - record and memory patterns accept both separators (and repeated ones) and are applied to the
//     raw command before any tokenizing, so the denial does not depend on how the shell reads it;
//   - the CLI is recognised by its Windows path, so --actor stays bound when the path is quoted.
// The tokenizer itself keeps POSIX semantics on every platform (an unquoted backslash is an escape,
// as in Git Bash behind the Bash tool on Windows); a first version that kept backslashes was
// rejected in review because `.eccode/drafts/.\./state.json` then read as a draft while bash writes
// the record. Windows itself is not run here; the CI job is the confirmation.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, write } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stderr.trim(), '', `guard reported an error: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const bash = (dir, command, role) => hook({ cwd: dir, tool_name: 'Bash', ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: { command } });
const denied = (out, label, re) => {
  assert.ok(out && out.permissionDecision === 'deny', `${label} should be denied, got ${JSON.stringify(out)}`);
  if (re) assert.match(out.permissionDecisionReason, re, label);
};
const allowed = (out, label) => assert.strictEqual(out, null, `${label} should be allowed, got ${JSON.stringify(out)}`);

test('F9/win32: record and memory files named with backslashes are denied on every platform, before any tokenizing', () => {
  const ctx = tmpProject();
  const memory = 'C:\\Users\\me\\.eccode\\memory\\records\\mem-sd-x.json';
  const other = 'C:\\Users\\me\\other-project\\.eccode\\state.json';
  const reason = /written only by the eccode CLI/;
  for (const role of [null, 'learning-debugger', 'technical-reviewer', 'backend-engineer']) {
    for (const target of [memory, `"${memory}"`, other]) {
      denied(bash(ctx.dir, `echo "{}" > ${target}`, role), `${role || 'main'} redirect ${target}`, reason);
      denied(bash(ctx.dir, `cp fake.json ${target}`, role), `${role || 'main'} cp ${target}`, reason);
      denied(bash(ctx.dir, `sed -i s/provisional/verified/ ${target}`, role), `${role || 'main'} sed -i ${target}`, reason);
    }
    denied(bash(ctx.dir, `rm ${other}`, role), `${role || 'main'} rm another record`, reason);
    denied(bash(ctx.dir, `node -e "require('fs').writeFileSync('${memory.replace(/\\/g, '\\\\')}','{}')"`, role), `${role || 'main'} inline write`, reason);
  }
  // Review drafts stay the reviewers' scratch area with either separator; reading a record is fine.
  allowed(bash(ctx.dir, 'echo x > .eccode/reviews/drafts/a.json', 'technical-reviewer'), 'draft, posix');
  allowed(bash(ctx.dir, 'cat C:\\Users\\me\\.eccode\\memory\\records\\mem-sd-x.json', 'learning-debugger'), 'reading a record');
  // The review's rejected variant: a dot-backslash-dot segment inside a draft path. Bash reads it as
  // `..`, so the write lands on the record; the guard must keep reading it the same way.
  denied(bash(ctx.dir, 'echo x > .eccode/drafts/.\\./state.json', 'technical-reviewer'), 'drafts/.\\. to the record', /part of the ECCode record|written only by the eccode CLI/);
  denied(bash(ctx.dir, 'echo x > .eccode/drafts/.\\./.\\./src/server.js', 'technical-reviewer'), 'drafts/.\\./.\\. to a project file', /does not edit project files/);
});

test('F9/win32: the tokenizer keeps POSIX (Git Bash) semantics on every platform', () => {
  const guard = require(GUARD);
  const words = (src) => guard.splitCommands(src).map((ws) => ws.map((w) => w.text));
  assert.deepStrictEqual(words('echo x > C:\\Users\\me\\notes.txt'), [['echo', 'x', '>', 'C:Usersmenotes.txt']], 'unquoted backslashes are escapes, as bash reads them');
  assert.deepStrictEqual(words('echo x > "C:\\Users\\me\\notes.txt"'), [['echo', 'x', '>', 'C:\\Users\\me\\notes.txt']], 'double quotes keep them');
  assert.deepStrictEqual(words("echo x > 'C:\\Users\\me\\notes.txt'"), [['echo', 'x', '>', 'C:\\Users\\me\\notes.txt']], 'single quotes keep them');
  assert.deepStrictEqual(words('echo a\\ b'), [['echo', 'a b']]);
  assert.deepStrictEqual(words('a \\\\ b'), [['a', '\\', 'b']]);
  assert.deepStrictEqual(words('echo .\\./x'), [['echo', '../x']], 'dot-backslash-dot is dot-dot');
});

test('F9/win32: an eccode invocation by its quoted Windows path is still bound to its --actor', () => {
  const guard = require(GUARD);
  assert.ok(guard.ECCODE_WORD.test('C:\\proj\\.claude\\eccode\\bin\\eccode.js'));
  assert.ok(guard.ECCODE_WORD.test('bin/eccode.js'));
  assert.ok(!guard.ECCODE_WORD.test('myeccode.js'), 'a different program is not the CLI');
  const { actors } = guard.eccodeActors('node "C:\\proj\\.claude\\eccode\\bin\\eccode.js" gate reopen design --actor user --resolution ok');
  assert.deepStrictEqual(actors, ['user']);
  const ctx = tmpProject();
  write(ctx.dir, 'src/server.js', '');
  denied(bash(ctx.dir, 'node "C:\\proj\\.claude\\eccode\\bin\\eccode.js" gate reopen design --actor user --resolution ok', null), 'main session --actor user by quoted Windows path', /reserved for a person at a terminal/);
  denied(bash(ctx.dir, 'node "C:\\proj\\bin\\eccode.js" task complete api --actor backend-engineer --handoff h.json', 'technical-reviewer'), 'identity mismatch by quoted Windows path', /Identity mismatch/);
  // Unquoted, bash would run C:projbineccode.js, which does not exist: nothing to bind, nothing runs.
  allowed(bash(ctx.dir, 'node C:\\proj\\bin\\eccode.js status --brief', 'technical-reviewer'), 'unquoted path is not an invocation');
});

test('F9/win32: RECORD_FILES matches record paths with either separator and nothing else', () => {
  const { RECORD_FILES } = require(GUARD);
  for (const p of ['.eccode/state.json', 'x/.eccode\\events.jsonl', 'C:\\h\\.eccode\\memory\\records\\m.json', '/h/.eccode/reviews/rev-1.json', '.eccode\\\\state.json']) assert.ok(RECORD_FILES.test(p), p);
  for (const p of ['.eccode/reviews/drafts/a.json', '.eccode\\reviews\\drafts\\a.json', '.eccode/drafts/x', 'src/eccode/state.json', 'my.eccode/state.json']) assert.ok(!RECORD_FILES.test(p), p);
});
