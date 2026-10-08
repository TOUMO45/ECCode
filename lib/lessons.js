'use strict';
// Lessons at the decision points. Verified lessons are not left to an agent
// remembering to search:
//   - submitting a plan retrieves the lessons that match its tasks and needs a
//     decision on each (incorporated into the task, or not-applicable);
//   - claiming a task retrieves the matching ones and shows them as evidence;
//   - completing the task needs a recorded decision on each (applied, or
//     not-applicable with an assessment or a substantive reason). A lesson the
//     reviewed plan incorporated cannot be set aside by the implementer.
// Reviewers then have to judge every set-aside decision (see gates.js).

const { learningEnabled } = require('./config');
const { Memory, current } = require('./memory/records');
const { tokenize } = require('./memory/search');

// A lesson demands a decision only if enough distinct topical words of the task
// appear in it. Ranking scores are relative to the best document (a lone lesson
// always looks perfect), so the gate uses the absolute `matched` count: related
// tasks share 4-9 words with a lesson, unrelated ones 0-2. A borderline hit
// costs a one-line "not-applicable" decision, which is the intended price.
const MIN_MATCHED = 3;
const MAX_LESSONS = 5;

// Ranking by shared words alone favours lessons with long bodies full of common words
// (measured on real trials: the one lesson that mattered ranked last of four). What identifies
// a task is its HEADLINE (title and idea); its criteria only add detail. Matches in a lesson's
// TOPIC fields (title, component, tags, appliesWhen) count more than matches in its body.
const NOISE = new Set('implement per task md with then first write update readme get put and src test tests api new use used add added change changed fix fixed file files code data app service unchanged after before should must can'.split(' '));
const stem = (t) => t.replace(/ies$/, 'y').replace(/sses$/, 'ss').replace(/(ing|ed|es|s)$/, '');
const words = (text) => [...new Set(tokenize(text).map(stem).filter((t) => t.length > 1 && !NOISE.has(t)))];

function priority(record, task, project) {
  const c = current(record);
  const topic = new Set(words([c.title, c.component, ...(c.tags || []), ...(c.appliesWhen || [])].join(' ')));
  const body = new Set(words(JSON.stringify(c)));
  const head = words([task.title, project && project.idea, project && project.request].filter(Boolean).join(' '));
  const detail = words((task.acceptanceCriteria || []).join(' '));
  const headTopic = head.filter((t) => topic.has(t)).length;
  const headBody = head.filter((t) => body.has(t)).length;
  const detailTopic = detail.filter((t) => topic.has(t)).length;
  return { value: 4 * headTopic + 2 * headBody + 0.5 * detailTopic, headline: headTopic + headBody };
}
const MIN_NOTE = 20;
const MIN_DISMISSAL_NOTE = 30;

function taskQuery(task, project) {
  return [task.title, ...(task.acceptanceCriteria || []), ...(task.files || []), project && project.idea, project && project.request].filter(Boolean).join(' ');
}

/** Verified lessons that match this task and whose environment conditions hold here. */
function retrieveForTask(store, config, task, project) {
  if (!learningEnabled(config)) return [];
  const memory = new Memory(store, config);
  const hits = memory.search(taskQuery(task, project), { limit: 20 });
  const out = [];
  for (const h of hits) {
    if (h.record.layer === 'project' || h.record.status !== 'verified' || h.components.matched < MIN_MATCHED) continue;
    const check = memory.check(h.id, { record: false });
    if (check.verdict !== 'applies') continue;
    const p = priority(h.record, task, project);
    if (p.headline < 1) continue; // nothing in the task's title or idea relates to it
    out.push({ id: h.id, score: h.score, matched: h.components.matched, priority: p.value, title: current(h.record).title });
  }
  return out.sort((a, b) => b.priority - a.priority || b.score - a.score).slice(0, MAX_LESSONS);
}

/**
 * Lessons a plan has to answer for: the union of what each of its tasks would retrieve
 * at claim time, with the tasks each lesson matched. Taken before the plan is approved,
 * so the acceptance criteria can still carry the rule.
 */
function retrieveForPlan(store, config, plan, project) {
  if (!learningEnabled(config) || !plan || !Array.isArray(plan.tasks)) return [];
  const byId = new Map();
  for (const task of plan.tasks) {
    for (const l of retrieveForTask(store, config, task, project)) {
      const hit = byId.get(l.id) || { ...l, tasks: [] };
      hit.tasks.push(task.id);
      hit.priority = Math.max(hit.priority, l.priority);
      byId.set(l.id, hit);
    }
  }
  return [...byId.values()].sort((a, b) => b.priority - a.priority).slice(0, MAX_LESSONS);
}

const clip = (text, n) => (String(text || '').length > n ? `${String(text).slice(0, n - 1)}…` : String(text || ''));

