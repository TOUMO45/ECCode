'use strict';
// The delivery run's analysis (spec docs/specs/2026-10-27-delivery-run-design.md).
// One stage: 2 engine runs and 2 bare runs on every mealie4 item. The primary
// criterion is delivery over the planned engine runs, so a run a cost ceiling
// kept from starting counts as not delivered; the proof run's functions do the
// counting and the multi-file run's marks a run cut by the timeout.
// usage: node bench/pilot/delivery.js --runs <dir> --labels <failures.json> --refusals <refusals.json> --planned 32 [--in-sample 01,05,07] [--out <file.md>]
const fs = require('fs');
const path = require('path');
const { readRuns, passed, runKeys, primary, friction: frictionOf } = require('./proof');
const { marked, withTests, idOrder } = require('./multifile');

// The registered run limit (--timeout 14400) and the figure reported beside it.
const LIMIT_MS = 14400000;
const WITHIN_MS = 7200000;
// Each item's planned runs per variant: the in-sample share of the planned runs.
const PER_ITEM = 2;

const delivered = (r) => Boolean(r.engine && r.engine.delivered && r.engine.auditOk);
// n/of planned engine runs (p%): what the criteria count.
const runsOf = (n, of) => `${n}/${of} planned engine runs${of ? ` (${Math.round((n / of) * 100)}%)` : ''}`;
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const testLine = (t) => (t ? `Stratified permutation test: difference ${t.delta.toFixed(3)}, p = ${t.p.toFixed(4)} (${t.strata} items, ${t.runs} runs).` : 'Stratified permutation test: no item has runs of both variants.');

/** Reviewed rescopes in the engine runs' copied records (tr-<process>/<run>/record/events.jsonl). */
function rescopes(dir, rows) {
  const out = { proposed: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    if (r.variant !== 'engine' || !r.transcripts || !r.transcripts.dir) continue;
    const file = path.join(dir, `tr-${r.process}`, r.transcripts.dir, 'record', 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())) {
      const ev = JSON.parse(line);
      if (ev.type === 'task.rescope_proposed') out.proposed += 1;
      else if (ev.type === 'task.rescoped' && ev.data && ev.data.proposal) out.approved += 1;
      else if (ev.type === 'task.rescope_reviewed' && ev.data && ev.data.decision === 'reject') out.rejected += 1;
    }
  }
  return out;
}

