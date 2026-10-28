'use strict';
// The proof run's analysis (bench/protocols/2026-10-26-mealie-proof.md).
// Stage 1 runs every item bare and through the engine; an item is hard when a
// stage-1 bare run failed a hidden check and that failure is labelled
// agent-error (the request states what the failing test checks). The primary
// comparison uses stage-2 runs on the hard items only: the stage-1 bare runs
// chose the items, so they would bias it.
// usage: node bench/pilot/proof.js --stage1 <dir> --labels <file> [--stage2 <dir>] [--refusals <file>] [--out <file.md>]
const fs = require('fs');
const path = require('path');
const { stratifiedTest } = require('../../lib/bench');
const { extractRefusals } = require('./refusals');

const readRuns = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => ({ process: path.basename(f, '.jsonl'), ...JSON.parse(l) })));

/** Passed every hidden check; a run with no result line (cut, or no checks ran) did not. */
// A run cut by the timeout fails whatever its hidden checks (the protocols' rule).
const passed = (r) => !r.timedOut && r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

/** One key per run: process:task:n, n counting that process's runs of the task from 1. */
function runKeys(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const k = `${r.process}:${r.task}`;
    seen.set(k, (seen.get(k) || 0) + 1);
    return `${k}:${seen.get(k)}`;
  });
}

/** Items a stage-1 bare run failed by agent error; throws if a failed bare run has no label. */
function hardItems(stage1, labels) {
  const keys = runKeys(stage1);
  const hard = new Set();
  const unlabelled = [];
  stage1.forEach((r, i) => {
    if (r.variant !== 'without' || passed(r)) return;
    const l = labels[keys[i]];
    if (!l) unlabelled.push(keys[i]);
    else if (l.label === 'agent-error') hard.add(r.task);
  });
  if (unlabelled.length) throw new Error(`unlabelled failed bare runs: ${unlabelled.join(', ')}`);
  return [...hard].sort();
}

const tally = (rows) => ({ passed: rows.filter(passed).length, runs: rows.length });

/** Stage-2 engine against bare on the hard items: counts and the stratified permutation test. */
function primary(stage2, hard) {
  const rows = stage2.filter((r) => hard.includes(r.task));
  const engine = rows.filter((r) => r.variant === 'engine');
  const without = rows.filter((r) => r.variant === 'without');
  const test = stratifiedTest(rows.map((r) => ({ stratum: r.task, variant: r.variant === 'engine' ? 'with' : 'without', lines: passed(r) ? 1 : 0 })));
  return { engine: tally(engine), without: tally(without), test };
}

/** Engine runs delivered with a clean audit; a run with no result counts as not delivered. */
function delivery(rows) {
  const engine = rows.filter((r) => r.variant === 'engine');
  const delivered = engine.filter((r) => r.engine && r.engine.delivered && r.engine.auditOk).length;
  return { delivered, runs: engine.length, share: engine.length ? delivered / engine.length : null };
}

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

/**
 * False refusals per engine run (row 105's rule: at most 1). Refusals come
 * from the engine processes' transcripts (tr-<process>), not their record
 * copies. Each id is <process>/<file under tr-<process>>:<line>, the
 * extractor's line id prefixed with where the transcript lies; the labels use it.
 */
