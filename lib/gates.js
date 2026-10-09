'use strict';
// Review gates. This module is where "approval means the criteria are
// satisfied" is enforced in code rather than in prompts:
//   - a gate cannot start before its predecessor is approved
//   - authors cannot approve their own work (any submitter, any task owner)
//   - reviews must target the latest submission, and artifacts must not have
//     changed since it was submitted
//   - approvals need resolvable evidence (existing anchors, intact logs) for
//     every criterion, no open blocking/major findings, and explicit
//     resolution of earlier findings
//   - approvals cover every criterion the gate requires (requiredCriteria):
//     the brief's acceptance criteria, the plan's phases, the phase's tasks
//   - implementation/verification approvals need passing checks that the
//     reviewer executed after the latest submission, on the tree under review,
//     including each verification command the phase's tasks declare
//   - repeated rejections escalate to the user with a recovery path

const fs = require('fs');
const path = require('path');
const { EccodeError, newId, own, sha256File, exists, readJson, writeJson } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, rolesFor, projectRelative, treeDigest, gitHead } = require('./project');
const { resolveRef, headings, redact } = require('./evidence');
const { gateKind } = require('./reducer');
const { validatePlan, matchesVerification } = require('./tasks');
const { retrieveForPlan, checkPlanDecisions, renderForPlan, decisionsToJudge } = require('./lessons');

const ORCHESTRATOR = 'orchestrator';
const USER = 'user';

function getGate(state, gateId) {
  const g = own(state.gates, gateId);
  if (!g || !state.gateOrder.includes(gateId)) {
    throw new EccodeError('UNKNOWN_GATE', `Unknown gate "${gateId}". Gates: ${state.gateOrder.join(', ')}`);
  }
  return g;
}

function predecessor(state, gateId) {
  const idx = state.gateOrder.indexOf(gateId);
  return idx > 0 ? state.gateOrder[idx - 1] : null;
}