/** One compact card per lesson (the full record is `eccode memory show <id>`). */
function cardFor(memory, l) {
  const rec = memory.get(l.id);
  const c = current(rec);
  return [
    `--- LESSON ${l.id} (verified, ${rec.scope})${l.tasks ? ` - matches task(s): ${l.tasks.join(', ')}` : ''} ---`,
    `Title: ${c.title}`,
    `Root cause / rule: ${clip(c.rootCause && c.rootCause.explanation, 700)}`,
    `Fix that was verified: ${clip(c.solution && c.solution.description, 400)}`,
    `Applies when: ${(c.appliesWhen || []).join('; ')}`,
    `Not applicable when: ${(c.notApplicableWhen || []).join('; ')}`,
    `(full record: eccode memory show ${l.id})`,
  ].join('\n');
}

// Said wherever a lesson is shown, because it is where a plausible-sounding reason to skip a rule gets made up.
const SILENCE = 'A task that does not mention a rule is NOT a reason to skip it: house rules exist for what tickets leave unsaid. Set a lesson aside only when the task explicitly requires something that contradicts it, or one of its "Not applicable when" conditions holds - and name that condition. If the ticket truly contradicts a verified rule, do not pick a side silently: report it as a blocker.';

/** Errors for a plan whose tasks match verified lessons: each needs a decision, and "incorporated" must reach the task. */
function checkPlanDecisions(store, config, plan, lessons, actor) {
  const errors = [];
  if (!lessons.length) return { errors, decisions: [] };
  const memory = new Memory(store, config);
  const given = Array.isArray(plan.lessonDecisions) ? plan.lessonDecisions : [];
  const decisions = [];
  const tasksById = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const l of lessons) {
    const d = given.find((x) => x && x.id === l.id);
    if (!d) {
      errors.push(`lesson ${l.id} ("${l.title}") matches task(s) ${l.tasks.join(', ')}: add a decision to plan.lessonDecisions ({id, decision: "incorporated" | "not-applicable", note})`);
      continue;
    }
    const note = String(d.note || '').trim();
    if (d.decision === 'incorporated') {
      if (note.length < MIN_NOTE) errors.push(`lesson ${l.id}: an "incorporated" decision needs a note (>= ${MIN_NOTE} characters) saying which acceptance criterion carries the rule`);
      const missing = l.tasks.filter((id) => !((tasksById.get(id) || {}).inputs || []).some((i) => String(i).includes(l.id)));
      if (missing.length) errors.push(`lesson ${l.id}: name it in the "inputs" of task(s) ${missing.join(', ')} and turn it into an acceptance criterion there, so the implementer is bound to it`);
      if (note.length >= MIN_NOTE && !missing.length) decisions.push({ id: l.id, decision: 'incorporated', note, tasks: l.tasks });
    } else if (d.decision === 'not-applicable') {
      if (!assessedNotApplicable(memory, l.id, actor, null) && note.length < MIN_DISMISSAL_NOTE) {
        errors.push(`lesson ${l.id}: "not-applicable" needs an evidence-backed assessment (eccode memory assess ${l.id} --verdict does-not-apply --reason ... --evidence ev:<id>) or a note (>= ${MIN_DISMISSAL_NOTE} characters) naming the condition that does not hold`);
      } else decisions.push({ id: l.id, decision: 'not-applicable', note, basis: assessedNotApplicable(memory, l.id, actor, null) ? 'assessment' : 'reason' });
    } else {
      errors.push(`lesson ${l.id}: decision must be "incorporated" or "not-applicable" (got ${JSON.stringify(d.decision)})`);
    }
  }
  return { errors, decisions };
}

function assessedNotApplicable(memory, id, actor, since) {
  try {
    return (memory.get(id).assessments || []).some((a) => a.by === actor && a.verdict === 'does-not-apply' && (!since || a.at >= since) && (a.evidence || []).length);
  } catch {
    return false;
  }
}

