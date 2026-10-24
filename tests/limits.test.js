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
  if (open.length === 0) assert.match(text, /\*\*No limit is open\.\*\*/, 'header must say no limit is open');
  else assert.match(text, new RegExp(`\\*\\*${words[open.length]} limits? (is|are) open\\*\\* \\(rows? ${open.map((x) => x.n).join(', ')}\\)`), 'header must state exactly which rows are open');
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
  // The pre-registered Sonnet batch is analysed on its own, as its protocol says.
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sonnet-batch-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'bench', 'results')).filter((x) => x.startsWith('2026-10-23-sonnet-n10-'))) fs.copyFileSync(path.join(ROOT, 'bench', 'results', f), path.join(batchDir, f));
  const batch = bench.tally(batchDir).byModel.sonnet;
  fs.rmSync(batchDir, { recursive: true, force: true });
  assert.ok(batch && batch.runs === 160, 'the pre-registered Sonnet batch has 160 paired runs');
  const near = (a, b) => Math.abs(a - b) <= 0.005;
  const bad = [];
  for (const doc of ['docs/senior-engineering.md', 'docs/final-report.md', 'docs/limits.md', 'docs/lean.md', 'README.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(/(\d+) live agent runs/g)) if (Number(m[1]) !== t.total.runs) bad.push(`${doc}: "${m[0]}" (records: ${t.total.runs})`);
    for (const m of text.matchAll(/(\d+)\/(\d+) hidden checks/g)) if (Number(m[1]) !== t.total.hiddenPassed || Number(m[2]) !== t.total.hiddenTotal) bad.push(`${doc}: "${m[0]}" (records: ${t.total.hiddenPassed}/${t.total.hiddenTotal})`);
    // Pooled figures (both models) unless the phrase names its model.
    for (const m of text.matchAll(/(?:−(\d+\.\d+) lines per change|(\d+\.\d+) fewer lines per change)(?! on Haiku)/g)) {
      if (!near(-Number(m[1] || m[2]), t.stratified.delta)) bad.push(`${doc}: "${m[0]}" (records, pooled: ${t.stratified.delta.toFixed(2)})`);
    }
    for (const m of text.matchAll(/(\d+\.\d+) fewer lines per change on Haiku/g)) {
      if (!near(-Number(m[1]), t.byModel.haiku.stratified.delta)) bad.push(`${doc}: "${m[0]}" (records: ${t.byModel.haiku.stratified.delta.toFixed(2)})`);
    }
    for (const m of text.matchAll(/\+(\d+\.\d+) lines per change in the pre-registered Sonnet batch/g)) {
      if (!near(Number(m[1]), batch.stratified.delta)) bad.push(`${doc}: "${m[0]}" (records: ${batch.stratified.delta.toFixed(2)})`);
    }
    for (const m of text.matchAll(/runs writing tests ros(?:e|ing) from (\d+)\/(\d+) to (\d+)\/(\d+)/g)) {
      const want = [batch.testsWithout.wrote, batch.testsWithout.runs, batch.testsWith.wrote, batch.testsWith.runs];
      if (m.slice(1, 5).map(Number).join() !== want.join()) bad.push(`${doc}: "${m[0]}" (records: ${want[0]}/${want[1]} to ${want[2]}/${want[3]})`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('every file the register cites as evidence exists', () => {
  const missing = [];
  for (const x of rows()) {
    for (const m of x.evidence.matchAll(/(?:^|[\s(`])((?:docs|lib|tests|scripts|bench|\.github)\/[\w./-]+\.(?:md|js|mjs|cjs|py|yml|txt))/g)) {
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

test('row 5: reports still grade their own sample size', () => {
  const rec = (variant, lines) => ({ task: 't', variant, hiddenPassed: 1, hiddenTotal: 1, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  assert.match(bench.report([rec('without', 3), rec('with', 2)], { agentCmd: 'x' }), /demonstration, not a statistic/);
  const big = [];
  for (let i = 0; i < 10; i++) big.push(rec('without', 10 + i), rec('with', 5 + i));
  assert.doesNotMatch(bench.report(big, { agentCmd: 'x' }), /demonstration, not a statistic/);
});

test('by design (row 36): the follow-up records still meet the closing rule registered before they ran, and the docs quote them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-followup-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'bench', 'results')).filter((x) => x.startsWith('2026-10-23-sonnet-followup-'))) fs.copyFileSync(path.join(ROOT, 'bench', 'results', f), path.join(dir, f));
  const s = bench.tally(dir).byModel.sonnet;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(s && s.runs === 80 && s.codeStratified && s.codeStratified.runs === 80, 'the follow-up batch has 80 runs that record test lines');
  // bench/protocols/2026-10-23-sonnet-code-lines.md: the row closes only if the tests-excluded mean is <= 0.
  assert.ok(s.codeStratified.delta <= 0, `closing rule no longer holds: tests-excluded mean ${s.codeStratified.delta}`);
  const bad = [];
  for (const doc of ['docs/senior-engineering.md', 'docs/final-report.md', 'docs/limits.md', 'docs/lean.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    const quoted = [...text.matchAll(/−(\d+\.\d+) code lines per change in the pre-registered follow-up/g)];
    if (!quoted.length) bad.push(`${doc}: does not state the follow-up figure`);
    for (const m of quoted) if (Math.abs(-Number(m[1]) - s.codeStratified.delta) > 0.005) bad.push(`${doc}: "${m[0]}" (records: ${s.codeStratified.delta.toFixed(2)})`);
  }
  assert.deepStrictEqual(bad, []);
});

test('by design (row 49): metrics labels recorded usage as what was reported at run end', () => {
  const ctx = require('./helpers').tmpProject();
  const out = spawnSync(process.execPath, [CLI, '--root', ctx.dir, 'metrics'], { encoding: 'utf8' }).stdout;
  assert.match(out, /costPerTrack \(usage as reported at run end\)/);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('engine-benchmark figures quoted in the docs match what bench tally derives from the engine reports', () => {
  const t = bench.tally(path.join(ROOT, 'bench', 'engine-results'));
  const near = (a, b) => Math.abs(a - b) <= 0.005;
  const bad = [];
  let quoted = 0;
  for (const doc of ['docs/senior-engineering.md', 'docs/limits.md', 'README.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    const re = /\*\*(\w+), engine batch:\*\* (\d+)\/(\d+) runs passed every hidden check without the engine and (\d+)\/(\d+) with it.*?; median cost per run \$(\d+\.\d+) without and \$(\d+\.\d+) with the engine/g;
    for (const m of text.matchAll(re)) {
      quoted += 1;
      const e = t.engine[m[1].toLowerCase()];
      if (!e) { bad.push(`${doc}: no engine batch for ${m[1]}`); continue; }
      const want = [e.without.allPass, e.without.runs, e.engine.allPass, e.engine.runs].join();
      if (m.slice(2, 6).map(Number).join() !== want) bad.push(`${doc}: "${m[0].slice(0, 80)}…" (records: ${want})`);
      if (!near(Number(m[6]), e.without.medianCostUsd) || !near(Number(m[7]), e.engine.medianCostUsd)) bad.push(`${doc}: cost "${m[6]} / ${m[7]}" (records: ${e.without.medianCostUsd} / ${e.engine.medianCostUsd})`);
    }
  }
  assert.ok(quoted >= 1, 'the docs quote the engine batches');
  assert.deepStrictEqual(bad, []);
});

test('delivery follow-up figures quoted in the docs match the follow-up reports (row 56 closing rule)', () => {
  const report = (f) => fs.readFileSync(path.join(ROOT, 'bench', 'engine-followup', f), 'utf8');
  const delivered = (text) => {
    const row = text.split('\n').find((l) => l.startsWith('| **all tasks** |'));
    return row.split('|')[8].trim().split(' / ')[0];
  };
  assert.strictEqual(delivered(report('2026-10-23-engine-followup-sonnet.md')), '16/20');
  const second = delivered(report('2026-10-23-engine-followup-2-sonnet.md'));
  assert.ok(Number(second.split('/')[0]) >= 18, `row 56 closes only at >= 18/20 (bench/protocols/2026-10-23-engine-delivery-followup-2.md): ${second}`);
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'senior-engineering.md'), 'utf8');
  assert.match(doc, new RegExp(`Delivery went from 6/20 to 16/20 to ${second.replace('/', '\\/')}`));
});