function startGate(store, config, gateId, actor) {
  return store.commit('gate.started', actor, { gate: gateId }, (state) => {
    const g = getGate(state, gateId);
    const roles = rolesFor(config, gateId);
    if (actor !== ORCHESTRATOR && !roles.authors.includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not start gate ${gateId}; allowed: ${ORCHESTRATOR}, ${roles.authors.join(', ')}`);
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

function missingSections(root, artifacts, required) {
  const all = artifacts
    .filter((a) => a.path.endsWith('.md'))
    .flatMap((a) => headings(fs.readFileSync(path.join(root, a.path), 'utf8')));
  return required.filter((sec) => !all.some((h) => h.includes(sec.toLowerCase())));
}

function hashArtifacts(root, files) {
  if (!files || files.length === 0) throw new EccodeError('INVALID_INPUT', 'A submission needs at least one artifact');
  return [...new Set(files.map((f) => projectRelative(root, f)))].map((rel) => {
    const abs = path.join(root, rel);
    if (!exists(abs) || !fs.statSync(abs).isFile()) throw new EccodeError('NOT_FOUND', `Artifact not found: ${rel}`);
    if (fs.statSync(abs).size === 0) throw new EccodeError('EMPTY_ARTIFACT', `Artifact is empty: ${rel}`);
    return { path: rel, sha256: sha256File(abs) };
  });
}

function phaseTasks(state, gateId) {
  const phase = gateId.slice('phase:'.length);
  return Object.values(state.tasks).filter((t) => t.phase === phase);
}

/**
 * Files a phase submission always pins: everything the phase's tasks changed,
 * except files they deleted (nothing to pin) and scratch drafts (not deliverables).
 */
function phaseChangedFiles(root, tasks) {
  return [...new Set(tasks.flatMap((t) => t.filesChanged || []))].filter((f) => !f.startsWith('.eccode/drafts/') && exists(path.join(root, f)));
}

/**
 * Submit artifacts for review. Phase submissions always include the files
 * changed by the phase's tasks, so explicit artifacts (notes, reports) can add
 * to the reviewed and hash-pinned set but never replace the code.
 */
function submit(store, config, gateId, actor, { artifacts = [], respondsTo, notes } = {}) {
  let planToImport = null;
  // Verified lessons that match the plan's tasks are retrieved before the store lock is taken
  // (retrieval reads memory files); the plan then has to answer for each of them.
  let planLessons = [];
  if (gateId === 'plan' && store.isInitialized()) {
    try {
      const planPath = artifacts.find((f) => String(f).endsWith('.json'));
      const draft = planPath ? readJson(path.join(store.root, projectRelative(store.root, planPath))) : null;
      if (draft) planLessons = retrieveForPlan(store, config, draft, store.state().project);
    } catch {
      planLessons = []; // an unreadable plan is reported by validation below
    }
  }
  const result = store.commit('gate.submitted', actor, { gate: gateId, respondsTo: respondsTo || null, notes: notes || null }, (state) => {
    const g = getGate(state, gateId);
    const roles = rolesFor(config, gateId);
    if (!roles.authors.includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not submit ${gateId}; authors: ${roles.authors.join(', ')}`);
    }
    // A gate that is `submitted` and has not been reviewed yet may be submitted again: an author who corrects a
    // file after submitting would otherwise be stuck (the pinned hash no longer matches, so the review is refused,
    // and a resubmission was refused too). The earlier submission stays in the record as superseded.
    const supersedes = g.status === 'submitted' ? g.submissions[g.submissions.length - 1] : null;
    if (!['in_progress', 'changes_requested'].includes(g.status) && !supersedes) {
      throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is ${g.status}; submissions require in_progress or changes_requested`);
    }
    if (supersedes && supersedes.actor !== actor) {
      throw new EccodeError('OWNERSHIP', `Gate ${gateId} was submitted by ${supersedes.actor}; only the submitter may replace a submission that has not been reviewed`);
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
      files = [...artifacts, ...phaseChangedFiles(store.root, tasks)];
    }
    const hashed = hashArtifacts(store.root, files);
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
      const answered = checkPlanDecisions(store, config, plan, planLessons, actor);
      if (answered.errors.length) {
        throw new EccodeError('PLAN_LESSONS', renderForPlan(store, config, planLessons, answered.errors), { errors: answered.errors, lessons: planLessons.map((l) => l.id) });
      }
      planToImport = { plan, source: planFile.path, lessonDecisions: answered.decisions };
    }
    const extra = {};
    // Only present when something matched, so older logs replay unchanged.
    if (planToImport && planLessons.length) {
      extra.lessons = planLessons.map((l) => ({ id: l.id, title: l.title, tasks: l.tasks, matched: l.matched }));
      extra.lessonDecisions = planToImport.lessonDecisions;
    }
    if (supersedes) extra.supersedes = supersedes.id;
    // The commit and working-tree digest the review will cover; delivery later refuses anything that
    // changed since the last approved one. Only when git is available, so older logs replay unchanged.
    const commit = gitHead(store.root);
    const tree = commit ? treeDigest(store.root) : null;
    if (commit && tree) Object.assign(extra, { commit, tree });
    return { submissionId: newId('sub'), artifacts: hashed, ...extra };
  });
  if (planToImport) {
    // A second commit: if the process dies before it, the plan gate holds a
    // submission whose plan was never imported, and approval is refused below.
    const imported = { phases: planToImport.plan.phases, tasks: planToImport.plan.tasks, source: planToImport.source, submissionId: result.event.data.submissionId };
    if (planToImport.lessonDecisions.length) imported.lessonDecisions = planToImport.lessonDecisions;
    store.commit('plan.imported', actor, imported);
  }
  return result;
}

/** Is the imported plan the one in this plan submission? (Old logs carry no submissionId.) */
function planImportedFor(state, sub) {
  const planFile = sub.artifacts.find((a) => a.path.endsWith('.json'));
  const p = state.plan;
  if (!p || !planFile || p.source !== planFile.path) return false;
  return p.submissionId ? p.submissionId === sub.id : p.importedAt >= sub.at;
}

// Ids an acceptance criterion may carry: AC1, AC-1, NFR2, S1, D10.
const CRITERION_ID = /^[A-Z][A-Z0-9]*-?\d+$/;
const ID_SOURCE = String.raw`[A-Z][A-Z0-9]*-?\d+`;
// "- AC1 text", "- AC1 (R2): text", "- **AC1 (R1)** [T] text", "1. AC1 text".
const LIST_ITEM = new RegExp(String.raw`^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)?(${ID_SOURCE})(?:\*\*|__)?(?:\s*\([^)]*\))?(?:\*\*|__)?\s*:?\s*(.*)$`);
// "| AC1 | text |"
const TABLE_ROW = new RegExp(String.raw`^\s*\|\s*(?:\*\*|__)?(${ID_SOURCE})(?:\*\*|__)?\s*\|\s*(.*?)\s*\|?\s*$`);

/** The family an acceptance id belongs to (AC for AC1 and AC-7), or null for free-form ids. */
function familyOf(id) {
  return CRITERION_ID.test(id) ? id.replace(/-?\d+$/, '') : null;
}

/**
 * Criteria listed under the given section headings of a Markdown document: list items or table rows that
 * start with a criterion id. A section runs to the next heading of the same or a higher level, so its
 * sub-sections count. The first occurrence of an id wins.
 */
function criteriaIn(markdown, sections) {
  const out = [];
  let level = 0; // heading level of the section being read; 0 = outside
  let heading = '';
  for (const line of markdown.split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = h[2].trim();
      if (sections.some((s) => text.toLowerCase().includes(s.toLowerCase()))) {
        level = h[1].length;
        heading = text;
      } else if (level && h[1].length <= level) {
        level = 0;
      }
      continue;
    }
    if (!level) continue;
    const m = LIST_ITEM.exec(line) || TABLE_ROW.exec(line);
    if (m && !out.some((c) => c.id === m[1])) out.push({ id: m[1], description: m[2].replace(/\*\*|__/g, '').trim(), heading });
  }
  return out;
}

function latestSubmission(state, gateId) {
  const g = own(state.gates, gateId);
  return g && g.submissions.length ? g.submissions[g.submissions.length - 1] : null;
}

function approvedSubmission(state, gateId) {
  const g = own(state.gates, gateId);
  return g && g.approvedSubmission ? g.submissions.find((s) => s.id === g.approvedSubmission) || null : null;
}

/** Acceptance criteria listed in a submission's Markdown artifacts (files that cannot be read are skipped). */
function criteriaOf(root, config, sub) {
  if (!sub) return [];
  const sections = ((config.review || {}).criteriaSections || {}).architecture || ['Acceptance Criteria'];
  const out = [];
  for (const a of sub.artifacts) {
    if (!/\.(md|markdown)$/i.test(a.path)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, a.path), 'utf8');
    } catch {
      continue;
    }
    for (const c of criteriaIn(text, sections)) {
      if (!out.some((x) => x.id === c.id)) out.push({ id: c.id, description: c.description, source: `artifact:${a.path}#${c.heading}` });
    }
  }
  return out;
}

