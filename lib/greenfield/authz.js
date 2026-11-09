'use strict';
// S3.1 I5 (L-GF-86): the action->role matrix of the engine's managed actions, default deny (GF-ROLE-1). wrap.js checks
// it before any other rule; a refusal is logged once by the rejection log (rejections.js).
//
// Rows are derived from what the frozen engine and the Greenfield-Senior layer already intend, so nothing an existing
// flow relies on is tightened, except the one gap L-GF-86 showed:
// - gate.start:<kind>: the orchestrator and the kind's authors (lib/gates.js startGate), EXCEPT phase gates, which only
//   the orchestrator starts (a phase gate opens the build for every group; a group role starting one was accepted).
// - gate.submit:<kind>: the kind's authors (gates.submit).
// - gate.review:<kind>: the kind's reviewers (gates.checkReview).
// - seal: the orchestrator (eccode-gf seal, gf_seal) and the engine itself (the plan approval seals G1).
// - task.claim, task.complete: the roles that can own a task: the phase authors and the group roles (C.GROUPS).
// An action with no row is refused for every role.
const C = require('./constants');

const ORCHESTRATOR = 'orchestrator';
const ENGINE = 'gf-engine';
const RULE = 'GF-ROLE-1';
const ACTIONS = ['gate.start', 'gate.submit', 'gate.review', 'seal', 'task.claim', 'task.complete'];

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const kindOf = (gate) => (String(gate).startsWith('phase:') ? 'phase' : String(gate));
const groupRoles = () => Object.values(C.GROUPS).flat();

/** The matrix for a project configuration: { '<action>[:<gate kind>]': [allowed roles] }. */
function matrix(config) {
  const roles = (config && config.roles) || {};
  const m = {};
  for (const [kind, r] of Object.entries(roles)) {
    if (!r || !Array.isArray(r.authors)) continue;
    m[`gate.start:${kind}`] = kind === 'phase' ? [ORCHESTRATOR] : uniq([ORCHESTRATOR, ...r.authors]);
    m[`gate.submit:${kind}`] = uniq([...r.authors]);
    m[`gate.review:${kind}`] = uniq([...(r.reviewers || [])]);
  }
  m.seal = [ORCHESTRATOR, ENGINE];
  const owners = uniq([...((roles.phase && roles.phase.authors) || []), ...groupRoles()]);
  m['task.claim'] = owners;
  m['task.complete'] = owners;
  return m;
}

/** Every role the engine knows in this configuration, plus the orchestrator and the user. */
function knownRoles(config) {
  const roles = (config && config.roles) || {};
  return uniq([ORCHESTRATOR, 'user', ...Object.values(roles).flatMap((r) => [...((r && r.authors) || []), ...((r && r.reviewers) || [])]), ...groupRoles()]);
}

/** GF-ROLE-1 problems for `actor` doing `action` (on `gate`, for the gate actions); [] when the matrix allows it. */
function problems(config, action, actor, { gate } = {}) {
  const row = gate !== undefined && gate !== null && String(action).startsWith('gate.') ? `${action}:${kindOf(gate)}` : action;
  const allowed = matrix(config)[row];
  if (allowed && allowed.includes(actor)) return [];
  const what = gate ? `${action} ${gate}` : action;
  return [{ rule: RULE, message: allowed ? `${actor} may not ${what}: the action->role matrix allows only ${allowed.join(', ')} (default deny)` : `${what} has no row in the action->role matrix, so no role may do it (default deny)` }];
}

module.exports = { matrix, knownRoles, problems, ACTIONS, ENGINE, RULE };
