'use strict';
// The slice-closure rule, GF-CLOSE-1..5 (owner conditions of 2026-11-07). A scope (a slice) closes only when
//   GF-CLOSE-1  the final tree has an independent review in three recorded steps: comprehension (the reviewer
//               explains the design back from the documents alone), critique (it tries to break the rules) and
//               readiness (go or no-go with cited evidence). Each step is recorded by a reviewer role that authored
//               nothing in the record; none is the closer's own;
//   GF-CLOSE-5  each step is its own dispatch, recorded by the orchestrator BEFORE the review with the artifacts it
//               receives (paths and hashes, never the implementers' drafts, handoffs, memory or log) and the tree
//               it was dispatched on; one dispatch carries one review;
//   GF-CLOSE-2  every finding is resolved: fixed (a fix-verify pair: the reproduction failed, the post-fix run passed,
//               both recorded after the finding), withdrawn (by the reviewer role that raised it) or deferred (by the
//               user, minor only, naming a limit);
//   GF-CLOSE-3  two batteries (pinned mutation runs recorded by the engine): the first before the first review, the
//               last on the closing tree and after the last fix, its survivors each with an accepted reason;
//   GF-CLOSE-4  accounting: unit all-processed-tokens, start and end each a non-negative integer or "unmeasurable".
// Every check is one function evaluated twice: before a record is committed and again, as an invariant, by the audit.
// What the engine cannot see (L-GF-19): that a dispatched agent really had no context beyond its declared inputs;
// it records the dispatch and checks what it can.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newId, sha256 } = require('../util');
const mutate = require('../mutate');
const events = require('./events');
const ownership = require('./ownership');
const wrap = require('./wrap');
const { allReviewersOf } = require('./roles');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const STEPS = ['comprehension', 'critique', 'readiness'];
const UNIT = 'all-processed-tokens';
const CLOSERS = ['orchestrator', 'user'];
const FORBIDDEN = /^\.eccode\/(drafts|handoffs|memory|runs|lab|improvements)\/|^\.eccode\/(events\.jsonl|state\.json)$/;
const P = (rule, message) => ({ rule, message });

