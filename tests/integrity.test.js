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
