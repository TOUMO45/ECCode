'use strict';
// Production guards (Phase 3, Part B) and their routing (Part F). Which
// guards a work item needs is decided by what the change reaches (impact and
// surfaces) and recorded as guard.routing; delivery and the last gate refuse
// a required guard that has not run on the current tree, a blocking finding
// nobody waived, a failed proof or probe. quick skips every guard.
const path = require('path');
const compat = require('../compat');
const lean = require('../lean');
const { EccodeError, newId, exists } = require('../util');
const worktree = require('../worktree');
const common = require('./common');

const GUARDS = ['migration', 'api', 'perf', 'race', 'security', 'release'];

function modules() {
  return {
    migration: require('./migration'),
    api: require('./api'),
    perf: require('./perf'),
    race: require('./race'),
    release: require('./release'),
    security: exists(path.join(__dirname, '..', 'security.js')) ? require('../security') : null,
  };
}

/** The guards a change needs, with the reason for each. */
function requiredFor(root, state) {
  const w = state.work;
  if (!w) return { required: [], reasons: {}, changed: [], surfaces: [] };
  const changed = worktree.changedSince(root, w.baseCommit);
  const reasons = {};
  if (w.track === 'quick') return { required: [], reasons: { none: 'the quick track skips every guard' }, changed, surfaces: [] };
  const bcfg = common.behaviorConfig(root);
  let surfaces = [];
  try { surfaces = require('../behavior').surfacesOf(root, state).surfaces; } catch { surfaces = []; }
  const http = surfaces.filter((s) => s.kind === 'http');
  const fns = surfaces.filter((s) => s.kind === 'function');
  const migrations = changed.filter((f) => compat.MIGRATION_FILE.test(f));
  if (migrations.length) reasons.migration = `migration file(s) changed: ${migrations.slice(0, 5).join(', ')}`;
  const py = changed.filter((f) => f.endsWith('.py') && !lean.TEST.test(f));
  // Python/FastAPI first: the OpenAPI diff needs a configured app, the signature diff changed Python files.
  if ((bcfg.app && http.length) || py.length) reasons.api = `${http.length} HTTP route(s) reached${bcfg.app ? '' : ' (signatures only: no app configured)'}; ${py.length} Python file(s) changed`;
  if (bcfg.app && (http.length || (common.guardsConfig(root).perf || {}).probes)) reasons.perf = `${http.length} HTTP route(s) reached; the app is configured for probes`;
  const mods = modules();
  if (mods.race.required(root, state, changed)) reasons.race = 'the change touches the configured watch paths of the race operations';
  // Security probes run against a configured FastAPI app (Python/FastAPI first); without one they cannot run, so they are not required (the limitation is reported).
  if (bcfg.app && mods.security && mods.security.required(root, state, changed, surfaces)) reasons.security = mods.security.reason(root, state, changed, surfaces);
  if (mods.release.TRACKS.has(w.track)) reasons.release = `${w.track} track`;
  return { required: GUARDS.filter((g) => reasons[g]), reasons, changed, surfaces };
}

function route(store, config, actor) {
  const state = store.state();
  common.assertActive(state);
  const r = requiredFor(store.root, state);
  const data = { id: newId('gr'), required: r.required, reasons: r.reasons, changedFiles: r.changed.slice(0, 200), surfaces: r.surfaces.slice(0, 100), treeFingerprint: common.fingerprint(store.root, state) };
  return store.commit('guard.routing', actor, data, (s) => common.assertActive(s)).event.data;
}