/**
 * The criteria an approval of this gate must cover, one review criterion per id:
 *   architecture - the acceptance-criteria ids of the submitted brief (config.review.criteriaSections);
 *   design       - the same ids from the approved brief (the spec answers to every criterion);
 *   plan         - phase:<id> for each phase of the submitted plan;
 *   phase gates  - task:<id> for each task of the phase, and phase:<id>;
 *   verification - the brief's acceptance criteria, or phase:<id> per phase when the brief lists none.
 * Empty when coverage cannot be derived (a brief without ids); `eccode gate show` says so.
 */
function requiredCriteria(state, config, root, gateId) {
  const kind = gateKind(gateId);
  const phases = (state.plan && state.plan.phases) || [];
  const phaseCriterion = (p, source) => ({ id: `phase:${p.id}`, description: p.goal || p.name || `phase ${p.id}`, source });
  if (kind === 'architecture') return criteriaOf(root, config, latestSubmission(state, gateId));
  if (kind === 'design') return criteriaOf(root, config, approvedSubmission(state, 'architecture'));
  if (kind === 'plan') {
    const sub = latestSubmission(state, gateId);
    const planFile = sub && sub.artifacts.find((a) => a.path.endsWith('.json'));
    let plan = null;
    try {
      plan = planFile ? readJson(path.join(root, planFile.path), null) : null;
    } catch {
      plan = null; // an invalid plan is refused at submission
    }
    const list = plan && Array.isArray(plan.phases) ? plan.phases : [];
    return list.filter((p) => p && typeof p.id === 'string').map((p, i) => phaseCriterion(p, `artifact:${planFile.path}#phases.${i}`));
  }
  if (kind === 'phase') {
    const phaseId = gateId.slice('phase:'.length);
    const phase = phases.find((p) => p.id === phaseId);
    const rework = (state.reworks || []).find((r) => r.id === phaseId);
    const out = phaseTasks(state, gateId).map((t) => ({ id: `task:${t.id}`, description: t.title, source: `task ${t.id} (${t.owner}${t.handoffId ? `, handoff ${t.handoffId}` : ''})` }));
    out.push(phase ? phaseCriterion(phase, 'plan') : { id: gateId, description: rework ? rework.reason : `phase ${phaseId}`, source: rework ? 'rework' : 'plan' });
    return out;
  }
  if (kind === 'verification') {
    const criteria = criteriaOf(root, config, approvedSubmission(state, 'architecture'));
    return criteria.length ? criteria : phases.map((p) => phaseCriterion(p, 'plan'));
  }
  return [];
}

