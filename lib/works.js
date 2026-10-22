'use strict';
// Work items: start the next piece of work (feature, refactor, fix, quick or
// another greenfield build) on the same project record, sized to its risk.
// The previous work item must be delivered or abandoned first; each item gets
// its own git base, so "every changed file was reviewed" holds per work item.

const path = require('path');
const fs = require('fs');
const { EccodeError, exists, sha256File } = require('./util');
const { TRACKS } = require('./reducer');
const { assertBudget, gitHead, gitChangedFiles } = require('./project');
const { validatePlan } = require('./tasks');

function baseline(root) {
  const baseCommit = gitHead(root);
  const dirtyAtInit = {};
  for (const f of (baseCommit && gitChangedFiles(root, baseCommit)) || []) {
    const abs = path.join(root, f);
    if (!f.startsWith('.eccode/') && exists(abs) && fs.statSync(abs).isFile()) dirtyAtInit[f] = sha256File(abs);
  }
  return { baseCommit, dirtyAtInit };
}

/** The one-task plan a quick work item imports automatically. */
function quickPlan(config, { title, owner, files, command }) {
  if (!owner || !files || !command) {
    throw new EccodeError('INVALID_INPUT', 'A quick work item needs --owner <role>, --files <glob[,glob]> and --command "<verification command>"');
  }
  const plan = {
    phases: [{ id: 'change', name: 'Change', goal: `Quick change: ${title}`, acceptanceCriteria: ['the change works and its verification command passes'] }],
    tasks: [{
      id: 'change',
      phase: 'change',
      title,
      owner,
      dependencies: [],
      inputs: [],
      outputs: [title],
      files: String(files).split(',').map((f) => f.trim()).filter(Boolean),
      acceptanceCriteria: ['the change works and its verification command passes'],
      verification: { method: 'run the pinned command', command },
    }],
  };
  const errors = validatePlan(plan, config);
  if (errors.length) throw new EccodeError('INVALID_PLAN', `Quick plan invalid:\n- ${errors.join('\n- ')}`, { errors });
  return plan;
}

function startWork(store, config, actor, { track, title, behavior, quick }) {
  if (!['orchestrator', 'user', 'delivery-lead'].includes(actor)) {
    throw new EccodeError('ROLE_NOT_ALLOWED', 'Work items are started by the orchestrator, delivery-lead or the user');
  }
  if (!TRACKS[track]) throw new EccodeError('INVALID_INPUT', `Unknown track "${track}". Tracks: ${Object.keys(TRACKS).join(', ')}`);
  if (!title || title.trim().length < 5) throw new EccodeError('INVALID_INPUT', 'A work item needs --title (>= 5 chars)');
  if (track === 'refactor' && !behavior) {
    throw new EccodeError('INVALID_INPUT', 'A refactor work item needs --behavior "<command>": the check that must pass before the first change and again at verification');
  }
  const plan = track === 'quick' ? quickPlan(config, { title, ...quick }) : null;
  const base = baseline(store.root);
  const result = store.commit('work.started', actor, { track, title: title.trim(), behavior: behavior || null, ...base }, (state) => {
    if (!state.project) throw new EccodeError('NOT_INITIALIZED', 'Run eccode init first');
    if (state.work && state.work.status === 'active') {
      throw new EccodeError('WORK_ACTIVE', `Work item ${state.work.id} ("${state.work.title}", ${state.work.track}) is still active. Deliver it (eccode deliver) or have the user abandon it (eccode work abandon --actor user --reason ...).`);
    }
    assertBudget(state, config);
    return { id: `w${Object.keys(state.pastWorks).length + 2}` };
  });
  if (plan) store.commit('plan.imported', actor, { phases: plan.phases, tasks: plan.tasks, source: 'auto:quick' });
  return result;
}

/** Only the user can abandon work: dropping gates mid-way is their call. */
function abandonWork(store, actor, reason) {
  return store.commit('work.abandoned', actor, { reason }, (state) => {
    if (actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Only the user may abandon a work item (--actor user)');
    if (!state.work || state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', 'No active work item to abandon');
    if (!reason || reason.trim().length < 10) throw new EccodeError('INVALID_INPUT', "Provide the user's --reason (>= 10 chars)");
  });
}

function normCmd(c) {
  return String(c).trim().replace(/\s+/g, ' ');
}

/**
 * Track-specific evidence rules, enforced when the verification gate is
 * submitted (gates.submit calls this):
 * - fix: the bug was reproduced (a failed run with purpose=reproduction inside
 *   this work) and the same command passed later — the memory-lesson rule
 *   applied to the delivery itself.
 * - refactor: the declared behavior command passed before the first claim and
 *   again after the last phase approval — behavior preserved, not rewritten.
 */
function checkTrackRules(state) {
  const w = state.work;
  if (!w) return [];
  const evs = Object.values(state.evidence).filter((e) => e.kind === 'command' && e.at >= w.startedAt);
  const problems = [];
  if (w.track === 'fix') {
    const repro = evs.filter((e) => e.purpose === 'reproduction' && e.status === 'failed');
    const pair = repro.find((r) => evs.some((e) => normCmd(e.command) === normCmd(r.command) && e.status === 'passed' && e.at > r.at));
    if (!pair) {
      problems.push('fix track: no reproduction pair found. Record the failing check first (eccode evidence run --purpose reproduction ...), fix the bug, then record the same command passing.');
    }
  }
  if (w.track === 'refactor') {
    const b = normCmd(w.behaviorCommand || '');
    const runs = evs.filter((e) => normCmd(e.command) === b && e.status === 'passed');
    const claims = Object.values(state.tasks).flatMap((t) => t.history.filter((h) => h.event === 'claimed').map((h) => h.at));
    const firstClaim = claims.sort()[0];
    const phaseApprovals = state.gateOrder.filter((g) => g.startsWith('phase:')).map((g) => state.gates[g].approvedAt).filter(Boolean).sort();
    const lastPhase = phaseApprovals[phaseApprovals.length - 1];
    if (!firstClaim || !runs.some((e) => e.at <= firstClaim)) {
      problems.push(`refactor track: the behavior command must be recorded passing BEFORE the first task claim (eccode evidence run ... -- ${JSON.stringify(w.behaviorCommand)}), to prove the baseline was green.`);
    }
    if (!lastPhase || !runs.some((e) => e.at >= lastPhase)) {
      problems.push('refactor track: the behavior command must be recorded passing again AFTER the last phase approval, to prove behavior was preserved.');
    }
  }
  return problems;
}

module.exports = { startWork, abandonWork, checkTrackRules, baseline, quickPlan, TRACKS };