function gitOut(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The git tree object of HEAD and what is dirty outside .eccode (tracked changes and untracked files). */
function treeState(root) {
  const tree = gitOut(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (tree === null) return { tree: null, dirty: ['this is not a git repository with a commit'] };
  const status = gitOut(root, ['status', '--porcelain', '--', '.', ':(exclude).eccode']);
  const lines = status === null ? ['git status failed'] : status.split('\n').filter(Boolean).map((l) => l.slice(3));
  return { tree: tree.trim(), dirty: lines.length ? lines.slice(0, 5) : null };
}
const cleanProblems = (rule, ts) => (ts.dirty ? [P(rule, `the tree is not clean (${ts.dirty.join(', ')}): commit or discard first, a review and a battery are bound to a tree`)] : []);

function ctxOf(store, config, state) {
  const log = store.readEvents();
  return { log, gf: project(log), state: state || store.state(), config, root: store.root };
}
const closedAt = (gf, scope, upto) => gf.closures.find((c) => c.scope === scope && c.seq < upto);
const reviewerRoles = (ctx) => allReviewersOf(ctx.config);
const evSeq = (ctx, id) => { const e = ctx.log.find((x) => x.type === 'evidence.recorded' && x.data && x.data.id === id); return e ? e.seq : null; };
const authors = (ctx) => new Set(ctx.log.filter((e) => ['task.claimed', 'task.completed', 'gate.submitted'].includes(e.type)).map((e) => e.actor));

// ------------------------------------------------------------------ dispatch (GF-CLOSE-5)
function dispatchProblems(d, ctx) {
  const out = [];
  const E = (m) => out.push(P('GF-CLOSE-5', m));
  const at = d.seq === Infinity ? '' : ` (seq ${d.seq})`;
  const name = d.seq === Infinity ? 'a dispatch' : `dispatch ${d.id}${at}`;
  if (d.actor !== 'orchestrator') E(`${name}: only the orchestrator records a dispatch (recorded by ${d.actor})`);
  if (!reviewerRoles(ctx).includes(d.role)) E(`${name}: ${d.role} is not a reviewer role (reviewers: ${reviewerRoles(ctx).join(', ')})`);
  if (!STEPS.includes(d.step)) E(`${name}: unknown step ${d.step} (steps: ${STEPS.join(', ')})`);
  if (!Array.isArray(d.inputs) || d.inputs.length === 0) E(`${name}: a dispatch lists the artifacts the reviewer receives (inputs)`);
  else {
    for (const i of d.inputs) {
      const p = typeof i === 'string' ? i : i && i.path;
      const n = ownership.normalizePath(p);
      if (n === null) E(`${name}: input ${p} is outside the project or not a relative path`);
      else if (FORBIDDEN.test(n)) E(`${name}: input ${n} is part of the implementers' working record (drafts, handoffs, memory, runs, lab, the event log); a zero-context review receives artifacts and the tree only`);
    }
  }
  const c = closedAt(ctx.gf, d.scope, d.seq);
  if (c) E(`${name}: scope ${d.scope} is closed (closed at seq ${c.seq})`);
  return out;
}

function recordDispatch(store, config, actor, input = {}) {
  requireGf(store);
  const ctx0 = ctxOf(store, config);
  const ts = treeState(store.root);
  const d = { actor, seq: Infinity, scope: input.scope, role: input.role, step: input.step, inputs: Array.isArray(input.inputs) ? input.inputs : [] };
  const problems = dispatchProblems(d, ctx0).map((p) => ({ ...p, message: p.message.replace(/^a dispatch: /, '') }));
  const hashed = [];
  for (const p of d.inputs) {
    const n = ownership.normalizePath(p);
    if (n === null || FORBIDDEN.test(n)) continue;
    const abs = path.join(store.root, n);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* reported below */ }
    if (!st || !st.isFile()) { problems.push(P('GF-CLOSE-5', `input ${n} is not a regular file in the project`)); continue; }
    hashed.push({ path: n, sha256: sha256(fs.readFileSync(abs)) });
  }
  if (typeof d.scope !== 'string' || !d.scope) problems.push(P('GF-CLOSE-5', 'a dispatch names its scope'));
  problems.push(...cleanProblems('GF-CLOSE-5', ts));
  if (problems.length) throw ruleError(problems);
  const data = { id: newId('disp'), scope: d.scope, role: d.role, step: d.step, treeHash: ts.tree, inputs: hashed };
  return events.commit(store, 'gf.dispatch.recorded', actor, data, () => {
    const again = dispatchProblems({ ...d, inputs: d.inputs }, ctxOf(store, config));
    if (again.length) throw ruleError(again);
  });
}

// ------------------------------------------------------------------ review (GF-CLOSE-1)
const stepVerdicts = { comprehension: ['clean', 'findings'], critique: ['clean', 'findings'], readiness: ['go', 'no-go'] };

function evidenceProblems(ref, r, ctx) {
  const m = /^ev:(.+)$/.exec(ref);
  if (m) {
    const ev = ctx.state.evidence && ctx.state.evidence[m[1]];
    const seq = evSeq(ctx, m[1]);
    if (!ev || !['passed', 'recorded'].includes(ev.status) || (seq !== null && r.seq !== Infinity && seq > r.seq)) return [P('GF-CLOSE-1', `evidence ${ref} is not a recorded check (it must exist, have passed or been recorded, and precede the review)`)];
    return [];
  }
  const f = /^(.+):(\d+)$/.exec(ref);
  const bad = [P('GF-CLOSE-1', `evidence ${ref} is not a line of that file at this tree`)];
  if (!f || ownership.normalizePath(f[1]) === null || Number(f[2]) < 1) return bad;
  const text = gitOut(ctx.root, ['show', `${r.treeHash}:${ownership.normalizePath(f[1])}`]);
  if (text === null) return bad;
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return Number(f[2]) <= lines ? [] : bad;
}

function reviewProblems(r, ctx) {
  const out = [];
  const label = r.seq === Infinity ? 'this review' : `review ${r.id} (seq ${r.seq})`;
  const E = (m) => out.push(P('GF-CLOSE-1', `${label}: ${m}`));
  if (!reviewerRoles(ctx).includes(r.actor)) E(`${r.actor} is not a reviewer role (reviewers: ${reviewerRoles(ctx).join(', ')})`);
  else if (authors(ctx).has(r.actor)) E(`${r.actor} authored work in this record (a claim, a completion or a gate submission), so it is not independent`);
  const d = ctx.gf.dispatches.find((x) => x.id === r.dispatch && x.seq < r.seq);
  if (!d) E(`dispatch ${r.dispatch} is not recorded`);
  else {
    if (d.role !== r.actor) E(`dispatch ${d.id} was recorded for ${d.role}, not ${r.actor}`);
    if (d.step !== r.step) E(`dispatch ${d.id} is for step ${d.step}, not ${r.step}`);
    if (d.scope !== r.scope) E(`dispatch ${d.id} belongs to scope ${d.scope}`);
    if (d.treeHash !== r.treeHash) E(`the tree changed since dispatch ${d.id} (dispatched at ${d.treeHash.slice(0, 12)}, now ${r.treeHash.slice(0, 12)}): the review is not of this tree`);
    const first = ctx.gf.reviews.find((x) => x.dispatch === d.id && x.seq < r.seq);
    if (first) E(`dispatch ${d.id} already carries review ${first.id}: each step is its own dispatch`);
  }
  if (!STEPS.includes(r.step)) E(`unknown step ${r.step}`);
  else if (!stepVerdicts[r.step].includes(r.verdict)) E(r.step === 'readiness' ? 'readiness is go or no-go' : `verdict ${r.verdict} does not fit step ${r.step}`);
  const findings = r.findings || [];
  if (r.step === 'readiness') {
    if (findings.length) E('a readiness verdict carries no findings');
    const ev = r.evidence || [];
    if (!ev.length) E('a readiness verdict cites evidence: an executed check (ev:<id>) or file:line');
    for (const ref of ev) for (const p of evidenceProblems(ref, r, ctx)) out.push({ ...p, message: `${label}: ${p.message}` });
  } else if (STEPS.includes(r.step)) {
    if (r.verdict === 'clean' && findings.length) E('verdict clean does not fit a review that lists findings');
    if (r.verdict === 'findings' && !findings.length) E('verdict findings does not fit a review that lists none');
    const kind = r.step === 'comprehension' ? 'documentation' : 'defect';
    for (const f of findings) if (f.kind !== kind) E(r.step === 'comprehension' ? 'a comprehension finding is a documentation defect (kind documentation): what the reviewer could not reconstruct from the documents' : 'a critique finding is a defect (kind defect): something reproducible that breaks a rule');
  }
  const ids = findings.map((f) => f.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) E(`finding id ${id} is repeated`);
  const seen = new Set(ctx.gf.reviews.filter((x) => x.seq < r.seq).flatMap((x) => (x.findings || []).map((f) => f.id)));
  for (const id of ids) if (seen.has(id)) E(`finding id ${id} is already recorded`);
  const c = closedAt(ctx.gf, r.scope, r.seq);
  if (c) E(`scope ${r.scope} is closed (closed at seq ${c.seq})`);
  return out;
}

function recordReview(store, config, actor, input = {}) {
  requireGf(store);
  const ts = treeState(store.root);
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const verdict = input.step === 'readiness' ? input.verdict : (input.verdict !== undefined ? input.verdict : (findings.length ? 'findings' : 'clean'));
  const r = { id: newId('rev'), actor, seq: Infinity, scope: input.scope, step: input.step, dispatch: input.dispatch, treeHash: ts.tree, summary: input.summary, verdict, findings, evidence: input.evidence };
  const problems = [...reviewProblems(r, ctxOf(store, config)), ...cleanProblems('GF-CLOSE-1', ts)];
  if (typeof r.summary !== 'string' || r.summary.length < 100) problems.push(P('GF-CLOSE-1', 'the summary needs 100 characters or more: what was read, what was reconstructed, what was not'));
  if (problems.length) throw ruleError(problems);
  const data = { id: r.id, scope: r.scope, step: r.step, dispatch: r.dispatch, treeHash: r.treeHash, summary: r.summary, verdict, ...(findings.length ? { findings } : {}), ...(r.evidence ? { evidence: r.evidence } : {}) };
  return events.commit(store, 'gf.review.recorded', actor, data, (state) => { const again = reviewProblems(r, ctxOf(store, config, state)); if (again.length) throw ruleError(again); });
}

// ------------------------------------------------------------------ resolution (GF-CLOSE-2)
function findingOf(ctx, id, upto) {
  for (const rv of ctx.gf.reviews) if (rv.seq < upto) { const f = (rv.findings || []).find((x) => x.id === id); if (f) return { finding: f, review: rv }; }
  return null;
}

function resolutionProblems(res, ctx) {
  const out = [];
  const label = res.seq === Infinity ? 'this resolution' : `resolution ${res.id} (seq ${res.seq})`;
  const E = (m) => out.push(P('GF-CLOSE-2', `${label}: ${m}`));
  const found = findingOf(ctx, res.finding, res.seq);
  if (!found) { E(`finding ${res.finding} is not recorded`); return out; }
  if (ctx.gf.resolutions.some((x) => x.finding === res.finding && x.seq < res.seq)) E(`finding ${res.finding} is already resolved`);
  if (!['fixed', 'withdrawn', 'deferred'].includes(res.resolution)) { E(`unknown resolution ${res.resolution} (fixed, withdrawn or deferred)`); return out; }
  const longReason = typeof res.reason === 'string' && res.reason.trim().length >= 30;
  if (res.resolution === 'fixed') {
    if (!res.proof) { E('fixed needs a proof: the post-fix evidence of a fix-verify run (ev:<id>)'); return out; }
    const id = String(res.proof).replace(/^ev:/, '');
    const post = ctx.state.evidence && ctx.state.evidence[id];
    if (!post) { E(`proof ${res.proof} is not a recorded check`); return out; }
    if (!post.fixVerify || post.fixVerify.phase !== 'post-fix') { E(`proof ${res.proof} is not the post-fix run of a fix verification`); return out; }
    if (post.status !== 'passed') E(`the post-fix run ${res.proof} did not pass`);
    const pre = post.fixVerify.preFix && ctx.state.evidence[post.fixVerify.preFix];
    if (!pre) { E(`the post-fix run ${res.proof} cites no pre-fix run`); return out; }
    if (pre.status !== 'failed') E(`the pre-fix run ev:${pre.id} did not fail: the test does not reproduce the finding`);
    else if (pre.purpose !== 'reproduction') E(`the pre-fix run ev:${pre.id} failed but is not a reproduction (it failed for a reason other than the finding)`);
    const preSeq = evSeq(ctx, pre.id);
    const postSeq = evSeq(ctx, id);
    if (preSeq !== null && preSeq < found.review.seq) E(`reproduction ev:${pre.id} was recorded before finding ${res.finding} was raised`);
    if (postSeq !== null && preSeq !== null && postSeq < preSeq) E(`the post-fix run was recorded before its pre-fix run`);
    if (res.seq !== Infinity && postSeq !== null && postSeq > res.seq) E('the proof was recorded after the resolution');
  } else if (res.resolution === 'withdrawn') {
    if (res.actor !== found.review.actor || !reviewerRoles(ctx).includes(res.actor)) E('only the reviewer role that raised a finding may withdraw it');
    if (!longReason) E('the reason needs 30 characters or more');
  } else {
    if (res.actor !== 'user') E('only the user may defer a finding');
    if (found.finding.severity !== 'minor') E('a blocking or major finding cannot be deferred');
    if (typeof res.limit !== 'string' || !res.limit.trim()) E('a deferral names its limit (limit): the numbered limit that records the residual');
    if (!longReason) E('the reason needs 30 characters or more');
  }
  const scope = found.review.scope;
  const c = closedAt(ctx.gf, scope, res.seq);
  if (c) E(`scope ${scope} is closed (closed at seq ${c.seq})`);
  return out;
}

function resolveFinding(store, config, actor, input = {}) {
  requireGf(store);
  const res = { id: newId('res'), actor, seq: Infinity, finding: input.finding, resolution: input.resolution, proof: input.proof, reason: input.reason, limit: input.limit };
  const problems = resolutionProblems(res, ctxOf(store, config));
  if (problems.length) throw ruleError(problems);
  const data = { id: res.id, finding: res.finding, resolution: res.resolution, ...(res.proof ? { proof: res.proof } : {}), ...(res.reason ? { reason: String(res.reason).trim() } : {}), ...(res.limit ? { limit: res.limit } : {}) };
  return events.commit(store, 'gf.finding.resolved', actor, data, (state) => { const again = resolutionProblems(res, ctxOf(store, config, state)); if (again.length) throw ruleError(again); });
}

// ------------------------------------------------------------------ battery (GF-CLOSE-3)
const survivorKey = (s) => `${s.file}:${s.line}:${s.op}`;

function batteryProblems(b, ctx) {
  const out = [];
  const label = b.seq === Infinity ? 'this battery' : `battery ${b.id} (seq ${b.seq})`;
  const E = (m) => out.push(P('GF-CLOSE-3', `${label}: ${m}`));
  if (b.actor !== 'orchestrator') E(`only the orchestrator runs a battery (recorded by ${b.actor})`);
  const m = /^ev:(.+)$/.exec(String(b.evidence));
  const ev = m && ctx.state.evidence && ctx.state.evidence[m[1]];
  if (b.seq !== Infinity && (!ev || ev.kind !== 'mutation')) E(`${b.evidence} is not a recorded mutation run`);
  const earlier = ctx.gf.batteries.filter((x) => x.scope === b.scope && x.seq < b.seq);
  if (b.round !== undefined && b.round !== earlier.length + 1) E(`round ${b.round} follows ${earlier.length} earlier round(s): rounds are 1, 2, 3 in order`);
  const c = closedAt(ctx.gf, b.scope, b.seq);
  if (c) E(`scope ${b.scope} is closed (closed at seq ${c.seq})`);
  return out;
}

function runBattery(store, config, actor, input = {}) {
  requireGf(store);
  const { scope, test, base, max } = input;
  const ctx0 = ctxOf(store, config);
  const problems = [];
  if (actor !== 'orchestrator') problems.push(P('GF-CLOSE-3', `only the orchestrator runs a battery (this is ${actor})`));
  if (typeof scope !== 'string' || !scope) problems.push(P('GF-CLOSE-3', 'a battery names its scope'));
  if (typeof test !== 'string' || !test.trim()) problems.push(P('GF-CLOSE-3', 'a battery needs the test command (test)'));
  if (typeof base !== 'string' || !base.trim()) problems.push(P('GF-CLOSE-3', 'a battery needs the base commit its mutants are measured from (base)'));
  if (closedAt(ctx0.gf, scope, Infinity)) problems.push(P('GF-CLOSE-3', `scope ${scope} is closed`));
  const before = treeState(store.root);
  problems.push(...cleanProblems('GF-CLOSE-3', before));
  if (problems.length) throw ruleError(problems);
  const res = mutate.run(store.root, { test, base, max: max || 25 });
  const after = treeState(store.root);
  if (after.tree !== before.tree || after.dirty) throw ruleError([P('GF-CLOSE-3', 'the tree changed while the battery ran: the run is void and is not recorded')]);
  if (!res.total) throw ruleError([P('GF-CLOSE-3', 'the battery ran no mutant (total 0): it measures nothing; point it at changed code with a base commit')]);
  const evd = mutate.record(store, actor, res, {});
  const round = ctx0.gf.batteries.filter((x) => x.scope === scope).length + 1;
  const data = { id: newId('bat'), scope, round, treeHash: before.tree, evidence: `ev:${evd.id}`, total: res.total, killed: res.killed, survived: res.survived, survivors: (res.survivors || []).map((s) => ({ key: survivorKey(s) })) };
  return events.commit(store, 'gf.battery.recorded', actor, data, (state) => { const again = batteryProblems({ ...data, actor, seq: Infinity, evidence: data.evidence }, ctxOf(store, config, state)); if (again.length) throw ruleError(again); });
}

// ------------------------------------------------------------------ the closure itself
function accountingProblems(a) {
  const E = (m) => P('GF-CLOSE-4', m);
  if (a === undefined || a === null || typeof a !== 'object' || Array.isArray(a)) return [E('accounting is required: { unit: "all-processed-tokens", start, end }, each of start and end a number or "unmeasurable"')];
  const out = [];
  if (a.unit !== UNIT) out.push(E(`accounting.unit must be ${UNIT}`));
  const ok = (v) => v === 'unmeasurable' || (Number.isInteger(v) && v >= 0);
  for (const k of ['start', 'end']) if (!ok(a[k])) out.push(E(`accounting.${k} must be a non-negative integer or "unmeasurable" (never blank, null or text)`));
  if (Number.isInteger(a.start) && Number.isInteger(a.end) && a.end < a.start) out.push(E('accounting.end is below accounting.start'));
  return out;
}

function closeProblems(c, ctx) {
  const out = [];
  const label = c.seq === Infinity ? '' : `scope ${c.scope} closed at seq ${c.seq}: `;
  const E = (rule, m) => out.push(P(rule, `${label}${m}`));
  if (!CLOSERS.includes(c.actor)) E('GF-CLOSE-1', `only the orchestrator or the user closes a slice (this is ${c.actor})`);
  const earlier = ctx.gf.closures.find((x) => x.scope === c.scope && x.seq < c.seq);
  if (earlier) { E('GF-CLOSE-1', c.seq === Infinity ? `scope ${c.scope} is already closed (at seq ${earlier.seq})` : `scope ${c.scope} is closed twice (first at seq ${earlier.seq})`); return out; }
  const tree12 = String(c.treeHash).slice(0, 12);
  const reviews = ctx.gf.reviews.filter((r) => r.scope === c.scope && r.seq < c.seq);
  for (const step of STEPS) {
    const latest = reviews.filter((r) => r.step === step && r.treeHash === c.treeHash).pop();
    if (!latest) E('GF-CLOSE-1', `no ${step} review is recorded on the closing tree ${tree12}: the closing review is of the tree being closed`);
    else if (step === 'readiness' && latest.verdict !== 'go') E('GF-CLOSE-1', `the readiness verdict on the closing tree is ${latest.verdict}`);
    const cited = c.steps && c.steps[step];
    if (cited && !reviews.some((r) => r.id === cited && r.step === step)) E('GF-CLOSE-1', `the cited ${step} review ${cited} is not recorded for this scope`);
  }
  for (const rv of reviews) {
    for (const f of rv.findings || []) {
      if (!ctx.gf.resolutions.some((x) => x.finding === f.id && x.seq < c.seq)) E('GF-CLOSE-2', `finding ${f.id} (${f.severity}) of review ${rv.id} is unresolved`);
    }
  }
  const batteries = ctx.gf.batteries.filter((b) => b.scope === c.scope && b.seq < c.seq);
  if (batteries.length < 2) E('GF-CLOSE-3', `${batteries.length} ${batteries.length === 1 ? 'battery' : 'batteries'} recorded; two are required: one before the first review and one on the closing tree`);
  else {
    const last = batteries[batteries.length - 1];
    if (reviews.length && batteries[0].seq > reviews[0].seq) E('GF-CLOSE-3', 'the first battery was recorded after the first review: it measures the tree before any review');
    if (last.treeHash !== c.treeHash) E('GF-CLOSE-3', `the last battery was run on tree ${last.treeHash.slice(0, 12)}, the closing tree is ${tree12}`);
    const fixes = ctx.gf.resolutions.filter((x) => x.resolution === 'fixed' && x.seq < c.seq && reviews.some((r) => (r.findings || []).some((f) => f.id === x.finding)));
    const lastFix = fixes[fixes.length - 1];
    if (lastFix && last.seq < lastFix.seq) E('GF-CLOSE-3', `the last battery (seq ${last.seq}) was recorded before the last fix (finding ${lastFix.finding} resolved at seq ${lastFix.seq})`);
    for (const s of last.survivors || []) {
      const ok = (c.accepted || []).find((a) => a.key === s.key && typeof a.reason === 'string' && a.reason.trim().length >= 30);
      if (!ok) E('GF-CLOSE-3', `survivor ${s.key} has no accepted reason of 30 characters or more`);
    }
  }
  for (const p of accountingProblems(c.accounting)) out.push(P(p.rule, `${label}${p.message}`));
  return out;
}

function close(store, config, actor, input = {}) {
  requireGf(store);
  const ctx = ctxOf(store, config);
  const ts = treeState(store.root);
  const c = { actor, seq: Infinity, scope: input.scope, treeHash: ts.tree, accounting: input.accounting, accepted: input.accepted || [] };
  const reviews = ctx.gf.reviews.filter((r) => r.scope === c.scope);
  c.steps = Object.fromEntries(STEPS.map((s) => [s, (reviews.filter((r) => r.step === s && r.treeHash === ts.tree).pop() || {}).id]).filter(([, id]) => id));
  const problems = [...closeProblems(c, ctx), ...cleanProblems('GF-CLOSE-1', ts)];
  if (problems.length) throw ruleError(problems);
  const batteries = ctx.gf.batteries.filter((b) => b.scope === c.scope).map((b) => b.id);
  const data = { scope: c.scope, treeHash: ts.tree, steps: c.steps, batteries, accepted: c.accepted, accounting: c.accounting };
  return events.commit(store, 'gf.slice.closed', actor, data, (state) => { const again = closeProblems(c, ctxOf(store, config, state)); if (again.length) throw ruleError(again); });
}

function requireGf(store) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
}

/** The audit's GF-CLOSE-* section: every record judged as it stood at its own seq, then the closures, then late events. */
function auditProblems(store, config, log, gf, state) {
  const out = [];
  const ctx = { log, gf, state, config, root: store.root };
  const at = (e) => ({ ...e, actor: e.actor });
  for (const d of gf.dispatches) out.push(...dispatchProblems(at(d), ctx));
  for (const r of gf.reviews) out.push(...reviewProblems(at(r), ctx));
  for (const x of gf.resolutions) out.push(...resolutionProblems(at(x), ctx));
  for (const b of gf.batteries) out.push(...batteryProblems(at(b), ctx));
  for (const c of gf.closures) out.push(...closeProblems(at(c), ctx));
  return out.filter((p, i, a) => a.findIndex((q) => q.rule === p.rule && q.message === p.message) === i);
}

module.exports = { recordDispatch, recordReview, resolveFinding, runBattery, close, auditProblems, treeState, STEPS, UNIT };
