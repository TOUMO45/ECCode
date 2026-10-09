'use strict';
// Phased tasks with explicit ownership. Conflicting edits are prevented by
// file-ownership globs: two tasks whose globs may overlap can never be
// claimed at the same time, and completion is refused if the handoff reports
// changes outside the task's globs, or git shows changes no task accounts for.

const fs = require('fs');
const path = require('path');
const { EccodeError, newId, own, isReservedKey, globsOverlap, matchesAny, writeJson, exists, sha256File, globstarCount, toPosix } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, gitHead, gitChangedFiles, projectRelative } = require('./project');
const { resolveRef, deepRedact } = require('./evidence');
const { retrieveForTask, checkDecisions, boundLessons } = require('./lessons');
const { Memory } = require('./memory/records');

// Scratch area every task may use. Records, artifacts of other gates and
// reviews under .eccode/ are never part of a task's ownership.
const ALWAYS_ALLOWED = ['.eccode/drafts/**'];

/**
 * Does a task with these ownership globs own `file`? Paths under .eccode/ are
 * never owned, whatever the globs say (a plausible `**\/*.json` must not reach
 * the config or approved artifacts); only the .eccode/drafts/ scratch area is.
 */
// Never owned, whatever the globs say: the record, the hooks and settings that register
// the guard (and the installed engine under .claude/eccode/), and git's own metadata.
const NEVER_OWNED = ['.claude/', '.git/'];
// Ids the engine assigns to reworks; a plan must not pre-empt them.
const RESERVED_ID = /^rework-\d+$/;

function owns(globs, file) {
  if (file.startsWith('.eccode/')) return matchesAny(file, ALWAYS_ALLOWED);
  if (NEVER_OWNED.some((p) => file.startsWith(p))) return false;
  return matchesAny(file, globs);
}

/**
 * Why an ownership glob is unacceptable in a plan or a rework (null = fine). A broad glob such as
 * `**\/*.json` is allowed (ownership of .claude/ and .git/ is refused at edit time by `owns`), but a
 * glob that names them is a plan mistake, and exponential globs are refused outright.
 */
function globProblem(glob) {
  if (globstarCount(glob) > 3) return `has more than three ** segments; matching it is exponential`;
  const clean = String(glob).replace(/^\.\//, '');
  if (NEVER_OWNED.some((p) => clean.startsWith(p))) return 'names .claude/ (hooks, settings, the installed engine) or .git/, which no task may own';
  return null;
}

/**
 * Paths a handoff may not list, and reasons: a symlink (a write through it lands
 * elsewhere), or a file whose real location is outside the project or inside the
 * record. Ownership is judged on the lexical path, so these must be refused outright.
 */
function unsafePaths(root, rels) {
  const out = [];
  for (const rel of rels) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // deleted files are checked by git, not here
    }
    if (st.isSymbolicLink()) {
      out.push(`${rel} is a symbolic link (writes through it land elsewhere)`);
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue;
    }
    const realRoot = fs.realpathSync(root);
    const relReal = toPosix(path.relative(realRoot, real));
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) out.push(`${rel} resolves outside the project (${real})`);
    else if (relReal.startsWith('.eccode/') && !relReal.startsWith('.eccode/drafts/')) out.push(`${rel} resolves into the record (${relReal})`);
  }
  return out;
}

function fileSha(root, rel) {
  const abs = path.join(root, rel);
  try {
    return exists(abs) ? sha256File(abs) : null;
  } catch {
    return 'unreadable'; // e.g. a directory: never equal to a recorded hash
  }
}

/** Working-tree files already changed at claim time, with their content hash (null = deleted). */
function dirtySnapshot(root, baseCommit) {
  const files = (gitChangedFiles(root, baseCommit) || []).filter((f) => !f.startsWith('.eccode/'));
  return Object.fromEntries(files.map((f) => [f, fileSha(root, f)]));
}

/**
 * Files git shows as changed since the claim that no task accounts for, and
 * that lie outside this task's ownership. A change is accounted for when this
 * handoff declares it, when it was already dirty at claim time and is
 * unchanged, or when it lies in the ownership of another task at work during
 * this claim (claimed now, or claimed/completed/failed since the claim):
 * parallel work is checked when that task completes. Claims recorded by older
 * versions carry no dirty snapshot: any task's recorded files are then
 * accepted. The record (.eccode/) is checked elsewhere.
 */
function unaccountedChanges(state, root, t, declared, actual) {
  const dirty = t.claim.dirtyAtClaim;
  const others = Object.values(state.tasks).filter((x) => x.id !== t.id);
  const parallel = others.filter((x) => x.status === 'claimed' || x.history.some((h) => h.event !== 'reset' && h.at >= t.claim.at));
  const recorded = new Set(dirty ? [] : others.flatMap((x) => x.filesChanged || []));
  return actual.filter((f) => {
    if (f.startsWith('.eccode/') || declared.includes(f) || owns(t.files, f) || recorded.has(f)) return false;
    if (dirty && own(dirty, f) !== undefined && own(dirty, f) === fileSha(root, f)) return false;
    return !parallel.some((x) => owns(x.files, f));
  });
}

