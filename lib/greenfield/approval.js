'use strict';
// S4-PREREQ D-2: automated slice approval inside a budget. Opt-in by project config, OFF by default:
//   .eccode/config.json  "gf": { "approval": { "auto": { "enabled": true, "maxSlices": N, "maxTokens": T, "maxWallClockMinutes": M } } }
// initProject writes nothing here. The config lives in .eccode/, which the guard keeps out of every agent's reach.
//
// What it approves: a CLOSED slice (a gf.slice.closed for the scope), the owner sign-off point. It closes nothing,
// approves no G1 gate, accepts no limit, defers no finding and amends no contract.
//
// It approves only when every precondition holds; otherwise it stops, writes one rejection-log entry per failing
// rule (action "auto-approve") and throws a GF_RULE error with details.humanNeeded = true:
//   GF-AUTO-0  policy absent, disabled or malformed
//   GF-AUTO-1  the scope is not closed, is already approved, or the record's GF audit is not clean (gates green)
//   GF-AUTO-2  budget: slices approved, tokens recorded by the closures (unmeasurable refuses), wall clock since init
//   GF-AUTO-3  sealed contracts and hidden-suite paths: G1 not sealed, a contract in the closing tree differs from its
//              sealed/amended hash, a contract amendment since the last approval baseline, a hidden path in the tree
//   GF-AUTO-4  the rejection log: its chain does not verify, or it holds a denial since the baseline (the approver's
//              own refusals excepted)
// The baseline is the last auto-approval or the last human `intervention` event (a human acknowledges what came
// before). An approval is ONE event of type "auto-approval" (actor "auto-approver") committed through the frozen
// store, so it is in the same hash chain; the frozen reducer and the GF projection ignore non-gf types.
// GF-AUTO-5 is the audit: audit(store, config) replays every auto-approval.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { sha256, newId } = require('../util');
const { canonical, validate: validateSchema } = require('./jsonschema');
const { project } = require('./projection');
const { ruleError } = require('./errors');
const contracts = require('./contracts');
const hidden = require('./hidden');
const rejections = require('./rejections');

const TYPE = 'auto-approval';
const ACTOR = 'auto-approver';
const ACTION = 'auto-approve';
const INTERVENTION = 'intervention';
const BOUNDS = ['maxSlices', 'maxTokens', 'maxWallClockMinutes'];
const CHECKS = ['policy', 'closed', 'not-yet-approved', 'gf-audit-clean', 'slice-budget', 'token-budget', 'wall-clock-budget', 'g1-sealed', 'contracts-match-seal', 'no-amendment-since-baseline', 'no-hidden-path-in-tree', 'rejection-log-verifies', 'no-denial-since-baseline'];

const SHA = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const POS = { type: 'integer', minimum: 1 };
const COUNT = { type: 'integer', minimum: 0 };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'scope', 'closureSeq', 'treeHash', 'policy', 'policyHash', 'budget', 'rejectionsSeq', 'checks'],
  properties: {
    id: { type: 'string', minLength: 1 }, scope: { type: 'string', minLength: 1 }, closureSeq: POS,
    treeHash: { type: 'string', pattern: '^[0-9a-f]{40,64}$' },
    policy: { type: 'object', required: ['enabled', ...BOUNDS], additionalProperties: false, properties: { enabled: { const: true }, maxSlices: POS, maxTokens: POS, maxWallClockMinutes: POS } },
    policyHash: SHA,
    budget: { type: 'object', required: ['slicesUsed', 'maxSlices', 'tokensUsed', 'maxTokens', 'wallClockMinutes', 'maxWallClockMinutes'], additionalProperties: false, properties: { slicesUsed: POS, maxSlices: POS, tokensUsed: COUNT, maxTokens: POS, wallClockMinutes: { type: 'number', minimum: 0 }, maxWallClockMinutes: POS } },
    rejectionsSeq: COUNT,
    checks: { type: 'array', items: { type: 'string' } },
  },
};

const P = (rule, message) => ({ rule, message });
const policyHashOf = (policy) => sha256(canonical(policy));

