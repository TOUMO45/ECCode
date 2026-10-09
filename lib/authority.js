'use strict';
// The human channel. The engine reserves some decisions for the user: reopening an escalated or
// approved gate, resetting an escalated task, a rework past the cap, accepting a risk, accepting a
// rolled-back log, adopting a workflow change, a decision recorded as the user's own. `--actor user`
// is only a string, so a person has to stand behind it in one of two ways:
//   1. at a terminal: bin/eccode.js shows what `--actor user` is about to record and waits for a
//      person to type "yes" on a TTY (ECCODE_TEST=1 is the test suite's switch, never an agent's);
//   2. by a bounded delegation the user granted in advance (`eccode delegate grant`): one action, one
//      target (or any target of that action), a number of uses, an expiry, a reason, recorded in the
//      hash-chained log. The agent then acts with `--delegation <id>`: the use is spent first
//      (`delegation.used`), and the action's own event carries { onBehalfOf: 'user', delegation }.
// Library callers (tests, in-process tools) still pass actor 'user' directly: the terminal check is
// the CLI's job; this module decides who the actor is and what a delegation allows.

const { EccodeError, newId, isId, now, own } = require('./util');

const USER = 'user';
const DEFAULT_USES = 1;
const DEFAULT_EXPIRES_MINUTES = 240;
const MAX_USES = 100;
const MAX_EXPIRES_MINUTES = 7 * 24 * 60;
const ROLE = /^[a-z][a-z0-9-]{1,40}$/;
const TARGET = /^[A-Za-z0-9_.:-]{1,80}$/;

/** The reserved actions: what the user would run, and whether a delegation names one target. */
const ACTIONS = {
  'gate.reopen': { what: (t) => `Reopening gate ${t}`, user: (t) => `eccode gate reopen ${t} --actor user --resolution "<decision>" [--waive all|F1,F2]`, targeted: true },
  'task.reset': { what: (t) => `Resetting escalated task ${t}`, user: (t) => `eccode task reset ${t} --actor user --reason "<decision>"`, targeted: true },
  'rework.open': { what: (t) => `Opening ${t} past limits.maxReworks`, user: () => 'eccode rework open --actor user --reason "<what is wrong and how it was found>" --files <glob> --owner <role>', targeted: true },
  'risk.accept': { what: (t) => `Accepting risk ${t}`, user: (t) => `eccode risk update --id ${t} --status accepted --actor user`, targeted: true },
  'rebuild.force': { what: () => 'Accepting a rolled-back event log', user: () => 'eccode rebuild --force --actor user', targeted: false },
  'improve.adopt': { what: (t) => `Adopting workflow change ${t}`, user: (t) => `eccode improve adopt ${t} --actor user`, targeted: true },
  'decision.record': { what: () => "Recording a decision as the user's", user: () => 'eccode decision add --title "<t>" --decision "<d>" --rationale "<r>" --actor user', targeted: false },
  // Reserved for a later feature (budget and limit changes); the name is accepted so grants can be prepared.
  'limits.raise': { what: (t) => `Raising limit ${t || ''}`.trim(), user: (t) => `(not a CLI command yet) raise limits.${t || '<name>'} in .eccode/config.json`, targeted: true },
};

function toRole(actor) {
  return actor !== USER && ROLE.test(String(actor)) ? actor : 'orchestrator';
}

function grantCommand(action, target, to) {
  return `eccode delegate grant --actor user --to ${to} --action ${action}${target ? ` --target ${target}` : ''} --reason "<what the user decided>"`;
}

/** The two ways forward, quoted in every USER_AUTH_REQUIRED refusal so the orchestrator can show them to the user. */
function waysForward(action, target, actor) {
  const to = toRole(actor);
  return `Either the user runs this in a terminal: ${ACTIONS[action].user(target)}; or the user grants a delegation: ${grantCommand(action, target, to)}, and ${to} reruns the command with --actor ${to} --delegation <id>.`;
}

function refuse(action, target, actor, reasons = []) {
  const what = ACTIONS[action].what(target);
  const message = `${reasons.length ? `${reasons.join('. ')}. ` : ''}${what} is reserved for the user; ${actor || 'an unnamed caller'} cannot do it alone. ${waysForward(action, target, actor)}`;
  throw new EccodeError('USER_AUTH_REQUIRED', message, { action, target, userCommand: ACTIONS[action].user(target), grantCommand: grantCommand(action, target, toRole(actor)) });
}

