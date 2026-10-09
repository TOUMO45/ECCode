'use strict';
// Review F9 / F4 follow-up (Windows CI job on 5da8913, 2 of 233 failed): the guard read command
// lines with POSIX escaping only, so a native Windows path lost its backslashes
// (C:\Users\me\.eccode\memory\records\x.json became C:Usersme.eccodememoryrecordsx.json):
// a shell write to a shared-memory record was not denied (fail-open) and an absolute path after
// a cd was denied as "relative" (false positive). Windows itself is not run here; these tests
// pin the three platform-independent repairs and the tokenizer's win32 branch under an override.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
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
const bash = (dir, command, role, env = {}) => hook({ cwd: dir, tool_name: 'Bash', ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: { command } }, env);
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
    denied(bash(ctx.dir, `echo "{}" > ${memory}`, role), `${role || 'main'} redirect`, reason);
    denied(bash(ctx.dir, `cp fake.json ${memory}`, role), `${role || 'main'} cp`, reason);
    denied(bash(ctx.dir, `sed -i s/provisional/verified/ ${memory}`, role), `${role || 'main'} sed -i`, reason);
    denied(bash(ctx.dir, `rm ${other}`, role), `${role || 'main'} rm another record`, reason);
    denied(bash(ctx.dir, `node -e "require('fs').writeFileSync('${memory.replace(/\\/g, '\\\\')}','{}')"`, role), `${role || 'main'} inline write`, reason);
  }
  // Review drafts stay the reviewers' scratch area with either separator.
  allowed(bash(ctx.dir, 'echo x > .eccode/reviews/drafts/a.json', 'technical-reviewer'), 'draft, posix');
  allowed(bash(ctx.dir, 'cat C:\\Users\\me\\.eccode\\memory\\records\\mem-sd-x.json', 'learning-debugger'), 'reading a record');
});

test('F9/win32: the tokenizer keeps backslashes that separate path segments only under win32; POSIX escapes are unchanged', () => {
  const guard = require(GUARD);
  const words = (src) => guard.splitCommands(src).map((ws) => ws.map((w) => w.text));
  guard.__setPlatform('linux');
  assert.deepStrictEqual(words('echo x > C:\\Users\\me\\notes.txt'), [['echo', 'x', '>', 'C:Usersmenotes.txt']]);
  assert.deepStrictEqual(words('echo a\\ b'), [['echo', 'a b']]);
  guard.__setPlatform('win32');
  assert.deepStrictEqual(words('echo x > C:\\Users\\me\\notes.txt'), [['echo', 'x', '>', 'C:\\Users\\me\\notes.txt']]);
  assert.deepStrictEqual(words('echo x > C:\\Users\\me\\.eccode\\state.json'), [['echo', 'x', '>', 'C:\\Users\\me\\.eccode\\state.json']]);
  assert.deepStrictEqual(words('echo a\\ b'), [['echo', 'a b']], 'an escaped blank is still an escape');
  assert.deepStrictEqual(words('echo "C:\\Users\\me"'), [['echo', 'C:\\Users\\me']], 'double quotes keep the backslash as bash does');
  assert.deepStrictEqual(words("echo 'C:\\x'"), [['echo', 'C:\\x']]);
  assert.deepStrictEqual(words('a \\\\ b'), [['a', '\\', 'b']], 'a doubled backslash is one literal backslash');
  guard.__setPlatform(process.platform);
});

test('F9/win32: an eccode invocation by its Windows path is still bound to its --actor', () => {
  const guard = require(GUARD);
  guard.__setPlatform('win32');
  assert.ok(guard.ECCODE_WORD.test('C:\\proj\\.claude\\eccode\\bin\\eccode.js'));
  assert.ok(guard.ECCODE_WORD.test('bin/eccode.js'));
  assert.ok(!guard.ECCODE_WORD.test('myeccode.js'), 'a different program is not the CLI');
  const { actors } = guard.eccodeActors('node C:\\proj\\.claude\\eccode\\bin\\eccode.js gate reopen design --actor user --resolution ok');
  assert.deepStrictEqual(actors, ['user']);
  guard.__setPlatform(process.platform);
  // Through the hook, with the platform override that only the test switch enables.
  const ctx = tmpProject();
  write(ctx.dir, 'src/server.js', '');
  const env = { ECCODE_TEST: '1', ECCODE_GUARD_PLATFORM: 'win32' };
  denied(bash(ctx.dir, 'node C:\\proj\\.claude\\eccode\\bin\\eccode.js gate reopen design --actor user --resolution ok', null, env), 'main session --actor user by Windows path', /reserved for a person at a terminal/);
  denied(bash(ctx.dir, 'node C:\\proj\\bin\\eccode.js task complete api --actor backend-engineer --handoff h.json', 'technical-reviewer', env), 'identity mismatch by Windows path', /Identity mismatch/);
  // Without the test switch the override is ignored (an agent cannot change how its commands are read).
  const plain = hook({ cwd: ctx.dir, tool_name: 'Bash', tool_input: { command: 'echo x > C:\\Users\\me\\notes.txt' } }, { ECCODE_GUARD_PLATFORM: 'win32', ECCODE_TEST: '' });
  assert.strictEqual(plain, null);
});

test('F9/win32: RECORD_FILES matches record paths with either separator and nothing else', () => {
  const { RECORD_FILES } = require(GUARD);
  for (const p of ['.eccode/state.json', 'x/.eccode\\events.jsonl', 'C:\\h\\.eccode\\memory\\records\\m.json', '/h/.eccode/reviews/rev-1.json']) assert.ok(RECORD_FILES.test(p), p);
  for (const p of ['.eccode/reviews/drafts/a.json', '.eccode\\reviews\\drafts\\a.json', '.eccode/drafts/x', 'src/eccode/state.json', 'my.eccode/state.json']) assert.ok(!RECORD_FILES.test(p), p);
});
