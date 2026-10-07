'use strict';
// Plan check for task t01-scaffold (delivery-lead, plan gate companion).
// Run from the project root: node .eccode/artifacts/plan/checks/scaffold-check.js
// Asserts package.json equals spec §Deployment exactly, and that .env.example
// and .gitignore carry the required entries. Exit 0 = pass, 1 = fail.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

const EXPECTED_PACKAGE = {
  name: 'triage-desk',
  version: '0.1.0',
  private: true,
  description: 'Support ticket triage with an AI suggestion and a labelled deterministic fallback',
  license: 'UNLICENSED',
  engines: { node: '>=22' },
  scripts: {
    start: 'node src/server.js',
    test: 'node --test --test-concurrency=1 "test/**/*.test.js"',
    eval: 'node eval/run.js',
    'eval:tune': 'node eval/run.js --split tune',
  },
};

check('package.json equals spec §Deployment (no dependencies, devDependencies or type)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepStrictEqual(pkg, EXPECTED_PACKAGE);
});

check('.env.example lists every C6.1 variable with the spec defaults', () => {
  const env = read('.env.example');
  for (const line of [
    'ANTHROPIC_API_KEY=',
    'ANTHROPIC_MODEL=claude-haiku-5-5',
    '# TRIAGE_ANTHROPIC_BASE_URL=https://api.anthropic.com',
    'HOST=127.0.0.1',
    '# TRIAGE_ALLOW_REMOTE=1',
    'PORT=3000',
    'TRIAGE_TIMEOUT_MS=20000',
    'TRIAGE_MAX_TOKENS=2048',
  ]) {
    assert.ok(env.split('\n').some((l) => l.trim() === line), `missing line: ${line}`);
  }
  assert.ok(!/^ANTHROPIC_BASE_URL=/m.test(env), 'must not define ANTHROPIC_BASE_URL (DES-1)');
  assert.ok(!/^ANTHROPIC_API_KEY=\S/m.test(env), 'ANTHROPIC_API_KEY must be empty in the example');
});

check('.gitignore ignores .env and node_modules/', () => {
  const lines = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('.env'), 'missing .env');
  assert.ok(lines.includes('node_modules/'), 'missing node_modules/');
});

if (failures.length) {
  console.log(`scaffold-check FAIL ${failures.length} check(s)`);
  process.exit(1);
}
console.log('scaffold-check PASS');
