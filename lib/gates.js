'use strict';
// Review gates. This module is where "approval means the criteria are
// satisfied" is enforced in code rather than in prompts:
//   - a gate cannot start before its predecessor is approved
//   - authors cannot approve their own work (any submitter, any task owner)
//   - reviews must target the latest submission, and artifacts must not have
//     changed since it was submitted
//   - approvals need resolvable evidence for every criterion, no open
//     blocking/major findings, and explicit resolution of earlier findings
//   - implementation/verification approvals need a passing check that the
//     reviewer executed after the latest submission
//   - repeated rejections escalate to the user with a recovery path

const fs = require('fs');
const path = require('path');
const { EccodeError, newId, sha256File, exists, readJson, writeJson } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, rolesFor, projectRelative } = require('./project');
const { resolveRef, redact: redactSecrets } = require('./evidence');
const { gateKind } = require('./reducer');
const { validatePlan } = require('./tasks');
const { coverage } = require('./delivery');

const ORCHESTRATOR = 'orchestrator';
const USER = 'user';


// A reproduction is meant to fail: it shows the bug before the fix. Its failure
// supports a met criterion unless the integrity window failed the run.
function shownFailure(ev) {
  return ev.purpose === 'reproduction' && !ev.integrity;
}

function getGate(state, gateId) {
  const g = state.gates[gateId];
  if (!g || !state.gateOrder.includes(gateId)) {
    throw new EccodeError('UNKNOWN_GATE', `Unknown gate "${gateId}". Gates: ${state.gateOrder.join(', ')}`);
  }
  return g;
}

function predecessor(state, gateId) {
  const idx = state.gateOrder.indexOf(gateId);
  return idx > 0 ? state.gateOrder[idx - 1] : null;
}

// reviewers: when the orchestrator dispatches more than one reviewer to a gate
// (a phase touching auth gets the technical and the security reviewer), each
// of them must approve the same submission before the gate is approved.
function startGate(store, config, gateId, actor, { reviewers } = {}) {
  const named = reviewers && reviewers.length ? [...new Set(reviewers)] : null;
  return store.commit('gate.started', actor, { gate: gateId, ...(named ? { reviewers: named } : {}) }, (state) => {
    const g = getGate(state, gateId);
    const roles = rolesFor(config, gateId);
    if (actor !== ORCHESTRATOR && !roles.authors.includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not start gate ${gateId}; allowed: ${ORCHESTRATOR}, ${roles.authors.join(', ')}`);
    }
    if (named && actor !== ORCHESTRATOR) {
      throw new EccodeError('ROLE_NOT_ALLOWED', `Only the ${ORCHESTRATOR} names the reviewers of gate ${gateId}`);
    }
    const unknown = (named || []).filter((r) => !roles.reviewers.includes(r));
    if (unknown.length) {
      throw new EccodeError('INVALID_INPUT', `${unknown.join(', ')} may not review ${gateId} (allowed: ${roles.reviewers.join(', ')})`);
    }
    if (gateId === 'plan') {
      const ambiguity = require('./design').ambiguityProblem(state);
      if (ambiguity) throw new EccodeError('AMBIGUITY_OPEN', ambiguity);
    }
    if (g.status !== 'pending') {
      throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is already ${g.status}`);
    }
    const prev = predecessor(state, gateId);
    if (prev && state.gates[prev].status !== 'approved') {
      throw new EccodeError('GATE_BLOCKED', `Gate ${gateId} cannot start: predecessor ${prev} is ${state.gates[prev].status}, not approved`);
    }
    assertBudget(state, config);
  });
}

function headings(markdown) {
  return markdown
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim().toLowerCase());
}

function missingSections(root, artifacts, required) {
  const all = artifacts
    .filter((a) => a.path.endsWith('.md'))
    .flatMap((a) => headings(fs.readFileSync(path.join(root, a.path), 'utf8')));
  return required.filter((sec) => !all.some((h) => h.includes(sec.toLowerCase())));
}

// An empty file may be submitted beside others (a new package's __init__.py
// that a task changed); a submission with nothing but empty files is refused.
function hashArtifacts(root, files) {
  if (!files || files.length === 0) throw new EccodeError('INVALID_INPUT', 'A submission needs at least one artifact');
  const rels = [...new Set(files)].map((f) => {
    const rel = projectRelative(root, f);
    const abs = path.join(root, rel);
    if (!exists(abs) || !fs.statSync(abs).isFile()) throw new EccodeError('NOT_FOUND', `Artifact not found: ${rel}`);
    return rel;
  });
  if (rels.every((rel) => fs.statSync(path.join(root, rel)).size === 0)) {
    throw new EccodeError('EMPTY_ARTIFACT', `Every artifact is empty: ${rels.join(', ')}`);
  }
  return rels.map((rel) => ({ path: rel, sha256: sha256File(path.join(root, rel)) }));
}

