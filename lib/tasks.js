'use strict';
// Phased tasks with explicit ownership. Conflicting edits are prevented by
// file-ownership globs: two tasks whose globs may overlap can never be
// claimed at the same time, and completion is refused if the handoff reports
// changes outside the task's globs.

const { EccodeError, newId, globsOverlap, matchesAny, writeJson } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, gitHead, gitChangedFiles, projectRelative } = require('./project');
const { resolveRef, redact } = require('./evidence');
const lean = require('./lean');
const compat = require('./compat');

// Scratch area every task may use. Records, artifacts of other gates and
// reviews under .eccode/ are never part of a task's ownership.
const ALWAYS_ALLOWED = ['.eccode/drafts/**'];

/** Structural + semantic plan validation. Returns error strings. */
function validatePlan(plan, config) {
  const errors = validateNamed('plan', plan);
  if (errors.length) return errors;
  const phaseIds = plan.phases.map((p) => p.id);
  const phaseIndex = new Map(phaseIds.map((id, i) => [id, i]));
  if (new Set(phaseIds).size !== phaseIds.length) errors.push('phase ids must be unique');
  const ids = new Set();
  const byId = new Map();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
    byId.set(t.id, t);
  }
  const knownRoles = new Set(Object.values(config.roles).flatMap((r) => [...r.authors, ...r.reviewers]));
  for (const t of plan.tasks) {
    if (!phaseIndex.has(t.phase)) errors.push(`task ${t.id}: unknown phase ${t.phase}`);
    if (!knownRoles.has(t.owner)) errors.push(`task ${t.id}: owner ${t.owner} is not a configured role`);
    for (const dep of t.dependencies) {
      const d = byId.get(dep);
      if (!d) errors.push(`task ${t.id}: unknown dependency ${dep}`);
      else if (phaseIndex.get(d.phase) > phaseIndex.get(t.phase)) {
        errors.push(`task ${t.id}: depends on ${dep} from a later phase`);
      }
    }
  }
  for (const p of plan.phases) {
    if (!plan.tasks.some((t) => t.phase === p.id)) errors.push(`phase ${p.id} has no tasks`);
  }
  // Cycle detection (DFS).
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'active');
    for (const dep of (byId.get(id) || { dependencies: [] }).dependencies) if (byId.has(dep)) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const t of plan.tasks) visit(t.id, []);
  return errors;
}

/** Pairs of tasks in the same phase that could run in parallel but share files. */
function ownershipConflicts(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, new Set(t.dependencies)]));
  const reaches = (a, b, seen = new Set()) => {
    if (seen.has(a)) return false;
    seen.add(a);
    for (const d of deps.get(a) || []) if (d === b || reaches(d, b, seen)) return true;
    return false;
  };
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a.phase !== b.phase || reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
      if (globsOverlap(a.files, b.files)) out.push([a.id, b.id]);
    }
  }
  return out;
}

function phaseGateOf(task) {
  return `phase:${task.phase}`;
}

function readyTasks(state, config) {
  const claimed = Object.values(state.tasks).filter((t) => t.status === 'claimed');
  return Object.values(state.tasks).filter((t) => {
    if (t.status !== 'pending') return false;
    const gate = state.gates[phaseGateOf(t)];
    if (!gate || !['in_progress', 'changes_requested'].includes(gate.status)) return false;
    if (!t.dependencies.every((d) => state.tasks[d] && state.tasks[d].status === 'done')) return false;
    if (claimed.some((c) => globsOverlap(c.files, t.files))) return false;
    return claimed.length < config.limits.maxConcurrency;
  });
}

function maxAttempts(config) {
  return 1 + config.limits.maxTaskRetries;
}

