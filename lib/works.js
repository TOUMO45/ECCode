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

// The one-task tracks: the plan is imported with the work item, so the task
// is ready to claim at once. quick: one change; debug: one bug, reproduced by
// a regression test before it is fixed.
const ONE_TASK = {
  quick: {
    id: 'change',
    goal: (title) => `Quick change: ${title}`,
    criteria: ['the change works and its verification command passes'],
  },
  debug: {
    id: 'fix',
    goal: (title) => `Fix the reported bug at its root cause: ${title}`,
    criteria: [
      'a regression test reproduces the reported bug: it fails on the code before the fix (eccode fix verify proves it)',
      'the root cause is fixed: the regression test and the pinned verification command pass',
    ],
  },
};

/** The one-task plan a quick or debug work item imports automatically. */
function oneTaskPlan(config, track, { title, owner, files, command }) {
  const spec = ONE_TASK[track];
  if (!spec) throw new EccodeError('INVALID_INPUT', `Track ${track} has no one-task plan`);
  if (!owner || !files || !command) {
    throw new EccodeError('INVALID_INPUT', `A ${track} work item needs --owner <role>, --files <glob[,glob]> and --command "<verification command>"`);
  }
  const plan = {
    phases: [{ id: spec.id, name: spec.id === 'fix' ? 'Fix' : 'Change', goal: spec.goal(title), acceptanceCriteria: spec.criteria }],
    tasks: [{
      id: spec.id,
      phase: spec.id,
      title,
      owner,
      dependencies: [],
      inputs: [],
      outputs: [title],
      files: String(files).split(',').map((f) => f.trim()).filter(Boolean),
      acceptanceCriteria: spec.criteria,
      verification: { method: 'run the pinned command', command },
    }],
  };
  const errors = validatePlan(plan, config);
  if (errors.length) throw new EccodeError('INVALID_PLAN', `${track[0].toUpperCase()}${track.slice(1)} plan invalid:\n- ${errors.join('\n- ')}`, { errors });
  return plan;
}

function quickPlan(config, spec) {
  return oneTaskPlan(config, 'quick', spec);
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
  const plan = ONE_TASK[track] ? oneTaskPlan(config, track, { title, ...quick }) : null;
  const base = baseline(store.root);
  const result = store.commit('work.started', actor, { track, title: title.trim(), behavior: behavior || null, ...base }, (state) => {
    if (!state.project) throw new EccodeError('NOT_INITIALIZED', 'Run eccode init first');
    if (state.work && state.work.status === 'active') {
      throw new EccodeError('WORK_ACTIVE', `Work item ${state.work.id} ("${state.work.title}", ${state.work.track}) is still active. Deliver it (eccode deliver) or have the user abandon it (eccode work abandon --actor user --reason ...).`);
    }
    assertBudget(state, config);
    return { id: `w${Object.keys(state.pastWorks).length + 2}` };
  });
  if (plan) store.commit('plan.imported', actor, { phases: plan.phases, tasks: plan.tasks, source: `auto:${track}` });
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
 * The fix verifications of this work item that proved their test: the
 * pre-fix run failed as a reproduction and the post-fix run of the same
 * proof passed. Returns [{pre, post}] in record order.
 */
function provenFixVerifications(state) {
  const w = state.work;
  const evs = Object.values(state.evidence).filter((e) => e.kind === 'command' && e.fixVerify && (!w || e.at >= w.startedAt));
  return evs
    .filter((e) => e.fixVerify.phase === 'post-fix' && e.status === 'passed')
    .map((post) => ({ post, pre: state.evidence[post.fixVerify.preFix] }))
    .filter(({ pre }) => pre && pre.status === 'failed' && pre.purpose === 'reproduction');
}

/**
 * Track-specific evidence rules, enforced when the track's last gate is
 * submitted (verification; on the debug track its one phase; gates.submit
 * calls this):
 * - fix: the bug was reproduced (a failed run with purpose=reproduction inside
 *   this work) and the same command passed later — the memory-lesson rule
 *   applied to the delivery itself.
 * - debug: eccode fix verify proved the regression test (it fails on the code
 *   before the fix and passes with it), and a mutation run on the changed
 *   lines is recorded, so the reviewer sees what the test does not check.
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
  if (w.track === 'debug') {
    if (!provenFixVerifications(state).length) {
      problems.push('debug track: no proven fix verification. Run eccode fix verify --actor <owner> --task <task> [--test "<command that runs the regression test>"]: the regression test must fail on the code before the fix and pass with it.');
    }
    const mutation = Object.values(state.evidence).some((e) => e.kind === 'mutation' && e.at >= w.startedAt);
    if (!mutation) {
      problems.push('debug track: no mutation run recorded. Run eccode mutate --actor <owner> --task <task> --test "<command>" --record, then strengthen the test for any survivor that shows untested behavior of the fix.');
    }
  }
  if ((w.track === 'fix' || w.track === 'debug') && !(state.lessons || []).some((l) => l.layer === 'debugging' && l.at >= w.startedAt)) {
    const owned = Object.values(state.tasks).filter((t) => t.owner);
    const [task, owner] = owned.length === 1 ? [owned[0].id, owned[0].owner] : ['<task>', '<the engineer who fixed it>'];
    problems.push(`${w.track} track: no lesson recorded for this work item. Draft one from the record: eccode memory draft --task ${task} --actor ${owner} --out .eccode/drafts/lesson-${task === '<task>' ? 'fix' : task}.json, fill in its TODO fields (symptoms, when it applies, and a failed attempt or delete that entry), then eccode memory add --file <that file> --actor ${owner}. Later work items are shown it when they start.`);
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

/**
 * Before a refactor work item's first claim: null when its behavior command
 * has been recorded passing in this work, else what to run. Checked at the
 * claim, where it can still be met; checkTrackRules checks it again at
 * verification.
 */
function refactorBaselineProblem(state) {
  const w = state.work;
  if (!w || w.track !== 'refactor') return null;
  if (Object.values(state.tasks).some((t) => t.history.some((h) => h.event === 'claimed'))) return null;
  const b = normCmd(w.behaviorCommand || '');
  const green = Object.values(state.evidence).some((e) => e.kind === 'command' && e.at >= w.startedAt && e.status === 'passed' && normCmd(e.command) === b);
  return green ? null : `refactor track: record the behavior command passing before the first task claim, to prove the baseline is green: eccode evidence run --actor <you> --label baseline -- ${JSON.stringify(w.behaviorCommand)}`;
}

module.exports = { startWork, abandonWork, checkTrackRules, refactorBaselineProblem, provenFixVerifications, baseline, quickPlan, oneTaskPlan, ONE_TASK, TRACKS };
