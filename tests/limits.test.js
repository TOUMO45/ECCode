'use strict';
// The limits register (docs/limits.md) is checked by CI, not asserted by its
// author: every row carries a valid disposition, every evidence file it cites
// exists, and each "Closed — by design" row's designed behavior is pinned here
// so a regression reopens the limit by failing the build.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const bench = require('../lib/bench');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'eccode.js');

function rows() {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'limits.md'), 'utf8').replace(/\r\n/g, '\n');
  return text.split('\n')
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => c.length >= 6 && /^\d+$/.test(c[1]))
    .map((c) => ({ n: Number(c[1]), limit: c[2], disposition: c[3], evidence: c[4] }));
}

test('every registered limit is dispositioned; none is open', () => {
  const r = rows();
  assert.ok(r.length >= 12, `expected the full register, got ${r.length} rows`);
  assert.deepStrictEqual(r.map((x) => x.n), r.map((_, i) => i + 1), 'rows are numbered 1..N without gaps');
  for (const x of r) assert.match(x.disposition, /^Closed — (eliminated|by design)$/, `row ${x.n}: ${x.disposition}`);
});

test('every file the register cites as evidence exists', () => {
  const missing = [];
  for (const x of rows()) {
    for (const m of x.evidence.matchAll(/(?:^|[\s(`])((?:docs|lib|tests|scripts|bench|\.github)\/[\w./-]+\.(?:md|js|mjs|cjs|py|yml))/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`row ${x.n}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('by design (row 4): a trace that never loads the target says so instead of implying "no callers"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-limits-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'target.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'other.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(dir, 'run.js'), "require('./src/other');\n");
  const r = spawnSync(process.execPath, [CLI, 'impact', 'src/target.js', '--trace', '--', 'node run.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir } });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /never loaded the target, so this trace says nothing about its runtime callers/, out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('by design (row 5): reports grade their own sample size', () => {
  const rec = (variant, lines) => ({ task: 't', variant, hiddenPassed: 1, hiddenTotal: 1, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  assert.match(bench.report([rec('without', 3), rec('with', 2)], { agentCmd: 'x' }), /demonstration, not a statistic/);
  const big = [];
  for (let i = 0; i < 10; i++) big.push(rec('without', 10 + i), rec('with', 5 + i));
  assert.doesNotMatch(bench.report(big, { agentCmd: 'x' }), /demonstration, not a statistic/);
});