function claim(store, config, taskId, actor, { runId } = {}) {
  // The lean baseline is taken once, at the task's first claim, and read before
  // taking the record lock: scanning a large ownership area must not hold up
  // other agents' commits.
  const pending = store.state().tasks[taskId];
  const leanBase = pending && !pending.leanBase ? lean.claimSnapshot(store.root, config, pending.files) : null;
  const compatBase = pending && !pending.compatBase ? compat.claimSnapshot(store.root, config, pending.files) : null;
  return store.commit('task.claimed', actor, { task: taskId, runId: runId || null, ...(leanBase ? { leanBase } : {}), ...(compatBase ? { compatBase } : {}) }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    // Tracks without a plan gate (quick) import their one-task plan at work
    // start, authorized by the actor who started the work.
    if (state.gates.plan && state.gates.plan.status !== 'approved') throw new EccodeError('GATE_BLOCKED', 'The plan gate must be approved before tasks are claimed');
    if (!state.gates.plan && !state.plan) throw new EccodeError('GATE_BLOCKED', 'No plan imported for this work item');
    const gate = state.gates[phaseGateOf(t)];
    if (!['in_progress', 'changes_requested'].includes(gate.status)) {
      throw new EccodeError('GATE_BLOCKED', `Phase gate ${gate.id} is ${gate.status}; start it first (eccode gate start ${gate.id})`);
    }
    if (t.owner !== actor) throw new EccodeError('OWNERSHIP', `Task ${taskId} is owned by ${t.owner}, not ${actor}`);
    if (t.status !== 'pending') throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
    const blocked = t.dependencies.filter((d) => state.tasks[d].status !== 'done');
    if (blocked.length) throw new EccodeError('DEPENDENCY_PENDING', `Task ${taskId} waits on: ${blocked.join(', ')}`);
    if (t.attempts >= maxAttempts(config)) throw new EccodeError('RETRY_LIMIT', `Task ${taskId} has used all ${maxAttempts(config)} attempts`);
    const active = Object.values(state.tasks).filter((x) => x.status === 'claimed');
    if (active.length >= config.limits.maxConcurrency) {
      throw new EccodeError('CONCURRENCY_LIMIT', `maxConcurrency=${config.limits.maxConcurrency} reached (active: ${active.map((x) => x.id).join(', ')})`);
    }
    const conflict = active.find((x) => globsOverlap(x.files, t.files));
    if (conflict) {
      throw new EccodeError('OWNERSHIP_CONFLICT', `Task ${taskId} files overlap with active task ${conflict.id} (claimed by ${conflict.claim.agent}); wait or re-plan ownership`);
    }
    assertBudget(state, config);
    return { baseCommit: gitHead(store.root) };
  });
}

