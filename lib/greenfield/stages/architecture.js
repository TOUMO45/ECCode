'use strict';
// Stage 2, the architecture: GF-ARC-1. N technology choices need N distinct recorded decisions, each over the
// alternatives the choice names (so "at least two alternatives and an ADR per choice" is checked, not claimed).
const { GROUPS } = require('../constants');
const { problem, shape, isObj, arr, dupes } = require('./common');

function validate(arch, ctx = {}) {
  const out = shape('GF-ARC-1', 'architecture', arch, 'architecture.json');
  if (!isObj(arch)) return out;
  const P = (p, m) => out.push(problem('GF-ARC-1', p, m));
  const comps = arr(arch.components).filter(isObj);
  const ids = comps.map((c) => c.id);
  for (const d of dupes(ids)) P('/components', `duplicate component id ${d}`);
  for (const c of comps) if (!Object.keys(GROUPS).includes(c.group)) P(`/components/${c.id}`, `component ${c.id} names unknown group ${c.group}`);
  for (const [i, f] of arr(arch.dataFlow).filter(isObj).entries()) {
    for (const end of [f.from, f.to]) if (!ids.includes(end) && !String(end).startsWith('external:')) P(`/dataFlow/${i}`, `dataFlow ${i} names "${end}", which is neither a component nor external:<name>`);
  }
  const design = (ctx.base && ctx.base.design) || {};
  const choices = arr(arch.techChoices).filter(isObj);
  for (const d of dupes(choices.map((c) => c.id))) P('/techChoices', `duplicate technology choice id ${d}`);
  for (const d of dupes(choices.map((c) => c.decision))) P('/techChoices', `decision ${d} is used by more than one choice: each choice needs its own recorded decision`);
  for (const c of choices) {
    const where = `/techChoices/${c.id}`;
    const alts = arr(c.alternatives).filter(isObj).map((a) => a.id);
    for (const d of dupes(alts)) P(where, `${c.id}: alternative ${d} appears twice`);
    if (alts.includes(c.chosen)) P(where, `${c.id}: the chosen option ${c.chosen} is also listed as an alternative`);
    const dec = arr(design.decisions).find((d) => d.id === c.decision);
    if (!dec) { P(where, `${c.id}: decision ${c.decision} is not a recorded design decision (eccode design alternatives, then decide)`); continue; }
    if (dec.chosen !== c.chosen) P(where, `${c.id}: chose ${c.chosen}, but decision ${dec.id} chose ${dec.chosen}`);
    const alt = arr(design.alternatives).find((a) => a.id === dec.alternatives);
    const options = alt ? arr(alt.options).map((o) => o.id) : [];
    for (const want of [c.chosen, ...alts]) if (!options.includes(want)) P(where, `${c.id}: ${want} is not among the options decision ${dec.id} compared (${options.join(', ') || 'none'})`);
    if (!arr(design.adrs).some((a) => a.decision === dec.id)) P(where, `${c.id}: decision ${dec.id} has no rendered ADR (eccode design adr)`);
  }
  return out;
}

module.exports = { validate };
