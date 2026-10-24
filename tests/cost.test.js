'use strict';
// What a track costs: runs, tokens, cost, run minutes, review rounds and wall
// time per work item, read from the event log and rolled up per track.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const metrics = require('../lib/memory/metrics');
const runs = require('../lib/runs');
const { tmpProject, expectCode } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');
const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

const ev = (type, data, minute) => ({ type, data, ts: new Date(Date.UTC(2026, 9, 23, 10, minute)).toISOString() });

test('costByWork: runs, reported usage with corrections, reviews and wall time land on the work item that was active', () => {
  const events = [
    ev('project.initialized', { name: 'shop', idea: 'x' }, 0),
    ev('run.started', { id: 'r1', task: 'api' }, 1),
    ev('run.ended', { id: 'r1', tokens: 1000, costUsd: 0.5, durationMinutes: 4 }, 5),
    ev('review.recorded', { gate: 'architecture', review: { decision: 'changes_requested' } }, 6),
    ev('review.recorded', { gate: 'architecture', review: { decision: 'approve' } }, 7),
    ev('run.corrected', { id: 'r1', tokens: 900, costUsd: 0.45 }, 8),
    ev('delivery.completed', { report: 'r.md' }, 30),
    ev('work.started', { id: 'w2', track: 'quick', title: 'Fix the label' }, 40),
    ev('run.started', { id: 'r2', task: 'change' }, 41),
    ev('run.ended', { id: 'r2', tokens: 0, costUsd: 0, durationMinutes: 2 }, 43),
    ev('run.corrected', { id: 'r2', tokens: 300, costUsd: 0.1 }, 44),
    ev('run.started', { id: 'r3', gate: 'phase:change' }, 45),
    ev('run.ended', { id: 'r3', tokens: 200, costUsd: 0, durationMinutes: 1 }, 46),
    ev('review.recorded', { gate: 'phase:change', review: { decision: 'approve' } }, 47),
    ev('delivery.completed', { report: 'r2.md' }, 50),
    ev('work.started', { id: 'w3', track: 'quick', title: 'Another change' }, 60),
    ev('run.started', { id: 'r4', task: 'change' }, 61),
    ev('work.abandoned', { reason: 'not needed after all' }, 70),
  ];
  const works = metrics.costByWork(events);
  assert.deepStrictEqual(works.map((w) => [w.id, w.track, w.status, w.runs, w.tokens, w.wallMinutes]), [
    ['w1', 'greenfield', 'delivered', 1, 900, 30],
    ['w2', 'quick', 'delivered', 2, 500, 10],
    ['w3', 'quick', 'abandoned', 1, 0, 10],
  ]);
  assert.strictEqual(works[0].changesRequested, 1);
  assert.strictEqual(works[0].costUsd, 0.45, 'a correction replaces the reported usage, it does not add to it');
  assert.strictEqual(works[1].runsWithoutUsage, 0, 'a correction that reports usage clears the gap');
  assert.strictEqual(works[1].costUsd, 0.1);
  assert.deepStrictEqual(works[1].tasks, { change: { runs: 1, tokens: 300 } });
  const t = metrics.costPerTrack(works);
  assert.deepStrictEqual(Object.keys(t).sort(), ['greenfield', 'quick']);
  assert.strictEqual(t.quick.workItems, 2);
  assert.strictEqual(t.quick.delivered, 1);
  assert.strictEqual(t.quick.medianTokensPerDelivery, 500, 'medians over delivered work items only');
  assert.strictEqual(t.quick.medianRunsPerDelivery, 2);
  assert.strictEqual(t.quick.tokens, 500);
  assert.strictEqual(t.quick.runs, 3);
});

test('the orchestrator opens a dispatched role\'s run with --for: the guard allows it, the run names the role', () => {
  const ctx = tmpProject();
  const guard = (command) => {
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '' } });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  assert.strictEqual(guard('eccode run start --actor backend-engineer --task api'), 'deny', 'the main session may not act as the role');
  assert.strictEqual(guard('eccode run start --actor orchestrator --for backend-engineer --task api'), 'allow');
  const r = spawnSync(process.execPath, [CLI, '--root', ctx.dir, 'run', 'start', '--actor', 'orchestrator', '--for', 'backend-engineer', '--task', 'api'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.strictEqual(ctx.store.state().runs[id].agent, 'backend-engineer');
  const end = spawnSync(process.execPath, [CLI, '--root', ctx.dir, 'run', 'end', id, '--actor', 'orchestrator', '--tokens', '4200'], { encoding: 'utf8' });
  assert.strictEqual(end.status, 0, end.stderr);
  const m = JSON.parse(spawnSync(process.execPath, [CLI, '--root', ctx.dir, 'metrics', '--json'], { encoding: 'utf8' }).stdout);
  assert.strictEqual(m.summary.costPerTrack.greenfield.tokens, 4200);
  assert.match(spawnSync(process.execPath, [CLI, '--root', ctx.dir, 'metrics'], { encoding: 'utf8' }).stdout, /greenfield: 1 work item \(0 delivered\); 1 run \(0 without usage\); 4200 tokens/);
  expectCode(() => runs.startRun(ctx.store, ctx.config, 'frontend-engineer', { agent: 'backend-engineer' }), 'ROLE_NOT_ALLOWED');
  expectCode(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'chief-wizard' }), 'INVALID_INPUT');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