function asStrings(v) {
  return (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');
}

function validateHandoff(state, root, handoff) {
  const errors = validateNamed('handoff', handoff);
  if (errors.length) return errors;
  const unfilled = require('./quick').placeholders(handoff);
  if (unfilled.length) errors.push(`fill in ${unfilled.join(', ')}: still the draft's TODO placeholder`);
  for (const ref of handoff.evidence) {
    const res = resolveRef(state, root, ref);
    if (!res.ok) errors.push(`evidence ${res.reason}`);
  }
  return errors;
}

function recordHandoff(store, actor, handoff) {
  const id = newId('ho');
  store.commit('handoff.recorded', actor, { id, handoff }, (state) => {
    const errors = validateHandoff(state, store.root, handoff);
    if (handoff.from !== actor) errors.push(`handoff.from (${handoff.from}) must match the acting agent (${actor})`);
    if (errors.length) throw new EccodeError('INVALID_HANDOFF', `Handoff rejected:\n- ${errors.join('\n- ')}`, { errors });
  });
  writeJson(store.path('handoffs', `${id}.json`), handoff);
  return id;
}

/**
 * Complete a claimed task with a validated handoff. Requires a passing check
 * recorded after the claim, and changed files inside the task's ownership.
 */
function complete(store, config, taskId, actor, handoff) {
  const handoffId = newId('ho');
  // Lean checks also run outside the lock; the claim they saw is re-checked inside.
  const preState = store.state();
  const pre = preState.tasks[taskId];
  const leanResult = pre && pre.status === 'claimed' && handoff && typeof handoff === 'object'
    ? lean.checkCompletion(store.root, config, pre, handoff, gitChangedFiles(store.root, pre.claim.baseCommit))
    : null;
  if (leanResult && leanResult.stats) {
    const cp = compat.checkCompletion(store.root, config, preState, pre, handoff);
    leanResult.errors.push(...cp.errors);
    if (cp.stats) {
      leanResult.stats.breaking = cp.stats.breaking;
      leanResult.stats.declaredBreaking = cp.stats.declaredBreaking;
      if (cp.warnings.length) leanResult.stats.warnings = [...(leanResult.stats.warnings || []), ...cp.warnings];
    }
    // Bug patterns on the lines this task added (lib/bugs.js, built-in rules only).
    const bg = require('./bugs').checkCompletion(store.root, config, pre, handoff, gitChangedFiles(store.root, pre.claim.baseCommit));
    leanResult.errors.push(...bg.errors);
    if (bg.stats) leanResult.stats.bugs = bg.stats;
  }
  if (leanResult && leanResult.stats) {
    // Measured blast radius of the change, for the phase reviewer. Advisory:
    // an index failure must never block a completion, so it only annotates.
    try {
      const changed = asStrings(handoff.filesChanged).filter((f) => !f.startsWith('.eccode/'));
      if (changed.length) {
        const imp = require('./codebase').impact(store.root, changed);
        leanResult.stats.impact = { dependents: imp.dependents.length, modules: imp.modules.slice(0, 20), modulesTotal: imp.modules.length, tests: imp.tests.slice(0, 30), testsTotal: imp.tests.length };
        if (!imp.tests.length && leanResult.stats.codeFiles) {
          (leanResult.stats.warnings = leanResult.stats.warnings || []).push('impact: no test file depends on the changed files (by the import index)');
        }
      }
    } catch (err) {
      leanResult.stats.impact = { error: String(err.message || err).slice(0, 200) };
    }
  }
  const res = store.commit('task.completed', actor, { task: taskId, handoffId }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (t.status !== 'claimed' || t.claim.agent !== actor) {
      throw new EccodeError('OWNERSHIP', `Task ${taskId} is not claimed by ${actor} (status ${t.status})`);
    }
    const errors = validateHandoff(state, store.root, handoff);
    if (handoff.task !== taskId) errors.push(`handoff.task must be ${taskId}`);
    if (handoff.from !== actor) errors.push(`handoff.from must be ${actor}`);
    const checks = handoff.evidence
      .map((r) => state.evidence[r.slice(3)])
      .filter((e) => e && e.kind === 'command' && e.status === 'passed' && e.at >= t.claim.at);
    if (!checks.length) errors.push('handoff must cite at least one passing check (ev:<id>) executed after the task was claimed');
    // The plan's verification command is the check the plan reviewer approved;
    // any other passing command (even `true`) does not stand in for it.
    const pinned = t.verification && t.verification.command;
    const same = (a, b) => String(a).trim().replace(/\s+/g, ' ') === String(b).trim().replace(/\s+/g, ' ');
    if (pinned && checks.length && !checks.some((e) => same(e.command, redact(pinned)))) {
      errors.push(`handoff must cite a passing run of the task's planned verification command, recorded after the claim. Run it exactly, as one argument: eccode evidence run --actor ${actor} --task ${taskId} --label verify -- ${JSON.stringify(pinned)}`);
    }
    const changed = (handoff.filesChanged || []).map((f) => projectRelative(store.root, f));
    const outside = changed.filter((f) => !matchesAny(f, [...t.files, ...ALWAYS_ALLOWED]));
    if (outside.length) errors.push(`files outside task ownership (${t.files.join(', ')}): ${outside.join(', ')}`);
    const actual = gitChangedFiles(store.root, t.claim.baseCommit);
    if (actual) {
      const missing = changed.filter((f) => !actual.includes(f));
      if (missing.length) errors.push(`handoff lists files that git shows as unchanged since claim: ${missing.join(', ')}`);
    }
    if (leanResult && (pre.attempts !== t.attempts || pre.claim.at !== t.claim.at)) errors.push('the task was re-claimed while completing; retry the completion');
    else if (leanResult) errors.push(...leanResult.errors);
    if (errors.length) throw new EccodeError('INVALID_HANDOFF', `Task completion rejected:\n- ${errors.join('\n- ')}`, { errors });
    return { filesChanged: changed, ...(leanResult && leanResult.stats ? { lean: leanResult.stats } : {}) };
  });
  store.commit('handoff.recorded', actor, { id: handoffId, handoff });
  writeJson(store.path('handoffs', `${handoffId}.json`), handoff);
  return res;
}