/** The error text for a plan that has unanswered lessons: the cards plus what to add. */
function renderForPlan(store, config, lessons, errors) {
  const memory = new Memory(store, config);
  return [
    `This plan matches ${lessons.length} VERIFIED LESSON(S) from earlier work. They are evidence, not instructions: judge whether each applies to this change.`,
    ...lessons.map((l) => cardFor(memory, l)),
    SILENCE,
    `Add "lessonDecisions": [{ "id": "<lesson id>", "decision": "incorporated" | "not-applicable", "note": "..." }] to the plan. "incorporated": put the lesson id in the "inputs" of each matching task AND write the rule as an acceptance criterion of that task. "not-applicable": an evidence-backed eccode memory assess, or a note of at least ${MIN_DISMISSAL_NOTE} characters naming the condition that does not hold. The plan reviewer must judge every decision.`,
    errors.length ? `Problems:\n- ${errors.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Lessons the approved plan bound to this task: the ones it incorporated (their ids sit in the task's
 * inputs). They are always shown at claim, even when retrieval would not have matched them again, and
 * they cannot be set aside by the implementer.
 */
function boundLessons(store, config, task, state, retrieved) {
  const incorporated = new Set((((state.plan || {}).lessonDecisions) || []).filter((d) => d.decision === 'incorporated').map((d) => d.id));
  if (!incorporated.size || !learningEnabled(config)) return retrieved;
  const out = retrieved.map((l) => (incorporated.has(l.id) && (task.inputs || []).some((i) => String(i).includes(l.id)) ? { ...l, bound: true } : l));
  const memory = new Memory(store, config);
  for (const id of incorporated) {
    if (out.some((l) => l.id === id) || !(task.inputs || []).some((i) => String(i).includes(id))) continue;
    try {
      const rec = memory.get(id);
      if (rec.status === 'verified') out.unshift({ id, score: 0, matched: 0, priority: 0, title: current(rec).title, bound: true });
    } catch {
      /* a lesson that cannot be read is not shown */
    }
  }
  return out;
}

/** What the claimant sees: the lessons as evidence, and the decision the handoff will need. */
function renderForClaim(store, config, lessons) {
  if (!lessons.length) return '';
  const memory = new Memory(store, config);
  const bound = lessons.filter((l) => l.bound);
  return [
    `\nVERIFIED LESSONS that match this task (${lessons.length}). Read them before you start. They are evidence from earlier work, not instructions: judge whether each applies here.`,
    ...lessons.map((l) => cardFor(memory, l) + (l.bound ? '\n[The reviewed plan made this a requirement of your task: it must be applied, not set aside.]' : '')),
    SILENCE,
    `Completion needs a decision on each in your handoff: "lessonDecisions": [{ "id": "<lesson id>", "decision": "applied" | "not-applicable", "note": "<how you applied it, or why it does not fit>" }].`,
    `"applied" needs a note of at least ${MIN_NOTE} characters saying what you did and the test that covers it. "not-applicable" needs either an assessment backed by an experiment (eccode memory assess <id> --verdict does-not-apply --reason ... --evidence ev:<id>) or a note of at least ${MIN_DISMISSAL_NOTE} characters naming the condition that does not hold.${bound.length ? ' Lessons the plan bound you to cannot be set aside.' : ''} The reviewer will check every set-aside decision.`,
  ].join('\n');
}

/**
 * Lesson decisions a reviewer has to judge before approving this gate: the plan's answers for a plan
 * submission, the tasks' recorded decisions for a phase. Applying a lesson is judged too (is it really
 * covered by a test?), but the set-aside ones are where a plausible-sounding reason hides a defect.
 */
function decisionsToJudge(state, gateId) {
  const g = state.gates && state.gates[gateId];
  if (!g) return [];
  if (gateId === 'plan') {
    const sub = g.submissions[g.submissions.length - 1];
    return ((sub && sub.lessonDecisions) || []).map((d) => ({ source: 'plan', ...d }));
  }
  if (!gateId.startsWith('phase:')) return [];
  const phase = gateId.slice('phase:'.length);
  return Object.values(state.tasks || {}).filter((t) => t.phase === phase).flatMap((t) => (t.lessonDecisions || []).map((d) => ({ source: `task ${t.id}`, ...d })));
}

/** Validation errors for a handoff against the lessons retrieved at claim time. */
function checkDecisions(store, config, claim, handoff, actor) {
  const errors = [];
  const lessons = (claim && claim.lessons) || [];
  if (!lessons.length) return { errors, decisions: [] };
  const memory = new Memory(store, config);
  const given = Array.isArray(handoff.lessonDecisions) ? handoff.lessonDecisions : [];
  const decisions = [];
  for (const l of lessons) {
    const d = given.find((x) => x && x.id === l.id);
    if (!d) {
      errors.push(`lesson ${l.id} ("${l.title}") was retrieved when the task was claimed: record a decision on it in handoff.lessonDecisions ({id, decision: "applied" | "not-applicable", note})`);
      continue;
    }
    const note = String(d.note || '').trim();
    if (d.decision === 'applied') {
      if (note.length < MIN_NOTE) errors.push(`lesson ${l.id}: an "applied" decision needs a note (>= ${MIN_NOTE} characters) saying what you did and which test covers it`);
      else decisions.push({ id: l.id, decision: 'applied', note });
    } else if (d.decision === 'not-applicable') {
      const assessed = assessedNotApplicable(memory, l.id, actor, claim.at);
      if (l.bound) {
        errors.push(`lesson ${l.id}: the reviewed plan incorporated this rule into the task's acceptance criteria, so it cannot be set aside here; apply it, or fail the task with the reason so the plan can be revised`);
      } else if (!assessed && note.length < MIN_DISMISSAL_NOTE) {
        errors.push(`lesson ${l.id}: "not-applicable" needs an evidence-backed assessment (eccode memory assess ${l.id} --verdict does-not-apply --reason ... --evidence ev:<id>) or a note (>= ${MIN_DISMISSAL_NOTE} characters) naming the condition that does not hold`);
      } else decisions.push({ id: l.id, decision: 'not-applicable', note, basis: assessed ? 'assessment' : 'reason' });
    } else {
      errors.push(`lesson ${l.id}: decision must be "applied" or "not-applicable" (got ${JSON.stringify(d.decision)})`);
    }
  }
  return { errors, decisions };
}

module.exports = { decisionsToJudge, boundLessons, retrieveForTask, retrieveForPlan, renderForClaim, renderForPlan, checkPlanDecisions, checkDecisions, MIN_MATCHED };