function phaseTasks(state, gateId) {
  const phase = gateId.slice('phase:'.length);
  return Object.values(state.tasks).filter((t) => t.phase === phase);
}

/**
 * Submit artifacts for review. For phase gates with no explicit artifacts,
 * the files changed by the phase's completed tasks are submitted.
 */
function submit(store, config, gateId, actor, { artifacts = [], respondsTo, notes } = {}) {
  let planToImport = null;
  const result = store.commit('gate.submitted', actor, { gate: gateId, respondsTo: respondsTo || null, notes: notes || null }, (state) => {
    const g = getGate(state, gateId);
    const roles = rolesFor(config, gateId);
    if (!roles.authors.includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not submit ${gateId}; authors: ${roles.authors.join(', ')}`);
    }
    // A submission whose artifacts changed after it can never be reviewed: its
    // author replaces it with a new one.
    const superseded = g.status === 'submitted' && staleArtifacts(store.root, g.submissions[g.submissions.length - 1]).length > 0;
    if (!['in_progress', 'changes_requested'].includes(g.status) && !superseded) {
      throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is ${g.status}; submissions require in_progress or changes_requested${g.status === 'submitted' ? ' (or an artifact of the pending submission changed since)' : ''}`);
    }
    if (g.status === 'changes_requested') {
      const lastReview = g.reviews[g.reviews.length - 1];
      if (respondsTo !== lastReview) {
        throw new EccodeError('RESPONSE_REQUIRED', `Resubmission must respond to the latest review: pass --responds-to ${lastReview}`, {
          openFindings: g.openFindings.map((f) => `${f.id} [${f.severity}] ${f.title}`),
        });
      }
    }
    let files = artifacts;
    if (gateKind(gateId) === 'phase') {
      const tasks = phaseTasks(state, gateId);
      const unfinished = tasks.filter((t) => t.status !== 'done');
      if (unfinished.length) {
        throw new EccodeError('PHASE_INCOMPLETE', `Phase has unfinished tasks: ${unfinished.map((t) => `${t.id}(${t.status})`).join(', ')}`);
      }
      // The tasks' changed files are always submitted; --artifact adds files.
      files = [...new Set([...files, ...tasks.flatMap((t) => t.filesChanged || [])])];
    }
    const hashed = hashArtifacts(store.root, files);
    // The track's last gate (verification, or the debug track's one phase).
    if (state.gateOrder[state.gateOrder.length - 1] === gateId) {
      // Only reviewed code ships: the final review must see every file changed
      // since this work item started that no earlier approval covered.
      const cov = coverage(state, store.root, hashed.map((a) => a.path));
      if (cov && cov.uncovered.length) {
        throw new EccodeError('UNREVIEWED_CHANGES', `Files changed since this work item started are not covered by any approved gate or by this submission. Add them as --artifact, or revert them:\n- ${cov.uncovered.join('\n- ')}`, { files: cov.uncovered });
      }
      const trackProblems = require('./works').checkTrackRules(state, store.root);
      if (trackProblems.length) {
        throw new EccodeError('TRACK_RULE', `The ${state.work.track} track requires more evidence before ${gateId} is submitted:\n- ${trackProblems.join('\n- ')}`, { problems: trackProblems });
      }
    }
    const required = (config.review.requiredSections || {})[gateKind(gateId)];
    if (required) {
      const missing = missingSections(store.root, hashed, required);
      if (missing.length) {
        throw new EccodeError('MISSING_SECTIONS', `Artifacts for ${gateId} are missing required sections: ${missing.join(', ')}`);
      }
    }
    if (gateId === 'plan') {
      const planFile = hashed.find((a) => a.path.endsWith('.json'));
      if (!planFile) throw new EccodeError('INVALID_PLAN', 'The plan gate needs a plan JSON artifact (schemas/plan.schema.json)');
      const plan = readJson(path.join(store.root, planFile.path));
      const errors = validatePlan(plan, config);
      if (errors.length) throw new EccodeError('INVALID_PLAN', `Plan is invalid:\n- ${errors.join('\n- ')}`, { errors });
      planToImport = { plan, source: planFile.path };
    }
    return { submissionId: newId('sub'), artifacts: hashed };
  });
  if (planToImport) {
    store.commit('plan.imported', actor, { phases: planToImport.plan.phases, tasks: planToImport.plan.tasks, source: planToImport.source });
  }
  return result;
}