function friction(dir, rows, labels) {
  const engine = rows.filter((r) => r.variant === 'engine');
  // Only the given runs' own transcript directories: a cut or abandoned run's
  // transcripts can sit beside them under tr-<process> without being in the reading.
  const own = [...new Set(engine.filter((r) => r.transcripts && r.transcripts.dir).map((r) => `${r.process}/${r.transcripts.dir}`))].sort();
  const refusals = own.flatMap((key) => {
    const [proc, run] = key.split('/');
    const base = path.join(dir, `tr-${proc}`);
    return walk(path.join(base, run))
      .filter((f) => f.endsWith('.jsonl') && !f.includes(`${path.sep}record${path.sep}`))
      .flatMap((f) => extractRefusals(fs.readFileSync(f, 'utf8'), `${proc}/${path.relative(base, f).split(path.sep).join('/')}`));
  });
  const runs = engine.length;
  const falseOnes = refusals.filter((x) => labels[x.id] && labels[x.id].label === 'false').length;
  return { refusals: refusals.length, unlabelled: refusals.filter((x) => !labels[x.id]).map((x) => x.id), false: falseOnes, runs, perRun: runs ? falseOnes / runs : null };
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const cost = (r) => (r.usage ? r.usage.costUsd : undefined);

const testLine = (t) => (t ? `Stratified permutation test: difference ${t.delta.toFixed(3)}, p = ${t.p.toFixed(4)} (${t.strata} items, ${t.runs} runs).` : 'Stratified permutation test: no item has runs of both variants.');

/**
 * The registered analysis: the primary verdict over stage-2 runs on the hard
 * items, the two secondary criteria over stage-1 engine runs (friction only
 * once every refusal is labelled), and what is reported without a criterion.
 */
function report({ stage1, stage2, labels, friction: f }) {
  const tasks = [...new Set(stage1.map((r) => r.task))].sort();
  const lines = ['# Proof run: analysis', '', '## Stage 1: every item', '', '| Item | Bare passed | Engine passed |', '|---|---|---|'];
  for (const t of tasks) {
    const of = (v) => tally(stage1.filter((r) => r.task === t && r.variant === v));
    lines.push(`| ${t} | ${of('without').passed}/${of('without').runs} | ${of('engine').passed}/${of('engine').runs} |`);
  }
  const hard = hardItems(stage1, labels);
  lines.push('', `Hard items (a stage-1 bare run failed by agent error): ${hard.length ? hard.join(', ') : 'none'}.`, '', '## Criteria', '');
  const p = stage2 && hard.length ? primary(stage2, hard) : null;
  const ran = p && p.engine.runs + p.without.runs > 0;
  if (hard.length < 3) lines.push(`- **Primary:** no verdict: ${hard.length} hard item${hard.length === 1 ? '' : 's'}, fewer than 3 hard items.`);
  else if (!stage2) lines.push(`- **Primary:** pending: ${hard.length} hard items, stage 2 not run yet.`);
  else if (!ran) lines.push('- **Primary:** no verdict: no stage-2 run on the hard items.');
  else {
    // The engine's share is higher and the test, whose sign is per item, agrees.
    const met = Boolean(p.test) && p.engine.runs > 0 && p.without.runs > 0 && p.engine.passed / p.engine.runs > p.without.passed / p.without.runs && p.test.delta > 0 && p.test.p < 0.05;
    lines.push(`- **Primary:** ${met ? 'met' : 'missed'}: engine ${p.engine.passed}/${p.engine.runs}, bare ${p.without.passed}/${p.without.runs} on the hard items in stage 2.`);
  }
  if (ran) {
    if (hard.length < 3) lines.push(`  Stage 2 on the hard items: engine ${p.engine.passed}/${p.engine.runs}, bare ${p.without.passed}/${p.without.runs}.`);
    lines.push(`  ${testLine(p.test)}`);
  }
  const d = delivery(stage1);
  lines.push(`- **Delivery:** ${d.delivered}/${d.runs} stage-1 engine runs (${d.share === null ? '—' : `${(d.share * 100).toFixed(0)}%`}) delivered with a clean audit; rule at least 80%: ${d.share !== null && d.share >= 0.8 ? 'met' : 'missed'}.`);
  if (f) {
    const n = f.unlabelled.length;
    if (!f.runs) lines.push('- **Friction:** no verdict: no engine run.');
    else lines.push(n
      ? `- **Friction:** no verdict yet: ${n} refusal${n === 1 ? '' : 's'} unlabelled.`
      : `- **Friction:** ${f.false} false refusal${f.false === 1 ? '' : 's'} in ${f.runs} stage-1 engine runs (${f.perRun.toFixed(2)} per run) among ${f.refusals} refusals; rule at most 1 per run: ${f.perRun <= 1 ? 'met' : 'missed'}.`);
  }
  const s1 = primary(stage1, tasks);
  lines.push('', '## Reported, no criterion', '', `Stage 1, all items: engine ${s1.engine.passed}/${s1.engine.runs}, bare ${s1.without.passed}/${s1.without.runs}.`, testLine(s1.test));
  const of = (v, g) => median(stage1.filter((r) => r.variant === v).map(g));
  const ratio = of('engine', cost) / of('without', cost);
  const min = (v) => { const m = of(v, (r) => r.durationMs); return m === null ? '—' : (m / 60000).toFixed(1); };
  lines.push(`Median cost, engine over bare: ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : '—'}.`, `Median run time: engine ${min('engine')} min, bare ${min('without')} min.`);
  return `${lines.join('\n')}\n`;
}

module.exports = { readRuns, passed, runKeys, hardItems, primary, delivery, friction, report };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : null);
  const stage1 = readRuns(opt('stage1'));
  const refusals = opt('refusals') ? JSON.parse(fs.readFileSync(opt('refusals'), 'utf8')) : null;
  const md = report({ stage1, stage2: opt('stage2') ? readRuns(opt('stage2')) : null, labels: JSON.parse(fs.readFileSync(opt('labels'), 'utf8')), friction: refusals && friction(opt('stage1'), stage1, refusals) });
  if (opt('out')) fs.writeFileSync(opt('out'), md);
  process.stdout.write(md);
}