/** Distinct verification commands the tasks declare, with the tasks that declare each. */
function declaredChecks(tasks) {
  const out = [];
  for (const t of tasks) {
    const v = t.verification;
    if (!v || !v.command) continue;
    const key = `${redact(v.command).trim().split(/\s+/).join(' ')}\u0000${v.cwd || ''}`;
    const found = out.find((d) => d.key === key);
    if (found) found.tasks.push(t.id);
    else out.push({ key, verification: v, tasks: [t.id] });
  }
  return out;
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
    if (!exists(abs)) reasons.push(`artifact ${a.path} was deleted after submission`);
    else if (sha256File(abs) !== a.sha256) reasons.push(`artifact ${a.path} changed after submission ${sub.id}; the author must resubmit before review`);
  }
  const kind = gateKind(gateId);
  // Phase reviews may cite any project file (e.g. tests next to the code).
  const allowedArtifacts = kind === 'phase' || kind === 'verification' ? null : sub.artifacts.map((a) => a.path);
  const refs = [
    ...review.criteria.flatMap((c) => c.evidence.map((r) => ({ r, ctx: `criterion ${c.id}`, mustPass: c.met }))),
    ...review.findings.flatMap((f) => (f.evidence || []).map((r) => ({ r, ctx: `finding ${f.id}`, mustPass: f.status === 'resolved' }))),
    ...(review.resolvedFindings || []).flatMap((f) => f.evidence.map((r) => ({ r, ctx: `resolution ${f.id}`, mustPass: true }))),
  ];
  for (const { r, ctx, mustPass } of refs) {
    const res = resolveRef(state, root, r, { allowedArtifacts, validateAnchor: true });
    if (!res.ok) reasons.push(`${ctx}: ${res.reason}`);
    else if (mustPass && res.evidence && res.evidence.kind === 'command' && res.evidence.status !== 'passed') {
      reasons.push(`${ctx}: cites ${r}, which failed (exit ${res.evidence.exitCode}); failed checks cannot support a met criterion`);
    }
  }

  // Coverage: the criteria the gate requires, by id. Duplicates are refused; so is an id from a reserved
  // namespace (task:, phase:, or an acceptance family the gate requires, such as AC9 next to AC1-AC8)
  // that nothing requires. Free-form ids (C1, security, lessons) stay allowed.
  const required = requiredCriteria(state, config, root, gateId);
  const requiredIds = new Set(required.map((c) => c.id));
  const ids = review.criteria.map((c) => c.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length) reasons.push(`duplicate criterion id(s): ${duplicates.join(', ')}; give each criterion its own id`);
  const families = new Set(required.map((c) => familyOf(c.id)).filter(Boolean));
  const unknown = [...new Set(ids)].filter((id) => !requiredIds.has(id) && (/^(task|phase):/.test(id) || families.has(familyOf(id))));
  if (unknown.length) {
    reasons.push(`unknown criterion id(s): ${unknown.join(', ')}; ${gateId} requires ${[...requiredIds].join(', ') || 'no particular ids'} (eccode gate show ${gateId}); other criteria take free-form ids such as C1`);
  }

  if (review.decision === 'approve') {
    const missing = required.filter((c) => !ids.includes(c.id));
    if (missing.length) {
      reasons.push(`approval does not cover the required criteria: ${missing.map((c) => c.id).join(', ')}; add one criterion per id, met, with evidence citing the section that proves it (eccode gate show ${gateId} lists them with their descriptions)`);
    }
    for (const c of review.criteria) {
      if (!c.met) reasons.push(`criterion ${c.id} is not met; approval requires every criterion to be met`);
      if (c.evidence.length < config.review.minEvidencePerApproval) reasons.push(`criterion ${c.id} has no supporting evidence`);
    }
    const open = review.findings.filter((f) => ['blocking', 'major'].includes(f.severity) && f.status !== 'resolved');
    if (open.length) reasons.push(`approval with open blocking/major findings: ${open.map((f) => f.id).join(', ')}`);
    // A finding raised and marked resolved in the same review needs the evidence of its resolution.
    for (const f of review.findings) {
      if (['blocking', 'major'].includes(f.severity) && f.status === 'resolved' && !(f.evidence || []).length) {
        reasons.push(`finding ${f.id} is marked resolved without evidence; cite the check or artifact that shows it fixed`);
      }
    }
    const resolved = new Set((review.resolvedFindings || []).map((f) => f.id));
    const unaddressed = g.openFindings.filter((f) => !resolved.has(f.id));
    if (unaddressed.length) {
      reasons.push(`earlier findings must be explicitly resolved with evidence before approval: ${unaddressed.map((f) => f.id).join(', ')}`);
    }
    const toJudge = decisionsToJudge(state, gateId);
    if (toJudge.length && !review.criteria.some((c) => c.id === 'lessons')) {
      reasons.push(`this submission records ${toJudge.length} decision(s) on verified lessons (${toJudge.map((d) => `${d.id}: ${d.decision}`).join('; ')}). Judge each - read the lesson (eccode memory show <id>), then decide whether it was applied with a test that covers it, or whether the stated reason for setting it aside really holds (a ticket that is silent about a rule is not a reason). Add a criterion with id "lessons" saying so, with evidence; if a decision is wrong, request changes`);
    }
    if (gateId === 'plan' && !planImportedFor(state, sub)) {
      reasons.push(`the plan in submission ${sub.id} was not imported (the submission was interrupted); request changes so the author resubmits`);
    }
    if (kind === 'phase') {
      const notDone = phaseTasks(state, gateId).filter((t) => t.status !== 'done');
      if (notDone.length) reasons.push(`phase tasks are not done: ${notDone.map((t) => `${t.id}(${t.status})`).join(', ')}`);
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
      const citedChecks = independent.filter((e) => cited.has(`ev:${e.id}`));
      if (independent.length && !citedChecks.length) {
        reasons.push('the review must cite at least one of the checks the reviewer executed');
      }
      if (kind === 'phase') {
        // Each verification command the phase's tasks declare must have been run by the reviewer and cited.
        const missing = declaredChecks(phaseTasks(state, gateId)).filter((d) => !citedChecks.some((e) => matchesVerification(root, e, d.verification)));
        if (missing.length) {
          const shown = missing.map((d) => `${redact(d.verification.command)}${d.verification.cwd ? ` (cwd ${d.verification.cwd})` : ''} [${d.tasks.join(', ')}]`).join('; ');
          reasons.push(`phase approval must cite a passing run, by ${reviewer} after submission ${sub.id}, of every verification command the phase's tasks declare; missing: ${shown}. Run each with eccode evidence run --actor ${reviewer} --gate ${gateId} --label "<label>" -- <command> and cite its ev: id`);
        }
      }
      // The cited checks vouch for the tree under review: the bytes must not have changed since they ran.
      const tree = treeDigest(root);
      const stale = tree ? citedChecks.filter((e) => e.tree && e.tree !== tree) : [];
      if (stale.length) {
        reasons.push(`cited check(s) ${stale.map((e) => `ev:${e.id}`).join(', ')} ran on a different source tree than the one under review now (files changed since the check); run the check again on the current tree and cite the new ev: id`);
      }
    }
  } else {
    const serious = review.findings.filter((f) => ['blocking', 'major'].includes(f.severity));
    if (!serious.length) reasons.push('changes_requested requires at least one blocking or major finding with a recommendation');
  }
  return reasons;
}