function ownerOf(state, file) {
  const owner = Object.values(state.tasks).find((x) => owns(x.files, file));
  return owner ? `task ${owner.id}'s ownership` : 'no task\'s ownership';
}

/** Structural + semantic plan validation. Returns error strings. */
/**
 * Ownership globs that point into .eccode/ (other than drafts/) never grant ownership (see `owns`),
 * so a plan that lists them is mistaken about what its tasks may write. Reported as warnings by
 * `eccode plan validate`, since the engine already enforces the rule at completion.
 */
function recordGlobWarnings(tasks) {
  const out = [];
  for (const t of tasks) {
    for (const g of t.files || []) {
      const clean = String(g).replace(/^\.\//, '');
      if (clean.startsWith('.eccode/') && !clean.startsWith('.eccode/drafts/')) {
        out.push(`${t.id}: ownership glob ${g} never grants ownership (.eccode/ is the record; only .eccode/drafts/ is writable; artifacts are submitted to gates, not owned)`);
      } else if (matchesAny('.claude/settings.json', [clean]) || matchesAny('.git/HEAD', [clean])) {
        out.push(`${t.id}: ownership glob ${g} reaches .claude/ or .git/, which are never owned (the engine refuses those edits; narrow the glob if that was not intended)`);
      }
    }
  }
  return out;
}

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
  // Task and phase ids become keys of state maps; Object.prototype names are reserved.
  for (const id of [...phaseIds, ...plan.tasks.map((t) => t.id)]) {
    if (isReservedKey(id)) errors.push(`id ${id} is reserved`);
    if (RESERVED_ID.test(id)) errors.push(`id ${id} is reserved for engine-opened reworks`);
  }
  for (const t of plan.tasks) {
    if (!phaseIndex.has(t.phase)) errors.push(`task ${t.id}: unknown phase ${t.phase}`);
    if (!knownRoles.has(t.owner)) errors.push(`task ${t.id}: owner ${t.owner} is not a configured role`);
    for (const g of t.files) {
      const problem = globProblem(g);
      if (problem) errors.push(`task ${t.id}: ownership glob ${g} ${problem}`);
    }
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
    if (!t.dependencies.every((d) => own(state.tasks, d) && own(state.tasks, d).status === 'done')) return false;
    if (claimed.some((c) => globsOverlap(c.files, t.files))) return false;
    return claimed.length < config.limits.maxConcurrency;
  });
}

function maxAttempts(config) {
  return 1 + config.limits.maxTaskRetries;
}

function claim(store, config, taskId, actor, { runId } = {}) {
  // Verified lessons that match the task are retrieved here, before the store
  // lock is taken (retrieval reads memory files), and recorded on the claim.
  const before = store.state();
  const candidate = before.tasks ? own(before.tasks, taskId) : null;
  const lessons = candidate ? boundLessons(store, config, candidate, before, retrieveForTask(store, config, candidate, before.project)) : [];
  return store.commit('task.claimed', actor, { task: taskId, runId: runId || null }, (state) => {
    const t = own(state.tasks, taskId);
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (state.gates.plan.status !== 'approved') throw new EccodeError('GATE_BLOCKED', 'The plan gate must be approved before tasks are claimed');
    const gate = state.gates[phaseGateOf(t)];
    if (!['in_progress', 'changes_requested'].includes(gate.status)) {
      throw new EccodeError('GATE_BLOCKED', `Phase gate ${gate.id} is ${gate.status}; start it first (eccode gate start ${gate.id})`);
    }
    if (t.owner !== actor) throw new EccodeError('OWNERSHIP', `Task ${taskId} is owned by ${t.owner}, not ${actor}`);
    if (t.status !== 'pending') throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
    const blocked = t.dependencies.filter((d) => !own(state.tasks, d) || own(state.tasks, d).status !== 'done');
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
    const baseCommit = gitHead(store.root);
    // What was already dirty, so completion blames the task only for what changed during the claim.
    const extra = baseCommit ? { baseCommit, dirtyAtClaim: dirtySnapshot(store.root, baseCommit) } : { baseCommit };
    if (lessons.length) extra.lessons = lessons; // only present when something matched, so older logs replay unchanged
    return extra;
  });
}

function validateHandoff(state, root, handoff) {
  const errors = validateNamed('handoff', handoff);
  if (errors.length) return errors;
  for (const ref of handoff.evidence) {
    const res = resolveRef(state, root, ref);
    if (!res.ok) errors.push(`evidence ${res.reason}`);
  }
  return errors;
}

