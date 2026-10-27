'use strict';
// The multi-file run's analysis (spec docs/specs/2026-10-26-multifile-run-design.md).
// Stage 1 screens every item with bare runs only; an item is hard when a
// stage-1 bare run failed a hidden check and that failure is labelled
// agent-error. Stage 2 runs both variants on the hard items (at most 6, drawn
// when there are more) and alone decides the primary comparison and the
// secondary criteria. The proof run's functions do the counting.
// usage: node bench/pilot/multifile.js --stage1 <dir> --labels <file> [--stage2 <dir>] [--refusals <file>] [--out <file.md>]
const fs = require('fs');
const path = require('path');
const { mulberry32 } = require('../../lib/bench');
const { shuffle } = require('./lib');
const { readRuns, passed, runKeys, hardItems, primary, delivery, friction: frictionOf } = require('./proof');

const MAX_HARD = 6;
// The registered timeout. Records from before the harness marked a timed-out
// run (timedOut) are known by their duration: only a killed agent runs this long.
const TIMEOUT_MS = 7200000;
// The runs of a saved file: typed lines (a process stopped at its --max-cost)
// are not runs, and a run cut by the timeout is marked.
const marked = (rows) => rows && rows.filter((r) => !r.type).map((r) => (!r.timedOut && r.durationMs >= TIMEOUT_MS ? { ...r, timedOut: true } : r));
/** An item's place in upstream order, from its id (mealie4-07-fix-… is 7). */
const idOrder = (id) => Number((/-(\d\d)-/.exec(id) || [])[1]);

/** The hard items stage 2 runs: all, in upstream order, or `max` of them drawn with mulberry32(42). */
function chooseHard(hard, order = idOrder, max = MAX_HARD) {
  const byOrder = (x, y) => (order(x) - order(y)) || x.localeCompare(y);
  const sorted = [...hard].sort(byOrder);
  if (sorted.length <= max) return sorted;
  return shuffle(sorted, mulberry32(42)).slice(0, max).sort(byOrder);
}

/** Runs whose patch adds or changes a backend test or a frontend spec file. */
function withTests(rows) {
  const touches = (patch) => [...String(patch || '').matchAll(/^\+\+\+ b\/(.+)$/gm)].some((m) => /^tests\/|\.(spec|test)\.ts$/.test(m[1]));
  return { n: rows.filter((r) => touches(r.patch)).length, runs: rows.length };
}

const tally = (rows) => ({ passed: rows.filter(passed).length, runs: rows.length });
const share = (t) => `${t.passed}/${t.runs}`;
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const testLine = (t) => (t ? `Stratified permutation test: difference ${t.delta.toFixed(3)}, p = ${t.p.toFixed(4)} (${t.strata} items, ${t.runs} runs).` : 'Stratified permutation test: no item has runs of both variants.');
const ON_HARD = 'stage-2 engine runs on the hard items';