function escalationRecovery(gateId, unresolved) {
  return [
    `User decision required for ${gateId}. Unresolved: ${unresolved.map((f) => `${f.id} (${f.title})`).join('; ') || 'see review history'}.`,
    'Options: (1) the user decides and reopens: eccode gate reopen ' + gateId + ' --actor user --resolution "<decision>" [--waive all|F1,F2] (without --waive the findings stay open and must be resolved with evidence; waive only what the user accepts);',
    '(2) reassign authorship (fresh author agent with the review history as input);',
    '(3) split the work into smaller tasks via a plan revision;',
    '(4) open a learning-debugger investigation if findings are disputed technical facts.',
  ].join(' ');
}

function recordReview(store, config, gateId, reviewer, rawReview) {
  const review = require('./evidence').deepRedact(rawReview); // review text goes into the record and the handoff
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

/**
 * Only the user can reopen an escalated gate (agent approval never substitutes): the user directly, or
 * an agent spending a delegation the user granted for it (lib/authority.js). Reopening gives the
 * author more review rounds; it does NOT settle the findings that caused the escalation. They stay open
 * and the next approving review must resolve each with evidence, unless the user names them in `waive`
 * ("all" or a list of finding ids), which records them as waived by the user.
 */
function reopenGate(store, gateId, actor, resolution, { waive, delegation } = {}) {
  let waiveIds = [];
  return require('./authority').commitReserved(store, { type: 'gate.reopened', actor, data: { gate: gateId, resolution }, action: 'gate.reopen', target: gateId, delegation, check: (state) => {
    const g = getGate(state, gateId);
    if (!resolution || resolution.trim().length < 10) throw new EccodeError('INVALID_INPUT', 'Provide the user\'s --resolution (>= 10 chars)');
    if (g.status === 'approved') {
      // Only the closing verification gate can be reopened after approval, and only by the user:
      // a rework on a delivered build changes files the verification covered, so verification must
      // be done again. Approved phases and documents are never reopened; their files change through
      // a rework gate (eccode rework open), reviewed by someone who did not write the fix.
      if (gateKind(gateId) !== 'verification') {
        throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is approved; approved work changes through a rework (eccode rework open), not by reopening the gate`);
      }
      if (waive) throw new EccodeError('INVALID_INPUT', 'An approved gate has no open findings to waive');
      return { waive: [], reopenedFrom: 'approved' };
    }
    if (g.status !== 'escalated') throw new EccodeError('INVALID_TRANSITION', `Gate ${gateId} is ${g.status}, not escalated`);
    const open = g.openFindings.map((f) => f.id);
    const wanted = waive === 'all' ? open : String(waive || '').split(',').map((x) => x.trim()).filter(Boolean);
    const unknown = wanted.filter((id) => !open.includes(id));
    if (unknown.length) throw new EccodeError('INVALID_INPUT', `--waive names findings that are not open on ${gateId}: ${unknown.join(', ')} (open: ${open.join(', ') || 'none'})`);
    waiveIds = wanted;
    return { waive: waiveIds };
  } });
}

/** Persist review JSON next to the record for human inspection. */
function archiveReview(store, reviewId, review) {
  writeJson(store.path('reviews', `${reviewId}.json`), require('./evidence').deepRedact(review));
}

module.exports = { startGate, submit, recordReview, reopenGate, checkReview, requiredCriteria, gateAuthors, predecessor, archiveReview, ORCHESTRATOR, USER };