/** Status as of `at`: the snapshot keeps active|exhausted|revoked; expiry is a matter of the clock. */
function statusOf(d, at = now()) {
  return d.status === 'active' && Date.parse(d.expiresAt) <= at.getTime() ? 'expired' : d.status;
}

/** Why delegation `d` does not let `actor` do `action` on `target` now (null = it does). */
function unusableReason(d, actor, action, target) {
  if (d.to !== actor) return `was granted to ${d.to}, not ${actor}`;
  if (d.action !== action) return `allows ${d.action}, not ${action}`;
  if (d.target !== null && d.target !== target) return `is for target ${d.target}, not ${target || '(none)'}`;
  const status = statusOf(d);
  if (status === 'revoked') return `is revoked (${d.revoked ? d.revoked.reason : 'no reason recorded'})`;
  if (status === 'expired') return `expired at ${d.expiresAt}`;
  if (status === 'exhausted') return `is exhausted (${d.used} of ${d.uses} uses spent)`;
  return null;
}

/**
 * Establish that `actor` may perform the reserved `action` on `target`. The user may; anyone else
 * needs a delegation that is theirs, for this action and target, active, not expired, with uses left.
 * Returns the data the action's event must carry: {} for the user, { onBehalfOf: 'user', delegation }
 * when a delegation is used. Given a store, using a delegation commits `delegation.used` first (the
 * reducer counts it), so a process killed afterwards can never have acted without spending; given a
 * state, the check is pure (for callers that cannot commit yet, e.g. a record being rebuilt).
 * `reasons` prefixes the refusal with the caller's context (why the user is needed this time).
 */
function assertUserAuthority(storeOrState, actor, action, target, { delegation, reasons = [] } = {}) {
  if (!ACTIONS[action]) throw new EccodeError('INVALID_INPUT', `Unknown reserved action ${JSON.stringify(action)}`);
  const t = target === undefined || target === null ? null : String(target);
  if (actor === USER) {
    if (delegation) throw new EccodeError('INVALID_INPUT', "The user acts directly; --delegation is for an agent acting on the user's behalf");
    return {};
  }
  if (!delegation) refuse(action, t, actor, reasons);
  if (!isId('dlg', delegation)) throw new EccodeError('INVALID_INPUT', `--delegation expects a delegation id (dlg-…), got ${JSON.stringify(delegation)}`);
  const check = (state) => {
    const d = own(state.delegations || {}, delegation);
    if (!d) refuse(action, t, actor, [...reasons, `No delegation ${delegation} in this record (eccode delegate list)`]);
    const why = unusableReason(d, actor, action, t);
    if (why) refuse(action, t, actor, [...reasons, `Delegation ${delegation} ${why}`]);
  };
  if (typeof storeOrState.commit === 'function') storeOrState.commit('delegation.used', actor, { id: delegation, action, target: t, by: actor }, check);
  else check(storeOrState);
  return { onBehalfOf: USER, delegation };
}

/**
 * Commit an event for an action the engine reserves for the user. `check(state)` holds the action's
 * own rules and returns its extra event data; `needsUser(state)` says whether THIS call needs the user
 * (true, or a reason text for the refusal) or not (false: resetting a done task, a rework under the
 * cap). `target` may be a function of the state (a rework's id is not known until it is opened).
 *
 * Order: the action's own rules run first on the current state, so a refused action never spends a
 * delegation; then the user's authority is established (a delegation is spent, recorded first); then
 * the event is committed under the lock, re-validated, carrying the authority data when a delegation
 * was used (and nothing new otherwise, so older logs replay unchanged).
 */
function commitReserved(store, { type, actor, data, action, target, delegation, needsUser = () => true, check = () => undefined }) {
  const preview = store.state();
  check(preview);
  const targetOf = (state) => (typeof target === 'function' ? target(state) : target);
  const why = needsUser(preview);
  const authority = why ? assertUserAuthority(store, actor, action, targetOf(preview), { delegation, reasons: typeof why === 'string' ? [why] : [] }) : {};
  return store.commit(type, actor, data, (state) => {
    const extra = check(state) || {};
    const need = needsUser(state);
    // The record moved between the preview and the lock (e.g. the task escalated meanwhile): the
    // authority established above does not cover this state, so the call is refused, nothing spent twice.
    if (need && actor !== USER && !authority.onBehalfOf) assertUserAuthority(state, actor, action, targetOf(state), { reasons: typeof need === 'string' ? [need] : [] });
    return { ...extra, ...authority };
  });
}

