'use strict';
// Contract test for package.json (spec §Deployment; brief AC12): zero dependencies, exact scripts, engines.node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../helpers/spawn-server.js');

const pkgPath = path.join(PROJECT_ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

test('AC12: no dependencies or devDependencies of any kind', () => {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert.equal(Object.hasOwn(pkg, key), false, `package.json must not declare ${key}`);
  }
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'node_modules')), false, 'no node_modules directory is needed');
});

test('§Deployment: exact scripts', () => {
  assert.deepEqual(pkg.scripts, {
    start: 'node src/server.js',
    test: 'node --test --test-concurrency=1 "test/**/*.test.js"',
    eval: 'node eval/run.js',
    'eval:tune': 'node eval/run.js --split tune',
  });
});

test('§Deployment: engines.node and the exact package fields, no "type"', () => {
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.equal(Object.hasOwn(pkg, 'type'), false, 'no "type" field (CommonJS)');
  assert.deepEqual(
    { name: pkg.name, version: pkg.version, private: pkg.private, description: pkg.description, license: pkg.license },
    {
      name: 'triage-desk',
      version: '0.1.0',
      private: true,
      description: 'Support ticket triage with an AI suggestion and a labelled deterministic fallback',
      license: 'UNLICENSED',
    },
  );
  assert.deepEqual(Object.keys(pkg).sort(), ['description', 'engines', 'license', 'name', 'private', 'scripts', 'version']);
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 22, `the running Node (${process.versions.node}) satisfies engines.node`);
});

test('AC12: the scripts reference files that exist', () => {
  for (const rel of ['src/server.js', 'eval/run.js']) {
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, rel)), `${rel} exists`);
  }
});
