'use strict';
// The time profile of an engine run from its record (lib/profile.js): minutes
// per wall-clock phase, executed checks binned by what they were for, agent
// time with no command running, the top sinks; carried in every engine run
// record the bench writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prof = require('../lib/profile');
const bench = require('../lib/bench');

const T0 = Date.parse('2026-11-01T10:00:00Z');
function events(spec) {
  // spec: [[secondsAfterStart, type, actor, data]]
  return spec.map(([s, type, actor, data], i) => ({ seq: i + 1, ts: new Date(T0 + s * 1000).toISOString(), type, actor, data }));
}
const cmd = (label, command, durationS, extra = {}) => ({ kind: 'command', label, command, durationMs: durationS * 1000, exitCode: 0, ...extra });

test('a debug run is binned into plan, lab, implement, review and orchestrator time; commands by kind; agent time is wall minus commands', () => {
  const ev = events([
    [0, 'project.initialized', 'orchestrator', { track: 'debug' }],
    [0, 'plan.imported', 'orchestrator', { tasks: [{ id: 'fix', verification: { command: 'python -m pytest tests' } }] }],
    [60, 'run.started', 'orchestrator', { id: 'r1', task: 'fix', agent: 'backend-engineer' }],
    [120, 'task.claimed', 'backend-engineer', { task: 'fix' }],
    [180, 'evidence.recorded', 'backend-engineer', cmd('tests: baseline', 'python -m pytest tests', 50, { task: 'fix' })],
    [180, 'tests.baseline', 'backend-engineer', { task: 'fix' }],
    [300, 'evidence.recorded', 'backend-engineer', cmd('repro', 'python -m pytest tests/test_bug.py', 20, { task: 'fix', purpose: 'reproduction', repro: true })],
    [300, 'repro.recorded', 'backend-engineer', { id: 'rp1', task: 'fix' }],
    [420, 'hypothesis.opened', 'backend-engineer', { id: 'h1' }],
    [480, 'evidence.recorded', 'backend-engineer', cmd('hypothesis h1', 'python -c 1', 10, { hypothesis: 'h1' })],
    [540, 'hypothesis.closed', 'backend-engineer', { hypothesis: 'h1', status: 'confirmed' }],
    [600, 'rootcause.declared', 'backend-engineer', { hypothesis: 'h1' }],
    [900, 'evidence.recorded', 'backend-engineer', cmd('verify', 'python -m pytest tests/test_bug.py', 30, { task: 'fix' })], // scoped: a subset
    [1000, 'evidence.recorded', 'backend-engineer', cmd('fix-verify: pre-fix', 'python -m pytest tests/test_bug.py', 20, { task: 'fix', fixVerify: { phase: 'pre-fix' } })],
    [1020, 'evidence.recorded', 'backend-engineer', cmd('fix-verify: post-fix', 'python -m pytest tests/test_bug.py', 20, { task: 'fix', fixVerify: { phase: 'post-fix' } })],
    [1200, 'evidence.recorded', 'backend-engineer', cmd('verify', 'python -m  pytest tests', 120, { task: 'fix' })], // the pinned full command (whitespace normalized)
    [1260, 'task.completed', 'backend-engineer', { task: 'fix' }],
    [1260, 'run.ended', 'orchestrator', { id: 'r1' }],
    [1320, 'gate.submitted', 'backend-engineer', { gate: 'phase:fix' }],
    [1380, 'run.started', 'orchestrator', { id: 'r2', gate: 'phase:fix', agent: 'technical-reviewer' }],
    [1500, 'evidence.recorded', 'technical-reviewer', cmd('review', 'python -m pytest tests', 120, { gate: 'phase:fix' })],
    [1560, 'review.recorded', 'technical-reviewer', { gate: 'phase:fix', decision: 'approve' }],
    [1560, 'run.ended', 'orchestrator', { id: 'r2' }],
    [1620, 'delivery.completed', 'orchestrator', {}],
  ]);
  const p = prof.profile(ev);
  assert.strictEqual(p.spanMinutes, 27);
  assert.deepStrictEqual(p.commands, {
    'lab: reproduce / baseline': { minutes: 1.17, runs: 2 },
    'lab: hypotheses': { minutes: 0.17, runs: 1 },
    'scoped checks': { minutes: 0.5, runs: 1 },
    'fix verify': { minutes: 0.67, runs: 2 },
    'full claim run': { minutes: 2, runs: 1 },
    'reviewer re-run': { minutes: 2, runs: 1 },
  });
  // Wall: plan 0..60 (1 min); lab 60..600 (9 min); implement 600..1260 (11 min); orchestrator 1260..1320 (1 min); review from the submission 1320..1560 (4 min); orchestrator 1560..1620 (1 min).
  assert.deepStrictEqual(p.wall, { plan: 1, lab: 9, implement: 11, 'orchestrator between dispatches': 2, review: 4 });
  // Agent time: lab 9 min minus 50+20+10 s of commands = 7.67; implement 11 min minus 30+20+20+120 s = 7.83; review 4 min minus 2 = 2.
  assert.deepStrictEqual(p.agent, { plan: 1, lab: 7.67, implement: 7.83, 'orchestrator between dispatches': 2, review: 2 });
  assert.deepStrictEqual({ reviews: p.reviews, rejections: p.rejections, dispatches: p.dispatches, tasks: p.tasks, delivered: p.delivered, checkMinutes: p.checkMinutes }, { reviews: 1, rejections: 0, dispatches: 2, tasks: 1, delivered: true, checkMinutes: 6.5 });
  const agg = prof.aggregate([p, p]);
  assert.strictEqual(agg.runs, 2);
  assert.strictEqual(agg.commands['full claim run'].minutes, 4);
  assert.strictEqual(agg.topSinks[0].sink, 'implement (agent time, no command running)');
  assert.match(prof.table(agg), /\| lab \| 18 \| 15\.34 \|/);
  assert.strictEqual(prof.profile([]), null);
});

