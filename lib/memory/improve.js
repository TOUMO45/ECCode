'use strict';
// Controlled self-improvement of the toolkit's own operating resources
// (skills, checklists, templates, tests):
//   observed problem -> candidate lesson -> proposed change -> evaluation
//   (baseline vs candidate on the same command) -> independent review ->
//   versioned adoption with a rollback path.
// Proposals can never touch protected paths (permissions, approval rules,
// engine code), must be grounded in verified internal lessons, and adoption
// requires the user unless the project explicitly delegates it.

const fs = require('fs');
const path = require('path');
const { EccodeError, newId, isId, readJson, writeJson, sha256, matchesAny, isoNow, exists, writeFileAtomic } = require('../util');
const { projectRelative } = require('../project');
const { loadConfig, protectedPaths } = require('../config');
const evidence = require('../evidence');

// Only the user or the orchestrator may undo an adopted change.
const ROLLBACK_ACTORS = ['user', 'orchestrator'];

/** A proposal's directory. The id names a path, so only engine-minted ids (imp-…) are accepted. */
function dir(store, id) {
  if (!isId('imp', id)) throw new EccodeError('INVALID_INPUT', `Invalid improvement id ${JSON.stringify(id)} (expected imp-…)`);
  return store.path('improvements', id);
}

function load(store, id) {
  const p = path.join(dir(store, id), 'proposal.json');
  if (!exists(p)) throw new EccodeError('NOT_FOUND', `No improvement proposal ${id}`);
  const prop = readJson(p);
  if (prop.id !== id) throw new EccodeError('INVALID_RECORD', `${p} names a different proposal (${prop.id})`);
  return prop;
}

function save(store, prop) {
  writeJson(path.join(dir(store, prop.id), 'proposal.json'), prop);
}

function list(store) {
  const base = store.path('improvements');
  if (!exists(base)) return [];
  return fs.readdirSync(base).filter((d) => isId('imp', d) && exists(path.join(base, d, 'proposal.json'))).map((d) => load(store, d));
}

/**
 * Absolute path of a proposal target after refusing paths outside the project
 * and protected paths. The proposal is data on disk, so the target is checked
 * again wherever it is written (evaluate, adopt, rollback), not only at propose.
 */
function targetPath(store, config, target) {
  const rel = projectRelative(store.root, String(target || ''));
  if (!rel) throw new EccodeError('INVALID_INPUT', 'An improvement target must be a file in the project');
  if (matchesAny(rel, protectedPaths(config || loadConfig(store.root)))) {
    throw new EccodeError('PROTECTED_PATH', `${rel} is protected (permissions/approval rules/record/engine); self-improvement cannot change it`);
  }
  return path.join(store.root, rel);
}

function propose(store, config, memory, actor, input) {
  const required = ['title', 'observation', 'lessons', 'target', 'change', 'rationale', 'evaluation'];
  const missing = required.filter((k) => input[k] === undefined);
  if (missing.length) throw new EccodeError('INVALID_INPUT', `Proposal missing: ${missing.join(', ')}`);
  const target = projectRelative(store.root, input.target);
  targetPath(store, config, target);
  if (!['replace', 'append'].includes(input.change.type) || typeof input.change.content !== 'string') {
    throw new EccodeError('INVALID_INPUT', 'change must be {type: replace|append, content: string}');
  }
  if (/permission|allowedTools|disallowedTools|requireUser|reviewers|authors/i.test(input.change.content) && /settings|\.eccode\/config/.test(target)) {
    throw new EccodeError('PROTECTED_PATH', 'Changes to permissions or approval requirements are never proposed automatically');
  }
  if (!Array.isArray(input.lessons) || !input.lessons.length) throw new EccodeError('INVALID_INPUT', 'Ground the proposal in at least one lesson id');
  const lessons = input.lessons.map((id) => memory.get(id));
  // Verified per the hash-chained log, not just the (editable) record file.
  const usable = lessons.filter((l) => l.trust !== 'untrusted' && !memory.unverifiedReason(l));
  if (!usable.length) {
    const why = lessons.map((l) => `${l.id}: ${l.trust === 'untrusted' ? 'untrusted' : memory.unverifiedReason(l)}`).join('; ');
    throw new EccodeError('UNGROUNDED', `A proposal needs at least one verified, internal lesson; untrusted or provisional material cannot drive changes (${why})`);
  }
  if (!input.evaluation.command) throw new EccodeError('INVALID_INPUT', 'evaluation.command (representative + regression cases) is required');
  const id = newId('imp');
  const abs = path.join(store.root, target);
  const prop = {
    id,
    title: input.title,
    observation: input.observation,
    lessons: input.lessons,
    target,
    change: input.change,
    rationale: input.rationale,
    evaluation: { command: input.evaluation.command, cases: input.evaluation.cases || null, baseline: null, candidate: null },
    status: 'proposed',
    proposedBy: actor,
    proposedAt: isoNow(),
    baseSha256: exists(abs) ? sha256(fs.readFileSync(abs)) : null,
    reviews: [],
    history: [{ at: isoNow(), by: actor, event: 'proposed' }],
  };
  save(store, prop);
  store.commit('improvement.proposed', actor, { id, target, lessons: input.lessons });
  return prop;
}

