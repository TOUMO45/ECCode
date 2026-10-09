// NFR1 scan of package.json: no runtime dependencies, only @playwright/test as a devDependency,
// engines.node >= 22.13, and the flag-free Node gate in front of every script that passes
// a version-specific flag to node (F-TR-4). Reads files only. The rules are plain functions,
// so the tests also run them on broken package.json objects and see them refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const GATE = 'node scripts/check-node.cjs &&';
// A flag that an older Node rejects before any script runs (bad option, exit 9).
const VERSION_FLAG = /(^|\s)(--disable-warning(=\S*)?|--experimental-sqlite|--import(=\S*)?|--test(-\S+)?|--env-file(=\S*)?)(\s|$)/;
// Scripts the spec names as flagged (Testing Strategy > Commands); pretest only gates.
const FLAGGED = ['start', 'seed', 'test', 'test:browser', 'test:live-model', 'test:live-paypal'];
const REQUIRED = [...FLAGGED, 'pretest', 'posttest'];

function dependencyProblems(p) {
  const problems = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (field in p) problems.push(`"${field}" must not exist (zero runtime dependencies)`);
  }
  if (JSON.stringify(p.devDependencies) !== JSON.stringify({ '@playwright/test': '1.56.1' })) {
    problems.push('devDependencies must be exactly {"@playwright/test":"1.56.1"}');
  }
  return problems;
}

function engineProblems(p) {
  const problems = [];
  if (JSON.stringify(p.engines) !== JSON.stringify({ node: '>=22.13' })) problems.push('engines must be exactly {"node":">=22.13"}');
  if (p.type !== 'module') problems.push('type must be "module"');
  if (p.private !== true) problems.push('private must be true');
  if (p.license !== 'MIT') problems.push('license must be "MIT"');
  return problems;
}

function gateProblems(p) {
  const scripts = p.scripts ?? {};
  const problems = [];
  for (const name of REQUIRED) if (typeof scripts[name] !== 'string') problems.push(`scripts.${name} is missing`);
  for (const [name, cmd] of Object.entries(scripts)) {
    const flagged = VERSION_FLAG.test(cmd) || FLAGGED.includes(name) || name === 'pretest';
    if (!flagged) continue;
    if (!String(cmd).startsWith(`${GATE} `)) problems.push(`scripts.${name} does not begin with "${GATE}"`);
    else if (cmd.split('scripts/check-node.cjs').length !== 2) problems.push(`scripts.${name} runs the gate more than once`);
  }
  for (const name of FLAGGED) {
    if (typeof scripts[name] === 'string' && !VERSION_FLAG.test(scripts[name])) problems.push(`scripts.${name} was expected to pass a version-specific flag`);
  }
  return problems;
}

test('NFR1: package.json has no dependencies, only the @playwright/test devDependency', () => {
  assert.deepEqual(dependencyProblems(pkg), []);
  assert.deepEqual(pkg.devDependencies, { '@playwright/test': '1.56.1' });
  assert.equal('dependencies' in pkg, false);
});

test('NFR1: package.json declares engines.node >= 22.13 and the module, private and licence fields', () => {
  assert.deepEqual(engineProblems(pkg), []);
  assert.deepEqual(pkg.engines, { node: '>=22.13' });
});

test('NFR1: every script that passes a version-specific flag to node begins with the flag-free Node gate', () => {
  assert.deepEqual(gateProblems(pkg), []);
  for (const name of FLAGGED) {
    assert.equal(pkg.scripts[name].startsWith(`${GATE} `), true, `scripts.${name} begins with "${GATE}"`);
    assert.equal(VERSION_FLAG.test(pkg.scripts[name]), true, `scripts.${name} passes a version-specific flag`);
  }
  assert.equal(pkg.scripts.pretest.startsWith(`${GATE} `), true);
});

test('NFR1: the rules refuse a package.json that breaks them', () => {
  assert.equal(dependencyProblems({ ...pkg, dependencies: { express: '4' } }).length, 1);
  assert.equal(dependencyProblems({ ...pkg, devDependencies: { ...pkg.devDependencies, left_pad: '1' } }).length, 1);
  assert.equal(dependencyProblems({ ...pkg, devDependencies: { '@playwright/test': '^1.56.1' } }).length, 1);
  assert.equal(engineProblems({ ...pkg, engines: { node: '>=22.5' } }).length, 1);
  assert.equal(engineProblems({ ...pkg, engines: undefined }).length, 1);
  const ungated = { ...pkg, scripts: { ...pkg.scripts, start: 'node --disable-warning=ExperimentalWarning src/index.js' } };
  assert.deepEqual(gateProblems(ungated), [`scripts.start does not begin with "${GATE}"`]);
  const flagFirst = { ...pkg, scripts: { ...pkg.scripts, seed: 'node --experimental-sqlite scripts/seed.js && node scripts/check-node.cjs' } };
  assert.equal(gateProblems(flagFirst).length, 1);
  const extra = { ...pkg, scripts: { ...pkg.scripts, 'test:extra': 'node --import ./x.js y.js' } };
  assert.deepEqual(gateProblems(extra), [`scripts.test:extra does not begin with "${GATE}"`]);
  const doubled = { ...pkg, scripts: { ...pkg.scripts, start: `${GATE} ${GATE} node --disable-warning=ExperimentalWarning src/index.js` } };
  assert.equal(gateProblems(doubled).length, 1);
  const missing = { ...pkg, scripts: { ...pkg.scripts } };
  delete missing.scripts['test:browser'];
  assert.deepEqual(gateProblems(missing), ['scripts.test:browser is missing']);
});

test('NFR1: the start script is the two-step line the README gives and runs src/index.js', () => {
  assert.equal(pkg.scripts.start, 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.equal(readme.includes(pkg.scripts.start), true, 'README shows the same start line');
});

test('NFR1: npm test runs the offline suite with the net guard and never the browser or live suites', () => {
  const { test: testScript, pretest, posttest } = pkg.scripts;
  assert.match(testScript, /--import \.\/test\/helpers\/net-guard\.js/);
  assert.match(testScript, /--test(\s|$)/);
  for (const dir of ['unit', 'api', 'integration', 'eval', 'scan', 'timing']) {
    assert.equal(testScript.includes(`test/${dir}/**/*.test.js`), true, `test/${dir} is in npm test`);
  }
  assert.equal(/browser|live/.test(testScript), false, 'npm test names no browser or live suite');
  assert.match(pretest, /scripts\/reset-test-out\.js/);
  assert.match(posttest, /scripts\/report-p95\.js/);
});

test('NFR3: the browser and live suites are separate scripts', () => {
  assert.match(pkg.scripts['test:browser'], /test\/browser\/\*\*\/\*\.test\.js/);
  assert.match(pkg.scripts['test:live-model'], /test\/live\/run-live-model\.js/);
  assert.match(pkg.scripts['test:live-paypal'], /test\/live\/paypal\/\*\*\/\*\.test\.js/);
});

test('NFR1: the gate script is plain ES5 CommonJS (no import, export, arrow, const, let, class or template)', () => {
  const text = readFileSync(join(ROOT, 'scripts', 'check-node.cjs'), 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\b(import|export)\s/.test(code), false);
  assert.equal(/=>|\b(const|let|class)\b|`/.test(code), false);
});
