'use strict';
// Agent runs: the unit of spend/runtime accounting and of failure recovery.
// The orchestrator opens a run before dispatching an agent and closes it with
// the usage numbers the harness reports. Runs left open by a crashed or
// interrupted session are detected and recovered (claims released, attempt
// counted) so work can resume safely.
//
// Usage is reported after the fact. The engine caps how many runs are open at
// once and can hold budget back for them, but it cannot meter spend as it
// happens or stop a running agent: a figure it was never given is recorded as
// unknown (null), never as 0, and the recorded totals are then a lower bound.

const { EccodeError, newId, now, own, isReservedKey } = require('./util');
const { assertBudget } = require('./project');
const tasks = require('./tasks');

function round(n, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Minutes elapsed since an ISO timestamp, to two decimals. */
function elapsedMinutes(since) {
  return round(Math.max(0, (now() - new Date(since)) / 60000), 2);
}

/** Runs still open. */
function runningRuns(state) {
  return Object.values(state.runs).filter((r) => r.status === 'running');
}

/**
 * What the record can and cannot say about spend, derived at read time (nothing
 * here is stored in the snapshot, so older logs replay unchanged). The totals
 * are exact only while every closed run carries a dollar figure: a run closed
 * with --no-usage, recovered after an interruption, or closed with tokens but
 * no cost and no pricing to estimate one, has unknown usage and makes the
 * recorded spend a lower bound until `run correct` fills it in.
 */
function spendAccounting(state, config) {
  const all = Object.values(state.runs);
  const closed = all.filter((r) => r.status !== 'running');
  const running = all.filter((r) => r.status === 'running').map((r) => r.id);
  const unknownUsage = closed.filter((r) => r.usageReported === false || r.costUsd === null).map((r) => r.id);
  const estimatedCostUsd = round(closed.filter((r) => r.costEstimated).reduce((sum, r) => sum + (r.costUsd || 0), 0));
  const reserve = config.limits.reserveUsdPerRun || null;
  return {
    costUsd: state.totals.costUsd,
    runtimeMinutes: state.totals.runtimeMinutes,
    tokens: state.totals.tokens,
    running,
    unknownUsage,
    estimatedCostUsd,
    reserveUsdPerRun: reserve,
    reservedUsd: reserve ? round(running.length * reserve) : 0,
  };
}

/**
 * Open a run. The orchestrator opens runs on behalf of the role it is about to
 * dispatch (--agent), because the main session may not act as a role; the run
 * belongs to that role. Roles opening their own runs omit agent.
 */
function startRun(store, config, actor, { task, gate, agent } = {}) {
  if (agent !== undefined && !/^[a-z][a-z0-9-]{1,40}$/.test(String(agent))) {
    throw new EccodeError('INVALID_INPUT', `--agent must be a role name such as delivery-lead (got ${JSON.stringify(agent)})`);
  }
  const id = newId('run');
  const data = { id, task: task || null, gate: gate || null };
  if (agent !== undefined) data.agent = agent; // set only when given, so older logs replay identically
  store.commit('run.started', actor, data, (state) => {
    const open = runningRuns(state);
    const max = config.limits.maxActiveRuns;
    if (open.length >= max) {
      // Every dispatch opens a run and every finished agent closes one, so open runs that
      // pile up are agents nobody closed: close or recover them before starting another.
      throw new EccodeError('RUN_LIMIT', `limits.maxActiveRuns=${max} reached; open runs: ${open.map((r) => `${r.id} (${r.agent}${r.task ? `, ${r.task}` : ''})`).join(', ')}. Close the ones whose agents have finished (eccode run end <runId> --actor orchestrator --status ok|failed --tokens <n>) or recover the interrupted ones: eccode recover --actor orchestrator (add --all after a restart).`, {
        recovery: 'Close or recover the open runs before starting another. Raising limits.maxActiveRuns in .eccode/config.json requires the user\'s explicit authorization.',
        openRuns: open.map((r) => r.id),
      });
    }
    assertBudget(state, config);
  });
  return id;
}

/** A usage figure counts as reported when it was given at all, including an explicit 0. */
function isGiven(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * A reported usage figure as a number (undefined when not given). Negative,
 * non-numeric or infinite values are refused: they would silently lower the
 * recorded spend (budgets) or be stored as 0 while marked "reported".
 */
function usageNumber(v, name) {
  if (!isGiven(v)) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new EccodeError('INVALID_INPUT', `${name} must be a finite non-negative number (got ${JSON.stringify(v)})`);
  return n;
}

function endRun(store, config, runId, actor, { status = 'ok', costUsd, tokens, note, noUsage = false } = {}) {
  if (!['ok', 'failed', 'interrupted'].includes(status)) throw new EccodeError('INVALID_INPUT', 'status must be ok|failed|interrupted');
  if (tokens === true || costUsd === true) throw new EccodeError('INVALID_INPUT', '--tokens and --cost-usd need a value');
  const tokenCount = usageNumber(tokens, '--tokens');
  const reportedCost = usageNumber(costUsd, '--cost-usd');
  const usageReported = tokenCount !== undefined || reportedCost !== undefined;
  if (!usageReported && !noUsage) {
    // Closing before the harness reports usage silently under-counts spend
    // (recorded workflow lesson: runs closed on estimates three times).
    throw new EccodeError('USAGE_MISSING', `Run ${runId}: give --tokens and/or --cost-usd from the agent's reported usage. If the agent reported none (crash, timeout), close it with --no-usage and fill it in later with 'eccode run correct'.`);
  }
  if (usageReported && noUsage) throw new EccodeError('INVALID_INPUT', '--no-usage cannot be combined with --tokens or --cost-usd');
  return store.commit('run.ended', actor, { id: runId, status, note: note || null, usageReported }, (state) => {
    const r = own(state.runs, runId);
    if (!r) throw new EccodeError('UNKNOWN_RUN', `Unknown run ${runId}`);
    if (r.status !== 'running') throw new EccodeError('INVALID_TRANSITION', `Run ${runId} already ${r.status}`);
    const durationMinutes = elapsedMinutes(r.startedAt);
    // A figure the harness did not report is unknown (null), never 0. Tokens
    // without a cost become an estimate only when pricing is configured;
    // otherwise the dollar figure stays unknown until `run correct` fills it in.
    if (!usageReported) return { durationMinutes, costUsd: null, tokens: null, costEstimated: false };
    const rate = config.pricing && config.pricing.usdPerMillionTokens;
    let cost = reportedCost;
    let costEstimated = false;
    if (cost === undefined) {
      if (tokenCount && rate) {
        cost = (tokenCount / 1e6) * rate;
        costEstimated = true;
      } else {
        cost = tokenCount === 0 ? 0 : null;
      }
    }
    return { durationMinutes, costUsd: cost, tokens: tokenCount === undefined ? null : tokenCount, costEstimated };
  });
}

// Corrections change recorded spend (budgets) and recovery releases other
// agents' claims: both belong to the orchestrator or the user, never to an agent.
const ACCOUNTING_ACTORS = ['orchestrator', 'user'];

function assertAccountingActor(actor, what) {
  if (!ACCOUNTING_ACTORS.includes(actor)) {
    throw new EccodeError('ROLE_NOT_ALLOWED', `${what} is performed by ${ACCOUNTING_ACTORS.join(' or ')} (--actor), not ${actor || 'an unnamed caller'}`);
  }
}

/** Correct the usage recorded for a closed run (e.g. an estimate replaced by the reported figure). */
function correctRun(store, runId, actor, { tokens, costUsd, reason }) {
  assertAccountingActor(actor, 'A run usage correction');
  if (!reason) throw new EccodeError('INVALID_INPUT', 'A correction needs --reason');
  if (tokens === true || costUsd === true) throw new EccodeError('INVALID_INPUT', '--tokens and --cost-usd need a value');
  const tokenCount = usageNumber(tokens, '--tokens');
  const reportedCost = usageNumber(costUsd, '--cost-usd');
  return store.commit('run.corrected', actor, { id: runId, reason }, (state) => {
    const r = own(state.runs, runId);
    if (!r) throw new EccodeError('UNKNOWN_RUN', `Unknown run ${runId}`);
    if (r.status === 'running') throw new EccodeError('INVALID_TRANSITION', `Run ${runId} is still open; close it with the right figures instead`);
    const data = { tokens: tokenCount === undefined ? r.tokens : tokenCount, costUsd: reportedCost === undefined ? r.costUsd : reportedCost };
    // A reported dollar figure replaces an estimate. Carried only when the flag
    // changes, so corrections written before it existed replay unchanged.
    if (reportedCost !== undefined && r.costEstimated) data.costEstimated = false;
    return data;
  });
}

/** Runs still open past the stale threshold (or all open runs with all=true). */
function staleRuns(state, config, { all = false } = {}) {
  const cutoff = now() - config.limits.staleRunMinutes * 60000;
  return runningRuns(state).filter((r) => all || new Date(r.startedAt) < cutoff);
}

/**
 * Recover from interruption: close stale runs as interrupted and release the
 * claims of tasks they were working on (the attempt counts toward retries).
 */
function recover(store, config, { all = false, actor } = {}) {
  assertAccountingActor(actor, 'Recovery');
  const state = store.state();
  const recovered = [];
  for (const r of staleRuns(state, config, { all })) {
    // Recorded under the real caller, not a fixed "orchestrator". As far as the
    // record can tell the run lasted until now; what it spent is unknown, not 0.
    store.commit('run.ended', actor, { id: r.id, status: 'interrupted', durationMinutes: elapsedMinutes(r.startedAt), costUsd: null, tokens: null, usageReported: false, note: 'recovered after interruption' });
    const entry = { run: r.id, agent: r.agent, task: r.task, released: false };
    const t = r.task && store.state().tasks[r.task];
    if (t && t.status === 'claimed' && t.claim.agent === r.agent) {
      const res = tasks.fail(store, config, r.task, actor, `run ${r.id} interrupted`, { interrupted: true });
      entry.released = true;
      entry.escalated = res.state.tasks[r.task].status === 'escalated';
    }
    recovered.push(entry);
  }
  // Claims with no live run (e.g. claimed then session died before a run was opened).
  if (all) {
    for (const t of Object.values(store.state().tasks)) {
      if (t.status === 'claimed' && !(t.claim.runId && store.state().runs[t.claim.runId] && store.state().runs[t.claim.runId].status === 'running')) {
        tasks.fail(store, config, t.id, actor, 'claim orphaned by interrupted session', { interrupted: true });
        recovered.push({ run: null, agent: t.claim.agent, task: t.id, released: true });
      }
    }
  }
  return recovered;
}

function recordRisk(store, actor, { id, title, severity, mitigation, owner, status = 'open' }) {
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) throw new EccodeError('INVALID_INPUT', 'risk id is required (letters, digits, _ . -)');
  if (isReservedKey(id)) throw new EccodeError('INVALID_INPUT', `risk id ${id} is reserved`);
  const sev = ['low', 'medium', 'high', 'critical'];
  return store.commit('risk.recorded', actor, { id, title, severity, mitigation, owner, status }, (state) => {
    const existing = own(state.risks, id);
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

module.exports = { startRun, endRun, correctRun, staleRuns, runningRuns, spendAccounting, recover, recordRisk, recordDecision };
