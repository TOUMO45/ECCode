import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../http/app-fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gatePath = join(root, 'scripts', 'check-node.cjs');
const require = createRequire(import.meta.url);
const gate = require(gatePath);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const PREFIX = 'node scripts/check-node.cjs &&';
const MESSAGE = /^RescueStock needs Node >= 22\.13 \(found \d+\.\d+\.\d+\)\. See README\.$/;

function oldNodeBinaries() {
  const candidates = ['/opt/node20/bin/node', '/opt/node21/bin/node'];
  for (const extra of (process.env.RS_OLD_NODE_BINS || '').split(',')) if (extra.trim()) candidates.push(extra.trim());
  return [...new Set(candidates)].filter((bin) => existsSync(bin));
}

test('NFR1: the gate accepts Node 22.13.0 and newer and refuses anything older', () => {
  for (const v of ['22.13.0', '22.13.1', '22.14.0', '22.22.0', '23.0.0', '24.1.2', '100.0.0']) {
    assert.equal(gate.check(v).ok, true, v);
  }
  for (const v of ['22.12.9', '22.5.0', '22.0.0', '21.7.3', '20.20.0', '18.19.1', '16.0.0', '8.17.0']) {
    assert.equal(gate.check(v).ok, false, v);
  }
  assert.equal(gate.check('not a version').ok, false);
});

test('NFR1: the gate message is exactly "RescueStock needs Node >= 22.13 (found X). See README."', () => {
  assert.equal(gate.check('20.20.0').message, 'RescueStock needs Node >= 22.13 (found 20.20.0). See README.');
  assert.equal(gate.message('18.0.0'), 'RescueStock needs Node >= 22.13 (found 18.0.0). See README.');
});

test('F-TR-4: scripts/check-node.cjs uses only ES5 syntax and no node: imports', () => {
  const source = readFileSync(gatePath, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const forbidden = [
    [/=>/, 'arrow function'],
    [/\b(let|const)\b/, 'let/const'],
    [/`/, 'template literal'],
    [/\basync\b|\bawait\b/, 'async/await'],
    [/\bclass\s+\w/, 'class'],
    [/\.\.\./, 'spread/rest'],
    [/\?\./, 'optional chaining'],
    [/\?\?/, 'nullish coalescing'],
    [/\bimport\b|\bexport\b/, 'ES module syntax'],
    [/require\(\s*['"]node:/, 'node: specifier'],
    [/\bfor\s*\([^)]*\bof\b/, 'for...of'],
    [/\*\*/, 'exponent operator'],
  ];
  for (const [pattern, name] of forbidden) assert.doesNotMatch(code, pattern, `check-node.cjs must not use ${name}`);
  assert.match(source, /^\/\*/, 'file documents itself');
});

test('F-TR-4: the gate runs flag-free on this Node and exits 0 silently', () => {
  const result = spawnSync(process.execPath, [gatePath], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('F-TR-4: on an older Node the gate prints the floor message and exits 1', (t) => {
  const bins = oldNodeBinaries();
  if (bins.length === 0) {
    t.skip('no older Node binary found (/opt/node20, /opt/node21 or RS_OLD_NODE_BINS)');
    return;
  }
  for (const bin of bins) {
    const result = spawnSync(bin, [gatePath], { encoding: 'utf8' });
    assert.equal(result.status, 1, bin);
    assert.match(result.stderr.trim(), MESSAGE, bin);
  }
});

test('F-TR-4: the exact start script stops at the gate on an older Node, before any flagged node runs', (t) => {
  const bins = oldNodeBinaries();
  if (bins.length === 0) {
    t.skip('no older Node binary found (/opt/node20, /opt/node21 or RS_OLD_NODE_BINS)');
    return;
  }
  for (const [index, bin] of bins.entries()) {
    const shimDir = join(tempDir('rs-oldnode-'), `bin${index}`);
    mkdirSync(shimDir, { recursive: true });
    symlinkSync(bin, join(shimDir, 'node'));
    for (const name of ['start', 'seed', 'test:browser', 'test:live-model', 'test:live-paypal']) {
      const result = spawnSync('/bin/sh', ['-c', pkg.scripts[name]], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      });
      assert.notEqual(result.status, 0, `${name} on ${bin}`);
      assert.match(result.stderr, /needs Node >= 22\.13 \(found/, `${name} on ${bin}`);
      assert.doesNotMatch(result.stderr, /bad option/i, `${name} on ${bin}: the flagged node must not run`);
    }
  }
});

test('F-TR-4: src/index.js repeats the check and exits 1 on an older Node before loading node:sqlite', (t) => {
  const source = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  assert.match(source, /RescueStock needs Node >= 22\.13 \(found \$\{process\.versions\.node\}\)\. See README\./);
  assert.doesNotMatch(source, /^import\s/m, 'index.js has no static imports');
  assert.ok(source.indexOf('meetsFloor(process.versions.node)') < source.indexOf("import('node:sqlite')"));
  assert.ok(source.indexOf("import('node:sqlite')") < source.indexOf("import('./main.js')"));

  const bins = oldNodeBinaries();
  if (bins.length === 0) {
    t.skip('no older Node binary found for the run half of this check');
    return;
  }
  for (const bin of bins) {
    const result = spawnSync(bin, [join(root, 'src', 'index.js')], { encoding: 'utf8' });
    assert.equal(result.status, 1, bin);
    assert.match(result.stderr.trim(), MESSAGE, bin);
  }
});

test('F-TR-4: every npm script that passes a flag to node starts with the gate', () => {
  const flagged = /\bnode\s+(?:--|[^&|;]*?\s--)/;
  let checked = 0;
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (flagged.test(command)) {
      checked += 1;
      assert.ok(command.startsWith(PREFIX), `script "${name}" passes a flag to node and must start with "${PREFIX}"`);
    }
  }
  assert.ok(checked >= 6, 'the flagged scripts were found');
  assert.equal(pkg.scripts.pretest.startsWith(PREFIX), true);
});

test('NFR1: package.json is exactly as the Deployment section specifies', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.engines, { node: '>=22.13' });
  assert.equal(pkg.dependencies, undefined, 'zero runtime dependencies');
  assert.deepEqual(pkg.devDependencies, { '@playwright/test': '1.56.1' });
  assert.deepEqual(pkg.scripts, {
    start: 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js',
    seed: 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning scripts/seed.js',
    pretest: 'node scripts/check-node.cjs && node scripts/reset-test-out.js',
    test:
      'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test --test-concurrency=4 "test/unit/**/*.test.js" "test/api/**/*.test.js" "test/integration/**/*.test.js" "test/eval/**/*.test.js" "test/scan/**/*.test.js" "test/timing/**/*.test.js"',
    posttest: 'node scripts/report-p95.js',
    'test:browser':
      'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "test/browser/**/*.test.js"',
    'test:live-model': 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning test/live/run-live-model.js',
    'test:live-paypal':
      'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "test/live/paypal/**/*.test.js"',
  });
});

test('NFR4: .gitignore covers data/, .env, reports/, test/.out/ and test/browser/out/ and keeps .env.example', () => {
  const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const entry of ['data/', '.env', 'reports/', 'test/.out/', 'test/browser/out/']) {
    assert.ok(lines.includes(entry), `.gitignore lists ${entry}`);
  }
  assert.ok(lines.includes('!.env.example'));
});
