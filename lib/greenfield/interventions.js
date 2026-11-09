'use strict';
// S4-PREREQ D-2 (plan P-4, ECCode side): human interventions in the event record, and a counter that reads the record
// alone. The taxonomy is the plan's closed one (section 6.1): approval, clarification-answer, correction, restart,
// unblock. Automated approvals (type "auto-approval", actor "auto-approver") are reported apart and never counted.
//
// Sources the counter uses:
//   1. `intervention` events (actor user only), written by `eccode-gf intervention record` for what happens outside
//      the engine (a restart, an unblock, a correction) or to describe an engine event (refSeq);
//   2. engine events recorded by the actor `user` that no intervention event references: request.clarified is a
//      clarification-answer, every other one is a human decision (approval).
const { newId } = require('../util');
const { ruleError } = require('./errors');
const rejections = require('./rejections');

const TYPE = 'intervention';
const KINDS = ['approval', 'clarification-answer', 'correction', 'restart', 'unblock'];
const CLARIFY = new Set(['request.clarified']);

/** Record one human intervention. Only the user (the guard asks the person before `--actor user` runs). */
function record(store, actor, { type, note, refSeq } = {}) {
  const problems = [];
  if (actor !== 'user') problems.push({ rule: 'GF-INT-1', message: `only the user records an intervention (this is ${actor})` });
  if (!KINDS.includes(type)) problems.push({ rule: 'GF-INT-1', message: `the intervention type must be one of ${KINDS.join(', ')} (found ${JSON.stringify(type)})` });
  if (typeof note !== 'string' || !note.trim()) problems.push({ rule: 'GF-INT-1', message: 'an intervention carries a note saying what the human did' });
  if (refSeq !== undefined && (!Number.isInteger(refSeq) || refSeq < 1)) problems.push({ rule: 'GF-INT-1', message: 'refSeq must be the seq of an event of this record' });
  if (Number.isInteger(refSeq) && !store.readEvents().some((e) => e.seq === refSeq)) problems.push({ rule: 'GF-INT-1', message: `there is no event at seq ${refSeq}` });
  if (problems.length) throw ruleError(problems);
  // the rejection-log position the human has seen: the approver's baseline moves past it
  const v = rejections.verify(store.root);
  const data = { id: newId('int'), type, note: note.trim(), rejectionsSeq: v.count, ...(refSeq ? { refSeq } : {}) };
  return store.commit(TYPE, actor, data);
}

/** Count from an event list alone: { counted: {kind: n}, total, autoApprovals, items: [...] }. */
function count(log) {
  const counted = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const items = [];
  const events = (log || []).filter((e) => e && typeof e === 'object');
  const referenced = new Set(events.filter((e) => e.type === TYPE && e.actor === 'user' && e.data && Number.isInteger(e.data.refSeq)).map((e) => e.data.refSeq));
  let autoApprovals = 0;
  const invalid = [];
  for (const e of events) {
    if (e.type === 'auto-approval') {
      if (e.actor === 'auto-approver') autoApprovals += 1;
      else invalid.push({ seq: e.seq, reason: `auto-approval by ${e.actor}, counted as a human approval` });
      if (e.actor !== 'auto-approver') { counted.approval += 1; items.push({ seq: e.seq, kind: 'approval', source: 'forged auto-approval' }); }
      continue;
    }
    if (e.type === TYPE) {
      const kind = e.data && e.data.type;
      if (e.actor !== 'user' || !KINDS.includes(kind)) { invalid.push({ seq: e.seq, reason: `intervention event with actor ${e.actor} and type ${JSON.stringify(kind)}` }); continue; }
      counted[kind] += 1;
      items.push({ seq: e.seq, kind, source: TYPE, ...(e.data.refSeq ? { refSeq: e.data.refSeq } : {}) });
      continue;
    }
    if (e.actor === 'user' && !referenced.has(e.seq)) {
      const kind = CLARIFY.has(e.type) ? 'clarification-answer' : 'approval';
      counted[kind] += 1;
      items.push({ seq: e.seq, kind, source: e.type });
    }
  }
  const total = KINDS.reduce((a, k) => a + counted[k], 0);
  return { counted, total, autoApprovals, items, invalid };
}

module.exports = { TYPE, KINDS, record, count };