/** Record a bounded delegation. Only the user grants one (the CLI confirms that at a terminal); a delegation cannot be delegated. */
function grant(store, actor, { to, action, target, uses, expires, reason } = {}) {
  if (actor !== USER) {
    throw new EccodeError('USER_AUTH_REQUIRED', `Only the user grants a delegation (eccode delegate grant --actor user, at a terminal); ${actor || 'an unnamed caller'} cannot, and a delegation cannot be delegated.`);
  }
  if (!to || !ROLE.test(String(to)) || to === USER) throw new EccodeError('INVALID_INPUT', '--to must be the role that will act on the user\'s behalf (e.g. orchestrator)');
  if (!ACTIONS[action]) throw new EccodeError('INVALID_INPUT', `--action must be one of: ${Object.keys(ACTIONS).join(', ')}`);
  const t = target === undefined || target === null || target === '' ? null : String(target);
  if (t !== null && !ACTIONS[action].targeted) throw new EccodeError('INVALID_INPUT', `${action} takes no --target`);
  if (t !== null && !TARGET.test(t)) throw new EccodeError('INVALID_INPUT', '--target must be an id (letters, digits, _ . : -)');
  const n = uses === undefined ? DEFAULT_USES : uses;
  if (!Number.isInteger(n) || n < 1 || n > MAX_USES) throw new EccodeError('INVALID_INPUT', `--uses must be a whole number from 1 to ${MAX_USES} (default ${DEFAULT_USES})`);
  const minutes = expires === undefined ? DEFAULT_EXPIRES_MINUTES : expires;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_EXPIRES_MINUTES) {
    throw new EccodeError('INVALID_INPUT', `--expires is in minutes, from 1 to ${MAX_EXPIRES_MINUTES} (7 days; default ${DEFAULT_EXPIRES_MINUTES})`);
  }
  if (!reason || String(reason).trim().length < 8) throw new EccodeError('INVALID_INPUT', 'A delegation needs a --reason of at least 8 characters: what the user decided and why');
  const id = newId('dlg');
  const expiresAt = new Date(now().getTime() + minutes * 60000).toISOString();
  const { event } = store.commit('delegation.granted', actor, { id, to, action, target: t, uses: n, expiresAt, reason: String(reason).trim() });
  return event.data;
}

function revoke(store, actor, id, reason) {
  if (actor !== USER) throw new EccodeError('USER_AUTH_REQUIRED', `Only the user revokes a delegation (eccode delegate revoke <id> --actor user, at a terminal); ${actor || 'an unnamed caller'} cannot.`);
  if (!isId('dlg', id)) throw new EccodeError('INVALID_INPUT', `Expected a delegation id (dlg-…), got ${JSON.stringify(id)}`);
  if (!reason || !String(reason).trim()) throw new EccodeError('INVALID_INPUT', 'Revoking a delegation needs a --reason');
  return store.commit('delegation.revoked', actor, { id, reason: String(reason).trim() }, (state) => {
    const d = own(state.delegations || {}, id);
    if (!d) throw new EccodeError('NOT_FOUND', `No delegation ${id} (eccode delegate list)`);
    if (d.status === 'revoked') throw new EccodeError('INVALID_TRANSITION', `Delegation ${id} is already revoked`);
  });
}

/** Every delegation with its status as of now (expired ones read as such even before any later event). */
function list(state, at = now()) {
  return Object.values(state.delegations || {}).map((d) => ({ ...d, status: statusOf(d, at) }));
}

function formatRow(d) {
  return `${d.id} [${d.status}] to=${d.to} action=${d.action} target=${d.target || 'any'} uses=${d.used}/${d.uses} expires=${d.expiresAt} — ${d.reason}`;
}

module.exports = { assertUserAuthority, commitReserved, grant, revoke, list, formatRow, statusOf, waysForward, ACTIONS, USER };