test('a pytest basename collision or a rescope changes the pinned command the full claim run is matched against', () => {
  const ev = events([
    [0, 'plan.imported', 'orchestrator', { tasks: [{ id: 'fix', verification: { command: 'pytest tests' } }] }],
    [10, 'task.rescoped', 'orchestrator', { task: 'fix', command: 'pytest tests/unit' }],
    [20, 'task.claimed', 'backend-engineer', { task: 'fix' }],
    [30, 'evidence.recorded', 'backend-engineer', cmd('verify', 'pytest tests/unit', 6, { task: 'fix' })],
    [40, 'evidence.recorded', 'backend-engineer', cmd('verify', 'pytest tests', 6, { task: 'fix' })],
  ]);
  const p = prof.profile(ev);
  assert.deepStrictEqual(p.commands, { 'full claim run': { minutes: 0.1, runs: 1 }, 'scoped checks': { minutes: 0.1, runs: 1 } });
});

test('the bench keeps the profile of an engine run in its record, from the sandbox\'s events', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-profile-'));
  assert.strictEqual(bench.profileOf(sandbox), null, 'no record, no profile');
  fs.mkdirSync(path.join(sandbox, '.eccode'));
  const ev = events([[0, 'project.initialized', 'orchestrator', {}], [60, 'task.claimed', 'backend-engineer', { task: 'change' }], [120, 'evidence.recorded', 'backend-engineer', cmd('verify', 'npm test', 30, { task: 'change' })]]);
  fs.writeFileSync(path.join(sandbox, '.eccode', 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const p = bench.profileOf(sandbox);
  assert.strictEqual(p.spanMinutes, 2);
  assert.deepStrictEqual(p.commands, { 'scoped checks': { minutes: 0.5, runs: 1 } });
  // The pilot's profiler reads the same profile back from a --save file.
  const file = path.join(sandbox, 'runs.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'batch', id: 'b' }) + '\n' + JSON.stringify({ task: 't', variant: 'debug', profile: p }) + '\n' + JSON.stringify({ task: 't', variant: 'without' }) + '\n');
  const pilot = require('../bench/pilot/phase3-profile');
  assert.strictEqual(pilot.fromRecords(file).length, 1);
  assert.strictEqual(pilot.aggregate(pilot.fromRecords(file)).spanMinutes, 2);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
