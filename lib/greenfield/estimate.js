'use strict';
// A revised estimate is recorded BESIDE the registered original and never over it: the original is the
// prediction that is scored (GF-EST-1).
const { newId } = require('../util');
const events = require('./events');
const wrap = require('./wrap');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const REVISERS = ['orchestrator', 'delivery-lead'];

function revise(store, config, actor, { reason, groups } = {}) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
  const P = [];
  const gf = project(store.readEvents());
  if (!gf.estimate.original) P.push({ rule: 'GF-EST-1', message: 'no estimate is registered yet; approving the plan gate registers it' });
  if (!REVISERS.includes(actor)) P.push({ rule: 'GF-EST-1', message: `${actor} may not revise the estimate (${REVISERS.join(', ')} may)` });
  const data = { id: newId('est'), of: gf.estimate.original ? gf.estimate.original.id : 'none', reason, groups };
  for (const e of events.validate('gf.estimate.revised', data)) P.push({ rule: 'GF-EST-1', message: e });
  if (P.length) throw ruleError(P);
  return events.commit(store, 'gf.estimate.revised', actor, data).event.data;
}

module.exports = { revise };
