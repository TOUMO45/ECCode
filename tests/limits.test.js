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

test('every registered limit has a valid disposition, and open ones are counted in the header', () => {
  const r = rows();
  assert.ok(r.length >= 27, `expected the full register, got ${r.length} rows`);
  assert.deepStrictEqual(r.map((x) => x.n), r.map((_, i) => i + 1), 'rows are numbered 1..N without gaps');
  for (const x of r) assert.match(x.disposition, /^(Closed — (eliminated|by design)|Open — (mitigated|named))$/, `row ${x.n}: ${x.disposition}`);
  const open = r.filter((x) => x.disposition.startsWith('Open'));
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'limits.md'), 'utf8');
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  assert.match(text, new RegExp(`\\*\\*${words[open.length]} limits? (is|are) open\\*\\* \\(rows? ${open.map((x) => x.n).join(', ')}\\)`), 'header must state exactly which rows are open');
});

test('the register is one unbroken table (renders as a table on GitHub)', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'docs', 'limits.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.startsWith('| # |'));
  const last = lines.map((l) => /^\| \d+ \|/.test(l)).lastIndexOf(true);
  assert.ok(first >= 0 && last > first);
  for (let i = first; i <= last; i++) assert.ok(lines[i].startsWith('|'), `line ${i + 1} breaks the table: "${lines[i]}"`);
});

test('figures quoted in the docs match what bench tally derives from the records', () => {
  const t = bench.tally(path.join(ROOT, 'bench', 'results'));
  const bad = [];
  for (const doc of ['docs/senior-engineering.md', 'docs/final-report.md', 'docs/limits.md', 'README.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(/(\d+) live agent runs/g)) if (Number(m[1]) !== t.total.runs) bad.push(`${doc}: "${m[0]}" (records: ${t.total.runs})`);
    for (const m of text.matchAll(/(\d+)\/(\d+) hidden checks/g)) if (Number(m[1]) !== t.total.hiddenPassed || Number(m[2]) !== t.total.hiddenTotal) bad.push(`${doc}: "${m[0]}" (records: ${t.total.hiddenPassed}/${t.total.hiddenTotal})`);
    for (const m of text.matchAll(/−(\d+\.\d+) lines per change|(\d+\.\d+) fewer lines per change/g)) {
      const v = Number(m[1] || m[2]);
      if (Math.abs(v + t.stratified.delta) > 0.005) bad.push(`${doc}: "${m[0]}" (records: ${(-t.stratified.delta).toFixed(2)})`);
    }
  }
  assert.deepStrictEqual(bad, []);
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
  assert.match(out, /never loaded src\/target.js, so this trace says nothing about the runtime callers of that target/, out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('by design (row 5): reports grade their own sample size', () => {
  const rec = (variant, lines) => ({ task: 't', variant, hiddenPassed: 1, hiddenTotal: 1, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  assert.match(bench.report([rec('without', 3), rec('with', 2)], { agentCmd: 'x' }), /demonstration, not a statistic/);
  const big = [];
  for (let i = 0; i < 10; i++) big.push(rec('without', 10 + i), rec('with', 5 + i));
  assert.doesNotMatch(bench.report(big, { agentCmd: 'x' }), /demonstration, not a statistic/);
});
