'use strict';
// Guard repairs from the independent adversarial verification of 0.3.0
// (docs/evidence/verification-0.3.0/REPORT.md) and the RescueStock pilot:
//   NEW-6  `>|` (clobber redirect) was split at the `|`, so the redirect had no target and every
//          role could write any file with it.
//   NEW-9  ECCODE_SHARED_MEMORY (and ECCODE_ROOT, ECCODE_SEQUENTIAL_ROLES, ECCODE_HOOKS) could be
//          set inline on an eccode command, pointing memory or the record elsewhere.
//   NEW-7  a shell function or alias defined in the same line hid the CLI from actor binding.
//   NESTED the project root was taken from the harness's project directory, so a project nested
//          in a repository that has its own record (examples/<app>/.eccode) was judged by the outer
//          record: its reviewers could not write their own draft area (found in the pilot).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, write, initRepo } = require('./helpers');
const { init } = require('../lib/project');

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
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const bash = (dir, command, role, env = {}) => hook({ cwd: dir, tool_name: 'Bash', ...agentOf(role), tool_input: { command } }, env);
const edit = (dir, tool, file, role, env = {}) => hook({ cwd: dir, tool_name: tool, ...agentOf(role), tool_input: { file_path: file } }, env);
const denied = (out, label, re) => {
  assert.ok(out && out.permissionDecision === 'deny', `${label} should be denied, got ${JSON.stringify(out)}`);
  if (re) assert.match(out.permissionDecisionReason, re, label);
};
const allowed = (out, label) => assert.strictEqual(out, null, `${label} should be allowed, got ${JSON.stringify(out)}`);

test('NEW-6: the clobber redirect >| is a redirect with a target, for every role and both spellings', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'src/server.js', 'module.exports = {};\n');
  for (const cmd of ['echo x >| src/server.js', 'echo x 1>| src/server.js', 'cat a >| src/server.js', 'printf y >>| src/server.js']) {
    denied(bash(ctx.dir, cmd, 'technical-reviewer'), `reviewer: ${cmd}`, /does not edit project files/);
    denied(bash(ctx.dir, cmd, 'backend-engineer'), `implementer without a claim: ${cmd}`, /no claimed task|does not edit|outside/);
  }
  denied(bash(ctx.dir, 'echo x >| .eccode/state.json', 'backend-engineer'), 'clobber onto the record', /written only by the eccode CLI|part of the ECCode record/);
  // A pipe is still a pipe.
  allowed(bash(ctx.dir, 'cat src/server.js | grep exports', 'technical-reviewer'), 'plain pipe');
  allowed(bash(ctx.dir, 'echo x >| .eccode/reviews/drafts/r.json', 'technical-reviewer'), 'clobber into the draft area');
});

test('NEW-9: ECCODE_SHARED_MEMORY, ECCODE_ROOT, ECCODE_SEQUENTIAL_ROLES and ECCODE_HOOKS cannot be set inline on an eccode command', () => {
  const ctx = tmpProject();
  const reason = /may not be set inline/;
  denied(bash(ctx.dir, 'ECCODE_SHARED_MEMORY=/tmp/forged eccode memory search race --actor learning-debugger', 'learning-debugger'), 'shared memory redirect', reason);
  denied(bash(ctx.dir, 'ECCODE_ROOT=/tmp/other eccode gate start design --actor orchestrator', null), 'root redirect from the main session', reason);
  denied(bash(ctx.dir, 'ECCODE_SEQUENTIAL_ROLES=1 eccode task claim api --actor backend-engineer', null), 'sequential switch inline', reason);
  denied(bash(ctx.dir, 'ECCODE_HOOKS=off eccode task claim api --actor backend-engineer', 'technical-reviewer'), 'hooks switch inline', reason);
  denied(bash(ctx.dir, 'env ECCODE_SHARED_MEMORY=/tmp/x node bin/eccode.js memory promote m-1 --actor learning-debugger', 'learning-debugger'), 'through env', reason);
  allowed(bash(ctx.dir, 'eccode memory search race --actor learning-debugger', 'learning-debugger'), 'the same command without the variable');
  // As for ECCODE_ACTOR before it, the variable is refused inline on any command (a script could
  // reach the engine); exporting it belongs to the user's environment, not to an agent's command.
  denied(bash(ctx.dir, 'ECCODE_SHARED_MEMORY=/tmp/x ls', 'learning-debugger'), 'the variable on a command that is not the CLI', reason);
});

