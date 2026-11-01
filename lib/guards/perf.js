'use strict';
// Performance budget (Phase 3, B.3). The change's hot paths (its HTTP
// surfaces, or the probes .eccode/guards.json configures) run as a
// micro-benchmark in the baseline and candidate worktrees: warmup, N
// repetitions, median and interquartile range, and the SQL statements one
// request executes (SQLAlchemy event hooks, so an N+1 shows as a query count
// that grew). A regression beyond the threshold, or a new N+1, refuses
// delivery unless a reviewer waives it with a rationale.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EccodeError, newId } = require('../util');
const worktree = require('../worktree');
const common = require('./common');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'guards', 'perf_probe.py');
const DEFAULTS = { warmup: 3, repetitions: 15, maxLatencyRegression: 0.2, minDeltaMs: 2, nPlusOneQueries: 3 };

/** The probes: configured, or one GET per HTTP surface of the change without path parameters, as the first non-anonymous role. */
function probesFor(root, state, cfg, bcfg) {
  if (Array.isArray(cfg.probes) && cfg.probes.length) return cfg.probes.map((p) => ({ ...p, headers: p.headers || (p.role ? common.roleHeaders(bcfg, p.role) : undefined) }));
  const { surfaces } = require('../behavior').surfacesOf(root, state);
  const role = (bcfg.roles || []).find((r) => r.name !== 'anonymous');
  const out = [];
  for (const s of surfaces.filter((x) => x.kind === 'http')) {
    const [method, p] = s.target.split(' ');
    if (!['GET', 'ANY'].includes(method) || /\{/.test(p)) continue;
    out.push({ name: `GET ${p}`, method: 'GET', path: p, headers: role ? role.headers : undefined });
  }
  return out;
}

function run(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const base = state.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', 'The performance guard needs the work item\'s git base commit');
  const bcfg = common.behaviorConfig(store.root);
  const cfg = { ...DEFAULTS, ...(common.guardsConfig(store.root).perf || {}) };
  if (!bcfg.app) throw new EccodeError('INVALID_INPUT', 'The performance guard needs .eccode/behavior.json "app": "<module>:<attr>"');
  const py = require('../lab').pythonFor(store.root, python || bcfg.python);
  const probes = probesFor(store.root, state, cfg, bcfg);
  const fp = common.fingerprint(store.root, state);
  const evs = [];
  const sides = {};
  const notes = [];
  if (!probes.length) notes.push('no probe: the change reaches no GET route without path parameters and .eccode/guards.json configures none');
  else worktree.withSides(store.root, base, ({ baseline, candidate }) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-perf-'));
    try {
      const probesFile = path.join(work, 'probes.json');
      fs.writeFileSync(probesFile, JSON.stringify(probes));
      for (const [name, side] of [['baseline', baseline], ['candidate', candidate]]) {
        const sideTmp = fs.mkdtempSync(path.join(work, `${name}-`));
        const out = path.join(work, `${name}.json`);
        const ev = common.runInSide(store, actor, { guard: 'perf', label: name, side, command: `${common.sh(py)} ${common.sh(SCRIPT)} --app ${common.sh(bcfg.app)} --probes ${common.sh(probesFile)} --out ${common.sh(out)} --warmup ${cfg.warmup} --repetitions ${cfg.repetitions}`, env: common.sideEnv(bcfg, sideTmp), setup: bcfg.setup, task, timeoutMs, evs });
        if (!fs.existsSync(out)) throw new EccodeError('GUARD_FAILED', `the ${name} benchmark produced no output (ev:${ev.id}):\n${ev.outputTail}`);
        sides[name] = JSON.parse(fs.readFileSync(out, 'utf8'));
        notes.push(...(sides[name].errors || []).map((e) => `${name}: ${e}`));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  const rows = [];
  for (const p of probes) {
    const b = sides.baseline && sides.baseline.probes.find((x) => x.name === p.name);
    const c = sides.candidate && sides.candidate.probes.find((x) => x.name === p.name);
    if (!b || !c) { rows.push({ name: p.name, missing: true }); continue; }
    const latencyRegression = c.median_ms > b.median_ms * (1 + cfg.maxLatencyRegression) && c.median_ms - b.median_ms > cfg.minDeltaMs;
    const moreQueries = typeof b.queries === 'number' && typeof c.queries === 'number' && c.queries > b.queries;
    const nPlusOne = moreQueries && c.queries - b.queries >= cfg.nPlusOneQueries;
    rows.push({ name: p.name, baseline: { median: b.median_ms, iqr: b.iqr_ms, queries: b.queries, status: b.status }, candidate: { median: c.median_ms, iqr: c.iqr_ms, queries: c.queries, status: c.status }, ratio: b.median_ms ? Math.round((c.median_ms / b.median_ms) * 100) / 100 : null, latencyRegression, moreQueries, nPlusOne });
  }
  const id = newId('perf');
  const art = common.writeArtifact(store, id, { id, probes: rows, raw: sides, notes, evidence: evs });
  const data = { id, probes: rows, threshold: cfg.maxLatencyRegression, regressions: rows.filter((r) => r.latencyRegression).length, nPlusOnes: rows.filter((r) => r.nPlusOne).length, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('perf.result', actor, data, (s) => common.assertActive(s)).event.data;
}

function deliveryProblems(state, root) {
  if (!state.work || !state.guards) return [];
  const fp = common.fingerprint(root, state);
  const r = [...state.guards.perf].reverse().find((x) => x.treeFingerprint === fp);
  if (!r) return ['perf guard: no benchmark matches the current tree (eccode guard perf --actor <owner>)'];
  const waived = new Set(state.guards.waivers.filter((w) => w.guard === 'perf' && w.result === r.id).map((w) => w.finding));
  const problems = [];
  for (const p of r.probes) {
    if (p.missing || waived.has(p.name)) continue;
    if (p.latencyRegression) problems.push(`perf guard: ${p.name} median ${p.baseline.median} ms -> ${p.candidate.median} ms (${p.ratio}x, threshold ${Math.round(r.threshold * 100)}%). A reviewer waives it with a rationale (eccode guard waive --guard perf --result ${r.id} --finding ${JSON.stringify(p.name)} --reason ...) or the change gets faster`);
    if (p.nPlusOne) problems.push(`perf guard: ${p.name} executes ${p.candidate.queries} SQL statements per request, ${p.baseline.queries} before: a new N+1. Load the related rows in one query, or a reviewer waives it`);
  }
  return problems;
}

function reportLines(state) {
  const list = (state.guards && state.guards.perf) || [];
  if (!list.length) return [];
  const lines = ['## Performance budget', '', '| Probe | Baseline median (IQR) ms, queries | Candidate median (IQR) ms, queries | Verdict |', '|---|---|---|---|'];
  for (const r of list) for (const p of r.probes) {
    if (p.missing) { lines.push(`| ${p.name} | — | — | not measured |`); continue; }
    lines.push(`| ${p.name} | ${p.baseline.median} (${p.baseline.iqr}), ${p.baseline.queries ?? '?'} | ${p.candidate.median} (${p.candidate.iqr}), ${p.candidate.queries ?? '?'} | ${p.nPlusOne ? 'N+1' : p.latencyRegression ? `regression ${p.ratio}x` : p.moreQueries ? 'more queries' : 'within budget'} |`);
  }
  lines.push('');
  return lines;
}

module.exports = { run, probesFor, deliveryProblems, reportLines, DEFAULTS };
