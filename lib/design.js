'use strict';
// Design before code (Phase 3, Part A). On the feature, refactor and
// greenfield tracks no task is owned until a design decision exists that
// compared at least two alternatives on complexity, risk, performance,
// security and reversibility; the decision is rendered as an ADR the reviewer
// must cite; a spike (a throwaway prototype) never ships; and a blocking
// ambiguity in the request stops planning until the user clarifies it or,
// headless, a reasonable reading is recorded as an assumption that every
// handoff and the final report surface.
const fs = require('fs');
const path = require('path');
const { gitChangedFiles } = require('./project');
const { EccodeError, newId, sha256, sha256File, writeFileAtomic, toPosix, exists, matchesAny } = require('./util');

const DESIGN_TRACKS = new Set(['feature', 'refactor', 'greenfield']);
const TRADEOFFS = ['complexity', 'risk', 'performance', 'security', 'reversibility'];
const SURFACES = new Set(['http', 'function', 'cli', 'schema']);
const MIN_TEXT = 10;

function onDesignTrack(state) {
  return Boolean(state.work && DESIGN_TRACKS.has(state.work.track) && state.work.status === 'active');
}

function assertActive(state) {
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  if (state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', `Work item ${state.work.id} is ${state.work.status}`);
}

function text(v, what, min = MIN_TEXT) {
  if (typeof v !== 'string' || v.trim().length < min) throw new EccodeError('INVALID_INPUT', `${what} is required (>= ${min} chars)`);
  return v.trim();
}

function designers(config) {
  return [...new Set([...config.roles.design.authors, ...config.roles.architecture.authors, 'orchestrator'])];
}

function reviewers(config) {
  return [...new Set([...config.roles.design.reviewers, ...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];
}

function assertRole(allowed, actor, what) {
  if (!allowed.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not ${what}; allowed: ${allowed.join(', ')}`);
}

// ------------------------------------------------------------ alternatives

function validOptions(options) {
  if (!Array.isArray(options) || options.length < 2) throw new EccodeError('INVALID_INPUT', 'design alternatives need at least two options, each {id, title, tradeoffs: {complexity, risk, performance, security, reversibility}}');
  const ids = new Set();
  return options.map((o, i) => {
    if (!o || typeof o !== 'object') throw new EccodeError('INVALID_INPUT', `option ${i}: not an object`);
    const id = text(o.id, `option ${i}: id`, 1);
    if (ids.has(id)) throw new EccodeError('INVALID_INPUT', `option ${id} appears twice`);
    ids.add(id);
    const tradeoffs = {};
    for (const k of TRADEOFFS) tradeoffs[k] = text(o.tradeoffs && o.tradeoffs[k], `option ${id}: tradeoff ${k}`);
    return { id, title: text(o.title, `option ${id}: title`, 3), tradeoffs };
  });
}

/** Record the alternatives compared (>= 2, every tradeoff stated). */
function alternatives(store, config, actor, options) {
  assertRole(designers(config), actor, 'record design alternatives');
  const list = validOptions(options);
  return store.commit('design.alternatives', actor, { id: newId('da'), options: list }, (state) => assertActive(state)).event.data;
}

// --------------------------------------------------------------- decision

function validInterfaces(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new EccodeError('INVALID_INPUT', 'interfaces must be a list of {surface: http|function|cli|schema, target}');
  return list.map((e, i) => {
    if (!e || !SURFACES.has(e.surface)) throw new EccodeError('INVALID_INPUT', `interface ${i}: surface must be http, function, cli or schema`);
    return { surface: e.surface, target: text(e.target, `interface ${i}: target`, 1) };
  });
}

/** The decision: one chosen option, every other option rejected with a reason, the interfaces it fixes. */
function decide(store, config, actor, { alternatives: altId, chosen, rationale, rejected, interfaces } = {}) {
  assertRole(designers(config), actor, 'record a design decision');
  const data = { id: newId('dd'), alternatives: text(altId, 'alternatives (the design.alternatives id)', 1), chosen: text(chosen, 'chosen option', 1), rationale: text(rationale, 'rationale', 20), rejected: [], interfaces: validInterfaces(interfaces) };
  if (!Array.isArray(rejected)) throw new EccodeError('INVALID_INPUT', 'rejected must list every other option with why: [{option, why}]');
  data.rejected = rejected.map((r, i) => ({ option: text(r && r.option, `rejected ${i}: option`, 1), why: text(r && r.why, `rejected ${i}: why`) }));
  return store.commit('design.decision', actor, data, (state) => {
    assertActive(state);
    const alt = state.design.alternatives.find((a) => a.id === data.alternatives);
    if (!alt) throw new EccodeError('NOT_FOUND', `Unknown design alternatives ${data.alternatives}; record them first (eccode design alternatives --file options.json)`);
    const ids = alt.options.map((o) => o.id);
    if (!ids.includes(data.chosen)) throw new EccodeError('INVALID_INPUT', `chosen option ${data.chosen} is not one of ${ids.join(', ')}`);
    const others = ids.filter((id) => id !== data.chosen);
    const covered = new Set(data.rejected.map((r) => r.option));
    const missing = others.filter((id) => !covered.has(id));
    if (missing.length) throw new EccodeError('INVALID_INPUT', `every other option must be rejected with a reason; missing: ${missing.join(', ')}`);
    const unknown = [...covered].filter((id) => !ids.includes(id) || id === data.chosen);
    if (unknown.length) throw new EccodeError('INVALID_INPUT', `rejected options not among the alternatives (or the chosen one): ${unknown.join(', ')}`);
    if (Object.values(state.tasks).some((t) => t.claim || t.status !== 'pending')) throw new EccodeError('DESIGN_LOCKED', 'Implementation started on the current decision; a change of design after that is a reviewer\'s amendment (eccode design amend --decision <id> --file interfaces.json --reason "<why>" --actor <reviewer>)');
  }).event.data;
}

// -------------------------------------------------------------------- ADR

function renderAdr(state, decision) {
  const alt = state.design.alternatives.find((a) => a.id === decision.alternatives);
  const lines = [`# ADR ${decision.id}: ${state.work.title}`, '', `Status: accepted (${decision.by}, ${decision.at})`, '', '## Context', '', state.project && state.project.idea ? state.project.idea : state.work.title, '', '## Alternatives considered', '', '| Option | Complexity | Risk | Performance | Security | Reversibility |', '|---|---|---|---|---|---|'];
  for (const o of alt.options) lines.push(`| ${o.id}: ${o.title} | ${TRADEOFFS.map((k) => o.tradeoffs[k]).join(' | ')} |`);
  lines.push('', '## Decision', '', `Chosen: **${decision.chosen}**. ${decision.rationale}`, '', '## Rejected', '');
  for (const r of decision.rejected) lines.push(`- ${r.option}: ${r.why}`);
  lines.push('', '## Interfaces and contracts fixed by this decision', '');
  if (!decision.interfaces.length) lines.push('- none declared');
  for (const i of decision.interfaces) lines.push(`- ${i.surface} ${i.target}`);
  lines.push('', '## Consequences', '', 'The change is checked against these interfaces at delivery; a different interface needs a reviewed amendment (design.amended).', '');
  return lines.join('\n');
}

/** Render the decision as an ADR artifact under .eccode/design/, content-hashed into the record. */
function adr(store, config, actor, { decision: decisionId } = {}) {
  assertRole(designers(config), actor, 'render an ADR');
  const state = store.state();
  assertActive(state);
  const decision = decisionId ? state.design.decisions.find((d) => d.id === decisionId) : state.design.decision;
  if (!decision) throw new EccodeError('NOT_FOUND', decisionId ? `Unknown decision ${decisionId}` : 'No design decision recorded yet (eccode design decide)');
  const rel = `.eccode/design/${decision.id}.md`;
  const content = renderAdr(state, decision);
  fs.mkdirSync(path.join(store.root, '.eccode', 'design'), { recursive: true });
  writeFileAtomic(path.join(store.root, rel), content);
  return store.commit('design.adr', actor, { id: newId('adr'), decision: decision.id, artifact: rel, artifactSha256: sha256(content) }, (s) => {
    assertActive(s);
    if (!s.design.decisions.some((d) => d.id === decision.id)) throw new EccodeError('NOT_FOUND', `Unknown decision ${decision.id}`);
  }).event.data;
}

/** A reviewer amends the decision's interfaces after implementation started. */
function amend(store, config, actor, { decision: decisionId, interfaces, reason } = {}) {
  assertRole(reviewers(config), actor, 'amend a design decision');
  const data = { id: newId('dam'), decision: text(decisionId, 'decision id', 1), interfaces: validInterfaces(interfaces), reason: text(reason, 'reason') };
  if (!data.interfaces.length) throw new EccodeError('INVALID_INPUT', 'an amendment names the interfaces it adds or changes');
  return store.commit('design.amended', actor, data, (state) => {
    assertActive(state);
    if (!state.design.decisions.some((d) => d.id === data.decision)) throw new EccodeError('NOT_FOUND', `Unknown decision ${data.decision}`);
  }).event.data;
}

// ------------------------------------------------------------------ spikes

function spikeStart(store, config, actor, { question, paths } = {}) {
  const allowed = [...new Set([...config.roles.phase.authors, ...designers(config)])];
  assertRole(allowed, actor, 'start a spike');
  const list = (Array.isArray(paths) ? paths : String(paths || '').split(',')).map((p) => toPosix(String(p).trim())).filter(Boolean);
  if (!list.length) throw new EccodeError('INVALID_INPUT', 'a spike names the paths (files or globs) its throwaway code lives in');
  return store.commit('design.spike.started', actor, { id: newId('sp'), question: text(question, 'question'), paths: list }, (state) => assertActive(state)).event.data;
}

/** Close a spike: what it proved is recorded, its files are hashed so a copy of them cannot be delivered under another name. */
function spikeClose(store, config, actor, spikeId, { proved } = {}) {
  const state = store.state();
  const spike = state.design.spikes.find((s) => s.id === spikeId);
  if (!spike) throw new EccodeError('NOT_FOUND', `Unknown spike ${spikeId}`);
  if (spike.closed) throw new EccodeError('INVALID_TRANSITION', `Spike ${spikeId} is closed`);
  if (actor !== spike.by && actor !== 'orchestrator') throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not close spike ${spikeId} (started by ${spike.by})`);
  const hashes = {};
  for (const f of spikeFiles(store.root, spike)) hashes[f] = sha256File(path.join(store.root, f));
  return store.commit('design.spike.closed', actor, { id: spikeId, proved: text(proved, 'what the spike proved'), discarded: true, fileHashes: hashes }, (s) => {
    assertActive(s);
    const cur = s.design.spikes.find((x) => x.id === spikeId);
    if (!cur || cur.closed) throw new EccodeError('INVALID_TRANSITION', `Spike ${spikeId} is closed`);
  }).event.data;
}

/** The files a spike's paths cover right now (tracked changes and untracked files). */
function spikeFiles(root, spike) {
  const changed = gitChangedFiles(root, 'HEAD') || [];
  const literal = spike.paths.filter((p) => !/[*?[]/.test(p) && exists(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile());
  return [...new Set([...changed.filter((f) => matchesAny(f, spike.paths)), ...literal])];
}

/** Spike code in the delivered change: by path, or by content under another name. */
function spikeProblems(state, root, changedFiles) {
  const spikes = (state.design && state.design.spikes) || [];
  if (!spikes.length) return [];
  const problems = [];
  const files = (changedFiles || []).map(toPosix).filter((f) => !f.startsWith('.eccode/'));
  for (const s of spikes) {
    const inDiff = files.filter((f) => matchesAny(f, s.paths));
    if (inDiff.length) problems.push(`spike ${s.id} (${s.question}) is still in the change: ${inDiff.join(', ')}. A spike is discarded, never delivered; remove it${s.closed ? '' : ' and close the spike (eccode design spike close)'}`);
    if (!s.closed) problems.push(`spike ${s.id} is open; close it with what it proved (eccode design spike close ${s.id} --proved "<what>")`);
    const hashes = new Set(Object.values(s.fileHashes || {}));
    if (hashes.size && root) {
      for (const f of files) {
        const abs = path.join(root, f);
        if (exists(abs) && fs.statSync(abs).isFile() && hashes.has(sha256File(abs))) problems.push(`${f} has the content of spike ${s.id}'s file (renamed spike code is still spike code)`);
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------- ambiguity

function validQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new EccodeError('INVALID_INPUT', 'an ambiguity records the unresolved questions: [{id, text, blocking, options?}]');
  return questions.map((q, i) => ({ id: text(q && q.id, `question ${i}: id`, 1), text: text(q && q.text, `question ${i}: text`), blocking: Boolean(q && q.blocking), options: Array.isArray(q && q.options) ? q.options.map(String) : [] }));
}

function ambiguity(store, config, actor, questions) {
  assertRole(designers(config), actor, 'record an ambiguity');
  return store.commit('request.ambiguity', actor, { id: newId('amb'), questions: validQuestions(questions) }, (state) => assertActive(state)).event.data;
}

/** The user answers; nothing else may. */
function clarify(store, config, actor, { question, answer } = {}) {
  if (actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Only the user clarifies a request (--actor user); headless, record a reasonable reading as an assumption instead (eccode request assume)');
  const data = { question: text(question, 'question id', 1), answer: text(answer, 'answer') };
  return store.commit('request.clarified', actor, data, (state) => {
    assertActive(state);
    if (!openQuestions(state, true).some((q) => q.id === data.question)) throw new EccodeError('NOT_FOUND', `No open question ${data.question}`);
  }).event.data;
}

/** Headless: a reasonable reading, recorded as an assumption that the handoff and the report surface. */
function assume(store, config, actor, { question, reading, rationale } = {}) {
  if (actor === 'user') throw new EccodeError('INVALID_INPUT', 'The user clarifies (eccode request clarify); an assumption is the orchestrator\'s recorded reading');
  assertRole(designers(config), actor, 'record an assumption');
  const data = { question: text(question, 'question id', 1), reading: text(reading, 'reading'), rationale: text(rationale, 'rationale') };
  return store.commit('request.assumption', actor, data, (state) => {
    assertActive(state);
    if (!openQuestions(state, true).some((q) => q.id === data.question)) throw new EccodeError('NOT_FOUND', `No open question ${data.question}`);
  }).event.data;
}

/** Questions without a clarification or an assumption; `all` includes non-blocking ones. */
function openQuestions(state, all = false) {
  const d = state.design;
  if (!d) return [];
  // Only the user's clarification answers a question; a clarification recorded by any other actor is not an answer.
  const answered = new Set([...d.clarifications.filter((c) => c.by === 'user').map((c) => c.question), ...d.assumptions.map((a) => a.question)]);
  return d.ambiguities.flatMap((a) => a.questions).filter((q) => !answered.has(q.id) && (all || q.blocking));
}

/** Planning is refused while a blocking question is open. */
function ambiguityProblem(state) {
  if (!state.work || ['quick', 'debug'].includes(state.work.track)) return null;
  const open = openQuestions(state);
  if (!open.length) return null;
  return `the request has ${open.length} blocking open question(s): ${open.map((q) => `${q.id} (${q.text})`).join('; ')}. Ask the user (eccode request clarify <id> --answer "<answer>" --actor user) or, headless, record the reasonable reading as an assumption (eccode request assume <id> --reading "<reading>" --rationale "<why>" --actor orchestrator)`;
}

// ------------------------------------------------------------------ rules

/** Task ownership on design tracks needs a decision over >= 2 alternatives. */
function claimProblem(state) {
  if (!onDesignTrack(state)) return null;
  const d = state.design.decision;
  if (!d) return `${state.work.track} track: no design decision recorded. Compare at least two alternatives (eccode design alternatives --file options.json --actor technical-designer), decide (eccode design decide --file decision.json), render the ADR (eccode design adr); only then is a task owned`;
  const alt = state.design.alternatives.find((a) => a.id === d.alternatives);
  if (!alt || alt.options.length < 2) return `${state.work.track} track: the design decision ${d.id} references ${alt ? alt.options.length : 'no'} alternative(s); two or more are required`;
  if (!alt.options.every((o) => TRADEOFFS.every((k) => o.tradeoffs && typeof o.tradeoffs[k] === 'string' && o.tradeoffs[k].trim().length >= MIN_TEXT))) return `${state.work.track} track: the alternatives ${alt.id} do not state every tradeoff (${TRADEOFFS.join(', ')}) for every option`;
  return null;
}

/** The verification review on design tracks must cite the ADR. */
function reviewProblems(state, gateId, review) {
  if (!onDesignTrack(state) || gateId !== 'verification') return [];
  const adrs = state.design.adrs;
  if (!adrs.length) return ['no ADR rendered for this work item (eccode design adr --actor technical-designer); the reviewer cites it'];
  const refs = new Set((review.criteria || []).flatMap((c) => c.evidence || []));
  const cited = adrs.some((a) => refs.has(`artifact:${a.artifact}`));
  return cited ? [] : [`the verification review must cite the ADR (artifact:${adrs[adrs.length - 1].artifact}) and say the change honours it`];
}

/** The declared interfaces of the change (behavior contract targets, plus any the caller adds, e.g. breaking API diffs) must be in the ADR or a reviewed amendment. */
function interfaceProblems(state, extraTargets = []) {
  if (!onDesignTrack(state) || !state.design.decision) return [];
  const declared = new Set([...state.design.decision.interfaces.map((i) => `${i.surface} ${i.target}`), ...state.design.amendments.flatMap((a) => a.interfaces.map((i) => `${i.surface} ${i.target}`))]);
  const covers = (key) => {
    if (declared.has(key)) return true;
    const [surface, target] = key.split(/ (.+)/);
    return [...declared].some((d) => {
      const [ds, dt] = d.split(/ (.+)/);
      return ds === surface && dt && dt.endsWith('*') && target.startsWith(dt.slice(0, -1));
    });
  };
  const used = [...((state.behavior && state.behavior.contracts) || []).flatMap((c) => c.entries.map((e) => `${e.surface} ${e.target}`)), ...extraTargets];
  const missing = [...new Set(used)].filter((k) => !covers(k));
  return missing.length ? [`interfaces changed that the ADR ${state.design.decision.id} does not declare: ${missing.join(', ')}. A reviewer amends the decision (eccode design amend --decision ${state.design.decision.id} --file interfaces.json --reason "<why>") or the change is brought back to the ADR`] : [];
}

function deliveryProblems(state, root, changedFiles, extraTargets = []) {
  const problems = [...spikeProblems(state, root, changedFiles), ...interfaceProblems(state, extraTargets)];
  const open = openQuestions(state);
  if (open.length) problems.push(`blocking questions still open: ${open.map((q) => q.id).join(', ')}`);
  if (onDesignTrack(state) && !state.design.adrs.length) problems.push('no ADR rendered for this work item (eccode design adr)');
  return problems;
}

// ----------------------------------------------------------------- output

function show(state) {
  const d = state.design;
  const out = [];
  for (const a of d.alternatives) out.push(`Alternatives ${a.id} by ${a.by}: ${a.options.map((o) => `${o.id} (${o.title})`).join(', ')}`);
  if (d.decision) out.push(`Decision ${d.decision.id}: ${d.decision.chosen} — ${d.decision.rationale}; interfaces: ${d.decision.interfaces.map((i) => `${i.surface} ${i.target}`).join(', ') || 'none'}`);
  else out.push('Decision: none (eccode design decide)');
  for (const a of d.adrs) out.push(`ADR ${a.id}: ${a.artifact}`);
  for (const a of d.amendments) out.push(`Amendment ${a.id} by ${a.by}: ${a.interfaces.map((i) => `${i.surface} ${i.target}`).join(', ')} (${a.reason})`);
  for (const s of d.spikes) out.push(`Spike ${s.id} (${s.paths.join(', ')}): ${s.closed ? `closed, proved: ${s.proved}` : 'open'} — ${s.question}`);
  for (const q of d.ambiguities.flatMap((a) => a.questions)) {
    const c = d.clarifications.find((x) => x.question === q.id);
    const as = d.assumptions.find((x) => x.question === q.id);
    out.push(`Question ${q.id}${q.blocking ? ' (blocking)' : ''}: ${q.text} → ${c ? `clarified by user: ${c.answer}` : as ? `ASSUMED: ${as.reading} (${as.rationale})` : 'OPEN'}`);
  }
  return out.join('\n');
}

/** Lines for the final report: the decision, and every assumption and open question, so a reader sees what was guessed. */
function reportLines(state) {
  const d = state.design;
  if (!d) return [];
  const lines = [];
  if (d.decision) {
    const alt = d.alternatives.find((a) => a.id === d.decision.alternatives);
    lines.push('## Design decision', '', `**${d.decision.chosen}** over ${(alt ? alt.options.filter((o) => o.id !== d.decision.chosen).map((o) => o.id) : []).join(', ') || 'no other option'} (${d.decision.id}, ${d.decision.by}): ${d.decision.rationale}${d.adrs.length ? ` ADR: ${d.adrs[d.adrs.length - 1].artifact}.` : ''}`, '');
    if (d.amendments.length) lines.push(`Amended by ${d.amendments.map((a) => `${a.by} (${a.reason})`).join('; ')}.`, '');
    if (d.spikes.length) lines.push(`Spikes (discarded, not delivered): ${d.spikes.map((s) => `${s.id} ${s.closed ? `proved ${s.proved}` : 'OPEN'}`).join('; ')}.`, '');
  }
  const questions = d.ambiguities.flatMap((a) => a.questions);
  if (questions.length) {
    lines.push('## Assumptions and open questions', '');
    for (const q of questions) {
      const c = d.clarifications.find((x) => x.question === q.id);
      const as = d.assumptions.find((x) => x.question === q.id);
      lines.push(`- ${q.id}${q.blocking ? ' (blocking)' : ''}: ${q.text} — ${c ? `clarified by the user: ${c.answer}` : as ? `**assumed** (not confirmed by the user): ${as.reading}. Why: ${as.rationale}` : '**open**'}`);
    }
    lines.push('');
  }
  return lines;
}

/** The assumptions as handoff text, so every handoff carries them. */
function assumptionLines(state) {
  const d = state.design;
  if (!d) return [];
  return d.assumptions.map((a) => `Assumption (not confirmed by the user) on ${a.question}: ${a.reading} — ${a.rationale}`);
}

module.exports = { DESIGN_TRACKS, TRADEOFFS, onDesignTrack, alternatives, decide, adr, amend, spikeStart, spikeClose, spikeProblems, ambiguity, clarify, assume, openQuestions, ambiguityProblem, claimProblem, reviewProblems, interfaceProblems, deliveryProblems, show, reportLines, assumptionLines, renderAdr };