/** A reviewer waives one finding of one result, with a reason. */
function waive(store, config, actor, { guard, result, finding, reason } = {}) {
  const reviewers = [...new Set([...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];
  if (!reviewers.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not waive a guard finding; reviewers: ${reviewers.join(', ')}`);
  if (!GUARDS.includes(guard)) throw new EccodeError('INVALID_INPUT', `guard must be one of ${GUARDS.join(', ')}`);
  if (typeof result !== 'string' || !result) throw new EccodeError('INVALID_INPUT', 'result is the id of the guard result the finding belongs to');
  if (typeof finding !== 'string' || !finding) throw new EccodeError('INVALID_INPUT', 'finding is the finding id (migration), "<kind>:<target>" (api), the probe name (perf) or the operation name (race)');
  if (typeof reason !== 'string' || reason.trim().length < 15) throw new EccodeError('INVALID_INPUT', 'reason is required (>= 15 chars): why this finding is acceptable in production');
  const data = { id: newId('gw'), guard, result, finding, reason: reason.trim() };
  return store.commit('guard.waiver', actor, data, (s) => {
    common.assertActive(s);
    const known = guard === 'migration' ? s.guards.migration.analyses : guard === 'security' ? Object.values(s.guards.security || {}).flat() : s.guards[guard] || [];
    if (!known.some((x) => x.id === result)) throw new EccodeError('NOT_FOUND', `No ${guard} result ${result}`);
  }).event.data;
}

/** The problems that block the last gate and delivery: required guards not run on the current tree, or failed and not waived. */
function deliveryProblems(state, root) {
  if (!state.work || !state.guards || state.work.track === 'quick' || !root) return [];
  const fp = common.fingerprint(root, state);
  const live = requiredFor(root, state);
  const problems = [];
  const routing = state.guards.routing;
  if (!routing) {
    if (!live.required.length) return [];
    return [`guards: no guard routing recorded and the change needs ${live.required.join(', ')} (eccode guard route --actor <owner>)`];
  }
  // The routing is re-derived from the tree at every check (so a change after the routing cannot lose a guard); each result carries its own tree fingerprint.
  const required = [...new Set([...routing.required, ...live.required])];
  const mods = modules();
  for (const g of required) {
    if (g === 'release') { problems.push(...mods.release.deliveryProblems(state)); continue; }
    if (g === 'security') { if (mods.security) problems.push(...mods.security.deliveryProblems(state, root)); continue; }
    problems.push(...mods[g].deliveryProblems(state, root));
  }
  return problems;
}

function reportLines(state) {
  const g = state.guards;
  if (!g) return [];
  const lines = [];
  if (g.routing) lines.push('## Production guards', '', `Routing ${g.routing.id}: ${g.routing.required.length ? g.routing.required.map((r) => `${r} (${g.routing.reasons[r]})`).join('; ') : 'none required'}.`, '');
  const mods = modules();
  for (const m of ['migration', 'api', 'perf', 'race', 'release']) lines.push(...mods[m].reportLines(state));
  if (mods.security) lines.push(...mods.security.reportLines(state));
  if (g.waivers.length) lines.push('**Waived by reviewers:** ' + g.waivers.map((w) => `${w.guard} ${w.result} ${w.finding} by ${w.by} (${w.reason})`).join('; '), '');
  return lines;
}

function show(state) {
  const g = state.guards;
  const out = [];
  out.push(g.routing ? `Routing ${g.routing.id}: ${g.routing.required.join(', ') || 'none'}` : 'Routing: not recorded (eccode guard route)');
  for (const a of g.migration.analyses) out.push(`Migration analysis ${a.id}: ${a.findings.length} finding(s), ${a.blocking} blocking`);
  for (const p of g.migration.proofs) out.push(`Rollback proof ${p.id}: ${p.roundTrip ? 'round-trips' : 'FAILED'}`);
  for (const d of g.api) out.push(`API diff ${d.id}: ${d.classification} (${d.breaking.length} breaking, ${d.additive.length} additive)`);
  for (const r of g.perf) out.push(`Perf ${r.id}: ${r.regressions} regression(s), ${r.nPlusOnes} N+1`);
  for (const r of g.race) out.push(`Race ${r.id}: ${r.failed} operation(s) broken`);
  for (const p of g.release) out.push(`Release plan ${p.id}: ${p.strategy}`);
  for (const w of g.waivers) out.push(`Waiver ${w.id}: ${w.guard} ${w.result} ${w.finding} (${w.reason})`);
  return out.join('\n');
}

module.exports = { GUARDS, requiredFor, route, waive, deliveryProblems, reportLines, show, modules };
