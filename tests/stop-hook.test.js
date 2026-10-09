'use strict';
// Stop hook: an unattended session started with an /eccode command may not end
// before the delivery is complete or a user decision is pending.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { init } = require('../lib/project');
const gates = require('../lib/gates');

const HOOK = path.join(__dirname, '..', 'scripts', 'hooks', 'stop.js');

function transcript(command) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tr-')), 'session.jsonl');
  const lines = [
    { type: 'queue-operation', operation: 'enqueue', content: command ? `/${command} do the thing` : 'hello' },
    { type: 'user', message: { role: 'user', content: command ? `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>do the thing</command-args>` : 'hello' } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

function run({ cwd, command, unattended = true, active = false, session = 'sess-' + Math.random().toString(36).slice(2), hooks } = {}) {
  const env = { ...process.env };
  delete env.ECCODE_UNATTENDED;
  delete env.ECCODE_HOOKS;
  if (unattended) env.ECCODE_UNATTENDED = '1';
  if (hooks) env.ECCODE_HOOKS = hooks;
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: session, transcript_path: transcript(command), cwd, stop_hook_active: active }), encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

function emptyDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-stop-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}

test('an interactive session, or one not started with an /eccode command, is never blocked', () => {
  const d = emptyDir();
  assert.strictEqual(run({ cwd: d, command: 'eccode:change', unattended: false }), null);
  assert.strictEqual(run({ cwd: d, command: null }), null);
  assert.strictEqual(run({ cwd: d, command: 'superpowers:brainstorming' }), null);
  assert.strictEqual(run({ cwd: d, command: 'eccode:change', hooks: 'off' }), null);
  assert.strictEqual(run({ cwd: d, command: 'eccode:status' }), null, 'read-only commands are not workflows');
});

test('unattended /eccode:change with no project: blocked, told to run the workflow rather than do the work itself', () => {
  const d = emptyDir();
  const out = run({ cwd: d, command: 'eccode:change' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /eccode init/);
  assert.match(out.reason, /orchestrat/i);
});

test('unattended with an unfinished project: blocked with the NEXT action; delivered: allowed', () => {
  const d = emptyDir();
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  const store = init(d, { name: 'X', idea: 'Fix the refund limit check in the payments service', profile: 'change' });
  const out = run({ cwd: d, command: 'eccode:change' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /NEXT: /);
  assert.match(out.reason, /plan/);
  // A pending user decision (escalated gate) is a legitimate place to stop. The escalation goes
  // through the record: a state.json edited by hand is refused (SNAPSHOT_DIVERGED), not read.
  store.commit('gate.escalated', 'orchestrator', { gate: 'plan', reason: 'review iterations exhausted', unresolved: [], recovery: 'Ask the user to decide' });
  assert.strictEqual(store.state().gates.plan.status, 'escalated');
  assert.strictEqual(run({ cwd: d, command: 'eccode:change' }), null);
});

test('the hook gives up after a few blocks per session so it can never loop forever', () => {
  const d = emptyDir();
  const session = 'looping-' + Math.random().toString(36).slice(2);
  const outs = [1, 2, 3, 4, 5, 6].map(() => run({ cwd: d, command: 'eccode:change', session, active: true }));
  assert.ok(outs.slice(0, 4).every((o) => o && o.decision === 'block'));
  assert.strictEqual(outs[5], null);
});
