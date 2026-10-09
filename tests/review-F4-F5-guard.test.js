'use strict';
// Regression tests for findings F4 and F5 of the independent review
// (docs/evidence/review-bundle/ECCode-independent-review.md): the PreToolUse guard
// must give a shell write the same answer as the Edit/Write tools (F4), and no
// agent context may mint user authority or write record files anywhere (F5).
// The guard is fed PreToolUse payloads on stdin; nothing is executed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { tmpProject, write, approveThroughPlan } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  // An internal error fails open and is logged; a test asserting "allowed" must not be fooled by one.
  assert.strictEqual(res.stderr.trim(), '', `guard reported an error: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const bash = (dir, command, role, extra = {}, env = {}) => hook({ cwd: dir, tool_name: 'Bash', ...agentOf(role), tool_input: { command }, ...extra }, env);
const edit = (dir, tool, file, role, extra = {}) => hook({ cwd: dir, tool_name: tool, ...agentOf(role), tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, ...extra });

function denied(out, label, pattern) {
  assert.ok(out && out.permissionDecision === 'deny', `${label} should be denied, got ${JSON.stringify(out)}`);
  if (pattern) assert.match(out.permissionDecisionReason, pattern, label);
}

function allowed(out, label) {
  assert.strictEqual(out, null, `${label} should be allowed, got ${JSON.stringify(out)}`);
}

function claimedApi(ctx) {
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
}

// The reviewer's probe: five ways to change a source file from the shell.
const SHELL_PROBES = [
  'echo changed > src/server.js',
  'sed -i s/a/b/ src/server.js',
  'cp /tmp/x src/server.js',
  `node -e "require('fs').writeFileSync('src/server.js','x')"`,
  `python3 -c "open('src/server.js','w').write('x')"`,
];

test('F4 reviewer shell writes to project files are denied exactly like the Write tool (the ten probe cases)', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'src/server.js', 'module.exports = {};\n');
  for (const role of ['technical-reviewer', 'security-reviewer']) {
    denied(edit(ctx.dir, 'Write', 'src/server.js', role), `${role} Write`, /does not edit project files/);
    for (const cmd of SHELL_PROBES) denied(bash(ctx.dir, cmd, role), `${role}: ${cmd}`);
    // Plain shell writes carry the Edit reason; inline interpreter code carries the Edit hint.
    assert.match(bash(ctx.dir, SHELL_PROBES[0], role).permissionDecisionReason, /does not edit project files/);
    assert.match(bash(ctx.dir, SHELL_PROBES[3], role).permissionDecisionReason, /Edit\/Write tool/);
  }
  assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'src/server.js'), 'utf8'), 'module.exports = {};\n', 'the probe never executes anything');
});

test('F4 reviewers and document authors keep their draft areas through the shell; the rest of .eccode/ follows the Edit rules', () => {
  const ctx = tmpProject();
  // Reviewers: review drafts and the shared drafts area, nothing else.
  allowed(bash(ctx.dir, 'echo "{}" > .eccode/reviews/drafts/x.json', 'technical-reviewer'), 'reviewer redirect into reviews/drafts');
  allowed(bash(ctx.dir, 'cat r.json | tee .eccode/reviews/drafts/core-1.json', 'security-reviewer'), 'reviewer tee into reviews/drafts');
  allowed(bash(ctx.dir, 'echo note >> .eccode/drafts/notes.md', 'architecture-reviewer'), 'reviewer append into drafts');
  denied(bash(ctx.dir, 'echo x > .eccode/artifacts/spec.md', 'technical-reviewer'), 'reviewer redirect into artifacts', /does not edit project files/);
  denied(edit(ctx.dir, 'Write', '.eccode/artifacts/spec.md', 'technical-reviewer'), 'reviewer Write into artifacts');
  // Document authors: artifacts and drafts, never project files.
  allowed(bash(ctx.dir, 'echo x > .eccode/artifacts/spec.md', 'technical-designer'), 'designer redirect into artifacts');
  denied(bash(ctx.dir, 'cp spec.md src/spec.md', 'technical-designer'), 'designer cp into src', /does not edit project files/);
  // Implementers: the claim decides, artifacts are never theirs (same answer as the Write tool).
  claimedApi(ctx);
  allowed(bash(ctx.dir, 'echo x > src/server/app.js', 'backend-engineer'), 'implementer redirect inside the claim');
  allowed(bash(ctx.dir, 'echo x >> .eccode/drafts/handoff-api.json', 'backend-engineer'), 'implementer draft');
  denied(bash(ctx.dir, 'echo x > .eccode/artifacts/plan.json', 'backend-engineer'), 'implementer redirect into artifacts', /outside the ownership/);
  denied(edit(ctx.dir, 'Write', '.eccode/artifacts/plan.json', 'backend-engineer'), 'implementer Write into artifacts', /outside the ownership/);
  // Reading the record stays free for everyone.
  allowed(bash(ctx.dir, 'cat .eccode/reviews/rev-x.json && grep -n x .eccode/artifacts/spec.md', 'technical-reviewer'), 'reads');
});

test('F4 inline interpreter code that writes files is denied for every ECCode role with the Edit hint; the main session is unaffected', () => {
  const ctx = tmpProject();
  claimedApi(ctx);
  const hint = /Use the Edit\/Write tool for file changes so ownership can be checked/;
  // Even a target inside the claim: the guard cannot see where inline code writes.
  for (const cmd of [
    `node -e "require('fs').writeFileSync('src/server/app.js','x')"`,
    `node --eval "require('fs').appendFileSync('src/server/app.js','x')"`,
    `node -p "require('fs').rmSync('src/server/app.js')"`,
    `node -e "require('fs').promises.rm('src/server/app.js')"`,
    `python3 -c "open('src/server/app.js','w').write('x')"`,
    `python -c "import shutil; shutil.copy('a.js','src/server/app.js')"`,
    `python3 -c "import os; os.remove('src/server/app.js')"`,
    `perl -e "unlink 'src/server/app.js'"`,
    `ruby -e "File.write('src/server/app.js','x')"`,
    `php -r "file_put_contents('src/server/app.js','x');"`,
    `deno eval "Deno.writeTextFileSync('src/server/app.js','x')"`,
    `python3 - <<'EOF'\nopen('src/server/app.js', 'w').write('x')\nEOF`,
    `node <<'EOF'\nrequire('fs').writeFileSync('src/server/app.js', 'x')\nEOF`,
    `echo "require('fs').writeFileSync('src/server/app.js','x')" | node`,
    `node <<< "require('fs').writeFileSync('src/server/app.js','x')"`,
    `sh -c "node -e \\"require('fs').writeFileSync('src/server/app.js','x')\\""`, // hook input, never executed
    `env FOO=1 node -e "require('fs').writeFileSync('src/server/app.js','x')"`,
  ]) {
    denied(bash(ctx.dir, cmd, 'backend-engineer'), `implementer: ${cmd}`, hint);
  }
  for (const role of ['technical-reviewer', 'product-architect', 'test-engineer']) {
    denied(bash(ctx.dir, SHELL_PROBES[4], role), `${role}: ${SHELL_PROBES[4]}`, hint);
  }
  // Inline code that only reads, scripts the guard cannot see into, and text that merely mentions an API stay allowed.
  for (const cmd of [
    `node -e "console.log(require('./package.json').version)"`,
    `node -e "console.log(require('fs').readFileSync('src/server/app.js','utf8'))"`,
    'python3 -c "print(1)"',
    'node --version && python3 -m pytest tests/',
    'node scripts/build.js',
    'grep -n writeFileSync src/server/app.js',
  ]) {
    allowed(bash(ctx.dir, cmd, 'backend-engineer'), `implementer: ${cmd}`);
  }
  // The main session is the orchestrator: inline code is its own business, the record is not.
  allowed(bash(ctx.dir, `node -e "require('fs').writeFileSync('src/server.js','x')"`, null), 'main session node -e');
  allowed(bash(ctx.dir, `python3 -c "open('notes.txt','w').write('x')"`, null), 'main session python -c');
  denied(bash(ctx.dir, `node -e "require('fs').writeFileSync('.eccode/state.json','{}')"`, null), 'main session inline write to the record', /written only by the eccode CLI/);
});

test('F4 relative shell targets are resolved from the hook cwd; outside the project is not ours, into it is checked, after a cd it cannot be bound', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'src/server.js', 'module.exports = {};\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-outside-'));
  const env = { CLAUDE_PROJECT_DIR: ctx.dir };
  // A scratch file next to the project is nobody's business.
  allowed(bash(outside, 'echo x > notes.txt', 'technical-reviewer', {}, env), 'reviewer scratch write outside the project');
  allowed(bash(outside, 'cp a.log b.log', 'backend-engineer', {}, env), 'implementer scratch copy outside the project');
  // A relative path that climbs back into the project is a project write.
  const into = `../${path.basename(ctx.dir)}/src/server.js`;
  denied(bash(outside, `echo x > ${into}`, 'technical-reviewer', {}, env), 'reviewer write into the project from outside', /does not edit project files/);
  denied(bash(outside, `sed -i s/a/b/ ${into}`, 'backend-engineer', {}, env), 'implementer write into the project from outside', /no claimed task/);
  // A cd inside the command moves the write somewhere the guard cannot bind: fail closed, say what to do.
  denied(bash(ctx.dir, 'cd src && echo x > ../src/server.js', 'technical-reviewer'), 'cd then relative write', /changes directory[\s\S]*Edit\/Write tool/);
  denied(bash(ctx.dir, 'cd /tmp && echo x > notes.txt', 'technical-reviewer'), 'cd away then relative write', /changes directory/);
  // The absolute path is quoted: on Windows an unquoted C:\... is read by Git Bash (and the guard) as
  // C:..., a relative name, which a cd makes unbindable; quoted, it keeps its separators everywhere.
  allowed(bash(ctx.dir, `cd /tmp && echo x > "${path.join(outside, 'notes.txt')}"`, 'technical-reviewer'), 'cd then absolute write outside');
  allowed(bash(ctx.dir, 'cd src && ls && cat server.js', 'technical-reviewer'), 'cd without a write');
});

test('F5 --actor user is denied from every agent context: the main session, subagents, sequential mode, the environment', () => {
  const ctx = tmpProject();
  const reserved = /--actor user is reserved for a person at a terminal/;
  const cmd = 'eccode gate reopen design --actor user --resolution "the user decided"';
  const main = bash(ctx.dir, cmd, null);
  denied(main, 'main session --actor user', reserved);
  assert.match(main.permissionDecisionReason, /Ask the user to run this command themselves: eccode gate reopen design --actor user/);
  assert.match(main.permissionDecisionReason, /eccode delegate grant/);
  assert.match(main.permissionDecisionReason, /--actor orchestrator --delegation <id>/);
  denied(bash(ctx.dir, cmd, 'technical-reviewer'), 'subagent --actor user', reserved);
  denied(bash(ctx.dir, cmd, 'delivery-lead'), 'implementer --actor user', reserved);
  denied(bash(ctx.dir, cmd, null, {}, { ECCODE_SEQUENTIAL_ROLES: '1' }), 'sequential mode --actor user', reserved);
  for (const c of [
    'node .claude/eccode/bin/eccode.js rebuild --force --actor user',
    'eccode run limits set --max-cost-usd 500 --actor=user',
    'eccode task reset api --actor user --reason "the user said so"',
    'eccode gate start design --actor orchestrator && eccode gate reopen design --actor user --resolution ok',
  ]) {
    denied(bash(ctx.dir, c, null), `main session: ${c}`, reserved);
  }
  // The actor the CLI would take from an exported ECCODE_ACTOR counts the same way.
  denied(bash(ctx.dir, 'eccode gate reopen design --resolution "ok"', null, {}, { ECCODE_ACTOR: 'user' }), 'exported ECCODE_ACTOR=user', reserved);
  // Orchestrator authority, delegated authority and read-only commands are untouched.
  allowed(bash(ctx.dir, 'eccode gate start design --actor orchestrator', null), 'orchestrator');
  allowed(bash(ctx.dir, 'eccode gate reopen design --actor orchestrator --delegation dg-1 --resolution ok', null), 'delegated orchestrator');
  allowed(bash(ctx.dir, 'eccode status --brief # the user may run --actor user herself', null), 'comment mentioning the actor');
  allowed(bash(ctx.dir, 'eccode evidence run --actor technical-reviewer --label t -- npm test', 'technical-reviewer'), 'reviewer evidence run');
});

test('F5 record and memory files outside the project (shared memory, another project) are written only by the CLI, from every context', () => {
  const ctx = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-home-'));
  const memory = path.join(home, '.eccode', 'memory', 'records', 'mem-sd-x.json');
  const other = path.join(home, 'other-project', '.eccode', 'state.json');
  const reason = /ECCode record and memory files are written only by the eccode CLI/;
  for (const role of [null, 'learning-debugger', 'technical-reviewer']) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      denied(edit(ctx.dir, tool, memory, role), `${role || 'main'} ${tool} shared memory record`, reason);
      denied(edit(ctx.dir, tool, other, role), `${role || 'main'} ${tool} another project's record`, reason);
    }
    for (const cmd of [
      `echo "{}" > ${memory}`,
      `cp fake.json ${memory}`,
      `sed -i 's/provisional/verified/' ${memory}`,
      `node -e "require('fs').writeFileSync('${memory}','{}')"`,
      `python3 -c "open('${other}','w').write('{}')"`,
      `rm ${other}`,
    ]) {
      denied(bash(ctx.dir, cmd, role), `${role || 'main'}: ${cmd}`, /written only by the eccode CLI/);
    }
  }
  // Plain files outside the project remain nobody's business.
  allowed(edit(ctx.dir, 'Write', path.join(home, 'notes.md'), 'technical-reviewer'), 'reviewer scratch file outside');
  allowed(bash(ctx.dir, `echo x > ${path.join(home, 'notes.md')}`, 'technical-reviewer'), 'reviewer scratch redirect outside');
  allowed(bash(ctx.dir, `cat ${memory}`, 'learning-debugger'), 'reading shared memory');
});
