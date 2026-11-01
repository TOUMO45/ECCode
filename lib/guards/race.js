'use strict';
// Concurrency check (Phase 3, B.4). The operations .eccode/guards.json
// declares (a request, its concurrency, and invariants as SQL: a conserved
// sum, an exact count, a maximum) run concurrently against a seeded database
// in the baseline and candidate worktrees; an invariant the candidate breaks
// refuses delivery. Required when the change touches the configured watch
// paths (shared state, sessions, counters, uniqueness, money, inventory).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EccodeError, newId, matchesAny } = require('../util');
const worktree = require('../worktree');
const common = require('./common');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'guards', 'race_probe.py');

function operationsFor(cfg, bcfg) {
  return (cfg.operations || []).map((op) => {
    const withHeaders = (r) => (r ? { ...r, headers: r.headers || (r.role ? common.roleHeaders(bcfg, r.role) : undefined) } : r);
    return { concurrency: 8, repeat: 2, ...op, request: withHeaders(op.request), setup: withHeaders(op.setup) };
  });
}

function run(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const base = state.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', 'The race probe needs the work item\'s git base commit');
  const bcfg = common.behaviorConfig(store.root);
  const cfg = common.guardsConfig(store.root).race || {};
  if (!bcfg.app) throw new EccodeError('INVALID_INPUT', 'The race probe needs .eccode/behavior.json "app"');
  if (!cfg.databaseEnv || !Array.isArray(cfg.operations) || !cfg.operations.length) throw new EccodeError('INVALID_INPUT', 'The race probe needs .eccode/guards.json "race": {databaseEnv, operations: [{name, concurrency, repeat, request, invariants: [{name, kind: conserved|equals|max, query, expect?}]}]}');
  const py = require('../lab').pythonFor(store.root, python || bcfg.python);
  const ops = operationsFor(cfg, bcfg);
  const fp = common.fingerprint(store.root, state);
  const evs = [];
  const sides = {};
  const notes = [];
  worktree.withSides(store.root, base, ({ baseline, candidate }) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-race-'));
    try {
      const opsFile = path.join(work, 'operations.json');
      fs.writeFileSync(opsFile, JSON.stringify(ops));
      for (const [name, side] of [['baseline', baseline], ['candidate', candidate]]) {
        const sideTmp = fs.mkdtempSync(path.join(work, `${name}-`));
        const env = common.sideEnv(bcfg, sideTmp);
        const out = path.join(work, `${name}.json`);
        const ev = common.runInSide(store, actor, { guard: 'race', label: name, side, command: `${common.sh(py)} ${common.sh(SCRIPT)} --app ${common.sh(bcfg.app)} --operations ${common.sh(opsFile)} --database "$${cfg.databaseEnv}" --out ${common.sh(out)}`, env, setup: bcfg.setup, task, timeoutMs, evs });
        if (!fs.existsSync(out)) throw new EccodeError('GUARD_FAILED', `the ${name} race probe produced no output (ev:${ev.id}):\n${ev.outputTail}`);
        sides[name] = JSON.parse(fs.readFileSync(out, 'utf8'));
        notes.push(...(sides[name].errors || []).map((e) => `${name}: ${e}`));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  const rows = ops.map((op) => {
    const b = sides.baseline.operations.find((x) => x.name === op.name);
    const c = sides.candidate.operations.find((x) => x.name === op.name);
    return { name: op.name, concurrency: op.concurrency, repeat: op.repeat, baseline: b ? { held: b.held, statuses: b.statuses, invariants: b.invariants } : null, candidate: c ? { held: c.held, statuses: c.statuses, invariants: c.invariants } : null };
  });
  const id = newId('race');
  const art = common.writeArtifact(store, id, { id, operations: rows, raw: sides, notes, evidence: evs });
  const data = { id, operations: rows, failed: rows.filter((r) => r.candidate && !r.candidate.held).length, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('race.result', actor, data, (s) => common.assertActive(s)).event.data;
}

/** Whether the change touches the configured watch paths (default: every non-test code file when operations are configured). */
function required(root, state, changed) {
  const cfg = common.guardsConfig(root).race || {};
  if (!Array.isArray(cfg.operations) || !cfg.operations.length) return false;
  const watch = Array.isArray(cfg.watch) && cfg.watch.length ? cfg.watch : ['**/*.py', '**/*.js', '**/*.ts'];
  const lean = require('../lean');
  return changed.some((f) => !lean.TEST.test(f) && matchesAny(f, watch));
}

function deliveryProblems(state, root) {
  if (!state.work || !state.guards) return [];
  const fp = common.fingerprint(root, state);
  const r = [...state.guards.race].reverse().find((x) => x.treeFingerprint === fp);
  if (!r) return ['race guard: no race probe matches the current tree (eccode guard race --actor <owner>)'];
  const waived = new Set(state.guards.waivers.filter((w) => w.guard === 'race' && w.result === r.id).map((w) => w.finding));
  const problems = [];
  for (const op of r.operations) {
    if (!op.candidate) { problems.push(`race guard: operation ${op.name} did not run on the candidate`); continue; }
    if (op.candidate.held || waived.has(op.name)) continue;
    const broken = op.candidate.invariants.filter((i) => !i.held).map((i) => `${i.name} (${i.kind}: before ${i.before}, after ${i.after}${i.expect !== undefined && i.expect !== null ? `, expected ${i.expect}` : ''})`);
    problems.push(`race guard: ${op.name} under ${op.concurrency}x${op.repeat} concurrent requests breaks ${broken.join('; ')}${op.baseline && !op.baseline.held ? ' (the baseline breaks it too)' : ''}. Make the operation atomic (one transaction with the check inside it, or a database constraint), or a reviewer waives it (eccode guard waive --guard race --result ${r.id} --finding ${JSON.stringify(op.name)} --reason ...)`);
  }
  return problems;
}

function reportLines(state) {
  const list = (state.guards && state.guards.race) || [];
  if (!list.length) return [];
  const lines = ['## Concurrency check', ''];
  for (const r of list) for (const op of r.operations) lines.push(`- ${op.name} (${op.concurrency} threads × ${op.repeat}): baseline ${op.baseline ? (op.baseline.held ? 'held' : 'BROKEN') : '—'}, candidate ${op.candidate ? (op.candidate.held ? 'held' : 'BROKEN: ' + op.candidate.invariants.filter((i) => !i.held).map((i) => i.name).join(', ')) : '—'}`);
  lines.push('');
  return lines;
}

module.exports = { run, required, operationsFor, deliveryProblems, reportLines };