/** Everyone who authored work covered by this gate (cannot approve it). */
function gateAuthors(state, gateId) {
  const g = state.gates[gateId];
  const authors = new Set(g.authors);
  if (gateKind(gateId) === 'phase') {
    for (const t of phaseTasks(state, gateId)) {
      if (t.completedBy) authors.add(t.completedBy);
      for (const h of t.history) if (h.event === 'claimed') authors.add(h.by);
    }
  }
  if (gateId === 'verification') {
    for (const t of Object.values(state.tasks)) if (t.completedBy) authors.add(t.completedBy);
  }
  return authors;
}

/** Validate a review against the gate rules. Returns a list of reasons (empty = valid). */
function checkReview(state, config, root, gateId, reviewer, review) {
  const reasons = validateNamed('review', review);
  if (reasons.length) return reasons;
  const g = getGate(state, gateId);
  const roles = rolesFor(config, gateId);
  if (!roles.reviewers.includes(reviewer)) {
    reasons.push(`${reviewer} is not an authorized reviewer for ${gateId} (allowed: ${roles.reviewers.join(', ')})`);
  }
  if (gateAuthors(state, gateId).has(reviewer)) {
    reasons.push(`${reviewer} authored work in ${gateId}; the author of an artifact cannot approve or review it`);
  }
  if (g.status !== 'submitted') {
    reasons.push(`gate ${gateId} is ${g.status}; only a submitted gate can be reviewed`);
    return reasons;
  }
  const sub = g.submissions[g.submissions.length - 1];
  for (const a of sub.artifacts) {
    const abs = path.join(root, a.path);
    if (!exists(abs)) reasons.push(`artifact ${a.path} was deleted after submission; the author must resubmit before review (eccode gate submit ${gateId})`);
    else if (sha256File(abs) !== a.sha256) reasons.push(`artifact ${a.path} changed after submission ${sub.id}; the author must resubmit before review (eccode gate submit ${gateId})`);
  }
  const kind = gateKind(gateId);
  // Phase reviews may cite any project file (e.g. tests next to the code).
  // Other reviews cite the submission, or what an earlier gate approved (the
  // audit pins approved artifacts), so a design can be traced to its brief.
  const approvedEarlier = Object.entries(state.gates).filter(([id, x]) => id !== gateId && x.status === 'approved' && x.submissions.length).flatMap(([, x]) => x.submissions[x.submissions.length - 1].artifacts.map((a) => a.path));
  const allowedArtifacts = kind === 'phase' || kind === 'verification' ? null : [...sub.artifacts.map((a) => a.path), ...approvedEarlier];
  const refs = [
    ...review.criteria.flatMap((c) => c.evidence.map((r) => ({ r, ctx: `criterion ${c.id}`, mustPass: c.met }))),
    ...review.findings.flatMap((f) => (f.evidence || []).map((r) => ({ r, ctx: `finding ${f.id}`, mustPass: false }))),
    ...(review.resolvedFindings || []).flatMap((f) => f.evidence.map((r) => ({ r, ctx: `resolution ${f.id}`, mustPass: true }))),
  ];
  for (const { r, ctx, mustPass } of refs) {
    const res = resolveRef(state, root, r, { allowedArtifacts });
    if (!res.ok) reasons.push(`${ctx}: ${res.reason}`);
    else if (mustPass && res.evidence && res.evidence.kind === 'command' && res.evidence.status !== 'passed' && !shownFailure(res.evidence)) {
      reasons.push(`${ctx}: cites ${r}, which failed (exit ${res.evidence.exitCode}); failed checks cannot support a met criterion (a run recorded with --purpose reproduction may, if the integrity window passed it)`);
    }
  }

  reasons.push(...require('./lab').reviewProblems(state, gateId, review));
  if (review.decision === 'approve') {
    for (const c of review.criteria) {
      if (!c.met) reasons.push(`criterion ${c.id} is not met; approval requires every criterion to be met`);
      if (c.evidence.length < config.review.minEvidencePerApproval) reasons.push(`criterion ${c.id} has no supporting evidence`);
    }
    const open = review.findings.filter((f) => ['blocking', 'major'].includes(f.severity) && f.status !== 'resolved');
    if (open.length) reasons.push(`approval with open blocking/major findings: ${open.map((f) => f.id).join(', ')}`);
    const resolved = new Set((review.resolvedFindings || []).map((f) => f.id));
    const unaddressed = g.openFindings.filter((f) => !resolved.has(f.id));
    if (unaddressed.length) {
      reasons.push(`earlier findings must be explicitly resolved with evidence before approval: ${unaddressed.map((f) => f.id).join(', ')}`);
    }
    if (kind === 'phase' || kind === 'verification') {
      const subAt = sub.at;
      const independent = Object.values(state.evidence).filter(
        (e) => e.kind === 'command' && e.recordedBy === reviewer && e.status === 'passed' && e.at >= subAt,
      );
      if (!independent.length) {
        reasons.push(`${kind} approvals require at least one passing check executed by the reviewer (eccode evidence run --actor ${reviewer}) after submission ${sub.id}`);
      }
      const cited = new Set(refs.map((x) => x.r));
      if (independent.length && !independent.some((e) => cited.has(`ev:${e.id}`))) {
        reasons.push('the review must cite at least one of the checks the reviewer executed');
      }
      // The reviewer's own check must be the check the plan pinned for the work under review, not any command that
      // happens to pass: a reviewer who ran `true` could otherwise approve, and deliver, a project whose pinned
      // tests fail (reproduced 2026-11-13).
      const same = (x, y) => String(x).trim().replace(/\s+/g, ' ') === String(y).trim().replace(/\s+/g, ' ');
      const scope = kind === 'phase' ? phaseTasks(state, gateId) : Object.values(state.tasks);
      const pinned = [...new Set(scope.map((t) => t.verification && t.verification.command).filter(Boolean))];
      const unrun = pinned.filter((cmd) => !independent.some((e) => same(e.command, redactSecrets(cmd))));
      if (independent.length && unrun.length) {
        reasons.push(`the reviewer must itself run each pinned verification command after submission ${sub.id} and see it pass; not yet run by ${reviewer}: ${unrun.map((cmd) => `eccode evidence run --actor ${reviewer} --gate ${gateId} --label review -- "${cmd}"`).join(' ; ')}`);
      }
      if (kind === 'verification') {
        reasons.push(...require('./stack').requiredCheckProblems(state, config, root, reviewer, subAt));
        reasons.push(...require('./behavior').reviewProblems(state, root, gateId, reviewer, review, subAt));
        reasons.push(...require('./design').reviewProblems(state, gateId, review));
      }
    }
  } else {
    const serious = review.findings.filter((f) => ['blocking', 'major'].includes(f.severity));
    if (!serious.length) reasons.push('changes_requested requires at least one blocking or major finding with a recommendation');
    // Phase 3 review discipline (code reviews — the phase and verification gates,
    // where a finding points at code; prose gates such as architecture and design
    // are exempt): every blocking/major finding must cite an executed failing
    // check (ev:<id> of a failed command) or a specific file:line in its detail.
    // An uncited rejection is refused.
    if (kind === 'phase' || kind === 'verification') {
      for (const f of serious) {
        const citesFailedCheck = (f.evidence || []).some((r) => {
          if (!String(r).startsWith('ev:')) return false;
          const e = state.evidence[String(r).slice(3)];
          return e && e.kind === 'command' && e.status === 'failed';
        });
        const citesLocation = /(^|[\s(])[\w./-]+:\d+/.test(f.detail || '');
        if (!citesFailedCheck && !citesLocation) reasons.push(`finding ${f.id}: a changes_requested finding on a ${kind} gate must cite an executed failing check (ev:<id> of a failed command) or a specific file:line in its detail; an uncited rejection is refused`);
      }
      // Bounded rounds on a low-risk task (no production-sensitive surface): after
      // the configured number of rejections the reviewer approves or escalates.
      const limit = config.review.maxRejectionsBeforeDecision;
      if (typeof limit === 'number' && lowRisk(state) && g.iterations >= limit) {
        reasons.push(`this is a low-risk change (the guard routing required no production-sensitive guard) and it has been rejected ${g.iterations} time(s); the reviewer must now approve or escalate (eccode gate escalate / the orchestrator resets a task), not request changes again. Bounded review rounds (config.review.maxRejectionsBeforeDecision=${limit}) keep a low-risk task from churning.`);
      }
    }
  }
  return reasons;
}

/** A low-risk change: the guard routing was recorded and required no production-sensitive guard. Unknown routing is not treated as low-risk. */
function lowRisk(state) {
  const r = state.guards && state.guards.routing;
  return Boolean(r && Array.isArray(r.required) && r.required.length === 0);
}

function escalationRecovery(gateId, unresolved) {
  return [
    `User decision required for ${gateId}. Unresolved: ${unresolved.map((f) => `${f.id} (${f.title})`).join('; ') || 'see review history'}.`,
    'Options: (1) narrow scope or relax the criterion with the user and reopen: eccode gate reopen ' + gateId + ' --actor user --resolution "<decision>";',
    '(2) reassign authorship (fresh author agent with the review history as input);',
    '(3) split the work into smaller tasks via a plan revision;',
    '(4) open a learning-debugger investigation if findings are disputed technical facts.',
  ].join(' ');
}

function recordReview(store, config, gateId, reviewer, review) {
  let reasons;
  try {
    return store.commit('review.recorded', reviewer, { gate: gateId, review }, (state) => {
      reasons = checkReview(state, config, store.root, gateId, reviewer, review);
      if (reasons.length) throw new EccodeError('REVIEW_REJECTED', `Review rejected by gate rules:\n- ${reasons.join('\n- ')}`, { reasons });
      const g = state.gates[gateId];
      return { reviewId: newId('rev'), submissionId: g.submissions[g.submissions.length - 1].id };
    });
  } catch (err) {
    if (err.code === 'REVIEW_REJECTED') {
      store.commit('review.rejected', reviewer, { gate: gateId, reasons, decision: review && review.decision });
    }
    throw err;
  } finally {
    // Escalate after too many rejections (evaluated on the committed state).
    if (store.isInitialized()) {
      const st = store.state();
      const g = st.gates[gateId];
      if (g && g.status === 'changes_requested' && g.iterations >= config.limits.maxReviewIterations) {
        store.commit('gate.escalated', ORCHESTRATOR, {
          gate: gateId,
          reason: `${g.iterations} review iterations without approval (limit ${config.limits.maxReviewIterations})`,
          unresolved: g.openFindings,
          recovery: escalationRecovery(gateId, g.openFindings),
        });
      }
    }
  }
}

/** The artifacts of a submission that changed or were deleted after it. */
function staleArtifacts(root, sub) {
  return (sub ? sub.artifacts : []).filter((a) => {
    const abs = path.join(root, a.path);
    return !exists(abs) || sha256File(abs) !== a.sha256;
  }).map((a) => a.path);
}

/**
 * Only the user can reopen an escalated gate (agent approval never
 * substitutes). Headless (config.headless), the orchestrator may reopen an
 * APPROVED gate whose approved submission's artifacts changed after the
 * approval (edits after approval fail the audit, and nobody is there to
 * reopen): the approval is dropped, the owner resubmits the current files and
 * a reviewer reviews them again, and the reopening is recorded as an
 * assumption. Nothing is delivered without that fresh review.
 */
function reopenGate(store, gateId, actor, resolution, { config = null } = {}) {
  const headless = Boolean(config && config.headless) && actor === ORCHESTRATOR;
  const r = store.commit('gate.reopened', actor, { gate: gateId, resolution }, (state) => {
    const g = getGate(state, gateId);
    if (!resolution || resolution.trim().length < 10) throw new EccodeError('INVALID_INPUT', 'Provide the --resolution (>= 10 chars)');
    if (headless && g.status === 'approved') {
      const sub = g.submissions.find((s) => s.id === g.approvedSubmission) || g.submissions[g.submissions.length - 1];
      const stale = staleArtifacts(store.root, sub);
      if (!stale.length) throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is approved and no artifact of its approved submission changed since; headless, only a gate whose approved artifacts changed is reopened by the orchestrator (an escalated gate is the user's)`);
      return { headless: true, stale };
    }
    if (actor !== USER) throw new EccodeError('USER_AUTH_REQUIRED', `Only the user may reopen an escalated gate (--actor user)${headless ? '; headless, the orchestrator reopens only an approved gate whose artifacts changed after the approval' : ''}`);
    if (g.status !== 'escalated') throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is ${g.status}, not escalated`);
  });
  if (r.event.data.headless) {
    require('./design').recordHeadlessAssumption(store, actor, {
      id: `reopen-${gateId.replace(/[^a-z0-9]+/gi, '-')}-${r.event.seq}`,
      question: `Gate ${gateId} was approved and then ${r.event.data.stale.join(', ')} changed; the user would decide whether to reopen it for a fresh review`,
      reading: `reopened for a fresh submission and review: ${resolution.trim()}`,
      rationale: resolution.trim(),
      source: 'gate.reopened',
    });
  }
  return r;
}

/** Persist review JSON next to the record for human inspection. */
function archiveReview(store, reviewId, review) {
  writeJson(store.path('reviews', `${reviewId}.json`), review);
}

module.exports = { startGate, submit, recordReview, reopenGate, checkReview, gateAuthors, predecessor, archiveReview, ORCHESTRATOR, USER };
