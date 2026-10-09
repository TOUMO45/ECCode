// Eval runner (spec 8.2). Usage:
//   node eval/run.js --provider cli|fallback [--holdout] [--set incidents|injections|all]
//                    [--reps 3] [--model haiku] [--max-cost 3] [--out file.json]
//   node eval/run.js --verifier [--holdout]       (M1b, M1c only, no model)
// Exit codes: 0 all PASS, 1 any FAIL, 2 INCOMPLETE (or budget refusal), 3 NOT_RUN, 64 usage error / refused precondition.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../src/config.js';
import { createCliProvider } from '../src/ai/cli.js';
import { createFallbackProvider } from '../src/ai/fallback.js';
import { validateDraft } from '../src/ai/schema.js';
import { PROMPT_VERSION } from '../src/ai/prompt.js';
import { loadSet, loadVerifierCorpus } from './lib/load.js';
import { wilson } from './lib/wilson.js';
import { checkManifest } from './lib/manifest.js';
import { readLog, appendLog, checkBudget, checkHoldoutCap, createTracker } from './lib/budget.js';
import { scoreIncident, scoreInjection, scoreVerifier, judgeRate, mean, topFlagged } from './lib/score.js';
import { renderText } from './lib/report.js';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EVAL_DIR, '..');
const LOG_DIR = process.env.GW_EVAL_LOG_DIR ? path.resolve(process.env.GW_EVAL_LOG_DIR) : EVAL_DIR; // override is for tests only
const USAGE_LOG = path.join(LOG_DIR, 'usage.log');
const HOLDOUT_LOG = path.join(LOG_DIR, 'holdout-runs.log');
const CONCURRENCY = 2;

class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { provider: null, holdout: false, set: 'all', reps: null, model: null, maxCost: null, out: null, verifier: false };
  const val = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--holdout') o.holdout = true;
    else if (a === '--verifier') o.verifier = true;
    else if (a === '--provider') { o.provider = val(i, a); i += 1; }
    else if (a === '--set') { o.set = val(i, a); i += 1; }
    else if (a === '--reps') { o.reps = val(i, a); i += 1; }
    else if (a === '--model') { o.model = val(i, a); i += 1; }
    else if (a === '--max-cost') { o.maxCost = val(i, a); i += 1; }
    else if (a === '--out') { o.out = val(i, a); i += 1; }
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (!o.verifier && !['cli', 'fallback'].includes(o.provider)) throw new UsageError('--provider cli|fallback is mandatory');
  if (o.verifier && o.provider) throw new UsageError('--verifier takes no --provider');
  if (!['incidents', 'injections', 'all'].includes(o.set)) throw new UsageError('--set must be incidents, injections or all');
  if (o.reps !== null && !/^[1-5]$/.test(o.reps)) throw new UsageError('--reps must be 1..5');
  if (o.maxCost !== null && !(Number(o.maxCost) > 0)) throw new UsageError('--max-cost must be a positive number');
  if (o.model !== null && !/^[A-Za-z0-9._:-]{1,64}$/.test(o.model)) throw new UsageError('--model has invalid characters');
  return o;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const thresholds = () => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const sumW = (parts) => wilson(parts.reduce((a, p) => a + p.k, 0), parts.reduce((a, p) => a + p.n, 0));
const verdict = (pass) => (pass ? 'PASS' : 'FAIL');

/** Runs `tasks` (async fns) with bounded concurrency; stops starting new ones when stop() is true. */
async function pool(tasks, n, stop) {
  let next = 0;
  let skipped = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next];
      next += 1;
      if (stop()) { skipped += 1; continue; }
      await t();
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return skipped;
}

async function generateAll({ provider, docs, reps, tracker, failures, latencies, models, concurrency, perCallCap }) {
  const results = Array.from({ length: reps }, () => ({}));
  const tasks = [];
  for (let r = 0; r < reps; r += 1) {
    for (const doc of docs) {
      tasks.push(async () => {
        const started = Date.now();
        try {
          const out = await provider.generate({ incident: { title: doc.title, severity: doc.severity, startedAt: doc.startedAt }, lines: doc.lines });
          const v = validateDraft(out.draft);
          tracker.add(out.usage);
          if (out.usage?.model) models.add(out.usage.model);
          latencies.push(out.usage?.durationMs || Date.now() - started);
          results[r][doc.id] = { draft: v.ok ? v.draft : null, schemaValid: v.ok, isFallback: provider.isFallback, serialized: JSON.stringify(out.draft) };
        } catch (e) {
          tracker.fail();
          const code = e?.code ?? 'ERROR';
          failures.set(code, (failures.get(code) ?? 0) + 1);
          results[r][doc.id] = { draft: null, schemaValid: false, isFallback: provider.isFallback, serialized: null };
        }
      });
    }
  }
  const skipped = await pool(tasks, concurrency, () => tracker.exhausted());
  void perCallCap;
  return { results, skipped };
}

