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
//   GF-CLOSE-6  (S2.1) owner acceptance: the user, through the owner CLI only, records every open finding of a scope as a
//               numbered limit; a blocking finding is refused; the scope is then accepted, not closed.
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
const C = require('./constants');

const STEPS = ['comprehension', 'critique', 'readiness'];
const UNIT = 'all-processed-tokens';
const CLOSERS = ['orchestrator', 'user'];
const CAVEAT = C.ACCEPT_CAVEAT;
const LIMIT_ID = /^L-GF-[0-9]+$/;
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
  // D2-2: the repository's own git configuration must not hide anything from the check.
  const status = gitOut(root, ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).eccode']);
  const lines = status === null ? ['git status failed'] : status.split('\n').filter(Boolean).map((l) => l.slice(3));
  // E2-7: untracked files are judged by the tree's own .gitignore files only, never by .git/info/exclude or
  // core.excludesFile, which live outside the tree being reviewed.
  const others = gitOut(root, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-per-directory=.gitignore', '--', '.', ':(exclude).eccode']);
  if (others === null) lines.push('git ls-files failed');
  else lines.push(...others.split('\n').filter(Boolean));
  // C2-2: git status does not show a tracked file whose index entry is marked skip-worktree or assume-unchanged, so
  // the files on disk could differ from the tree being reviewed. Any such mark outside .eccode counts as dirty.
  const flagged = gitOut(root, ['ls-files', '-v', '--', '.', ':(exclude).eccode']);
  if (flagged === null) lines.push('git ls-files failed');
  else for (const l of flagged.split('\n').filter(Boolean)) {
    const tag = l[0];
    if (tag === 'S') lines.push(`${l.slice(2)} marked skip-worktree`);
    else if (tag !== tag.toUpperCase()) lines.push(`${l.slice(2)} marked assume-unchanged`);
  }
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
    // D2-4: an input is judged where it lands. A symlink anywhere on its path (the file itself or a directory above
    // it) must not lead out of the project or into the working record.
    const real = require('./permissions').resolveReal(store.root, n);
    if (real.outside) { problems.push(P('GF-CLOSE-5', `input ${n} resolves outside the project`)); continue; }
    if (real.rel !== n && FORBIDDEN.test(real.rel)) { problems.push(P('GF-CLOSE-5', `input ${n} resolves to ${real.rel}, part of the implementers' working record`)); continue; }
    let target = null;
    try { target = fs.statSync(abs); } catch { /* reported below */ }
    if (!target || !target.isFile()) { problems.push(P('GF-CLOSE-5', `input ${n} is not a regular file in the project`)); continue; }
    // E2-6: a hard link shares a file with another name, possibly one under the working record.
    if (target.nlink > 1) { problems.push(P('GF-CLOSE-5', `input ${n} has ${target.nlink} hard links: a hard link can share a working-record file, so a dispatch input has one link`)); continue; }
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
    // A go cites checks that passed (or mutation runs, recorded); a no-go may also cite the check that failed.
    const ok = r.verdict === 'no-go' ? ['passed', 'recorded', 'failed'] : ['passed', 'recorded'];
    if (!ev || !ok.includes(ev.status) || (seq !== null && r.seq !== Infinity && seq > r.seq)) return [P('GF-CLOSE-1', `evidence ${ref} is not a recorded check (it must exist, have passed or been recorded, or for a no-go have failed, and precede the review)`)];
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

/** The evidence ids a fixed resolution rests on: its post-fix (or passing) run and its reproduction. */
function proofIds(x, ctx) {
  if (x.resolution !== 'fixed' || !x.proof) return { post: null, pre: null };
  const post = String(x.proof).replace(/^ev:/, '');
  if (x.reproduction !== undefined) return { post, pre: String(x.reproduction).replace(/^ev:/, '') };
  const ev = ctx.state.evidence && ctx.state.evidence[post];
  return { post, pre: ev && ev.fixVerify ? ev.fixVerify.preFix || null : null };
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
  if (res.resolution === 'fixed' && res.reproduction !== undefined) {
    // A documentation defect has no source change, so the frozen fix verification cannot run on it: its proof is a
    // paired run of one command, failed as a reproduction after the finding, then passed.
    if (found.finding.kind !== 'documentation') { E('a defect is proven by a fix verification (fix-verify), not by a paired run: a paired run is for documentation findings only'); return out; }
    const preId = String(res.reproduction).replace(/^ev:/, '');
    const postId = String(res.proof || '').replace(/^ev:/, '');
    const pre = ctx.state.evidence && ctx.state.evidence[preId];
    const post = ctx.state.evidence && ctx.state.evidence[postId];
    if (!pre) { E(`reproduction ${res.reproduction} is not a recorded check`); return out; }
    if (!post) { E(`proof ${res.proof} is not a recorded check`); return out; }
    if (pre.status !== 'failed' || pre.purpose !== 'reproduction') E(`the reproduction ${res.reproduction} must have failed and be recorded with purpose reproduction`);
    if (post.status !== 'passed') E(`the proof ${res.proof} did not pass`);
    const same = (a, b) => String(a || '').trim().replace(/\s+/g, ' ') === String(b || '').trim().replace(/\s+/g, ' ');
    if (!same(pre.command, post.command)) E(`the reproduction and the proof ran different commands (${pre.command} / ${post.command}): a paired run is one command, before and after`);
    const preSeq = evSeq(ctx, preId);
    const postSeq = evSeq(ctx, postId);
    if (preSeq !== null && preSeq < found.review.seq) E(`reproduction ${res.reproduction} was recorded before finding ${res.finding} was raised`);
    if (preSeq !== null && postSeq !== null && postSeq < preSeq) E('the proof was recorded before its reproduction');
    if (res.seq !== Infinity && postSeq !== null && postSeq > res.seq) E('the proof was recorded after the resolution');
  } else if (res.resolution === 'fixed') {
    if (!res.proof) { E('fixed needs a proof: the post-fix evidence of a fix-verify run (ev:<id>)'); return out; }
    const id = String(res.proof).replace(/^ev:/, '');
    const post = ctx.state.evidence && ctx.state.evidence[id];
    if (!post) { E(`proof ${res.proof} is not a recorded check`); return out; }
    if (!post.fixVerify || post.fixVerify.phase !== 'post-fix') { E(`proof ${res.proof} is not the post-fix run of a fix verification`); return out; }
    if (post.status !== 'passed') E(`the post-fix run ${res.proof} did not pass`);
    const pre = post.fixVerify.preFix && ctx.state.evidence[post.fixVerify.preFix];
    if (!pre) { E(`the post-fix run ${res.proof} cites no pre-fix run`); return out; }
    // C2-1: the reproduction is of the reviewed code: the pre-fix run's base commit has the tree the finding was raised on.
    const baseTree = String(gitOut(ctx.root, ['rev-parse', '--verify', '--quiet', `${post.fixVerify.base}^{tree}`]) || '').trim();
    if (baseTree !== found.review.treeHash) E(`the pre-fix run of ${res.proof} ran at ${String(post.fixVerify.base).slice(0, 12)}, whose tree is not the tree finding ${res.finding} was raised on (${found.review.treeHash.slice(0, 12)}): the reproduction must be of the reviewed code`);
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
    // The owner's decision of round 5: a minor finding, or a major documentation finding, may be deferred by the user.
    if (found.finding.severity === 'blocking') E('a blocking finding cannot be deferred');
    else if (found.finding.severity === 'major' && found.finding.kind !== 'documentation') E('a major defect cannot be deferred: the user defers only a minor finding or a major documentation finding');
    if (typeof res.limit !== 'string' || !res.limit.trim()) E('a deferral names its limit (limit): the numbered limit that records the residual');
    if (!longReason) E('the reason needs 30 characters or more');
  }
  // R2-1: one proof proves one finding. A run that already proves an earlier resolution cannot prove another.
  const mine = proofIds(res, ctx);
  for (const other of ctx.gf.resolutions.filter((x) => x.seq < res.seq && x.finding !== res.finding)) {
    const theirs = proofIds(other, ctx);
    if (mine.post && theirs.post === mine.post) E(`proof ev:${mine.post} already resolves finding ${other.finding}: one proof proves one finding`);
    else if (mine.pre && theirs.pre === mine.pre) E(`reproduction ev:${mine.pre} already proves finding ${other.finding}: one proof proves one finding`);
  }
  const scope = found.review.scope;
  const c = closedAt(ctx.gf, scope, res.seq);
  if (c) E(`scope ${scope} is closed (closed at seq ${c.seq})`);
  return out;
}

function resolveFinding(store, config, actor, input = {}) {
  requireGf(store);
  const res = { id: newId('res'), actor, seq: Infinity, finding: input.finding, resolution: input.resolution, proof: input.proof, reproduction: input.reproduction, reason: input.reason, limit: input.limit };
  const problems = resolutionProblems(res, ctxOf(store, config));
  if (problems.length) throw ruleError(problems);
  const data = { id: res.id, finding: res.finding, resolution: res.resolution, ...(res.proof ? { proof: res.proof } : {}), ...(res.reproduction !== undefined ? { reproduction: res.reproduction } : {}), ...(res.reason ? { reason: String(res.reason).trim() } : {}), ...(res.limit ? { limit: res.limit } : {}) };
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
  // R2-2: a battery is tied to its own run: the run is not cited twice, it is the event right before the battery
  // (the engine writes them back to back), its numbers and survivors are the battery's, and the tree is real.
  if (b.seq !== Infinity && ev && ev.kind === 'mutation') {
    const twin = ctx.gf.batteries.find((x) => x.seq < b.seq && x.evidence === b.evidence);
    if (twin) E(`${b.evidence} is already cited by battery ${twin.id}: one run is one battery`);
    const at = evSeq(ctx, m[1]);
    const evEvent = ctx.log.find((x) => x.seq === at);
    if (at !== b.seq - 1 || !evEvent || evEvent.actor !== b.actor) E(`the mutation run ${b.evidence} was not recorded immediately before this battery by the same actor (the engine writes the run and its battery back to back)`);
    const mu = ev.mutation || {};
    // The evidence keeps at most 20 survivors; the battery lists every survivor (one per survived mutant).
    const evKeys = (mu.survivors || []).map(survivorKey).sort();
    const batKeys = (b.survivors || []).map((x) => x.key).sort();
    const sameSurvivors = batKeys.length === b.survived && evKeys.every((k) => batKeys.includes(k)) && (evKeys.length >= 20 || evKeys.length === batKeys.length);
    if (mu.total !== b.total || mu.killed !== b.killed || mu.survived !== b.survived || !sameSurvivors) E(`the battery does not match its evidence ${b.evidence} (total, killed, survived and survivors must be the run's)`);
  }
  if (b.seq !== Infinity && typeof b.treeHash === 'string' && String(gitOut(ctx.root, ['cat-file', '-t', b.treeHash]) || '').trim() !== 'tree') E(`${b.treeHash.slice(0, 12)} is not a tree of this repository`);
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

// ------------------------------------------------------------------ owner acceptance (GF-CLOSE-6, S2.1)
/** The findings of `scope`'s reviews (valid or not) without a valid resolution recorded before `upto`. */
function openFindings(ctx, scope, upto) {
  const valid = ctx.gf.resolutions.filter((x) => x.seq < upto && resolutionProblems(x, ctx).length === 0);
  const out = [];
  for (const rv of ctx.gf.reviews.filter((r) => r.scope === scope && r.seq < upto)) for (const f of rv.findings || []) if (!valid.some((x) => x.finding === f.id)) out.push(f);
  return out;
}

function acceptanceProblems(a, ctx) {
  const out = [];
  const label = a.seq === Infinity ? 'this acceptance' : `acceptance ${a.id} (seq ${a.seq})`;
  const E = (m) => out.push(P('GF-CLOSE-6', `${label}: ${m}`));
  if (a.actor !== 'user') E(`only the user records an acceptance with limits, through the owner CLI (this is ${a.actor})`);
  if (typeof a.scope !== 'string' || !a.scope) { E('an acceptance names its scope'); return out; }
  const c = closedAt(ctx.gf, a.scope, a.seq);
  if (c) E(`scope ${a.scope} is closed (closed at seq ${c.seq}): a closed scope is not accepted`);
  const earlier = (ctx.gf.acceptances || []).find((x) => x.scope === a.scope && x.seq < a.seq);
  if (earlier) E(`scope ${a.scope} is already accepted (at seq ${earlier.seq})`);
  const list = Array.isArray(a.accepted) ? a.accepted : [];
  if (!list.length) E('an acceptance lists at least one open finding (a scope with none is closed, not accepted)');
  const open = new Map(openFindings(ctx, a.scope, a.seq).map((f) => [f.id, f]));
  const seen = new Set();
  for (const x of list) {
    const id = x && typeof x === 'object' ? x.finding : undefined;
    if (seen.has(id)) { E(`finding ${id} is listed twice`); continue; }
    seen.add(id);
    const f = open.get(id);
    if (!f) { E(`${id} is not an open finding of scope ${a.scope}`); continue; }
    if (x.severity !== f.severity) E(`finding ${id} is ${f.severity}, listed as ${x.severity}: the severity is the recorded one`);
    // The owner's decision refuses a blocking finding against a prevention rule (a managed-path rule); the engine cannot tell which rule a
    // finding is against, so it refuses every blocking finding (design 18.5, 18.7).
    if (f.severity === 'blocking') E(`finding ${id} is blocking: a blocking finding cannot be accepted`);
    if (typeof x.limit !== 'string' || !LIMIT_ID.test(x.limit)) E(`finding ${id}: the limit id must be of the form L-GF-<n>`);
    if (typeof x.reason !== 'string' || x.reason.trim().length < 30) E(`finding ${id}: the reason needs 30 characters or more`);
  }
  for (const f of open.values()) if (!seen.has(f.id)) E(`finding ${f.id} is open and not listed (${f.severity}): an acceptance lists every open finding of the scope`);
  if (a.seq !== Infinity && typeof a.treeHash === 'string' && String(gitOut(ctx.root, ['cat-file', '-t', a.treeHash]) || '').trim() !== 'tree') E(`${a.treeHash.slice(0, 12)} is not a tree of this repository`);
  return out;
}

/** GF-CLOSE-6: the user accepts `scope` with limits. Refused unless every open finding is listed and none is blocking. */
function accept(store, config, actor, input = {}) {
  requireGf(store);
  const ts = treeState(store.root);
  const a = { id: newId('acc'), actor, seq: Infinity, scope: input.scope, accepted: input.accepted };
  const problems = [...acceptanceProblems(a, ctxOf(store, config)), ...cleanProblems('GF-CLOSE-6', ts)];
  if (problems.length) throw ruleError(problems);
  const data = { id: a.id, scope: a.scope, treeHash: ts.tree, accepted: a.accepted.map((x) => ({ finding: x.finding, severity: x.severity, limit: x.limit, reason: String(x.reason).trim() })), caveat: CAVEAT };
  return events.commit(store, 'gf.slice.accepted', actor, data, (state) => { const again = acceptanceProblems(a, ctxOf(store, config, state)); if (again.length) throw ruleError(again); });
}

/** The valid acceptances of the record: accepted, and whether the scope was also closed. */
function acceptedScopes(ctx) {
  return (ctx.gf.acceptances || []).filter((a) => acceptanceProblems(a, ctx).length === 0).map((a) => ({ scope: a.scope, seq: a.seq, treeHash: a.treeHash, findings: a.accepted.length, closed: ctx.gf.closures.some((c) => c.scope === a.scope) }));
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
  // Only records that pass their own checks count toward a closure (R2-1): a forged review, resolution or battery is
  // reported by the audit and stands in for nothing here.
  const reviews = ctx.gf.reviews.filter((r) => r.scope === c.scope && r.seq < c.seq && reviewProblems(r, ctx).length === 0);
  const allReviews = ctx.gf.reviews.filter((r) => r.scope === c.scope && r.seq < c.seq);
  const validResolutions = ctx.gf.resolutions.filter((x) => x.seq < c.seq && resolutionProblems(x, ctx).length === 0);
  for (const step of STEPS) {
    const latest = reviews.filter((r) => r.step === step && r.treeHash === c.treeHash).pop();
    if (!latest) E('GF-CLOSE-1', `no ${step} review is recorded on the closing tree ${tree12}: the closing review is of the tree being closed`);
    else if (step === 'readiness' && latest.verdict !== 'go') E('GF-CLOSE-1', `the readiness verdict on the closing tree is ${latest.verdict}`);
    // D2-3: a no-go stands until the tree changes; a later go on the same tree does not override it.
    if (step === 'readiness' && reviews.some((r) => r.step === 'readiness' && r.treeHash === c.treeHash && r.verdict === 'no-go')) E('GF-CLOSE-1', 'a readiness no-go was recorded on the closing tree: it stands until the tree changes (a new round on a new tree)');
    const cited = c.steps && c.steps[step];
    if (cited && !reviews.some((r) => r.id === cited && r.step === step)) E('GF-CLOSE-1', `the cited ${step} review ${cited} is not recorded for this scope`);
  }
  // D3-1: a closing review's author is not the closer, whatever the configuration names as reviewers.
  for (const r of reviews.filter((x) => x.treeHash === c.treeHash && x.actor === c.actor)) E('GF-CLOSE-1', `${r.step} review ${r.id} on the closing tree was recorded by ${c.actor}, the closer: a closing review's author is not the closer`);
  for (const rv of allReviews) {
    for (const f of rv.findings || []) {
      const res = validResolutions.find((x) => x.finding === f.id);
      if (!res) E('GF-CLOSE-2', `finding ${f.id} (${f.severity}) of review ${rv.id} is unresolved`);
      // C2-1: a fix changes the tree, so a finding fixed on the closing tree itself was not fixed in it.
      else if (res.resolution === 'fixed' && rv.treeHash === c.treeHash) E('GF-CLOSE-2', `finding ${f.id} was fixed, but the closing tree is the tree it was raised on: a fix changes the tree, so it needs a new round on the fixed tree`);
    }
  }
  const batteries = ctx.gf.batteries.filter((b) => b.scope === c.scope && b.seq < c.seq && batteryProblems(b, ctx).length === 0);
  if (batteries.length < 2) E('GF-CLOSE-3', `${batteries.length} ${batteries.length === 1 ? 'battery' : 'batteries'} recorded; two are required: one before the first review and one on the closing tree`);
  else {
    const last = batteries[batteries.length - 1];
    if (allReviews.length && batteries[0].seq > allReviews[0].seq) E('GF-CLOSE-3', 'the first battery was recorded after the first review: it measures the tree before any review');
    if (last.treeHash !== c.treeHash) E('GF-CLOSE-3', `the last battery was run on tree ${last.treeHash.slice(0, 12)}, the closing tree is ${tree12}`);
    const fixes = validResolutions.filter((x) => x.resolution === 'fixed' && allReviews.some((r) => (r.findings || []).some((f) => f.id === x.finding)));
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

/** What closing `scope` now would be refused for: the same checks as close, committing nothing. */
function preview(store, config, scope, { accounting, accepted } = {}) {
  requireGf(store);
  const ctx = ctxOf(store, config);
  const ts = treeState(store.root);
  const c = { actor: 'orchestrator', seq: Infinity, scope, treeHash: ts.tree, accounting: accounting || { unit: UNIT, start: 'unmeasurable', end: 'unmeasurable' }, accepted: accepted || [] };
  const problems = [...closeProblems(c, ctx), ...cleanProblems('GF-CLOSE-1', ts)];
  const scoped = (list) => list.filter((x) => x.scope === scope);
  const acceptance = acceptedScopes(ctx).find((a) => a.scope === scope) || null;
  return { scope, treeHash: ts.tree, ok: problems.length === 0, problems, accepted: acceptance, dispatches: scoped(ctx.gf.dispatches).length, reviews: scoped(ctx.gf.reviews).map((r) => ({ id: r.id, step: r.step, verdict: r.verdict, actor: r.actor, tree: r.treeHash.slice(0, 12), findings: (r.findings || []).map((f) => f.id) })), batteries: scoped(ctx.gf.batteries).map((b) => ({ id: b.id, round: b.round, tree: b.treeHash.slice(0, 12), total: b.total, survived: b.survived })) };
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
  for (const a of gf.acceptances || []) out.push(...acceptanceProblems(at(a), ctx));
  return out.filter((p, i, a) => a.findIndex((q) => q.rule === p.rule && q.message === p.message) === i);
}

module.exports = { recordDispatch, recordReview, resolveFinding, runBattery, close, accept, acceptedScopes, preview, auditProblems, treeState, STEPS, UNIT, CAVEAT };