function fail(store, config, taskId, actor, reason, { interrupted = false } = {}) {
  return store.commit('task.failed', actor, { task: taskId, reason, interrupted }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (t.status !== 'claimed') throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}, not claimed`);
    if (!interrupted && actor !== t.claim.agent && actor !== 'orchestrator') {
      throw new EccodeError('OWNERSHIP', `Only ${t.claim.agent} or the orchestrator can fail task ${taskId}`);
    }
    if (!reason) throw new EccodeError('INVALID_INPUT', 'A failure reason is required');
    if (t.attempts >= maxAttempts(config)) {
      return {
        escalated: true,
        recovery: `Task ${taskId} failed ${t.attempts} time(s). Ask the user to choose: re-scope the task, assign a different owner, or open a learning-debugger investigation; then eccode task reset ${taskId} --actor user --reason "<decision>".`,
      };
    }
    return { escalated: false };
  });
}

/**
 * Return a task to pending: rework after a review finding (orchestrator or
 * delivery-lead, from done) or after escalation (user only).
 */
function reset(store, taskId, actor, reason) {
  return store.commit('task.reset', actor, { task: taskId, reason }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (!reason) throw new EccodeError('INVALID_INPUT', 'A reason is required');
    if (t.status === 'escalated' && actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Only the user may reset an escalated task');
    if (t.status === 'done' && !['orchestrator', 'delivery-lead', 'user'].includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', 'Rework of a completed task is scheduled by the orchestrator or delivery-lead');
    }
    if (!['done', 'escalated'].includes(t.status)) throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
  });
}

/**
 * Change a pending task's file ownership. On the quick track the orchestrator
 * wrote the one-task plan, so it may correct it; a reviewed plan is changed
 * only by the user. The task must not be claimed: releasing it first (task
 * fail) means the next claim takes its baselines over the new files.
 */
function rescope(store, config, taskId, actor, { files, command, reason } = {}) {
  const globs = String(files || '').split(',').map((f) => f.trim()).filter(Boolean);
  const cmd = command === undefined || command === null ? null : String(command).trim();
  return store.commit('task.rescoped', actor, { task: taskId, files: globs.length ? globs : null, command: cmd, reason }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    // One-task tracks plan themselves (no plan gate), so their orchestrator
    // may correct the ownership or the pinned check; a reviewed plan's are the user's.
    const oneTask = Boolean(state.work && require('./works').ONE_TASK[state.work.track]);
    if (!(actor === 'user' || (oneTask && actor === 'orchestrator'))) {
      throw new EccodeError('ROLE_NOT_ALLOWED', oneTask ? `A ${state.work.track} task is rescoped by the orchestrator or the user` : 'This task belongs to a reviewed plan: only the user may change its ownership or its pinned check');
    }
    if (!globs.length && !cmd) throw new EccodeError('INVALID_INPUT', 'rescope needs --files <glob,glob>, --command "<verification command>", or both');
    if (cmd !== null && cmd.length < 3) throw new EccodeError('INVALID_INPUT', 'rescope --command needs the verification command');
    if (!reason || reason.trim().length < 10) throw new EccodeError('INVALID_INPUT', 'rescope needs --reason (>= 10 chars)');
    if (t.status !== 'pending') {
      throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}; release it first (eccode task fail ${taskId} --actor orchestrator --reason "..."), so the next claim starts from the new scope`);
    }
    const conflict = globs.length && Object.values(state.tasks).find((x) => x.id !== taskId && x.status === 'claimed' && globsOverlap(x.files, globs));
    if (conflict) throw new EccodeError('OWNERSHIP_CONFLICT', `The new files overlap active task ${conflict.id}`);
    return { from: t.files, ...(cmd ? { fromCommand: (t.verification && t.verification.command) || null } : {}) };
  });
}

/** The commit a task's change is measured from: its open claim's base, else the base of the claim that completed. */
function taskBase(t) {
  return (t && ((t.claim && t.claim.baseCommit) || t.baseCommit)) || null;
}

module.exports = { validatePlan, ownershipConflicts, readyTasks, claim, complete, fail, reset, rescope, recordHandoff, validateHandoff, maxAttempts, taskBase };
