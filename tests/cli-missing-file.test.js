'use strict';
// A missing --file is the user's mistake, not an engine fault: it must be reported as a
// refusal with a code (exit 2, docs/usage.md "Exit codes"), never as an internal error with a stack trace.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-missing-'));
  const r = run(dir, 'init', '--name', 'demo', '--idea', 'a demo');
  assert.strictEqual(r.status, 0, r.stderr);
  return dir;
}

test('a missing JSON input file is a NOT_FOUND refusal, not an internal error', () => {
  const dir = project();
  for (const args of [
    ['plan', 'validate', 'nope.json'],
    ['memory', 'add', '--file', 'nope.json', '--actor', 'orchestrator'],
    ['improve', 'propose', '--file', 'nope.json', '--actor', 'orchestrator'],
  ]) {
    const r = run(dir, ...args);
    assert.doesNotMatch(r.stderr, /internal error/, args.join(' '));
    assert.match(r.stderr, /\[NOT_FOUND\] File not found: nope\.json/, args.join(' '));
    assert.strictEqual(r.status, 2, args.join(' '));
  }
});

test('invalid JSON in an input file is still reported as INVALID_JSON', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  const r = run(dir, 'plan', 'validate', 'bad.json');
  assert.match(r.stderr, /\[INVALID_JSON\]/);
  assert.strictEqual(r.status, 2);
});

test('--version prints the package version and nothing else', () => {
  const r = run(os.tmpdir(), '--version');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), require('../package.json').version);
});