function candidateContent(abs, prop) {
  const before = exists(abs) ? fs.readFileSync(abs, 'utf8') : '';
  return prop.change.type === 'replace' ? prop.change.content : before + prop.change.content;
}

/** Parse "ECCODE_EVAL {json}" lines (passed/total) or fall back to exit code. */
function score(ev, store) {
  const log = fs.readFileSync(path.join(store.root, ev.log), 'utf8');
  const m = log.match(/ECCODE_EVAL\s+(\{.*\})/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      return { passed: Number(j.passed), total: Number(j.total), exitCode: ev.exitCode };
    } catch {
      /* fall through */
    }
  }
  return { passed: ev.exitCode === 0 ? 1 : 0, total: 1, exitCode: ev.exitCode };
}

/**
 * Run the evaluation command against the baseline (current file) or the
 * candidate (change temporarily applied, always restored afterwards).
 */
function evaluate(store, actor, id, variant, commandOverride) {
  const prop = load(store, id);
  if (!['baseline', 'candidate'].includes(variant)) throw new EccodeError('INVALID_INPUT', 'variant must be baseline|candidate');
  if (!['proposed', 'evaluated'].includes(prop.status)) throw new EccodeError('INVALID_TRANSITION', `Proposal ${id} is ${prop.status}`);
  const command = commandOverride || prop.evaluation.command;
  const abs = targetPath(store, null, prop.target);
  const original = exists(abs) ? fs.readFileSync(abs) : null;
  if ((original ? sha256(original) : null) !== prop.baseSha256) {
    throw new EccodeError('TARGET_CHANGED', `${prop.target} changed since the proposal was made; re-propose against the current version`);
  }
  let ev;
  try {
    if (variant === 'candidate') writeFileAtomic(abs, candidateContent(abs, prop));
    ev = evidence.runCommand(store, actor, { label: `improvement ${id} ${variant}`, command, purpose: 'check' });
  } finally {
    if (variant === 'candidate') {
      if (original === null) fs.rmSync(abs, { force: true });
      else writeFileAtomic(abs, original);
    }
  }
  // The command is kept per variant: a comparison is only meaningful when both ran the same one.
  prop.evaluation[variant] = { evidence: ev.id, command, ...score(ev, store), by: actor, at: isoNow() };
  if (prop.evaluation.baseline && prop.evaluation.candidate) prop.status = 'evaluated';
  prop.history.push({ at: isoNow(), by: actor, event: `evaluated:${variant}`, evidence: ev.id });
  save(store, prop);
  return prop;
}

function verdict(prop) {
  const b = prop.evaluation.baseline;
  const c = prop.evaluation.candidate;
  if (!b || !c) return { ok: false, reason: 'both baseline and candidate evaluations are required' };
  if (typeof b.command !== 'string' || b.command !== c.command) {
    return { ok: false, reason: 'baseline and candidate were evaluated with different commands (or without a recorded command); re-run both with the same command' };
  }
  if (c.exitCode !== 0) return { ok: false, reason: `candidate evaluation failed (exit ${c.exitCode})` };
  const br = b.total ? b.passed / b.total : 0;
  const cr = c.total ? c.passed / c.total : 0;
  if (cr < br) return { ok: false, reason: `candidate regresses: ${c.passed}/${c.total} vs baseline ${b.passed}/${b.total}` };
  return { ok: true, reason: `candidate ${c.passed}/${c.total} vs baseline ${b.passed}/${b.total}`, improved: cr > br };
}

