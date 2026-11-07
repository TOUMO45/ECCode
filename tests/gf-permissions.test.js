'use strict';
// S2, T2: path-scoped permissions in the PreToolUse hook (GF-OWN-2, GF-FRZ-1, drafts namespacing). Every case runs
// the real hook (scripts/hooks/guard.js) as a child process in a sealed Greenfield-Senior project: the hook is the
// managed path's write check, and it fails closed in a Greenfield-Senior project.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const wrap = require('../lib/greenfield/wrap');
const messages = require('../lib/greenfield/messages');
const bundle = require('../lib/greenfield/bundle');
const { tmpProject } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts/hooks/guard.js');
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);

/** A sealed project whose phase gate is started and in which each group role holds its skeleton task. */
function team() {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  for (const [role, task] of [['integration-engineer', 's0-contracts'], ['backend-engineer', 's0-app'], ['database-engineer', 's0-db'], ['frontend-engineer', 's0-web'], ['test-engineer', 's0-accept'], ['devops-engineer', 's0-compose']]) {
    F(ctx, 'task.claimed', role, { task, runId: null });
  }
  return ctx;
}

function hook(ctx, role, tool, input, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: ctx.dir, tool_name: tool, ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '', ...env },
  });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
const write = (ctx, role, rel, tool = 'Write') => hook(ctx, role, tool, { file_path: path.join(ctx.dir, rel) });
const bash = (ctx, role, command) => hook(ctx, role, 'Bash', { command });
const must = (r, re) => { assert.strictEqual(r.decision, 'deny', `expected a denial, got ${r.decision}`); assert.match(r.reason, re); };

// ------------------------------------------------------------------ positive
const ALLOWED = [
  ['backend-engineer', 'app/main.py'],
  ['integration-engineer', 'mocks/server.js'],
  ['integration-engineer', 'tests/contract/test_health.py'],
  ['database-engineer', 'migrations/versions/0001_base.py'],
  ['database-engineer', 'app/db/models.py'],
  ['frontend-engineer', 'web/index.html'],
  ['test-engineer', 'tests/acceptance/test_health.py'],
  ['devops-engineer', 'Dockerfile'],
  ['backend-engineer', '.eccode/drafts/backend/notes.md'],
  ['database-engineer', '.eccode/drafts/db/notes.md'],
];
for (const [role, rel] of ALLOWED) {
  test(`GF-OWN-2 positive: ${role} may write ${rel} inside its group and its claimed task`, () => {
    const ctx = team();
    const r = write(ctx, role, rel);
    assert.strictEqual(r.decision, 'allow', r.reason);
  });
}
test('before the seal a group role\'s write gets the existing "no claimed task" refusal (group roles hold no claim before G1 is sealed)', () => {
  const ctx = gfProject();
  must(write(ctx, 'backend-engineer', 'app/main.py'), /no claimed task/);
});