/** The policy in force: { policy, problems }. Absent, disabled or malformed: problems (GF-AUTO-0). */
function policyOf(config) {
  const raw = config && config.gf && config.gf.approval && config.gf.approval.auto;
  if (raw === undefined || raw === null) return { policy: null, problems: [P('GF-AUTO-0', 'automated approval is off (no gf.approval.auto in the project config); a human approves this slice')] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { policy: null, problems: [P('GF-AUTO-0', 'gf.approval.auto is not an object')] };
  const out = [];
  if (raw.enabled !== true) out.push(P('GF-AUTO-0', 'gf.approval.auto.enabled is not true; a human approves this slice'));
  for (const k of BOUNDS) if (!Number.isInteger(raw[k]) || raw[k] < 1) out.push(P('GF-AUTO-0', `gf.approval.auto.${k} must be a positive integer (found ${JSON.stringify(raw[k])}); without every bound there is no budget`));
  const extra = Object.keys(raw).filter((k) => k !== 'enabled' && !BOUNDS.includes(k));
  if (extra.length) out.push(P('GF-AUTO-0', `gf.approval.auto has unknown keys: ${extra.join(', ')}`));
  if (out.length) return { policy: null, problems: out };
  return { policy: { enabled: true, maxSlices: raw.maxSlices, maxTokens: raw.maxTokens, maxWallClockMinutes: raw.maxWallClockMinutes }, problems: [] };
}

function git(root, args, encoding = 'utf8') {
  const r = spawnSync('git', ['-C', root, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function rejectionEntries(root) {
  let text = '';
  try { text = fs.readFileSync(rejections.fileOf(root), 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** The baseline: the last auto-approval or human intervention event, as { seq, rejectionsSeq } (0, 0 before any). */
function baselineOf(log, upto = Infinity) {
  let b = { seq: 0, rejectionsSeq: 0 };
  for (const e of log) {
    if (e.seq >= upto) break;
    if ((e.type === TYPE && e.actor === ACTOR) || (e.type === INTERVENTION && e.actor === 'user')) {
      b = { seq: e.seq, rejectionsSeq: Number.isInteger(e.data && e.data.rejectionsSeq) ? e.data.rejectionsSeq : b.rejectionsSeq };
    }
  }
  return b;
}

/** Tokens recorded by the closures before `upto`: { tokens } or { unmeasurable: [scope...] }. */
function tokensOf(gf, upto = Infinity) {
  let tokens = 0;
  const blind = [];
  for (const c of gf.closures.filter((x) => x.seq < upto)) {
    const a = c.accounting || {};
    if (Number.isInteger(a.start) && Number.isInteger(a.end) && a.end >= a.start) tokens += a.end - a.start;
    else blind.push(c.scope);
  }
  return blind.length ? { tokens, unmeasurable: blind } : { tokens };
}

/** Contract files in `tree` whose bytes differ from the expected (sealed or last amended) hash. */
function treeContractProblems(root, gf, tree) {
  const out = [];
  for (const [rel, expected] of Object.entries(contracts.currentHashes(gf))) {
    const blob = git(root, ['cat-file', 'blob', `${tree}:${rel}`], 'buffer');
    if (blob === null) out.push(P('GF-AUTO-3', `${rel} is missing from the closing tree ${tree.slice(0, 12)}; it was sealed at ${expected.slice(0, 12)}`));
    else if (sha256(blob) !== expected) out.push(P('GF-AUTO-3', `${rel} in the closing tree ${tree.slice(0, 12)} differs from its sealed (or last amended) hash ${expected.slice(0, 12)}: a slice that touches a sealed contract needs a human`));
  }
  return out;
}

/** Hidden-suite paths that exist inside `tree`. */
function treeHiddenProblems(root, config, tree) {
  const out = [];
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* as given */ }
  const rels = new Set();
  for (const abs of hidden.paths(root, config)) {
    for (const base of [root, realRoot]) {
      const rel = path.relative(base, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) rels.add(rel.split(path.sep).join('/'));
    }
  }
  for (const rel of rels) {
    const listed = git(root, ['ls-tree', '-r', '--name-only', tree, '--', rel]);
    if (listed === null || listed.trim()) out.push(P('GF-AUTO-3', `the closing tree ${tree.slice(0, 12)} contains the hidden-suite path ${rel}: a slice that touches the hidden suite is never approved automatically`));
  }
  return out;
}

/** Every precondition, committing nothing: { ok, problems, policy, budget, closure, rejectionsSeq }. */
function evaluate(store, config, scope, { now = Date.now() } = {}) {
  const problems = [];
  const { policy, problems: pp } = policyOf(config);
  problems.push(...pp);
  if (typeof scope !== 'string' || !scope) problems.push(P('GF-AUTO-1', 'an approval names its scope'));
  const log = store.readEvents();
  const gf = project(log);
  const approvals = log.filter((e) => e.type === TYPE && e.actor === ACTOR);
  const closure = gf.closures.find((c) => c.scope === scope) || null;

  // GF-AUTO-1: closed, not yet approved, gates green
  if (!closure) problems.push(P('GF-AUTO-1', `scope ${scope} has no gf.slice.closed: only a closed slice is approved`));
  if (approvals.some((e) => e.data && e.data.scope === scope)) problems.push(P('GF-AUTO-1', `scope ${scope} is already approved`));
  let auditOk = false;
  try {
    const r = require('./audit').run(store, config);
    auditOk = r.ok;
    if (!r.ok) problems.push(P('GF-AUTO-1', `the record's audit is not clean (${(r.errors || []).length} Greenfield error(s), ${((r.base && r.base.errors) || []).length} frozen error(s)): the gates are not green`));
  } catch (e) { problems.push(P('GF-AUTO-1', `the audit could not run: ${e && e.message ? e.message : e}`)); }

  // GF-AUTO-2: the budget (only with a valid policy)
  const init = gf.initialized;
  const wallClockMinutes = init && init.ts ? Math.max(0, (now - Date.parse(init.ts)) / 60000) : null;
  const tok = tokensOf(gf);
  const budget = policy ? { slicesUsed: approvals.length + 1, maxSlices: policy.maxSlices, tokensUsed: tok.tokens, maxTokens: policy.maxTokens, wallClockMinutes: wallClockMinutes === null ? 0 : Math.round(wallClockMinutes * 100) / 100, maxWallClockMinutes: policy.maxWallClockMinutes } : null;
  if (policy) {
    if (approvals.length >= policy.maxSlices) problems.push(P('GF-AUTO-2', `the slice budget is spent (${approvals.length} of ${policy.maxSlices} approved): a hard stop, a human approves from here`));
    if (tok.unmeasurable) problems.push(P('GF-AUTO-2', `the token budget cannot be verified: the accounting of ${tok.unmeasurable.join(', ')} is unmeasurable`));
    else if (tok.tokens > policy.maxTokens) problems.push(P('GF-AUTO-2', `the token budget is spent (${tok.tokens} recorded by the closures, max ${policy.maxTokens})`));
    if (wallClockMinutes === null) problems.push(P('GF-AUTO-2', 'the wall-clock budget cannot be verified: no gf.project.initialized time'));
    else if (wallClockMinutes > policy.maxWallClockMinutes) problems.push(P('GF-AUTO-2', `the wall-clock budget is spent (${budget.wallClockMinutes} min since init, max ${policy.maxWallClockMinutes})`));
  }

  // GF-AUTO-3: sealed contracts and hidden-suite paths
  const base = baselineOf(log);
  if (!gf.seal) problems.push(P('GF-AUTO-3', 'G1 is not sealed: there are no sealed contracts to hold the slice to'));
  else if (closure) problems.push(...treeContractProblems(store.root, gf, closure.treeHash));
  const amended = log.filter((e) => e.seq > base.seq && (e.type === 'gf.contract.amendment.requested' || e.type === 'gf.contract.amended'));
  if (amended.length) problems.push(P('GF-AUTO-3', `a contract amendment was ${amended.map((e) => `${e.type === 'gf.contract.amended' ? 'applied' : 'requested'} at seq ${e.seq}`).join(', ')} since the last approval baseline (seq ${base.seq}): a human approves a slice that touches a sealed contract`));
  if (closure) problems.push(...treeHiddenProblems(store.root, config, closure.treeHash));

  // GF-AUTO-4: the rejection log
  const v = rejections.verify(store.root);
  if (!v.ok) problems.push(P('GF-AUTO-4', `the rejection log does not verify (${v.errors.slice(0, 3).join('; ')}): the approver cannot know what was denied`));
  const entries = rejectionEntries(store.root);
  const denials = entries.filter((e) => e.seq > base.rejectionsSeq && e.action !== ACTION);
  if (denials.length) problems.push(P('GF-AUTO-4', `${denials.length} denied action(s) since the last approval baseline (${denials.slice(0, 3).map((e) => `${e.rule} by ${e.actor}`).join(', ')}${denials.length > 3 ? ', ...' : ''}): a human looks first`));

  const unique = problems.filter((p, i, a) => a.findIndex((q) => q.rule === p.rule && q.message === p.message) === i);
  return { ok: unique.length === 0, problems: unique, policy, budget, closure, auditOk, rejectionsSeq: entries.length ? entries[entries.length - 1].seq : 0 };
}

/** Approve the closed slice `scope`, or stop: every failing rule is logged and a GF_RULE error is thrown. */
function autoApprove(store, config, scope, { now = Date.now() } = {}) {
  const ev = evaluate(store, config, scope, { now });
  if (!ev.ok) {
    for (const rule of [...new Set(ev.problems.map((p) => p.rule))]) {
      try {
        rejections.record(store.root, { actor: ACTOR, action: ACTION, rule, reason: ev.problems.filter((p) => p.rule === rule).map((p) => p.message).join('\n'), data: { scope: String(scope) } });
      } catch (e) { process.stderr.write(`eccode: the rejection log could not be written: ${e.message}\n`); }
    }
    const err = ruleError(ev.problems);
    err.details.humanNeeded = true;
    throw err;
  }
  const data = {
    id: newId('aa'), scope, closureSeq: ev.closure.seq, treeHash: ev.closure.treeHash,
    policy: ev.policy, policyHash: policyHashOf(ev.policy), budget: ev.budget,
    // the approver's own refusal entries are part of what this approval acknowledges
    rejectionsSeq: ev.rejectionsSeq, checks: CHECKS,
  };
  const errors = validateSchema(SCHEMA, data);
  if (errors.length) throw ruleError(errors.map((e) => P('GF-AUTO-5', `${e.path || '/'} ${e.message}`)));
  // inside the store's lock: nothing approved the same scope or spent the last slice in between
  return store.commit(TYPE, ACTOR, data, () => {
    const again = store.readEvents().filter((e) => e.type === TYPE && e.actor === ACTOR);
    if (again.some((e) => e.data && e.data.scope === scope)) throw ruleError([P('GF-AUTO-1', `scope ${scope} was approved concurrently`)]);
    if (again.length >= ev.policy.maxSlices) throw ruleError([P('GF-AUTO-2', 'the slice budget was spent concurrently')]);
  });
}

/** GF-AUTO-5: replay every auto-approval of the record. Returns problems ([] when clean). */
function audit(store) {
  const out = [];
  const log = store.readEvents();
  const E = (seq, m) => out.push({ rule: 'GF-AUTO-5', seq, message: m });
  let n = 0;
  const seen = new Set();
  for (const e of log) {
    if (e.type !== TYPE) continue;
    const d = e.data || {};
    const label = `auto-approval ${d.id || '?'} (seq ${e.seq})`;
    if (e.actor !== ACTOR) { E(e.seq, `${label} was recorded by actor ${e.actor}; only ${ACTOR} records an auto-approval`); continue; }
    n += 1;
    for (const x of validateSchema(SCHEMA, d)) E(e.seq, `${label}: ${x.path || '/'} ${x.message}`);
    if (d.policy && d.policyHash !== policyHashOf(d.policy)) E(e.seq, `${label}: its policyHash does not match its policy`);
    if (d.policy && Number.isInteger(d.policy.maxSlices) && n > d.policy.maxSlices) E(e.seq, `${label} is approval number ${n}, beyond its policy's maxSlices ${d.policy.maxSlices} (budget exceeded)`);
    if (d.budget && d.budget.slicesUsed !== n) E(e.seq, `${label} records slicesUsed ${d.budget.slicesUsed}, but it is approval number ${n} of the record (budget accounting)`);
    if (seen.has(d.scope)) E(e.seq, `${label}: scope ${d.scope} is approved twice`);
    seen.add(d.scope);
    const before = log.filter((x) => x.seq < e.seq);
    const gf = project(before);
    const closure = gf.closures.find((c) => c.scope === d.scope);
    if (!closure) E(e.seq, `${label}: scope ${d.scope} had no gf.slice.closed before it`);
    else if (closure.treeHash !== d.treeHash || closure.seq !== d.closureSeq) E(e.seq, `${label}: its tree or closure seq is not the closure of ${d.scope}`);
    const tok = tokensOf(gf);
    if (d.policy && Number.isInteger(d.policy.maxTokens)) {
      if (tok.unmeasurable) E(e.seq, `${label}: the token budget was unverifiable at its seq (${tok.unmeasurable.join(', ')} unmeasurable)`);
      else if (tok.tokens > d.policy.maxTokens) E(e.seq, `${label}: ${tok.tokens} tokens were recorded before it, beyond maxTokens ${d.policy.maxTokens}`);
    }
    const base = baselineOf(log, e.seq);
    if (before.some((x) => x.seq > base.seq && (x.type === 'gf.contract.amendment.requested' || x.type === 'gf.contract.amended'))) E(e.seq, `${label}: a contract amendment preceded it since its baseline`);
  }
  return out;
}

module.exports = { TYPE, ACTOR, ACTION, INTERVENTION, CHECKS, SCHEMA, policyOf, policyHashOf, baselineOf, evaluate, autoApprove, audit };
