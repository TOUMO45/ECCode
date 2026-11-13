'use strict';
// A reviewer's approval must rest on the check the plan pinned, run by the reviewer after the submission.
// Reproduced 2026-11-13: a reviewer who ran `true` approved both gates and `deliver` printed "Delivered" while
// the project's pinned test command was failing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const ec = (cwd, ...args) => sh(cwd, process.execPath, [BIN, ...args]);

function submittedQuickProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-pinned-'));
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 't']]) sh(dir, 'git', a);
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), 'exports.add=(a,b)=>a+b;\n');
  fs.writeFileSync(path.join(dir, 'test', 'm.test.js'), "const a=require('assert');const m=require('../src/m.js');a.strictEqual(m.add(1,2),3);\n");
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","scripts":{"test":"node test/m.test.js"}}\n');
  sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', 'init']);
  assert.strictEqual(ec(dir, 'quick', 'add a sub function', '--actor', 'orchestrator').status, 0);
  ec(dir, 'task', 'claim', 'change', '--actor', 'backend-engineer');
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), 'exports.add=(a,b)=>a+b;exports.sub=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(dir, 'test', 'm.test.js'), "const a=require('assert');const m=require('../src/m.js');a.strictEqual(m.add(1,2),3);a.strictEqual(m.sub(3,2),1);\n");
  ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', 'npm test');
  ec(dir, 'handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', '.eccode/drafts/h.json');
  const h = path.join(dir, '.eccode', 'drafts', 'h.json');
  fs.writeFileSync(h, fs.readFileSync(h, 'utf8').replace(/TODO: the decisions[^"]*/, 'no special constraints here').replace(/TODO: what is true[^"]*/, 'sub added; npm test passes'));
  const done = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/h.json');
  assert.strictEqual(done.status, 0, done.stderr);
  const sub = ec(dir, 'gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  assert.strictEqual(sub.status, 0, sub.stderr);
  return dir;
}

function reviewWith(dir, command) {
  const run = ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', command);
  const id = /ev:(ev-[a-z0-9-]+)/.exec(run.stdout)[1];
  const file = path.join(os.tmpdir(), `rev-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ decision: 'approve', summary: 'Reviewed the change and ran a check for it.',
    criteria: [{ id: 'C1', description: 'the check passes', met: true, evidence: [`ev:${id}`] }], findings: [], resolvedFindings: [], lessonsConsulted: [] }));
  return ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--file', file);
}

test('a reviewer who ran only a trivial passing command cannot approve; the refusal prints the command to run', () => {
  const dir = submittedQuickProject();
  const r = reviewWith(dir, 'true');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /the reviewer must itself run each pinned verification command/);
  assert.match(r.stderr, /eccode evidence run --actor technical-reviewer --gate phase:change --label review -- "npm test"/);
});

test('the same review is accepted once the reviewer has run the pinned command and seen it pass', () => {
  const dir = submittedQuickProject();
  const r = reviewWith(dir, 'npm test');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Gate phase:change is now approved/);
});

test('evidence run exits 3 when the check fails, 0 when it passes; a reproduction may fail and still exit 0', () => {
  const dir = submittedQuickProject();
  assert.strictEqual(ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--label', 'x', '--', 'false').status, 3);
  assert.strictEqual(ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--label', 'x', '--', 'true').status, 0);
  assert.strictEqual(ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--label', 'x', '--purpose', 'reproduction', '--', 'false').status, 0);
});

test('quick starts on a plain Python project with unittest files, and says the whole next command when it cannot detect a check', () => {
  const py = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-py-'));
  sh(py, 'git', ['init', '-q']);
  fs.mkdirSync(path.join(py, 'tests'));
  fs.writeFileSync(path.join(py, 'm.py'), 'def add(a, b):\n    return a + b\n');
  fs.writeFileSync(path.join(py, 'tests', 'test_m.py'), 'import unittest\n');
  const ok = ec(py, 'quick', 'add a sub function', '--actor', 'orchestrator');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /-m unittest discover -s tests/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-empty-'));
  sh(empty, 'git', ['init', '-q']);
  const no = ec(empty, 'quick', 'build the tool in brief.md', '--actor', 'orchestrator');
  assert.strictEqual(no.status, 2);
  assert.match(no.stderr, /eccode quick "build the tool in brief\.md" --actor orchestrator --command "/);
});
