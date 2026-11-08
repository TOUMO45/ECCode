'use strict';
// S2, T6: L-GF-17, "the log asserts an actor and does not bind it". The question: can group A act as group B on
// the managed path? Measured here, not assumed. Two controls outside the log stop it: the per-role server lock with
// the harness's tool list, and the PreToolUse hook. This file (1) proves each control for every ordered pair of
// group roles, (2) states the residual as a test that must change when keyed attestation exists (L-GF-20), and
// (3) tests `eccode-gf preflight`, which turns the two controls from assumptions into a recorded fact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const C = require('../lib/greenfield/constants');
const preflightMod = require('../lib/greenfield/preflight');
const audit = require('../lib/greenfield/audit');
const { install } = require('../lib/install');
const mcp = require('../lib/mcp');
const gf = require('../lib/greenfield');

const GUARD = path.join(__dirname, '..', 'scripts/hooks/guard.js');
const CLI = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const GROUP_ROLES = Object.values(C.GROUPS).flat();
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); return ctx; };
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });

function hook(dir, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: dir, tool_name: tool, ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}

// ------------------------------------------------------------------ (1) the controls, for every ordered pair
test('the matrix covers every group role: eight roles, fifty-six ordered pairs', () => {
  assert.strictEqual(GROUP_ROLES.length, 8);
});
const dir = gfProject().dir;
for (const A of GROUP_ROLES) {
  for (const B of GROUP_ROLES) {
    if (A === B) continue;
    test(`hook: ${A} calling ${B}'s MCP server is denied; acting as ${B} on the command line is denied`, () => {
      const viaServer = hook(dir, A, `mcp__eccode_${B}__task_complete`, {});
      assert.strictEqual(viaServer.decision, 'deny');
      assert.match(viaServer.reason, new RegExp(`acts as ${B}`));
      const viaCli = hook(dir, A, 'Bash', { command: `eccode task claim s0-app --actor ${B}` });
      assert.strictEqual(viaCli.decision, 'deny');
      assert.match(viaCli.reason, /GF-RUN-1/); // round 5: a group role has no shell, so the identity check is not reached
    });
  }
}
for (const A of GROUP_ROLES) {
  test(`hook: ${A} may call its own server, and has no shell for the command line (GF-RUN-1)`, () => {
    assert.strictEqual(hook(dir, A, `mcp__eccode_${A}__task_next`, {}).decision, 'allow');
    const viaCli = hook(dir, A, 'Bash', { command: `eccode task next --actor ${A}` });
    assert.strictEqual(viaCli.decision, 'deny');
    assert.match(viaCli.reason, /GF-RUN-1/);
  });
}
test('hook: a group role cannot act as the orchestrator or the user, and the main session cannot act as a group role', () => {
  for (const A of GROUP_ROLES) {
    assert.strictEqual(hook(dir, A, 'Bash', { command: 'eccode status --actor orchestrator' }).decision, 'deny');
    assert.strictEqual(hook(dir, A, 'Bash', { command: 'eccode status --actor user' }).decision, 'deny');
    assert.strictEqual(hook(dir, A, 'mcp__eccode_orchestrator__status', {}).decision, 'deny');
  }
  assert.strictEqual(hook(dir, undefined, 'Bash', { command: 'eccode task claim s0-app --actor backend-engineer' }).decision, 'deny');
});
test('server: a tool of a role-locked server records the server\'s actor and ignores an actor argument', () => {
  const ctx = sealed();
  const m = call('gf_message_send', { to: ['orchestrator'], kind: 'question', subject: 'who am I', body: 'This message carries an actor argument.', actor: 'integration-engineer', from: 'api' }, ctx, 'frontend-engineer');
  assert.strictEqual(m.from, 'frontend');
  const logged = ctx.store.readEvents().filter((e) => e.type === 'gf.message').pop();
  assert.strictEqual(logged.actor, 'frontend-engineer');
  let err;
  try { call('gf_ownership_amend', { group: 'db', to: ['app/db/**', 'x.ini'], reason: 'r'.repeat(40), message: m.id, actor: 'technical-reviewer' }, ctx, 'frontend-engineer'); } catch (e) { err = e; }
  assert.ok(err && /frontend-engineer is not a reviewer/.test(err.message), 'an actor argument cannot turn a group role into a reviewer');
});
test('server: every role in the engine\'s lockable set has a server entry the installer writes, locked with --actor <role>', () => {
  const ctx = gfProject();
  install({ target: ctx.dir, profile: 'no-shell' });
  const servers = JSON.parse(fs.readFileSync(path.join(ctx.dir, '.mcp.json'), 'utf8')).mcpServers;
  for (const role of GROUP_ROLES) {
    assert.ok(servers[`eccode_${role}`], `eccode_${role}`);
    assert.deepStrictEqual(servers[`eccode_${role}`].args.slice(-2), ['--actor', role]);
  }
});

