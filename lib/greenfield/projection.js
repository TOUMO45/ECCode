'use strict';
// GF state by replay of the event log. Pure: the same events give a deep-equal result, nothing is written, and
// the frozen reducer and state.json are never involved. Events that are unknown or fail their schema are
// listed (audit reports them) and never merged into the state; the first valid init, estimate and seal win and
// later duplicates are kept apart so an audit can name them.
const events = require('./events');

function project(log) {
  const gf = {
    initialized: null,
    stackProfile: null,
    registrations: [],
    estimate: { original: null, revisions: [] },
    seal: null,
    requests: [],
    amendments: [],
    ownershipAmendments: [],
    configPins: [],
    dispatches: [],
    reviews: [],
    resolutions: [],
    batteries: [],
    closures: [],
    acceptances: [],
    isolationChecks: [],
    groupCommits: [],
    merges: [],
    depsInstalls: [],
    messages: [],
    extraInits: [],
    extraSeals: [],
    extraEstimates: [],
    unknown: [],
    invalid: [],
  };
  for (const ev of log || []) {
    if (!events.isGfType(ev.type)) continue;
    if (!events.TYPES[ev.type]) { gf.unknown.push({ seq: ev.seq, type: ev.type }); continue; }
    const errors = events.validate(ev.type, ev.data);
    if (errors.length) { gf.invalid.push({ seq: ev.seq, type: ev.type, errors }); continue; }
    const entry = { seq: ev.seq, ts: ev.ts, actor: ev.actor, ...ev.data };
    switch (ev.type) {
      case 'gf.project.initialized':
        if (gf.initialized) gf.extraInits.push(entry); else { gf.initialized = entry; gf.stackProfile = entry.stackProfile; }
        break;
      case 'gf.artifact.registered': gf.registrations.push(entry); break;
      case 'gf.estimate.registered':
        if (gf.estimate.original) gf.extraEstimates.push(entry); else gf.estimate.original = entry;
        break;
      case 'gf.estimate.revised': gf.estimate.revisions.push(entry); break;
      case 'gf.g1.sealed':
        if (gf.seal) gf.extraSeals.push(entry); else gf.seal = entry;
        break;
      case 'gf.message': gf.messages.push(entry); break;
      case 'gf.contract.amendment.requested': gf.requests.push(entry); break;
      case 'gf.contract.amended': gf.amendments.push(entry); break;
      case 'gf.ownership.amended': gf.ownershipAmendments.push(entry); break;
      case 'gf.config.pinned': gf.configPins.push(entry); break;
      case 'gf.dispatch.recorded': gf.dispatches.push(entry); break;
      case 'gf.review.recorded': gf.reviews.push(entry); break;
      case 'gf.finding.resolved': gf.resolutions.push(entry); break;
      case 'gf.battery.recorded': gf.batteries.push(entry); break;
      case 'gf.slice.closed': gf.closures.push(entry); break;
      case 'gf.slice.accepted': gf.acceptances.push(entry); break;
      case 'gf.isolation.checked': gf.isolationChecks.push(entry); break;
      case 'gf.group.committed': gf.groupCommits.push(entry); break;
      case 'gf.groups.merged': gf.merges.push(entry); break;
      case 'gf.deps.installed': gf.depsInstalls.push(entry); break;
      default: break;
    }
  }
  return gf;
}

module.exports = { project };
