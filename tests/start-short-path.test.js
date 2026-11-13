'use strict';
// `eccode start`: small work from an empty folder to "Delivered" in eight commands, with no file written by hand
// and one independent review. Measured 2026-11-13: the default path needed 30 commands, 12 hand-written files and
// 5 gates for the same toy project, and a weak model never finished it in 40 minutes (pilot W1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const HAVE_PY = spawnSync(PY, ['--version']).status === 0;
const skip = HAVE_PY ? false : 'needs python';
const CHECK = `${PY} -m unittest discover -s tests`;
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const ec = (cwd, ...args) => sh(cwd, process.execPath, [BIN, ...args]);

function emptyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-start-'));
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 't']]) sh(dir, 'git', a);
  fs.writeFileSync(path.join(dir, 'brief.md'), '# Brief\nBuild add(a, b).\n');
  sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', 'init']);
  return dir;
}

function build(dir, { broken = false } = {}) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'adder.py'), `def add(a, b):\n    return a ${broken ? '-' : '+'} b\n`);
  fs.writeFileSync(path.join(dir, 'tests', 'test_adder.py'),
    'import unittest\nfrom adder import add\n\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n');
}

test('an empty project is delivered in eight commands, with nothing written by hand and one review', { skip }, () => {
  const dir = emptyProject();
  const commands = [];
  const run = (...args) => { const r = ec(dir, ...args); commands.push(args.slice(0, 2).join(' ')); assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
  const started = run('start', 'build the adder in brief.md', '--command', CHECK);
  assert.match(started.stdout, /Do these in order\. Each line is the whole command:/);
  assert.match(started.stdout, /7\. orchestrator: eccode deliver --actor orchestrator/);
  run('task', 'claim', 'change', '--actor', 'backend-engineer');
  build(dir);
  run('evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK);
  run('task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'adder.add exists and its unittest suite passes');
  run('gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  run('evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', CHECK);
  run('gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'The adder matches the brief and its tests pass when I run them.');
  assert.match(run('deliver', '--actor', 'orchestrator').stdout, /Delivered/);
  assert.strictEqual(commands.length, 8);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.eccode', 'state.json'), 'utf8'));
  assert.deepStrictEqual(state.gateOrder, ['phase:change']);
  assert.match(ec(dir, 'audit').stdout, /Audit OK/);
});

test('the short path keeps the evidence rules: no approval without the reviewer running the pinned check, none by the author', { skip }, () => {
  const dir = emptyProject();
  ec(dir, 'start', 'build the adder in brief.md', '--command', CHECK);
  ec(dir, 'task', 'claim', 'change', '--actor', 'backend-engineer');
  build(dir);
  ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK);
  ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'adder.add exists and its unittest suite passes');
  ec(dir, 'gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  const noRun = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'Looks right to me, approving without running it.');
  assert.strictEqual(noRun.status, 2);
  assert.match(noRun.stderr, /eccode evidence run --actor technical-reviewer/);
  const self = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'backend-engineer', '--approve', '--summary', 'I wrote it and I approve it myself, it is fine.');
  assert.strictEqual(self.status, 2);
  assert.match(ec(dir, 'deliver', '--actor', 'orchestrator').stderr, /DELIVERY_BLOCKED/);
});

test('work whose check fails cannot be completed, and the run that shows it exits 3', { skip }, () => {
  const dir = emptyProject();
  ec(dir, 'start', 'build the adder in brief.md', '--command', CHECK);
  ec(dir, 'task', 'claim', 'change', '--actor', 'backend-engineer');
  build(dir, { broken: true });
  assert.strictEqual(ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK).status, 3);
  const done = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'adder.add exists and its unittest suite passes');
  assert.strictEqual(done.status, 2);
  assert.match(done.stderr, /passing check/);
});

test('a review can be drafted from the record instead of written from memory', { skip }, () => {
  const dir = emptyProject();
  ec(dir, 'start', 'build the adder in brief.md', '--command', CHECK);
  ec(dir, 'task', 'claim', 'change', '--actor', 'backend-engineer');
  build(dir);
  ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK);
  ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'adder.add exists and its unittest suite passes');
  ec(dir, 'gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', CHECK);
  const draft = JSON.parse(ec(dir, 'gate', 'review', 'phase:change', '--draft', '--actor', 'technical-reviewer').stdout);
  assert.strictEqual(draft.decision, 'approve');
  assert.ok(draft.criteria.length >= 1 && draft.criteria.every((c) => c.evidence.length === 1 && /^ev:/.test(c.evidence[0])));
  assert.match(draft.summary, /^TODO/);
});

