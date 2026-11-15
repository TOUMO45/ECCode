#!/usr/bin/env node
'use strict';
// Hidden acceptance checks for the existing-codebase pilot (W4). Never shown to an agent.
//   node tools/existing/oracle.js <t1|t2|t3> <ECCode tree under test>
// Every check drives the tree's own bin/eccode.js from outside, in a throwaway project. No shell built-ins are used,
// so it runs the same on Windows. Prints PASS/FAIL per check and "SCORE n/m"; exits 0 only on full marks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const [task, treeArg] = process.argv.slice(2);
if (!task || !treeArg) { process.stderr.write('usage: oracle.js <t1|t2|t3> <tree>\n'); process.exit(2); }
const TREE = path.resolve(treeArg);
const BIN = path.join(TREE, 'bin', 'eccode.js');
const PINNED = 'node test/m.test.js';

const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000 });
const ec = (cwd, ...args) => sh(cwd, process.execPath, [BIN, ...args]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const both = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `w4-${tag}-`));

function gateStatus(dir, id) {
  const r = ec(dir, 'status', '--json');
  const g = (JSON.parse(r.stdout).gates || []).find((x) => x.id === id);
  return g ? g.status : null;
}

/** A git project with a quick change started and claimed; the change itself is made, the check not yet run. */
function claimed() {
  const dir = tmp('proj');
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 't']]) sh(dir, 'git', a);
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), 'exports.add=(a,b)=>a+b;\n');
  fs.writeFileSync(path.join(dir, 'test', 'm.test.js'), "const a=require('assert');const m=require('../src/m.js');a.strictEqual(m.add(1,2),3);\n");
  fs.writeFileSync(path.join(dir, 'ok.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(dir, 'bad.js'), 'process.exit(1);\n');
  sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', 'init']);
  const q = ec(dir, 'quick', 'add a sub function', '--actor', 'orchestrator', '--command', PINNED, '--files', 'src/**,test/**');
  assert(q.status === 0, `setup: quick failed: ${both(q)}`);
  assert(ec(dir, 'task', 'claim', 'change', '--actor', 'backend-engineer').status === 0, 'setup: claim failed');
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), 'exports.add=(a,b)=>a+b;exports.sub=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(dir, 'test', 'm.test.js'), "const a=require('assert');const m=require('../src/m.js');a.strictEqual(m.add(1,2),3);a.strictEqual(m.sub(3,2),1);\n");
  return dir;
}

function authorCheck(dir) {
  const r = ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', PINNED);
  assert(/PASSED/.test(r.stdout), `setup: author check did not pass: ${both(r)}`);
}

/** The same project taken to a submitted phase:change gate the old way (drafted handoff, edited by hand). */
function submitted() {
  const dir = claimed();
  authorCheck(dir);
  const rel = path.join('.eccode', 'drafts', 'h.json');
  assert(ec(dir, 'handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', rel.split(path.sep).join('/')).status === 0, 'setup: handoff draft failed');
  const h = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  h.context = 'no special constraints here'; h.completedWork = 'sub added; the test run passes';
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(h));
  const done = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', rel.split(path.sep).join('/'));
  assert(done.status === 0, `setup: complete failed: ${both(done)}`);
  const sub = ec(dir, 'gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
  assert(sub.status === 0, `setup: submit failed: ${both(sub)}`);
  return dir;
}

function reviewerRun(dir, command) {
  const r = ec(dir, 'evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:change', '--label', 'review', '--', command);
  const m = /ev:(ev-[a-z0-9-]+)/.exec(r.stdout);
  assert(m && /PASSED/.test(r.stdout), `setup: reviewer run of "${command}" did not pass: ${both(r)}`);
  return `ev:${m[1]}`;
}

function reviewFile(dir, refs) {
  const file = path.join(tmp('rev'), 'review.json');
  fs.writeFileSync(file, JSON.stringify({ decision: 'approve', summary: 'Reviewed the change and ran a check for it.',
    criteria: [{ id: 'C1', description: 'the check passes', met: true, evidence: refs }], findings: [], resolvedFindings: [], lessonsConsulted: [] }));
  return ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--file', file);
}