function score({ docsInc, docsInj, results, th, tier, kind, reps, incomplete }) {
  const slack = th.worstRunSlack;
  const perRep = [];
  const m1Parts = []; const m2Parts = []; const m3Parts = []; const flaggedAll = []; const perIncident = new Map();
  for (let r = 0; r < reps; r += 1) {
    let ver = 0; let st = 0; let tm = 0; let tt = 0; let am = 0; let at = 0;
    for (const d of docsInc) {
      const res = results[r][d.id];
      if (!res) continue;
      const s = scoreIncident(d, res.draft);
      ver += s.verified; st += s.statements; tm += s.timelineMatched; tt += s.timelineTotal; am += s.actionsMatched; at += s.actionsTotal;
      flaggedAll.push(...s.flagged);
      const pi = perIncident.get(d.id) ?? { v: 0, s: 0 };
      pi.v += s.verified; pi.s += s.statements; perIncident.set(d.id, pi);
    }
    m1Parts.push({ k: ver, n: st }); m2Parts.push({ k: tm, n: tt }); m3Parts.push({ k: am, n: at });
    perRep.push({ m1: st ? ver / st : null, m2: tt ? tm / tt : null, m3: at ? am / at : null });
  }
  const metrics = {};
  const rate = (key, parts, label) => {
    if (!docsInc.length) return null;
    const reps_ = perRep.map((p) => p[key]);
    if (reps_.some((x) => x === null)) return { verdict: 'FAIL', display: `${label}: no data (zero denominator in a repetition)` };
    const t = th[key][kind][tier];
    const j = judgeRate(reps_, t, kind === 'cli' ? slack : 0);
    const w = sumW(parts);
    return { verdict: verdict(j.pass), threshold: t, mean: j.mean, min: j.min, interval: w, perRep: reps_, display: `mean ${(100 * j.mean).toFixed(1)}% min ${(100 * j.min).toFixed(1)}% vs threshold ${(100 * t).toFixed(0)}%; Wilson95 ${iv(w)}` };
  };
  const iv = (w) => `${(100 * w.rate).toFixed(1)}% [${(100 * w.lo).toFixed(1)}, ${(100 * w.hi).toFixed(1)}] (${w.k}/${w.n})`;
  metrics.m1 = rate('m1', m1Parts, 'M1');
  metrics.m2 = rate('m2', m2Parts, 'M2');
  metrics.m3 = rate('m3', m3Parts, 'M3');

  if (docsInj.length) {
    let passes = 0; const detail = [];
    for (const d of docsInj) {
      const reps_ = [];
      for (let r = 0; r < reps; r += 1) { const res = results[r][d.id]; reps_.push(res ? scoreInjection(d, res.draft, res.schemaValid) : { pass: false }); }
      const ok = reps_.every((x) => x.pass);
      if (ok) passes += 1;
      detail.push({ id: d.id, pass: ok, failedChecks: reps_.filter((x) => !x.pass).map((x) => ['c1', 'c2', 'c3'].filter((c) => x[c] === false)) });
    }
    const t = th.m4[kind][tier];
    metrics.m4 = { verdict: verdict(passes >= t), passes, cases: docsInj.length, threshold: t, detail, display: `${passes} of ${docsInj.length} cases passed all ${reps} repetition(s); threshold ${t}` };
  } else metrics.m4 = null;

  let miss = null;
  if (kind === 'cli' && !incomplete && metrics.m1 && metrics.m1.verdict !== 'PASS') {
    const top = topFlagged(flaggedAll);
    const lowest = [...perIncident].map(([id, p]) => ({ id, m1: p.s ? p.v / p.s : 0 })).sort((a, b) => a.m1 - b.m1 || (a.id < b.id ? -1 : 1)).slice(0, 3);
    miss = { ...top, lowest };
  }
  return { metrics, perRep, miss };
}

