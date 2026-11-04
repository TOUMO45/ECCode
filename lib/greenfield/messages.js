'use strict';
// gf.message: the only channel between groups. A message is a hash-chained event from the sender's own group.
// (The orchestrator's dispatch prompt remains an out-of-band channel the engine cannot read: L-GF-4.)
const { newId } = require('../util');
const C = require('./constants');
const events = require('./events');
const wrap = require('./wrap');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const GROUP_NAMES = new Set([...Object.keys(C.GROUPS), 'orchestrator']);
const MAX_BODY_BYTES = 4096;

function requireGf(store) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
}

function send(store, config, actor, input = {}) {
  requireGf(store);
  const { to, kind, subject, body, refs, inReplyTo } = input;
  const P = [];
  const M1 = (message) => P.push({ rule: 'GF-MSG-1', message });
  const from = C.groupOf(actor);
  if (!from) M1(`${actor} belongs to no group and cannot send messages`);
  if (!Array.isArray(to) || to.length === 0) M1('a message needs at least one recipient group');
  else for (const t of to) if (!GROUP_NAMES.has(t)) M1(`unknown recipient group ${t} (groups: ${[...GROUP_NAMES].join(', ')})`);
  if (!C.MESSAGE_KINDS.includes(kind)) M1(`unknown message kind ${kind} (kinds: ${C.MESSAGE_KINDS.join(', ')})`);
  if (kind === 'amendment-request' && !(Array.isArray(to) && to.includes('api'))) P.push({ rule: 'GF-MSG-2', message: 'an amendment request is addressed to the api group, which owns the contracts' });
  if (typeof body !== 'string' || body.length === 0) M1('a message needs a body');
  else if (Buffer.byteLength(body) > MAX_BODY_BYTES) M1(`the body is ${Buffer.byteLength(body)} bytes; the limit is ${MAX_BODY_BYTES}`);
  if (typeof subject !== 'string' || subject.length < 3 || subject.length > 200) M1('the subject is 3 to 200 characters');
  if (inReplyTo !== undefined && !project(store.readEvents()).messages.some((m) => m.id === inReplyTo)) M1(`inReplyTo ${inReplyTo} is not a recorded message`);
  if (P.length) throw ruleError(P);
  const data = { id: newId('msg'), from, to, kind, subject, body, ...(refs ? { refs } : {}), ...(inReplyTo ? { inReplyTo } : {}) };
  return events.commit(store, 'gf.message', actor, data).event.data;
}

/** Recorded messages, optionally filtered by sender group, recipient group and kind. */
function list(store, { from, to, kind } = {}) {
  return project(store.readEvents()).messages.filter((m) => (!from || m.from === from) && (!to || m.to.includes(to)) && (!kind || m.kind === kind));
}

module.exports = { send, list, MAX_BODY_BYTES };