/** The registered analysis: the primary and secondary criteria, then what is reported without one. */
function report({ engine, bare, labels, friction: f, rescopes: rs, planned, inSample, withinMs = WITHIN_MS, perItem = PER_ITEM }) {
  [engine, bare] = [marked(engine, LIMIT_MS), marked(bare, LIMIT_MS)];
  if (engine.some((r) => r.variant !== 'engine')) throw new Error('a run passed as engine is not an engine run');
  if (bare.some((r) => r.variant !== 'without')) throw new Error('a run passed as bare is not a bare run');
  if (engine.length > planned) throw new Error(`more engine runs than planned: ${engine.length} > ${planned}`);
  const all = [...engine, ...bare];
  const keys = runKeys(all);
  const unlabelled = all.map((r, i) => [r, keys[i]]).filter(([r, k]) => !passed(r) && !labels[k]).map(([, k]) => k);
  if (unlabelled.length) throw new Error(`unlabelled failed runs: ${unlabelled.join(', ')}`);

  const done = engine.filter(delivered);
  const lines = ['# Delivery run: analysis', '', '## Criteria', ''];
  const notStarted = planned - engine.length;
  lines.push(`- **Delivery (primary):** ${runsOf(done.length, planned)} delivered with a clean audit within the 4-hour limit${notStarted ? `; ${notStarted} planned run${notStarted === 1 ? '' : 's'} never started, counted as not delivered` : ''}. Rule at least 80% of planned runs: ${done.length >= 0.8 * planned ? 'met' : 'missed'}.`);
  if (f) {
    const n = f.unlabelled.length;
    if (!f.runs) lines.push('- **Friction (secondary):** no verdict: no engine run.');
    else lines.push(n
      ? `- **Friction (secondary):** no verdict yet: ${n} refusal${n === 1 ? '' : 's'} unlabelled.`
      : `- **Friction (secondary):** ${f.false} false refusal${f.false === 1 ? '' : 's'} in ${f.runs} engine runs (${f.perRun.toFixed(2)} per run) among ${f.refusals} refusals; rule at most 1 per run: ${f.perRun <= 1 ? 'met' : 'missed'}.`);
  }

  lines.push('', '## Reported, no criterion', '');
  lines.push(`- **Within 2 hours:** ${runsOf(done.filter((r) => r.durationMs <= withinMs).length, planned)} delivered and ended within ${(withinMs / 1000).toLocaleString('en-US')} s.`);
  const inPlanned = perItem * inSample.length;
  const inRuns = done.filter((r) => inSample.includes(r.task)).length;
  lines.push(`- **In-sample (${inSample.join(', ') || 'none'}):** ${runsOf(inRuns, inPlanned)} delivered.`);
  lines.push(`- **Out-of-sample:** ${runsOf(done.length - inRuns, planned - inPlanned)} delivered.`);
  const items = [...new Set(all.map((r) => r.task))];
  const c = primary(all, items);
  lines.push(`- **Hidden checks, engine against bare:** engine ${c.engine.passed}/${c.engine.runs}, bare ${c.without.passed}/${c.without.runs} (a run cut by the timeout fails). ${testLine(c.test)}`);
  if (rs) lines.push(`- **Rescopes:** ${rs.proposed} proposed, ${rs.approved} approved, ${rs.rejected} rejected.`);
  const cost = (rows) => { const m = median(rows.map((r) => (r.usage ? r.usage.costUsd : undefined))); return m === null ? '—' : `$${m.toFixed(2)}`; };
  const min = (rows) => { const m = median(rows.map((r) => r.durationMs)); return m === null ? '—' : `${(m / 60000).toFixed(1)} min`; };
  lines.push(`- **Median cost:** engine ${cost(engine)}, bare ${cost(bare)}. **Median run time:** engine ${min(engine)}, bare ${min(bare)}.`);
  const tests = (rows) => { const x = withTests(rows); return `${x.n}/${x.runs}`; };
  lines.push(`- **Runs whose patch adds or changes tests:** engine ${tests(engine)}, bare ${tests(bare)}.`);
  lines.push(`- **Timeouts:** engine ${engine.filter((r) => r.timedOut).length}, bare ${bare.filter((r) => r.timedOut).length}.`);

  lines.push('', '## By item', '', '| Item | Engine delivered | Engine passed | Bare passed |', '|---|---|---|---|');
  const byOrder = (x, y) => (idOrder(x) - idOrder(y)) || x.localeCompare(y);
  for (const t of items.sort(byOrder)) {
    const e = engine.filter((r) => r.task === t);
    const b = bare.filter((r) => r.task === t);
    lines.push(`| ${t}${inSample.includes(t) ? ' (in-sample)' : ''} | ${e.filter(delivered).length}/${e.length} | ${e.filter(passed).length}/${e.length} | ${b.filter(passed).length}/${b.length} |`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { report, rescopes, LIMIT_MS, WITHIN_MS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : null);
  const dir = opt('runs');
  const rows = marked(readRuns(dir), LIMIT_MS);
  const engine = rows.filter((r) => /^e\d+$/.test(r.process));
  const bare = rows.filter((r) => r.process === 'w');
  const labels = JSON.parse(fs.readFileSync(opt('labels'), 'utf8'));
  const refusals = opt('refusals') ? JSON.parse(fs.readFileSync(opt('refusals'), 'utf8')) : null;
  const orders = (opt('in-sample') || '01,05,07').split(',').map(Number);
  const inSample = [...new Set(rows.map((r) => r.task))].filter((t) => orders.includes(idOrder(t)));
  const md = report({
    engine, bare, labels, planned: Number(opt('planned')), inSample,
    friction: refusals ? frictionOf(dir, engine, refusals) : null,
    rescopes: rescopes(dir, engine),
  });
  if (opt('out')) fs.writeFileSync(opt('out'), md);
  process.stdout.write(md);
}
