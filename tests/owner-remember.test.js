'use strict';
// What the owner asks for outside the brief must reach later sessions. A pilot on 2026-11-19 (memory off) lost, in
// one run of three, every requirement the owner stated in session 1 for parts built in sessions 2 and 3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const HOOK = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');
const ec = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
const CMD = 'node -e "process.exit(0)"';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-keep-'));
  fs.writeFileSync(path.join(dir, 'brief.md'), '# brief\n');
  return dir;
}

test('start --remember records the owner\'s words and prints them with the steps', () => {
  const dir = project();
  const r = ec(dir, 'start', 'build the catalogue', '--command', CMD, '--remember', 'loans are due after 14 days, not 21', '--remember', 'a member may hold at most 3 books');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /The owner asked for these/);
  assert.match(r.stdout, /1\. loans are due after 14 days, not 21/);
  assert.match(r.stdout, /2\. a member may hold at most 3 books/);
});

test('the requirements reach a later session: resume brief, status and the next start', () => {
  const dir = project();
  assert.strictEqual(ec(dir, 'start', 'build the catalogue', '--command', CMD, '--remember', 'loans are due after 14 days, not 21').status, 0);
  const k = ec(dir, 'remember', 'report overdue takes --min-days N');
  assert.strictEqual(k.status, 0, k.stderr);
  assert.match(ec(dir, 'remember', 'report overdue takes --min-days N').stdout, /Already on record/);
  const hook = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.match(hook.stdout, /loans are due after 14 days, not 21/);
  assert.match(hook.stdout, /--min-days N/);
  assert.match(ec(dir, 'status', '--brief').stdout, /bind every part/);
  assert.strictEqual(ec(dir, 'work', 'abandon', '--actor', 'user', '--reason', 'next session starts the next part').status, 0);
  const next = ec(dir, 'start', 'build lending', '--command', CMD);
  assert.strictEqual(next.status, 0, next.stderr);
  assert.match(next.stdout, /loans are due after 14 days, not 21/);
  assert.match(next.stdout, /--min-days N/);
});

test('remember refuses an empty requirement', () => {
  const dir = project();
  ec(dir, 'start', 'build the catalogue', '--command', CMD);
  const r = ec(dir, 'remember', 'x');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /INVALID_INPUT/);
});
