'use strict';
// The sandboxed profile: the record is read-only to shell commands at the OS
// level, the CLI says so at once, and each agent may use only its own role's
// eccode MCP server (checked structurally from the tool name).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { install } = require('../lib/install');
const { LOCKABLE } = require('../lib/mcp');
const { Store } = require('../lib/store');
const { tmpProject } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');

test('install --sandbox writes the OS-enforced profile and one MCP server per role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sbx-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  install({ target: dir, scope: 'project', sandbox: true });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.sandbox.enabled, true);
  assert.strictEqual(settings.sandbox.failIfUnavailable, true);
  assert.strictEqual(settings.sandbox.allowUnsandboxedCommands, false);
  for (const p of ['.eccode/events.jsonl', '.eccode/state.json', '.eccode/config.json', '.eccode/evidence']) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(p), p);
  }
  assert.ok(!settings.sandbox.filesystem.denyWrite.some((p) => /[*?[]/.test(p)), 'no globs: the Linux sandbox skips them');
  assert.match(settings.hooks.PreToolUse[0].matcher, /mcp__eccode_/);
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  for (const role of LOCKABLE) assert.deepStrictEqual(mcp.mcpServers[`eccode_${role}`].args.slice(-2), ['--actor', role]);
  // Re-running is idempotent: no duplicate deny entries.
  install({ target: dir, scope: 'project', sandbox: true });
  const again = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(again.sandbox.filesystem.denyWrite.length, settings.sandbox.filesystem.denyWrite.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

function decide(dir, tool, agent) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_name: tool, ...(agent ? { agent_type: `eccode:${agent}` } : {}), tool_input: {} }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

test('each agent may call only its own role\'s eccode MCP server', () => {
  const { dir } = tmpProject();
  assert.strictEqual(decide(dir, 'mcp__eccode_orchestrator__status', null), 'allow');
  assert.strictEqual(decide(dir, 'mcp__eccode_backend-engineer__task_claim', null), 'deny');
  assert.strictEqual(decide(dir, 'mcp__eccode_backend-engineer__task_claim', 'backend-engineer'), 'allow');
  assert.strictEqual(decide(dir, 'mcp__eccode_orchestrator__risk_add', 'backend-engineer'), 'deny');
  assert.strictEqual(decide(dir, 'mcp__eccode_technical-reviewer__gate_review', 'backend-engineer'), 'deny');
});

test('a read-only record fails fast with a clear message instead of a lock timeout', () => {
  const { dir } = tmpProject();
  const store = new Store(dir);
  const orig = fs.accessSync;
  fs.accessSync = (p, mode) => {
    if (String(p).endsWith('events.jsonl') && mode === fs.constants.W_OK) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    return orig(p, mode);
  };
  const started = Date.now();
  try {
    assert.throws(() => store.commit('risk.recorded', 'orchestrator', { id: 'R1' }), (err) => err.code === 'RECORD_READ_ONLY' && /MCP tools/.test(err.message));
    assert.ok(Date.now() - started < 1000, 'must not wait for the lock');
  } finally {
    fs.accessSync = orig;
  }
});

test('the default profile is always enforced: sandbox where supported, otherwise no shell', () => {
  const { defaultProfile } = require('../lib/install');
  const has = (yes) => (cmd) => yes.includes(cmd);
  assert.strictEqual(defaultProfile({ platform: 'darwin', has: has([]) }).profile, 'sandbox');
  assert.strictEqual(defaultProfile({ platform: 'linux', has: has(['bwrap', 'socat']) }).profile, 'sandbox');
  assert.strictEqual(defaultProfile({ platform: 'linux', has: has(['bwrap']) }).profile, 'no-shell');
  assert.strictEqual(defaultProfile({ platform: 'win32', has: has(['bwrap', 'socat']) }).profile, 'no-shell');
  for (const p of ['darwin', 'linux', 'win32', 'freebsd']) {
    assert.notStrictEqual(defaultProfile({ platform: p, has: has([]) }).profile, 'guard', `${p} must not default to the text-only guard`);
  }
});

test('no-shell profile denies every shell tool and the record paths, registers role servers, and is detected', () => {
  const { install: inst, protectionProfile } = require('../lib/install');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-noshell-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.strictEqual(protectionProfile(dir), 'guard');
  inst({ target: dir, scope: 'project', profile: 'no-shell' });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  for (const t of ['Bash', 'PowerShell', 'Monitor']) assert.ok(settings.permissions.deny.includes(t), t);
  for (const r of ['Edit(/.eccode/events.jsonl)', 'Edit(/.eccode/state.json)', 'Edit(/.eccode/config.json)', 'Edit(/.eccode/evidence/**)']) assert.ok(settings.permissions.deny.includes(r), r);
  assert.ok(!settings.permissions.deny.some((r) => /drafts|artifacts/.test(r)), 'drafts and artifacts stay writable');
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers['eccode_orchestrator'] && mcp.mcpServers['eccode_backend-engineer']);
  assert.strictEqual(protectionProfile(dir), 'no-shell');
  const sbx = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sbx2-'));
  inst({ target: sbx, scope: 'project', profile: 'sandbox' });
  assert.strictEqual(protectionProfile(sbx), 'sandbox');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sbx, { recursive: true, force: true });
});

test('every session states which record protection is active', () => {
  const { install: inst } = require('../lib/install');
  const hook = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');
  const run = (dir) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } }).stdout;
  const guard = tmpProject();
  assert.match(run(guard.dir), /Record protection: text guard only/);
  const ns = tmpProject();
  inst({ target: ns.dir, scope: 'project', profile: 'no-shell' });
  assert.match(run(ns.dir), /Record protection: no shell/);
  const sb = tmpProject();
  inst({ target: sb.dir, scope: 'project', profile: 'sandbox' });
  assert.match(run(sb.dir), /Record protection: OS sandbox/);
});

test('MCP servers ECCode did not install are named every session', () => {
  const { install: inst } = require('../lib/install');
  const hook = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');
  const ctx = tmpProject();
  inst({ target: ctx.dir, scope: 'project', profile: 'no-shell' });
  const mcpFile = path.join(ctx.dir, '.mcp.json');
  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  mcp.mcpServers.files = { command: 'some-fs-server' };
  fs.writeFileSync(mcpFile, JSON.stringify(mcp));
  const out = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: ctx.dir }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir } }).stdout;
  assert.match(out, /Other MCP servers in \.mcp\.json run outside the record protection: files\./);
  assert.doesNotMatch(out, /eccode_orchestrator, /); // ECCode's own servers are not listed
});

test('install --with-codebase-memory registers the server and it is not flagged as foreign', { skip: !process.env.ECCODE_CBM && !process.env.ECCODE_REQUIRE_TRACERS && 'set ECCODE_CBM to a codebase-memory-mcp binary' }, () => {
  const { install: inst } = require('../lib/install');
  const ctx = tmpProject();
  inst({ target: ctx.dir, scope: 'project', profile: 'no-shell', codebaseMemory: true });
  const mcp = JSON.parse(fs.readFileSync(path.join(ctx.dir, '.mcp.json'), 'utf8'));
  assert.strictEqual(mcp.mcpServers.codebase_memory.command, process.env.ECCODE_CBM);
  const hook = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');
  const out = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: ctx.dir }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir } }).stdout;
  assert.doesNotMatch(out, /Other MCP servers/);
});