function review(store, actor, id, decision, notes) {
  const prop = load(store, id);
  // Reviews judge an evaluation; re-reviewing an approved/adopted proposal would strand its rollback path.
  if (prop.status !== 'evaluated') throw new EccodeError('INVALID_TRANSITION', `Proposal ${id} is ${prop.status}; only an evaluated proposal can be reviewed`);
  if (actor === prop.proposedBy) throw new EccodeError('REVIEW_REJECTED', 'The proposer cannot review their own proposal');
  if (!['approve', 'reject'].includes(decision)) throw new EccodeError('INVALID_INPUT', 'decision must be approve|reject');
  if (!notes || notes.length < 15) throw new EccodeError('INVALID_INPUT', 'Review notes must explain what was checked');
  if (decision === 'approve') {
    const v = verdict(prop);
    if (!v.ok) throw new EccodeError('EVALUATION_FAILED', `Cannot approve: ${v.reason}`);
  }
  prop.reviews.push({ at: isoNow(), by: actor, decision, notes });
  prop.status = decision === 'approve' ? 'approved' : 'rejected';
  prop.history.push({ at: isoNow(), by: actor, event: decision });
  save(store, prop);
  store.commit('improvement.reviewed', actor, { id, decision });
  return prop;
}

function adopt(store, config, actor, id) {
  const prop = load(store, id);
  if (prop.status !== 'approved') throw new EccodeError('INVALID_TRANSITION', `Proposal ${id} is ${prop.status}, not approved`);
  const requireUser = config.improvement.requireUserForAdoption !== false;
  if (requireUser && actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Adopting a workflow change requires the user (--actor user)');
  const abs = targetPath(store, config, prop.target);
  const original = exists(abs) ? fs.readFileSync(abs) : null;
  if ((original ? sha256(original) : null) !== prop.baseSha256) throw new EccodeError('TARGET_CHANGED', `${prop.target} changed since evaluation; re-evaluate`);
  const d = dir(store, id);
  if (original !== null) fs.writeFileSync(path.join(d, 'before'), original);
  const content = candidateContent(abs, prop);
  writeFileAtomic(abs, content);
  fs.writeFileSync(path.join(d, 'after'), content);
  const version = list(store).filter((p) => p.target === prop.target && p.version).length + 1;
  prop.status = 'adopted';
  prop.version = version;
  prop.afterSha256 = sha256(content);
  prop.adoptedBy = actor;
  prop.adoptedAt = isoNow();
  prop.history.push({ at: isoNow(), by: actor, event: 'adopted', version });
  save(store, prop);
  store.commit('improvement.adopted', actor, { id, target: prop.target, version });
  return prop;
}

function rollback(store, actor, id, reason, { regression = false, config } = {}) {
  const prop = load(store, id);
  if (!ROLLBACK_ACTORS.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `Rollback is performed by ${ROLLBACK_ACTORS.join(' or ')} (got ${actor})`);
  if (prop.status !== 'adopted') throw new EccodeError('INVALID_TRANSITION', `Proposal ${id} is ${prop.status}`);
  if (!reason) throw new EccodeError('INVALID_INPUT', 'rollback needs --reason');
  const abs = targetPath(store, config, prop.target);
  const cur = exists(abs) ? sha256(fs.readFileSync(abs)) : null;
  if (cur !== prop.afterSha256) throw new EccodeError('TARGET_CHANGED', `${prop.target} was modified after adoption; restore manually from ${path.join(dir(store, id), 'before')}`);
  const before = path.join(dir(store, id), 'before');
  if (exists(before)) writeFileAtomic(abs, fs.readFileSync(before));
  else fs.rmSync(abs, { force: true });
  prop.status = 'rolled_back';
  prop.rollback = { at: isoNow(), by: actor, reason, regression };
  prop.history.push({ at: isoNow(), by: actor, event: 'rolled_back', reason });
  save(store, prop);
  store.commit('improvement.rolled_back', actor, { id, reason, regression });
  return prop;
}

module.exports = { propose, evaluate, review, adopt, rollback, list, load, verdict };