async function main(argv) {
  const o = parseArgs(argv);
  const th = thresholds();
  const tier = o.holdout ? 'holdout' : 'tune';
  const at = new Date().toISOString();
  const commit = gitCommit();
  const out = (text) => process.stdout.write(text);
  const notes = [];

  let manifestHash = null;
  if (o.holdout) {
    const m = checkManifest(path.join(EVAL_DIR, 'holdout'));
    if (!m.ok) { process.stderr.write(`HOLDOUT ABORTED: manifest check failed:\n  ${m.problems.join('\n  ')}\n`); return 64; }
    manifestHash = m.manifestHash;
  }

  const base = {
    at, set: o.verifier ? 'verifier' : o.set, holdout: o.holdout, promptVersion: PROMPT_VERSION, gitCommit: commit, manifestHash,
    cliVersion: null, models: [], notes,
  };
  const emit = (report, code) => {
    const text = renderText(report);
    out(text);
    const file = o.out ?? path.join(EVAL_DIR, 'reports', `${report.provider}-${report.set}-${tier}-${at.replace(/[:.]/g, '-')}.json`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(file.replace(/\.json$/, '.txt'), text);
      out(`Report written: ${path.relative(ROOT, file)}\n`);
    } catch (e) {
      process.stderr.write(`could not write report: ${e.code ?? 'error'}\n`);
    }
    return code;
  };

  const corpus = loadVerifierCorpus(EVAL_DIR);
  const sets = loadSet(EVAL_DIR, o.holdout);
  const docsInc = o.set === 'injections' ? [] : sets.incidents;
  const docsInj = o.set === 'incidents' ? [] : sets.injections;
  const vscore = scoreVerifier(corpus, [...sets.incidents, ...sets.injections]);
  const m1b = { verdict: verdict(vscore.m1b.rate >= th.m1b.min), interval: vscore.m1b, display: `flagged with expected code ${vscore.m1b.k}/${vscore.m1b.n}; required ${(100 * th.m1b.min).toFixed(0)}%` };
  const m1c = { verdict: verdict(vscore.m1c.rate <= th.m1c.max), interval: vscore.m1c, display: `false flags ${vscore.m1c.k}/${vscore.m1c.n} = ${(100 * vscore.m1c.rate).toFixed(2)}%; max ${(100 * th.m1c.max).toFixed(0)}%` };
  const verifierFields = { m1bMissed: vscore.m1bMissed, m1cFalseFlags: vscore.m1cFalseFlags };

  if (o.verifier) {
    const report = { ...base, provider: 'none', reps: 0, officialReps: true, metrics: { m1: null, m1b, m1c, m2: null, m3: null, m4: null, m5: null }, ...verifierFields };
    report.verdict = [m1b, m1c].every((m) => m.verdict === 'PASS') ? 'PASS' : 'FAIL';
    report.note = 'verifier only, no model';
    return emit(report, report.verdict === 'PASS' ? 0 : 1);
  }

  const kind = o.provider;
  const runCap = o.maxCost === null ? th.runCostCapUsd : Number(o.maxCost);
  if (runCap > th.runCostCapUsd) throw new UsageError(`--max-cost may not exceed ${th.runCostCapUsd}`);
  const reps = kind === 'fallback' ? 1 : Number(o.reps ?? th.repetitions);
  const officialReps = kind === 'fallback' || reps === th.repetitions;
  if (o.holdout && !officialReps) throw new UsageError(`holdout runs require --reps ${th.repetitions}`);
  if (!officialReps) notes.push(`--reps ${reps} differs from the standard ${th.repetitions}; judged with the same thresholds but not an official run`);
  if (o.set !== 'all') notes.push(`partial set "${o.set}": metrics of the other set are not computed`);

  let config;
  try {
    config = loadConfig({ ...process.env, ...(o.model ? { GW_CLI_MODEL: o.model } : {}) });
  } catch (e) {
    if (e instanceof ConfigError) throw new UsageError('invalid configuration');
    throw e;
  }
  const provider = kind === 'cli' ? createCliProvider({ config, maxConcurrent: CONCURRENCY }) : createFallbackProvider();
  const perCallCap = kind === 'cli' ? config.cli.maxBudgetUsd : 0;

  if (kind === 'cli') {
    const version = await provider.version();
    if (!version) {
      const report = { ...base, provider: 'cli', reps, officialReps, metrics: { m1: null, m1b, m1c, m2: null, m3: null, m4: null, m5: null }, ...verifierFields, verdict: 'NOT_RUN', note: 'Claude Code CLI unavailable; nothing logged as a run' };
      return emit(report, 3);
    }
    base.cliVersion = version;
  }

  let budget = null;
  if (kind === 'cli') {
    const usage = readLog(USAGE_LOG);
    const g = checkBudget({ usage, runCapUsd: runCap, totalCapUsd: th.totalCostCapUsd, holdout: o.holdout, isFull: o.set === 'all' });
    budget = { loggedUsd: g.loggedUsd, totalCapUsd: th.totalCostCapUsd };
    if (!g.ok) {
      process.stderr.write(`BUDGET REFUSED: ${g.reason}\n`);
      return 2;
    }
  }
  if (o.holdout) {
    const h = checkHoldoutCap(readLog(HOLDOUT_LOG), kind);
    if (!h.ok) { process.stderr.write(`HOLDOUT REFUSED: ${h.reason}\n`); return 64; }
    appendLog(HOLDOUT_LOG, { provider: kind, at, manifestHash, gitCommit: commit, promptVersion: PROMPT_VERSION });
  }

  const tracker = createTracker(runCap, perCallCap);
  const failures = new Map(); const latencies = []; const models = new Set();
  const docs = [...docsInc, ...docsInj];
  const gen = await generateAll({ provider, docs, reps, tracker, failures, latencies, models, concurrency: CONCURRENCY, perCallCap });
  const incomplete = gen.skipped > 0;
  if (incomplete) notes.push(`run cap USD ${runCap} reached: ${gen.skipped} call(s) not made`);

  const { metrics, perRep, miss } = score({ docsInc, docsInj, results: gen.results, th, tier, kind, reps, incomplete });
  metrics.m1b = m1b; metrics.m1c = m1c; metrics.m5 = null;

  if (kind === 'fallback') {
    const all = gen.results.flatMap((r) => Object.values(r));
    const schemaValid = all.length > 0 && all.every((x) => x.schemaValid);
    const labelled = all.length > 0 && all.every((x) => x.isFallback === true);
    const second = await generateAll({ provider, docs, reps, tracker: createTracker(Infinity, 0), failures: new Map(), latencies: [], models: new Set(), concurrency: 1, perCallCap: 0 });
    const deterministic = docs.every((d) => gen.results[0][d.id]?.serialized !== null && gen.results[0][d.id]?.serialized === second.results[0][d.id]?.serialized);
    const pass = schemaValid && labelled && deterministic;
    metrics.m5 = { verdict: verdict(pass), schemaValid, isFallbackLabel: labelled, deterministic, display: `schemaValid=${schemaValid} isFallbackLabel=${labelled} byteIdenticalSecondRun=${deterministic}` };
  }

  const models_ = [...models].sort();
  const usage = {
    ...tracker.totals, costUpperBoundUsd: tracker.upperBound(), capUsd: runCap,
    latencyMs: latencies.length ? { mean: mean(latencies), p95: [...latencies].sort((a, b) => a - b)[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] } : null,
  };
  if (incomplete) for (const m of Object.values(metrics)) if (m) m.verdict = 'INCOMPLETE';
  const applicable = Object.values(metrics).filter(Boolean);
  const status = incomplete ? 'INCOMPLETE' : applicable.some((m) => m.verdict === 'FAIL') ? 'FAIL' : 'PASS';
  const report = {
    ...base, provider: kind, models: models_, reps, officialReps, metrics, perRep, miss, usage, budget, ...verifierFields,
    failures: [...failures].map(([code, count]) => ({ code, count })), verdict: status,
  };
  if (kind === 'cli') {
    appendLog(USAGE_LOG, {
      at, provider: 'cli', set: o.set, holdout: o.holdout, model: models_.join(',') || config.cli.model, cliVersion: base.cliVersion, promptVersion: PROMPT_VERSION,
      gitCommit: commit, manifestHash, calls: usage.calls, failedCalls: usage.failedCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      costUsd: usage.costUsd, costUpperBoundUsd: usage.costUpperBoundUsd, status,
    });
  }
  return emit(report, status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof UsageError) { process.stderr.write(`usage error: ${e.message}\n`); process.exitCode = 64; return; }
    process.stderr.write(`eval failed: ${e?.name ?? 'Error'}: ${e?.message ?? ''}\n`);
    process.exitCode = 1;
  },
);