test('a second piece of work on the same record also ends at its one gate; plain quick keeps its verification gate', { skip }, () => {
  const dir = emptyProject();
  ec(dir, 'start', 'build the adder in brief.md', '--command', CHECK);
  let state = JSON.parse(fs.readFileSync(path.join(dir, '.eccode', 'state.json'), 'utf8'));
  assert.strictEqual(state.work.oneGate, true);
  const other = emptyProject();
  fs.mkdirSync(path.join(other, 'tests'));
  fs.writeFileSync(path.join(other, 'tests', 'test_x.py'), 'import unittest\n');
  assert.strictEqual(ec(other, 'quick', 'add a function', '--actor', 'orchestrator').status, 0);
  state = JSON.parse(fs.readFileSync(path.join(other, '.eccode', 'state.json'), 'utf8'));
  assert.deepStrictEqual(state.gateOrder, ['phase:change', 'verification']);
});

test('after a rejection NEXT says how to rework, and following it leads to an approval and delivery', { skip }, () => {
  const dir = emptyProject();
  const ok = (...args) => { const r = ec(dir, ...args); assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r; };
  ok('start', 'build the adder in brief.md', '--command', CHECK);
  ok('task', 'claim', 'change', '--actor', 'backend-engineer');
  build(dir);
  ok('evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK);
  ok('task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'adder.add exists and its unittest suite passes');
  ok('gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  ok('evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', CHECK);
  const review = JSON.parse(ok('gate', 'review', 'phase:change', '--draft', '--actor', 'technical-reviewer').stdout);
  review.decision = 'changes_requested';
  review.summary = 'Negative numbers are not covered by any test in the suite.';
  review.criteria.forEach((c) => { c.met = false; });
  review.findings = [{ id: 'F1', severity: 'major', title: 'no test for negative numbers', detail: 'tests/test_adder.py:7 only checks 1 + 2', evidence: [], recommendation: 'add a test for add(-1, 1)' }];
  const file = path.join(os.tmpdir(), `rework-${path.basename(dir)}.json`);
  fs.writeFileSync(file, JSON.stringify(review));
  ok('gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--file', file);
  const next = ok('status', '--brief').stdout;
  assert.match(next, /NEXT: rework/);
  assert.match(next, /eccode task reset change --actor orchestrator --reason "rework for (rev-[a-z0-9-]+)"/);
  assert.match(next, /Resubmitting unchanged work is rejected again/);
  const rev = /--responds-to (rev-[a-z0-9-]+)/.exec(next)[1];
  ok('task', 'reset', 'change', '--actor', 'orchestrator', '--reason', `rework for ${rev}`);
  ok('task', 'claim', 'change', '--actor', 'backend-engineer');
  fs.appendFileSync(path.join(dir, 'tests', 'test_adder.py'), '\n    def test_negative(self):\n        self.assertEqual(add(-1, 1), 0)\n');
  ok('evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', CHECK);
  ok('task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'a negative-number test was added and the suite passes');
  ok('gate', 'submit', 'phase:change', '--actor', 'backend-engineer', '--responds-to', rev);
  ok('evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', CHECK);
  ok('gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'The negative-number test was added and the whole suite passes.');
  assert.match(ok('deliver', '--actor', 'orchestrator').stdout, /Delivered/);
});