const CHECKS = {
  t1: [
    ['a missing input file is refused with exit 2 and [NOT_FOUND] naming the file (plan validate)', () => {
      const dir = tmp('nf'); ec(dir, 'init', '--name', 'demo', '--idea', 'a demo');
      const r = ec(dir, 'plan', 'validate', 'nope.json');
      assert(r.status === 2, `exit ${r.status}`); assert(/\[NOT_FOUND\]/.test(r.stderr) && /nope\.json/.test(r.stderr), r.stderr.slice(0, 200));
    }],
    ['the same for memory add --file and improve propose --file', () => {
      const dir = tmp('nf'); ec(dir, 'init', '--name', 'demo', '--idea', 'a demo');
      for (const args of [['memory', 'add', '--file', 'nope.json', '--actor', 'orchestrator'], ['improve', 'propose', '--file', 'nope.json', '--actor', 'orchestrator']]) {
        const r = ec(dir, ...args);
        assert(r.status === 2 && /\[NOT_FOUND\]/.test(r.stderr) && /nope\.json/.test(r.stderr), `${args.join(' ')}: exit ${r.status} ${r.stderr.slice(0, 160)}`);
      }
    }],
    ['a missing input file never prints "internal error" or a stack trace', () => {
      const dir = tmp('nf'); ec(dir, 'init', '--name', 'demo', '--idea', 'a demo');
      const r = ec(dir, 'plan', 'validate', 'nope.json');
      assert(/\[NOT_FOUND\]/.test(r.stderr), 'not refused as NOT_FOUND');
      assert(!/internal error/i.test(r.stderr) && !/\n\s+at .+:\d+:\d+/.test(r.stderr), r.stderr.slice(0, 200));
    }],
    ['a file that exists but is not JSON is still [INVALID_JSON], exit 2', () => {
      const dir = tmp('nf'); ec(dir, 'init', '--name', 'demo', '--idea', 'a demo');
      fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
      const r = ec(dir, 'plan', 'validate', 'bad.json');
      assert(r.status === 2 && /\[INVALID_JSON\]/.test(r.stderr), `exit ${r.status} ${r.stderr.slice(0, 160)}`);
    }],
    ['--version prints the package version and nothing else, exit 0', () => {
      const r = ec(os.tmpdir(), '--version');
      assert(r.status === 0 && r.stdout.trim() === JSON.parse(fs.readFileSync(path.join(TREE, 'package.json'), 'utf8')).version, `exit ${r.status} "${r.stdout.trim().slice(0, 80)}"`);
    }],
    ['evidence run exits 3 when the command fails, and the failed run is still recorded', () => {
      const dir = claimed();
      const r = ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'x', '--', 'node bad.js');
      assert(r.status === 3, `exit ${r.status}`); assert(/Evidence ev:ev-\S+ . FAILED/.test(r.stdout), r.stdout.slice(0, 160));
    }],
    ['evidence run exits 0 when the command passes', () => {
      const dir = claimed();
      assert(ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'x', '--', 'node ok.js').status === 0, 'not 0');
    }],
    ['a failing run recorded with --purpose reproduction exits 0', () => {
      const dir = claimed();
      const r = ec(dir, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'x', '--purpose', 'reproduction', '--', 'node bad.js');
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 160)}`);
    }],
  ],
  t2: [
    ['a reviewer who ran only some other passing command cannot approve (exit 2)', () => {
      const dir = submitted();
      const r = reviewFile(dir, [reviewerRun(dir, 'node ok.js')]);
      assert(r.status === 2, `exit ${r.status}: ${both(r).slice(0, 200)}`);
    }],
    ['after that refusal the gate is still submitted, not approved', () => {
      const dir = submitted();
      reviewFile(dir, [reviewerRun(dir, 'node ok.js')]);
      assert(gateStatus(dir, 'phase:change') === 'submitted', `gate is ${gateStatus(dir, 'phase:change')}`);
    }],
    ['the refusal names the pinned command the reviewer has to run', () => {
      const dir = submitted();
      const r = reviewFile(dir, [reviewerRun(dir, 'node ok.js')]);
      assert(r.status === 2 && r.stderr.includes(PINNED), r.stderr.slice(0, 300));
    }],
    ['the same review is accepted once the reviewer has run the pinned command itself', () => {
      const dir = submitted();
      const r = reviewFile(dir, [reviewerRun(dir, PINNED)]);
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
      assert(gateStatus(dir, 'phase:change') === 'approved', `gate is ${gateStatus(dir, 'phase:change')}`);
    }],
    ['extra spaces in the reviewer\'s command do not matter', () => {
      const dir = submitted();
      const r = reviewFile(dir, [reviewerRun(dir, 'node   test/m.test.js')]);
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
    }],
    ['the author\'s own passing run of the pinned command does not count for the reviewer', () => {
      const dir = submitted();
      authorCheck(dir); // a second author run, after the submission
      const r = reviewFile(dir, [reviewerRun(dir, 'node ok.js')]);
      assert(r.status === 2, `exit ${r.status}`);
    }],
    ['after a refusal, running the pinned command and reviewing again is accepted', () => {
      const dir = submitted();
      const first = reviewerRun(dir, 'node ok.js');
      assert(reviewFile(dir, [first]).status === 2, 'first review was not refused');
      const r = reviewFile(dir, [first, reviewerRun(dir, PINNED)]);
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
    }],
  ],
  t3: [
    ['task complete --done "<text>" completes the task with no handoff file', () => {
      const dir = claimed(); authorCheck(dir);
      const r = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'sub added; the test run passes');
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
      const sub = ec(dir, 'gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
      assert(sub.status === 0, `submit after it failed: ${both(sub).slice(0, 200)}`);
    }],
    ['--done before any passing check is refused with exit 2 (the handoff rules still apply)', () => {
      const dir = claimed();
      const r = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'sub added; the test run passes');
      assert(r.status === 2 && /\[INVALID_HANDOFF\]/.test(r.stderr), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    }],
    ['--done with a too-short text is refused with exit 2', () => {
      const dir = claimed(); authorCheck(dir);
      const r = ec(dir, 'task', 'complete', 'change', '--actor', 'backend-engineer', '--done', 'ok');
      assert(r.status === 2 && /\[INVALID_HANDOFF\]/.test(r.stderr), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    }],
    ['task complete --handoff <file> still works', () => { submitted(); }],
    ['gate review --approve --summary "<verdict>" approves with no review file', () => {
      const dir = submitted(); reviewerRun(dir, PINNED);
      const r = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'The change does what was asked and the check passes.');
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
      assert(gateStatus(dir, 'phase:change') === 'approved', `gate is ${gateStatus(dir, 'phase:change')}`);
    }],
    ['--approve by a reviewer who ran no check of their own is refused, and the gate stays submitted', () => {
      const dir = submitted();
      const r = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'The change does what was asked and the check passes.');
      assert(r.status === 2, `exit ${r.status}: ${both(r).slice(0, 200)}`);
      assert(gateStatus(dir, 'phase:change') === 'submitted', `gate is ${gateStatus(dir, 'phase:change')}`);
    }],
    ['--approve by the author of the work is refused', () => {
      const dir = submitted();
      const r = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'backend-engineer', '--approve', '--summary', 'The change does what was asked and the check passes.');
      assert(r.status !== 0 && gateStatus(dir, 'phase:change') === 'submitted', `exit ${r.status}, gate ${gateStatus(dir, 'phase:change')}`);
    }],
    ['--approve without --summary is refused and nothing is recorded', () => {
      const dir = submitted(); reviewerRun(dir, PINNED);
      const r = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve');
      assert(r.status !== 0 && !/internal error/i.test(r.stderr), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
      assert(gateStatus(dir, 'phase:change') === 'submitted', `gate is ${gateStatus(dir, 'phase:change')}`);
    }],
    ['--approve on a gate that is not submitted is refused with exit 2', () => {
      const dir = claimed();
      const r = ec(dir, 'gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--approve', '--summary', 'The change does what was asked and the check passes.');
      assert(r.status === 2 && !/internal error/i.test(r.stderr), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    }],
    ['gate review --file <review.json> still works', () => {
      const dir = submitted();
      const r = reviewFile(dir, [reviewerRun(dir, PINNED)]);
      assert(r.status === 0, `exit ${r.status}: ${both(r).slice(0, 300)}`);
    }],
  ],
};

const list = CHECKS[task];
if (!list) { process.stderr.write(`unknown task ${task}\n`); process.exit(2); }
let passed = 0;
for (const [name, fn] of list) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); } catch (e) { process.stdout.write(`FAIL ${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 260)}\n`); }
}
process.stdout.write(`\nSCORE ${passed}/${list.length}\n`);
process.exitCode = passed === list.length ? 0 : 1;
