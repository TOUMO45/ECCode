'use strict';
// Agent runs: the unit of spend/runtime accounting and of failure recovery.
// The orchestrator opens a run before dispatching an agent and closes it with
// the usage numbers the harness reports. Runs left open by a crashed or
// interrupted session are detected and recovered (claims released, attempt
// counted) so work can resume safely.

const { EccodeError, newId, now } = require('./util');
const { assertBudget } = require('./project');
const tasks = require('./tasks');

function startRun(store, config, actor, { task, gate } = {}) {
  const id = newId('run');
  store.commit('run.started', actor, { id, task: task || null, gate: gate || null }, (state) => {
    assertBudget(state, config);
  });
  return id;
}

/** A usage figure counts as reported when it was given at all, including an explicit 0. */
function isGiven(v) {
  return v !== undefined && v !== null && v !== '';
}

function endRun(store, config, runId, actor, { status = 'ok', costUsd, tokens, note, noUsage = false } = {}) {
  if (!['ok', 'failed', 'interrupted'].includes(status)) throw new EccodeError('INVALID_INPUT', 'status must be ok|failed|interrupted');
  if (tokens === true || costUsd === true) throw new EccodeError('INVALID_INPUT', '--tokens and --cost-usd need a value');
  const usageReported = isGiven(tokens) || isGiven(costUsd);
  if (!usageReported && !noUsage) {
    // Closing before the harness reports usage silently under-counts spend
    // (recorded workflow lesson: runs closed on estimates three times).
    throw new EccodeError('USAGE_MISSING', `Run ${runId}: give --tokens and/or --cost-usd from the agent's reported usage. If the agent reported none (crash, timeout), close it with --no-usage and fill it in later with 'eccode run correct'.`);
  }
  if (usageReported && noUsage) throw new EccodeError('INVALID_INPUT', '--no-usage cannot be combined with --tokens or --cost-usd');
  return store.commit('run.ended', actor, { id: runId, status, note: note || null, usageReported }, (state) => {
    const r = state.runs[runId];
    if (!r) throw new EccodeError('UNKNOWN_RUN', `Unknown run ${runId}`);
    if (r.status !== 'running') throw new EccodeError('INVALID_TRANSITION', `Run ${runId} already ${r.status}`);
    const durationMinutes = Math.max(0, (now() - new Date(r.startedAt)) / 60000);
    let cost = Number(costUsd || 0);
    let costEstimated = false;
    const rate = config.pricing && config.pricing.usdPerMillionTokens;
    if (!costUsd && tokens && rate) {
      cost = (Number(tokens) / 1e6) * rate;
      costEstimated = true;
    }
    if (!(cost >= 0)) throw new EccodeError('INVALID_INPUT', 'cost must be a non-negative number');
    return { durationMinutes: Math.round(durationMinutes * 100) / 100, costUsd: cost, tokens: Number(tokens || 0), costEstimated };
  });
}

/** Correct the usage recorded for a closed run (e.g. an estimate replaced by the reported figure). */
function correctRun(store, runId, actor, { tokens, costUsd, reason }) {
  if (!reason) throw new EccodeError('INVALID_INPUT', 'A correction needs --reason');
  return store.commit('run.corrected', actor, { id: runId, reason }, (state) => {
    const r = state.runs[runId];
    if (!r) throw new EccodeError('UNKNOWN_RUN', `Unknown run ${runId}`);
    if (r.status === 'running') throw new EccodeError('INVALID_TRANSITION', `Run ${runId} is still open; close it with the right figures instead`);
    const t = tokens === undefined ? r.tokens : Number(tokens);
    const c = costUsd === undefined ? r.costUsd : Number(costUsd);
    if (!(t >= 0) || !(c >= 0)) throw new EccodeError('INVALID_INPUT', 'tokens and cost must be non-negative numbers');
    return { tokens: t, costUsd: c };
  });
}

/** Runs still open past the stale threshold (or all open runs with all=true). */
function staleRuns(state, config, { all = false } = {}) {
  const cutoff = now() - config.limits.staleRunMinutes * 60000;
  return Object.values(state.runs).filter((r) => r.status === 'running' && (all || new Date(r.startedAt) < cutoff));
}

/**
 * Recover from interruption: close stale runs as interrupted and release the
 * claims of tasks they were working on (the attempt counts toward retries).
 */
function recover(store, config, { all = false } = {}) {
  const state = store.state();
  const recovered = [];
  for (const r of staleRuns(state, config, { all })) {
    store.commit('run.ended', 'orchestrator', { id: r.id, status: 'interrupted', durationMinutes: 0, costUsd: 0, tokens: 0, usageReported: false, note: 'recovered after interruption' });
    const entry = { run: r.id, agent: r.agent, task: r.task, released: false };
    const t = r.task && store.state().tasks[r.task];
    if (t && t.status === 'claimed' && t.claim.agent === r.agent) {
      const res = tasks.fail(store, config, r.task, 'orchestrator', `run ${r.id} interrupted`, { interrupted: true });
      entry.released = true;
      entry.escalated = res.state.tasks[r.task].status === 'escalated';
    }
    recovered.push(entry);
  }
  // Claims with no live run (e.g. claimed then session died before a run was opened).
  if (all) {
    for (const t of Object.values(store.state().tasks)) {
      if (t.status === 'claimed' && !(t.claim.runId && store.state().runs[t.claim.runId] && store.state().runs[t.claim.runId].status === 'running')) {
        tasks.fail(store, config, t.id, 'orchestrator', 'claim orphaned by interrupted session', { interrupted: true });
        recovered.push({ run: null, agent: t.claim.agent, task: t.id, released: true });
      }
    }
  }
  return recovered;
}

function recordRisk(store, actor, { id, title, severity, mitigation, owner, status = 'open' }) {
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) throw new EccodeError('INVALID_INPUT', 'risk id is required (letters, digits, _ . -)');
  const sev = ['low', 'medium', 'high', 'critical'];
  return store.commit('risk.recorded', actor, { id, title, severity, mitigation, owner, status }, (state) => {
    const existing = state.risks[id];
    if (!existing && (!title || !sev.includes(severity))) {
      throw new EccodeError('INVALID_INPUT', `new risks need --title and --severity (${sev.join('|')})`);
    }
    if (!['open', 'mitigated', 'accepted', 'closed'].includes(status)) throw new EccodeError('INVALID_INPUT', 'status must be open|mitigated|accepted|closed');
    if (severity !== undefined && !sev.includes(severity)) throw new EccodeError('INVALID_INPUT', `severity must be ${sev.join('|')}`);
    if (status === 'accepted' && actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Only the user can accept a risk');
    // Omitted (undefined) fields are dropped when Store.commit serializes the
    // event, and commit reduces that persisted form, so the reducer's merge
    // keeps previously recorded values.
  });
}

function recordDecision(store, actor, { title, decision, rationale, alternatives, lessons = [] }) {
  if (!title || !decision || !rationale) throw new EccodeError('INVALID_INPUT', 'decisions need --title, --decision and --rationale');
  const id = newId('dec');
  store.commit('decision.recorded', actor, { id, title, decision, rationale, alternatives: alternatives || null, lessons });
  for (const lesson of lessons) store.commit('memory.cited', actor, { lesson, context: `decision ${id}: ${title}` });
  return id;
}

module.exports = { startRun, endRun, correctRun, staleRuns, recover, recordRisk, recordDecision };
