'use strict';
// Stage 6, the estimates: GF-EST-1. Agent predictions registered before work, labelled uncalibrated.
const { problem, shape, isObj, arr } = require('./common');

function validate(est, ctx = {}) {
  const out = shape('GF-EST-1', 'estimates', est, 'estimates.json');
  if (!isObj(est) || !isObj(est.groups)) return out;
  const P = (p, m) => out.push(problem('GF-EST-1', p, m));
  for (const [g, e] of Object.entries(est.groups)) {
    if (!isObj(e)) continue;
    for (const k of ['minutes', 'tokens']) if (isObj(e[k]) && e[k].low > e[k].high) P(`/groups/${g}/${k}`, `${g} ${k}: low ${e[k].low} is above high ${e[k].high}`);
  }
  const bd = ctx.docs && ctx.docs.breakdown;
  if (isObj(bd)) {
    const counts = {};
    for (const t of arr(bd.tasks).filter(isObj)) counts[t.group] = (counts[t.group] || 0) + 1;
    for (const [g, n] of Object.entries(counts)) {
      if (!est.groups[g]) P('/groups', `group ${g} has ${n} task(s) in the breakdown and no estimate`);
      else if (isObj(est.groups[g]) && est.groups[g].tasks !== n) P(`/groups/${g}`, `${g} estimates ${est.groups[g].tasks} task(s) but the breakdown has ${n}`);
    }
    for (const g of Object.keys(est.groups)) if (!counts[g]) P(`/groups/${g}`, `an estimate for ${g}, which has no task in the breakdown`);
  }
  return out;
}

module.exports = { validate };