test('NEW-7: a shell function or alias defined around the CLI in the same line is refused', () => {
  const ctx = tmpProject();
  const reason = /shell function or alias/;
  denied(bash(ctx.dir, 'e() { eccode "$@"; }; e gate reopen design --actor user --resolution ok', null), 'function hides --actor user', reason);
  denied(bash(ctx.dir, 'e() { eccode "$@"; }; e task claim api --actor backend-engineer', 'technical-reviewer'), 'function hides role impersonation', reason);
  denied(bash(ctx.dir, 'function run { node bin/eccode.js "$@"; }; run task claim api --actor backend-engineer', 'technical-reviewer'), 'function keyword', reason);
  denied(bash(ctx.dir, 'alias e=eccode; e task claim api --actor backend-engineer', 'technical-reviewer'), 'alias', reason);
  allowed(bash(ctx.dir, 'f() { echo hi; }; f', 'technical-reviewer'), 'a function that has nothing to do with the CLI');
  allowed(bash(ctx.dir, 'eccode status --brief', 'technical-reviewer'), 'plain call');
});

test('REVIEW: a record planted inside a record never re-roots the guard; the record directory itself is the CLI\'s', () => {
  const ctx = tmpProject();
  const reason = /written only by the eccode CLI|part of an ECCode record|part of the ECCode record/;
  // Planting through the CLI is refused by the engine; planting by copy is refused by the guard.
  assert.throws(() => init(path.join(ctx.dir, '.eccode'), { name: 'x', idea: 'y' }), /inside an ECCode record directory/);
  denied(bash(ctx.dir, 'cp -r .eccode .eccode/.eccode', null), 'main copies the record into itself', reason);
  denied(bash(ctx.dir, 'rsync -a forged/ .eccode/', null), 'main rsync into the record', reason);
  denied(bash(ctx.dir, 'cp -r forged/. .eccode', null), 'main cp -r into the record', reason);
  denied(bash(ctx.dir, 'rm -rf .eccode', 'backend-engineer'), 'rm -rf the record', reason);
  denied(bash(ctx.dir, 'tar -xf x.tar -C .eccode/', null), 'tar into the record', reason);
  // Even with a planted record (made outside the guard), the outer record files stay the CLI's.
  const planted = path.join(ctx.dir, '.eccode', '.eccode');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'events.jsonl'), '');
  for (const rel of ['.eccode/state.json', '.eccode/events.jsonl', '.eccode/config.json', '.eccode/reviews/rev-1.json', '.eccode/memory/records/m.json', '.eccode/evidence/ev-1.log']) {
    denied(edit(ctx.dir, 'Write', path.join(ctx.dir, rel), null), `main Write ${rel} with a planted record`, reason);
    denied(bash(ctx.dir, `echo x > ${rel}`, null), `main redirect ${rel} with a planted record`, reason);
    denied(bash(ctx.dir, `echo x >| ${rel}`, null), `main clobber ${rel} with a planted record`, reason);
  }
  allowed(edit(ctx.dir, 'Write', path.join(ctx.dir, '.eccode', 'drafts', 'note.md'), 'technical-reviewer'), 'a draft stays a draft');
  denied(bash(ctx.dir, 'echo x >| .eccode/events.jsonl', null), 'main clobber onto the log without a planted record', reason);
});

