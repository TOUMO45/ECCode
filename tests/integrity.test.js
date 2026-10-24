'use strict';
// The integrity window around evidence commands: whatever a command runs —
// including project code an agent edited, however it is written — it must not
// change the record or tracked files outside the actor's claimed ownership.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { tmpProject, approveThroughPlan, write } = require('./helpers');

function project() {
  const ctx = tmpProject();
  write(ctx.dir, 'src/server/app.js', 'module.exports = 1;\n');
  write(ctx.dir, 'src/web/ui.js', 'module.exports = 2;\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'code'], { cwd: ctx.dir });
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer'); // owns src/server/**
  return ctx;
}

test('a command that writes to the record is reverted and its evidence fails', () => {
  const ctx = project();
  const events = path.join(ctx.dir, '.eccode', 'events.jsonl');
  const before = fs.readFileSync(events, 'utf8');
  // Path assembled at runtime: a text guard could not see it.
  const cmd = `node -e "require('fs').appendFileSync(['.ecc','ode/ev','ents.jsonl'].join(''), 'forged\\\\n')"`;
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'sneaky', command: cmd });
  assert.strictEqual(ev.status, 'failed');
  assert.match(ev.integrity.join(' '), /changed the ECCode record \(\.eccode\/events\.jsonl\); the change was reverted/);
  const after = fs.readFileSync(events, 'utf8');
  assert.ok(after.startsWith(before), 'earlier events unchanged');
  for (const line of after.trim().split('\n')) JSON.parse(line); // the raw forged line is gone: every line is an event again
  assert.strictEqual(after.slice(before.length).trim().split('\n').length, 1, 'only the evidence event itself was appended');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('a command that changes tracked files outside the claim fails; inside the claim it passes', () => {
  const ctx = project();
  const outside = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'x', command: `node -e "require('fs').appendFileSync('src/web/ui.js', '// x\\\\n')"` });
  assert.strictEqual(outside.status, 'failed');
  assert.match(outside.integrity.join(' '), /outside backend-engineer's claimed ownership: src\/web\/ui\.js/);
  const inside = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'y', command: `node -e "require('fs').appendFileSync('src/server/app.js', '// y\\\\n')"` });
  assert.strictEqual(inside.status, 'passed', JSON.stringify(inside.integrity));
  // Edits made before the command are not blamed on it.
  const again = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'z', command: 'node -e "process.exit(0)"' });
  assert.strictEqual(again.status, 'passed', JSON.stringify(again.integrity));
});

test('a failing node --test check is recorded as failed even when ECCode itself runs under a Node test runner', () => {
  // This file runs under `node --test`, so NODE_TEST_CONTEXT is inherited here
  // exactly as it would be when ECCode is started from inside a test runner.
  const ctx = tmpProject();
  write(ctx.dir, 'failing.test.js', "require('node:test')('fails', () => { throw new Error('boom'); });\n");
  const prev = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = prev || 'child-v8';
  try {
    const ev = evidence.runCommand(ctx.store, 'orchestrator', { label: 'nested', command: 'node --test failing.test.js' });
    assert.strictEqual(ev.status, 'failed', `a failing test must not record as ${ev.status}`);
    assert.notStrictEqual(ev.exitCode, 0);
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prev;
  }
});

// Mealie pilot, c1 item 1: mutate's window reverted the record to its snapshot
// and erased a passing evidence run another engineer recorded meanwhile (its
// completion was then refused: the evidence did not exist) and the
// orchestrator's run end. Writes by other agents must survive the window.
const os = require('os');
const { spawnSync } = require('child_process');
const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
function waitFor(file, ms = 30000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return fs.existsSync(file);
}

test('an event another agent records while a check runs is kept, not reverted', () => {
  const ctx = project();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-window-'));
  const done = path.join(tmp, 'writer.done');
  // Another agent: its own process, not started by the check, records a risk while the check runs.
  fs.writeFileSync(path.join(tmp, 'agent.js'), `const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'risk', 'add', '--id', 'R9', '--title', 'concurrent risk', '--severity', 'low', '--actor', 'orchestrator'], { cwd: ${JSON.stringify(ctx.dir)}, encoding: 'utf8' });\nrequire('fs').writeFileSync(${JSON.stringify(done)}, String(r.status) + r.stderr);\n`);
  fs.writeFileSync(path.join(tmp, 'check.js'), `const env = { ...process.env }; delete env.ECCODE_EVIDENCE;\nrequire('child_process').spawn(process.execPath, [${JSON.stringify(path.join(tmp, 'agent.js'))}], { env, detached: true, stdio: 'ignore' }).unref();\nsetTimeout(() => {}, 1500);\n`);
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'slow check', command: `node "${path.join(tmp, 'check.js')}"` });
  assert.ok(waitFor(done), 'the other agent finished');
  assert.strictEqual(fs.readFileSync(done, 'utf8').trim(), '0', 'its write succeeded once the check ended');
  assert.strictEqual(ev.status, 'passed');
  assert.strictEqual(ev.integrity, undefined, 'the other agent\'s write is not the check\'s');
  assert.ok(ctx.store.readEvents().some((e) => e.type === 'risk.recorded' && e.data.id === 'R9'), 'the event survived');
  assert.ok(ctx.store.readEvents().some((e) => e.data && e.data.id === ev.id), 'and so did the evidence');
  assert.strictEqual(ctx.store.audit().ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a checked command that calls the engine to write is refused at once, and nothing is recorded', () => {
  const ctx = project();
  const started = Date.now();
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'writes', command: `node "${CLI}" risk add --id R8 --title "from the check" --severity low --actor orchestrator` });
  assert.ok(Date.now() - started < 8000, 'no wait on the window\'s own lock');
  assert.strictEqual(ev.status, 'failed');
  assert.strictEqual(ev.integrity, undefined, 'refused before anything was written');
  assert.match(fs.readFileSync(path.join(ctx.dir, ev.log), 'utf8'), /a checked command may not write the ECCode record/);
  assert.ok(!ctx.store.readEvents().some((e) => e.type === 'risk.recorded'));
});

test('a live window\'s lock is never broken as stale; a dead holder\'s is', () => {
  const { withLock } = require('../lib/util');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lock-'));
  const lock = path.join(dir, '.lock');
  const old = new Date(Date.now() - 120000);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, window: true }));
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(lock, () => 'stolen', { timeoutMs: 100, staleMs: 50, windowWaitMs: 300 }), (e) => e.code === 'LOCK_TIMEOUT' && /held by a running check/.test(e.message));
  assert.ok(fs.existsSync(lock), 'still held');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), window: true }));
  fs.utimesSync(lock, old, old);
  assert.strictEqual(withLock(lock, () => 'taken', { timeoutMs: 1000, staleMs: 50 }), 'taken');
  fs.rmSync(dir, { recursive: true, force: true });
});