function recordHandoff(store, actor, rawHandoff) {
  const id = newId('ho');
  const handoff = deepRedact(rawHandoff); // a secret pasted into a handoff never reaches the record
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
function complete(store, config, taskId, actor, rawHandoff) {
  const handoffId = newId('ho');
  const handoff = deepRedact(rawHandoff);
  const res = store.commit('task.completed', actor, { task: taskId, handoffId }, (state) => {
    const t = own(state.tasks, taskId);
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (t.status !== 'claimed' || t.claim.agent !== actor) {
      throw new EccodeError('OWNERSHIP', `Task ${taskId} is not claimed by ${actor} (status ${t.status})`);
    }
    const errors = validateHandoff(state, store.root, handoff);
    if (handoff.task !== taskId) errors.push(`handoff.task must be ${taskId}`);
    if (handoff.from !== actor) errors.push(`handoff.from must be ${actor}`);
    const checks = handoff.evidence
      .map((r) => own(state.evidence, r.slice(3)))
      .filter((e) => e && e.kind === 'command' && e.status === 'passed' && e.at >= t.claim.at);
    if (!checks.length) errors.push('handoff must cite at least one passing check (ev:<id>) executed after the task was claimed');
    const changed = (handoff.filesChanged || []).map((f) => projectRelative(store.root, f));
    const outside = changed.filter((f) => !owns(t.files, f));
    if (outside.length) errors.push(`files outside task ownership (${t.files.join(', ')}; .eccode/ only under drafts/): ${outside.join(', ')}`);
    const actual = gitChangedFiles(store.root, t.claim.baseCommit);
    if (actual) {
      const missing = changed.filter((f) => !actual.includes(f));
      if (missing.length) errors.push(`handoff lists files that git shows as unchanged since claim: ${missing.join(', ')}`);
      const unaccounted = unaccountedChanges(state, store.root, t, changed, actual);
      if (unaccounted.length) {
        errors.push(`files changed since the claim that no task declares (revert them, or have the owning task declare them): ${unaccounted.map((f) => `${f} (in ${ownerOf(state, f)})`).join(', ')}`);
      }
      // Changes inside this task's ownership must be declared too: an undeclared file is never
      // pinned by the phase submission, so it could be rewritten after approval unnoticed.
      const dirty = t.claim.dirtyAtClaim;
      if (dirty) {
        const undeclared = actual.filter((f) => !f.startsWith('.eccode/') && !changed.includes(f) && owns(t.files, f) && !(own(dirty, f) !== undefined && own(dirty, f) === fileSha(store.root, f)));
        if (undeclared.length) errors.push(`files changed inside your ownership that the handoff does not declare (every change is reviewed, or reverted): ${undeclared.join(', ')}`);
      }
      // Symlinks and paths that resolve elsewhere defeat ownership and record protection.
      errors.push(...unsafePaths(store.root, [...new Set([...changed, ...actual.filter((f) => owns(t.files, f))])]));
    }
    const lessonCheck = checkDecisions(store, config, t.claim, handoff, actor);
    errors.push(...lessonCheck.errors);
    if (errors.length) throw new EccodeError('INVALID_HANDOFF', `Task completion rejected:\n- ${errors.join('\n- ')}`, { errors });
    return lessonCheck.decisions.length ? { filesChanged: changed, lessonDecisions: lessonCheck.decisions } : { filesChanged: changed };
  });
  // Lessons that were applied are cited, so the record shows which knowledge was used where.
  for (const d of res.event.data.lessonDecisions || []) {
    if (d.decision !== 'applied') continue;
    try {
      new Memory(store, config).cite(d.id, actor, `task ${taskId}: ${d.note}`.slice(0, 300));
    } catch {
      /* a lesson that vanished between claim and completion does not undo the work */
    }
  }
  store.commit('handoff.recorded', actor, { id: handoffId, handoff });
  writeJson(store.path('handoffs', `${handoffId}.json`), handoff);
  return res;
}

function fail(store, config, taskId, actor, reason, { interrupted = false } = {}) {
  return store.commit('task.failed', actor, { task: taskId, reason, interrupted }, (state) => {
    const t = own(state.tasks, taskId);
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
 * delivery-lead, from done) or after escalation (the user only: directly, or
 * an agent spending the user's delegation, lib/authority.js).
 */
function reset(store, taskId, actor, reason, { delegation } = {}) {
  const escalated = (state) => {
    const t = own(state.tasks, taskId);
    return t && t.status === 'escalated' ? `Task ${taskId} is escalated` : false;
  };
  return require('./authority').commitReserved(store, { type: 'task.reset', actor, data: { task: taskId, reason }, action: 'task.reset', target: taskId, delegation, needsUser: escalated, check: (state) => {
    const t = own(state.tasks, taskId);
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (!reason) throw new EccodeError('INVALID_INPUT', 'A reason is required');
    if (t.status === 'done' && !['orchestrator', 'delivery-lead', 'user'].includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', 'Rework of a completed task is scheduled by the orchestrator or delivery-lead');
    }
    if (!['done', 'escalated'].includes(t.status)) throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
    // A reset under a submitted/approved phase could never be reclaimed (claims need an open phase).
    const gate = own(state.gates, phaseGateOf(t));
    if (gate && ['submitted', 'approved'].includes(gate.status)) {
      throw new EccodeError('INVALID_TRANSITION', `Phase gate ${gate.id} is ${gate.status}; rework is scheduled after a review requests changes`);
    }
  } });
}

module.exports = { validatePlan, ownershipConflicts, recordGlobWarnings, readyTasks, claim, complete, fail, reset, recordHandoff, validateHandoff, maxAttempts, owns, globProblem, unsafePaths, RESERVED_ID };