// ------------------------------------------------------------------ (2) the residual, stated as a test
test('RESIDUAL (L-GF-17): an event forged through Store.commit with another group\'s actor audits clean on the ownership rules; it must become detectable when keyed attestation (L-GF-20) exists', () => {
  const ctx = sealed();
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  // an agent of the frontend group wrote this line, with backend-engineer as the actor: the log cannot say so
  F(ctx, 'task.completed', 'backend-engineer', { task: 's0-app', handoffId: 'ho-spoof', filesChanged: ['app/main.py'] });
  const found = audit.run(ctx.store, ctx.config).errors.filter((e) => /^GF-OWN/.test(e.rule));
  assert.deepStrictEqual(found, [], 'the content is the legitimate record: the actor is asserted, not bound');
});
test('what a spoof does NOT buy: a changed sealed contract is detected whoever changed it (content-addressed)', () => {
  const ctx = sealed();
  fs.appendFileSync(path.join(ctx.dir, 'contracts/openapi.json'), ' ');
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-FRZ-2'));
});

// ------------------------------------------------------------------ (3) preflight
const fresh = () => gfProject();
function wiring(dirRoot) {
  const f = path.join(dirRoot, '.claude', 'settings.json');
  return { f, read: () => JSON.parse(fs.readFileSync(f, 'utf8')), write: (s) => fs.writeFileSync(f, JSON.stringify(s, null, 2)) };
}
for (const profile of ['sandbox', 'no-shell']) {
  test(`preflight: a project installed with the ${profile} profile reports the managed-path regime and no warning`, () => {
    const ctx = fresh();
    install({ target: ctx.dir, profile });
    const r = preflightMod.preflight(ctx.dir);
    assert.strictEqual(r.profile, profile);
    assert.strictEqual(r.guardWired, true);
    assert.strictEqual(r.regime, 'managed-path');
    assert.deepStrictEqual(r.warnings, []);
    for (const role of GROUP_ROLES) { assert.strictEqual(r.roleServers[role], true, role); assert.strictEqual(r.agentTools[role], 'own-only', role); }
  });
}
test('preflight: the guard profile is the text-level regime and the warning names the consequence', () => {
  const ctx = fresh();
  install({ target: ctx.dir, profile: 'guard' });
  const r = preflightMod.preflight(ctx.dir);
  assert.strictEqual(r.profile, 'guard');
  assert.strictEqual(r.regime, 'text-level');
  assert.ok(r.warnings.some((w) => /L-GF-17/.test(w) && /a group can act as another group without the log showing it/.test(w)), JSON.stringify(r.warnings));
});
test('preflight: a project that was never installed (no settings, no servers) is the text-level regime with every control missing', () => {
  const ctx = fresh();
  const r = preflightMod.preflight(ctx.dir);
  assert.strictEqual(r.regime, 'text-level');
  assert.strictEqual(r.guardWired, false);
  assert.ok(r.warnings.some((w) => /guard is not wired/.test(w)));
  assert.ok(GROUP_ROLES.every((role) => r.roleServers[role] === false));
});
test('preflight: removing the guard from the settings of a no-shell project is reported (guardWired false, a warning)', () => {
  const ctx = fresh();
  install({ target: ctx.dir, profile: 'no-shell' });
  const w = wiring(ctx.dir);
  const s = w.read();
  s.hooks.PreToolUse = [];
  w.write(s);
  const r = preflightMod.preflight(ctx.dir);
  assert.strictEqual(r.guardWired, false);
  assert.strictEqual(r.regime, 'text-level');
  assert.ok(r.warnings.some((x) => /guard is not wired/.test(x)));
});
test('preflight: a guard whose matcher leaves out the eccode servers or the file tools is not wired', () => {
  for (const matcher of ['Bash', 'Edit|Write|MultiEdit|NotebookEdit', 'Bash|Edit|Write|MultiEdit|NotebookEdit']) {
    const ctx = fresh();
    install({ target: ctx.dir, profile: 'no-shell' });
    const w = wiring(ctx.dir);
    const s = w.read();
    for (const g of s.hooks.PreToolUse) g.matcher = matcher;
    w.write(s);
    assert.strictEqual(preflightMod.preflight(ctx.dir).guardWired, false, matcher);
  }
});
test('preflight: a group role whose agent lists another role\'s server tools, or whose server is not locked to it, is reported', () => {
  const ctx = fresh();
  install({ target: ctx.dir, profile: 'no-shell' });
  const agent = path.join(ctx.dir, '.claude/agents/frontend-engineer.md');
  fs.writeFileSync(agent, fs.readFileSync(agent, 'utf8').replace(/^tools: (.*)$/m, (l, list) => `tools: ${list}, mcp__eccode_backend-engineer__task_complete`));
  const mcpFile = path.join(ctx.dir, '.mcp.json');
  const m = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  m.mcpServers['eccode_test-engineer'].args = ['.claude/eccode/bin/eccode.js', 'mcp', '--actor', 'orchestrator'];
  fs.writeFileSync(mcpFile, JSON.stringify(m));
  const r = preflightMod.preflight(ctx.dir);
  assert.strictEqual(r.agentTools['frontend-engineer'], 'other-servers');
  assert.strictEqual(r.roleServers['test-engineer'], false);
  assert.strictEqual(r.regime, 'text-level');
  assert.ok(r.warnings.some((x) => /frontend-engineer/.test(x) && /other role/.test(x)));
  assert.ok(r.warnings.some((x) => /test-engineer/.test(x) && /not locked/.test(x)));
});
test('battery 11 (S2.2): outside the guard profile, a group role whose agent lists no tools of its own server is reported', () => {
  const ctx = fresh();
  install({ target: ctx.dir, profile: 'no-shell' });
  const agent = path.join(ctx.dir, '.claude/agents/backend-engineer.md');
  fs.writeFileSync(agent, fs.readFileSync(agent, 'utf8').replace(/^tools: (.*)$/m, (l, list) => `tools: ${list.split(',').map((t) => t.trim()).filter((t) => !t.startsWith('mcp__eccode_')).join(', ')}`));
  const r = preflightMod.preflight(ctx.dir);
  assert.strictEqual(r.agentTools['backend-engineer'], 'missing');
  assert.ok(r.warnings.some((x) => /backend-engineer's agent lists no tools of its own server/.test(x)), JSON.stringify(r.warnings));
});
test('preflight: the process environment ECCODE_HOOKS=off is reported as hooksOff', () => {
  const ctx = fresh();
  install({ target: ctx.dir, profile: 'no-shell' });
  const before = process.env.ECCODE_HOOKS;
  process.env.ECCODE_HOOKS = 'off';
  try {
    const r = preflightMod.preflight(ctx.dir);
    assert.strictEqual(r.hooksOff, true);
    assert.strictEqual(r.regime, 'text-level');
    assert.ok(r.warnings.some((x) => /ECCODE_HOOKS=off/.test(x)));
  } finally { if (before === undefined) delete process.env.ECCODE_HOOKS; else process.env.ECCODE_HOOKS = before; }
});
test('the audit carries the managed-path section as warnings (never errors), the MCP tool and the CLI report the same', () => {
  const ctx = sealed();
  const a = audit.run(ctx.store, ctx.config);
  assert.ok(a.managedPath && a.managedPath.regime === 'text-level');
  assert.ok(Array.isArray(a.warnings) && a.warnings.length >= 1);
  assert.ok(!a.errors.some((e) => /L-GF-17/.test(e.message)), 'a regime is a fact, not a rule violation');
  const viaTool = call('gf_preflight', {}, ctx, 'orchestrator');
  assert.strictEqual(viaTool.regime, 'text-level');
  const cli = spawnSync(process.execPath, [CLI, 'preflight', '--json', '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(JSON.parse(cli.stdout).regime, 'text-level');
});
test('the audit of a project that is not Greenfield-Senior has no managed-path section', () => {
  const { tmpProject } = require('./helpers');
  const plain = tmpProject();
  assert.strictEqual(audit.run(plain.store, plain.config).managedPath, undefined);
});
void gf;
