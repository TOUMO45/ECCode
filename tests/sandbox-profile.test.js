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