/** The registered analysis, in the spec's order: screening, hard items, stage 2, criteria, the rest. */
function report({ stage1, stage2, labels, friction: f, order = idOrder }) {
  [stage1, stage2] = [marked(stage1), marked(stage2)];
  if (stage1.some((r) => r.variant !== 'without')) throw new Error('stage 1 is bare-only: an engine run was passed as stage 1');
  const byOrder = (x, y) => (order(x) - order(y)) || x.localeCompare(y);
  const tasks = [...new Set(stage1.map((r) => r.task))].sort(byOrder);
  const keys = runKeys(stage1);
  const lines = ['# Multi-file run: analysis', '', '## Stage 1: bare screening', '', '| Item | Bare passed | Failure labels |', '|---|---|---|'];
  for (const t of tasks) {
    const failed = stage1.map((r, i) => [r, keys[i]]).filter(([r]) => r.task === t && !passed(r));
    const named = failed.map(([, k]) => (labels[k] ? labels[k].label : 'unlabelled'));
    lines.push(`| ${t} | ${share(tally(stage1.filter((r) => r.task === t)))} | ${named.length ? named.join(', ') : '—'} |`);
  }
  const hard = hardItems(stage1, labels).sort(byOrder);
  const chosen = chooseHard(hard, order);
  lines.push('', `Hard items (a stage-1 bare run failed by agent error): ${hard.length ? hard.join(', ') : 'none'}.`);
  if (chosen.length < hard.length) lines.push(`Chosen for stage 2 (${chosen.length} drawn with mulberry32(42), in upstream order): ${chosen.join(', ')}.`);
  const rows2 = (stage2 || []).filter((r) => chosen.includes(r.task));
  if (stage2) {
    lines.push('', '## Stage 2: the hard items', '', '| Item | Bare passed | Engine passed |', '|---|---|---|');
    for (const t of chosen) {
      const of = (v) => { const x = tally(rows2.filter((r) => r.task === t && r.variant === v)); return x.runs ? share(x) : `no ${v === 'engine' ? 'engine' : 'bare'} run`; };
      lines.push(`| ${t} | ${of('without')} | ${of('engine')} |`);
    }
  }
  lines.push('', '## Criteria', '');
  const p = stage2 && chosen.length ? primary(stage2, chosen) : null;
  const ran = p && p.engine.runs + p.without.runs > 0;
  if (hard.length < 3) lines.push(`- **Primary:** no verdict: ${hard.length} hard item${hard.length === 1 ? '' : 's'}, fewer than 3 hard items.`);
  else if (!stage2) lines.push(`- **Primary:** pending: ${hard.length} hard items, stage 2 not run yet.`);
  else if (!ran) lines.push('- **Primary:** no verdict: no stage-2 run on the hard items.');
  else {
    // The engine's share is higher and the test, whose sign is per item, agrees.
    const met = Boolean(p.test) && p.engine.runs > 0 && p.without.runs > 0 && p.engine.passed / p.engine.runs > p.without.passed / p.without.runs && p.test.delta > 0 && p.test.p < 0.05;
    lines.push(`- **Primary:** ${met ? 'met' : 'missed'}: engine ${share(p.engine)}, bare ${share(p.without)} on the hard items in stage 2.`);
  }
  if (ran) {
    if (hard.length < 3) lines.push(`  Stage 2 on the hard items: engine ${share(p.engine)}, bare ${share(p.without)}.`);
    lines.push(`  ${testLine(p.test)}`);
  }
  const d = delivery(rows2);
  lines.push(d.runs
    ? `- **Delivery:** ${d.delivered}/${d.runs} ${ON_HARD} (${(d.share * 100).toFixed(0)}%) delivered with a clean audit; rule at least 80%: ${d.share >= 0.8 ? 'met' : 'missed'}.`
    : '- **Delivery:** no verdict: no stage-2 engine run.');
  if (f) {
    const n = f.unlabelled.length;
    if (!f.runs) lines.push('- **Friction:** no verdict: no stage-2 engine run.');
    else lines.push(n
      ? `- **Friction:** no verdict yet: ${n} refusal${n === 1 ? '' : 's'} unlabelled.`
      : `- **Friction:** ${f.false} false refusal${f.false === 1 ? '' : 's'} in ${f.runs} ${ON_HARD} (${f.perRun.toFixed(2)} per run) among ${f.refusals} refusals; rule at most 1 per run: ${f.perRun <= 1 ? 'met' : 'missed'}.`);
  }
  const of = (v, g) => median(rows2.filter((r) => r.variant === v).map(g));
  const ratio = of('engine', (r) => (r.usage ? r.usage.costUsd : undefined)) / of('without', (r) => (r.usage ? r.usage.costUsd : undefined));
  const min = (v) => { const m = of(v, (r) => r.durationMs); return m === null ? '—' : (m / 60000).toFixed(1); };
  const tests = (rows) => { const x = withTests(rows); return `${x.n}/${x.runs}`; };
  lines.push('', '## Reported, no criterion', '', `Stage 1, all items: bare ${share(tally(stage1))}.`,
    `Median cost, engine over bare: ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : '—'} (stage-2 runs).`,
    `Median run time: engine ${min('engine')} min, bare ${min('without')} min (stage-2 runs).`,
    `Runs whose patch adds or changes tests: stage-2 engine ${tests(rows2.filter((r) => r.variant === 'engine'))}, stage-2 bare ${tests(rows2.filter((r) => r.variant === 'without'))}, stage-1 bare ${tests(stage1)}.`);
  return `${lines.join('\n')}\n`;
}

const jsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const cutRun = (r) => Boolean(r.infrastructure && r.infrastructure.neverStarted === false);

/**
 * The two readings of a stage after a container restart (protocol amendment 1),
 * as runs directories this script reads, each with links to tr-<process>:
 * registered: each process's registered/<process>.jsonl (cut and never-started
 * runs are failures), or its own file when the restart did not cut it;
 * continued: every run that ran, each cut run's record dropped and its
 * replacement (<rerun>/<process>.jsonl) appended after the stage.
 */
function readings(stage, rerun) {
  const out = { registered: path.join(stage, 'reading-registered'), continued: path.join(stage, 'reading-continued') };
  const write = (dir, p, rows) => fs.writeFileSync(path.join(dir, `${p}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  for (const dir of Object.values(out)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  for (const f of fs.readdirSync(stage).filter((x) => x.endsWith('.jsonl')).sort()) {
    const p = path.basename(f, '.jsonl');
    const own = jsonl(path.join(stage, f)).filter((r) => !r.type);
    const registered = path.join(stage, 'registered', f);
    write(out.registered, p, fs.existsSync(registered) ? jsonl(registered).filter((r) => !r.type) : own);
    write(out.continued, p, [...own.filter((r) => !cutRun(r)), ...(rerun ? jsonl(path.join(rerun, f)).filter((r) => !r.type) : [])]);
    if (fs.existsSync(path.join(stage, `tr-${p}`))) for (const dir of Object.values(out)) fs.symlinkSync(path.resolve(stage, `tr-${p}`), path.join(dir, `tr-${p}`));
  }
  return out;
}

module.exports = { chooseHard, withTests, report, idOrder, readings };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : null);
  const stage1 = marked(readRuns(opt('stage1')));
  const stage2 = opt('stage2') ? marked(readRuns(opt('stage2'))) : null;
  const labels = JSON.parse(fs.readFileSync(opt('labels'), 'utf8'));
  const refusals = opt('refusals') ? JSON.parse(fs.readFileSync(opt('refusals'), 'utf8')) : null;
  const chosen = chooseHard(hardItems(stage1, labels));
  const f = refusals && stage2 ? frictionOf(opt('stage2'), stage2.filter((r) => chosen.includes(r.task)), refusals) : null;
  const md = report({ stage1, stage2, labels, friction: f });
  if (opt('out')) fs.writeFileSync(opt('out'), md);
  process.stdout.write(md);
}