test('REVIEW: the CLI is recognised on tokenized words, wrappers in every bash form and depth, computed variable names', () => {
  const ctx = tmpProject();
  // Quoting tricks that hide the word "eccode" from the raw text.
  denied(bash(ctx.dir, 'node bin/ecc"ode".js task claim api --actor backend-engineer', 'technical-reviewer'), 'quoted CLI name, impersonation', /Identity mismatch/);
  denied(bash(ctx.dir, "node bin/ecc'ode'.js gate reopen design --actor user --resolution ok", null), 'quoted CLI name, --actor user', /reserved for a person/);
  // Wrapper forms the first regex missed.
  const wrap = /shell function or alias/;
  for (const c of [
    'function e() { eccode "$@"; }; e task claim api --actor backend-engineer',
    'function e () { eccode "$@"; }; e task claim api --actor backend-engineer',
    'e() ( eccode "$@" ); e task claim api --actor backend-engineer',
    'e() if true; then eccode "$@"; fi; e task claim api --actor backend-engineer',
    '  e() { eccode "$@"; }; e task claim api --actor backend-engineer',
    'if true; then e() { eccode "$@"; }; fi; e task claim api --actor backend-engineer',
    '{ e() { eccode "$@"; }; }; e task claim api --actor backend-engineer',
    'bash -c \'e() { eccode "$@"; }; e task claim api --actor backend-engineer\'',
    'sh -c "e() { eccode \\"\\$@\\"; }; e task claim api --actor backend-engineer"',
    'e() {\n  eccode "$@"\n}\ne task claim api --actor backend-engineer',
    'eccode evidence run --actor technical-reviewer --label t -- \'e() { eccode "$@"; }; e task claim api --actor backend-engineer\'',
  ]) denied(bash(ctx.dir, c, 'technical-reviewer'), `wrapper: ${c.slice(0, 40)}`, wrap);
  // Computed variable names.
  denied(bash(ctx.dir, 'V=ECCODE_SHARED_MEMORY; export $V=/tmp/x; eccode memory search race --actor learning-debugger', 'learning-debugger'), 'computed export', /computed name|may not be set inline/);
  denied(bash(ctx.dir, 'N=ECCODE_ACTOR; declare "$N"=user; eccode gate reopen design --resolution ok', null), 'computed declare', /computed name|may not be set inline/);
  // No false positives: a function unrelated to the CLI, with the CLI only in a comment.
  allowed(bash(ctx.dir, 'f() { echo hi; }; f # see the eccode docs', 'technical-reviewer'), 'function with the CLI in a comment');
  allowed(bash(ctx.dir, 'eccode status --brief', null), 'plain');
  allowed(bash(ctx.dir, 'npm test && eccode evidence list --json', 'technical-reviewer'), 'plain with &&');
});

test('NESTED: a project nested in a repository with its own record is judged by its own record', () => {
  // outer: a repository with its own ECCode record; inner: examples/app with another record.
  const outer = tmpProject();
  const inner = path.join(outer.dir, 'examples', 'app');
  fs.mkdirSync(inner, { recursive: true });
  init(inner, { name: 'App', idea: 'nested app' });
  const draft = path.join(inner, '.eccode', 'reviews', 'drafts', 'architecture-1.json');
  const env = { CLAUDE_PROJECT_DIR: outer.dir };
  // The reviewer of the inner project writes its own draft area (was denied: the outer record saw
  // examples/app/.eccode/reviews/drafts/... as an ordinary project file).
  allowed(edit(outer.dir, 'Write', draft, 'architecture-reviewer', env), 'inner draft by Write from the outer cwd');
  allowed(edit(inner, 'Write', draft, 'architecture-reviewer', env), 'inner draft by Write from the inner cwd');
  allowed(bash(outer.dir, `echo x > ${draft}`, 'architecture-reviewer', env), 'inner draft by redirect from the outer cwd');
  // The inner record itself stays the CLI's, from either cwd and for every role.
  const innerState = path.join(inner, '.eccode', 'state.json');
  for (const role of [null, 'architecture-reviewer', 'backend-engineer']) {
    denied(edit(outer.dir, 'Write', innerState, role, env), `${role || 'main'} inner record by Write`, /written only by the eccode CLI|part of the ECCode record/);
    denied(bash(outer.dir, `echo x > examples/app/.eccode/state.json`, role, env), `${role || 'main'} inner record by redirect`, /written only by the eccode CLI|part of the ECCode record/);
  }
  // Inner project files are governed by the inner record's claims: an outer-project reviewer still
  // cannot write them, and an implementer with no claim in the inner project cannot either.
  denied(edit(outer.dir, 'Write', path.join(inner, 'src', 'x.js'), 'technical-reviewer', env), 'reviewer writes inner source', /does not edit project files/);
  denied(bash(inner, 'echo x > src/x.js', 'backend-engineer', env), 'implementer without an inner claim', /no claimed task|outside/);
});