// ------------------------------------------------------------------ negative table
const DENIED = [
  ['frontend-engineer', 'app/main.py', /app\/main\.py belongs to backend, not to frontend/],
  ['backend-engineer', 'app/db/models.py', /app\/db\/models\.py belongs to db, not to backend/],
  ['backend-engineer', 'app/auth/tokens.py', /belongs to security, not to backend/],
  ['backend-engineer', 'pyproject.toml', /pyproject\.toml is owned by no group.*amend/],
  ['database-engineer', 'README.md', /README\.md is owned by no group/],
  ['frontend-engineer', 'contracts/openapi.json', /GF-FRZ-1.*api group/],
  ['backend-engineer', 'contracts/db-schema.json', /GF-FRZ-1.*api group/],
  ['integration-engineer', 'contracts/openapi.json', /GF-FRZ-1.*sealed.*amendment request/],
  ['integration-engineer', 'contracts/events.json', /GF-FRZ-1.*not in the seal|GF-FRZ-1.*sealed/],
  ['backend-engineer', '.eccode/drafts/db/notes.md', /drafts are namespaced.*\.eccode\/drafts\/backend\//],
  ['backend-engineer', '.eccode/drafts/notes.md', /drafts are namespaced/],
  ['frontend-engineer', '.eccode/events.jsonl', /part of the ECCode record/],
  ['devops-engineer', 'docs/readme.md', /outside the ownership of devops-engineer's claimed task/],
  ['delivery-lead', 'app/main.py', /belongs to backend, not to delivery/],
];
for (const [role, rel, re] of DENIED) {
  test(`GF-OWN-2 / GF-FRZ-1 negative: ${role} writing ${rel} is denied`, () => {
    const ctx = team();
    must(write(ctx, role, rel), re);
  });
}

// ------------------------------------------------------------------ GF-FRZ-1: an open amendment request opens one file for the api group
function openRequest(ctx, contract = 'contracts/openapi.json', id = 'req-1') {
  const msg = messages.send(ctx.store, ctx.config, 'frontend-engineer', { to: ['api'], kind: 'amendment-request', subject: 'needs a field', body: 'The client needs a due date on Task.' }).id;
  F(ctx, 'gf.contract.amendment.requested', 'frontend-engineer', { id, contract, reason: 'the client needs a field the contract lacks', message: msg, proposed: 'add due to Task' });
}
test('GF-FRZ-1: with an open amendment request for the file the api group may write it; for another contract file it may not', () => {
  const ctx = team();
  openRequest(ctx);
  assert.strictEqual(write(ctx, 'integration-engineer', 'contracts/openapi.json').decision, 'allow');
  must(write(ctx, 'integration-engineer', 'contracts/db-schema.json'), /GF-FRZ-1.*amendment request/);
  must(write(ctx, 'frontend-engineer', 'contracts/openapi.json'), /GF-FRZ-1.*api group/);
});
test('GF-FRZ-1: once the request is applied (amended) the file is closed again', () => {
  const ctx = team();
  openRequest(ctx);
  F(ctx, 'gf.contract.amended', 'technical-reviewer', { id: 'am-1', request: 'req-1', contract: 'contracts/openapi.json', fromSha: 'a'.repeat(64), toSha: 'b'.repeat(64), reason: 'approved: the field is needed and is additive for the client', classification: 'additive', affectedOps: [], invalidates: [] });
  must(write(ctx, 'integration-engineer', 'contracts/openapi.json'), /GF-FRZ-1.*amendment request/);
});

// ------------------------------------------------------------------ bypass: the same denials by every route to a write
const SHELL = [
  ['redirect', (p) => `echo x > ${p}`],
  ['append', (p) => `echo x >> ${p}`],
  ['tee', (p) => `echo x | tee ${p}`],
  ['sed -i', (p) => `sed -i s/a/b/ ${p}`],
  ['cp', (p) => `cp /tmp/x ${p}`],
  ['mv', (p) => `mv /tmp/x ${p}`],
  ['rm', (p) => `rm ${p}`],
  ['truncate', (p) => `truncate -s 0 ${p}`],
];
for (const [name, mk] of SHELL) {
  test(`bypass: ${name} into another group's path by shell is denied like the file tool (frontend into app/main.py)`, () => {
    const ctx = team();
    // The hook treats every argument of truncate as a write target (an existing behaviour, not S2's), so its
    // denial may name `-s` or the size first; the write is denied either way.
    const re = name === 'truncate' ? /Shell write to /: /Shell write to app\/main\.py: .*belongs to backend/;
    must(bash(ctx, 'frontend-engineer', mk('app/main.py')), re);
  });
}
test('bypass: the contract path by shell and by the other file tools', () => {
  const ctx = team();
  must(bash(ctx, 'frontend-engineer', 'echo {} > contracts/openapi.json'), /GF-FRZ-1/);
  for (const tool of ['Edit', 'MultiEdit']) must(write(ctx, 'frontend-engineer', 'contracts/openapi.json', tool), /GF-FRZ-1/);
  must(hook(ctx, 'frontend-engineer', 'NotebookEdit', { notebook_path: path.join(ctx.dir, 'app/n.ipynb') }), /belongs to backend/);
});
test('bypass: a path that normalises into another group is judged on the normalised path', () => {
  const ctx = team();
  must(write(ctx, 'backend-engineer', 'app/../web/x.js'), /web\/x\.js belongs to frontend, not to backend/);
  must(bash(ctx, 'backend-engineer', 'echo x > app/../web/x.js'), /belongs to frontend/);
});
test('bypass: a symlinked directory inside the project is judged where it points (a frontend path that leads into app/)', () => {
  const ctx = team();
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.symlinkSync(path.join(ctx.dir, 'app'), path.join(ctx.dir, 'web', 'link'), 'dir');
  must(write(ctx, 'frontend-engineer', 'web/link/evil.py'), /app\/evil\.py belongs to backend, not to frontend/);
});
test('bypass: a symlink that leads outside the project is refused for a group role', () => {
  const ctx = team();
  const outside = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-gf-out-'));
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.symlinkSync(outside, path.join(ctx.dir, 'web', 'out'), 'dir');
  must(write(ctx, 'frontend-engineer', 'web/out/x.js'), /outside the project/);
});
test('the delivery group\'s two roles share its paths: devops-engineer and delivery-lead each hold only their group\'s globs', () => {
  const ctx = team();
  must(write(ctx, 'devops-engineer', 'web/x.js'), /belongs to frontend, not to delivery/);
});

// ------------------------------------------------------------------ fail closed, and what is outside the layer
test('fail closed: one byte appended to the sealed breakdown.json denies every group-role write with GF-OWN-1; the orchestrator is not affected', () => {
  const ctx = team();
  const p = Object.keys(bundle.approvedHashes(ctx.store.state())).find((x) => path.posix.basename(x) === 'breakdown.json');
  fs.appendFileSync(path.join(ctx.dir, p), ' ');
  must(write(ctx, 'backend-engineer', 'app/main.py'), /GF-OWN-1.*breakdown\.json/);
  assert.strictEqual(write(ctx, 'backend-engineer', '.eccode/drafts/backend/n.md').decision, 'allow', 'a draft under its own group namespace needs no map: it is not a project file');
  assert.strictEqual(write(ctx, undefined, 'app/main.py').decision, 'allow', 'the main session (orchestrator) is not a group role');
});
test('a record that is not a Greenfield-Senior project keeps the existing rules: a group role needs a claimed task, drafts stay shared', () => {
  const plain = tmpProject();
  must(write(plain, 'backend-engineer', 'app/main.py'), /no claimed task/);
  assert.strictEqual(write(plain, 'backend-engineer', '.eccode/drafts/anything/notes.md').decision, 'allow');
});
test('reviewers and document authors are not group roles: their rules are unchanged', () => {
  const ctx = team();
  must(write(ctx, 'technical-reviewer', 'app/main.py'), /reviews\/designs but does not edit project files/);
  assert.strictEqual(write(ctx, 'technical-designer', '.eccode/drafts/anything/notes.md').decision, 'allow');
});
test('the stated limit: with ECCODE_HOOKS=off the hook allows (a managed-path check, not a boundary against a session that turns it off); the audit is what then detects', () => {
  const ctx = team();
  const r = hook(ctx, 'frontend-engineer', 'Write', { file_path: path.join(ctx.dir, 'app/main.py') }, { ECCODE_HOOKS: 'off' });
  assert.strictEqual(r.decision, 'allow');
});
