'use strict';
// Glob algebra for ownership maps. Deliberately conservative: a glob is "covered" only when it is provably inside
// another, so a case the algebra cannot prove is refused, never accepted. The frozen engine's globsOverlap
// (lib/util.js) answers "may these overlap"; this module adds "is this inside that".
const { globsOverlap } = require('../util');

/** True when `glob` lies provably inside one of `globs`. A glob containing `..` is never covered. */
function covered(glob, globs) {
  if (typeof glob !== 'string' || glob.includes('..')) return false;
  for (const g of globs || []) {
    if (typeof g !== 'string') continue;
    if (g === glob || g === '**') return true;
    if (g.endsWith('/**') && glob.startsWith(g.slice(0, -2))) return true;
  }
  return false;
}

/**
 * Problems that keep a set of groups from owning disjoint paths. Groups are `{ name, globs, denyGlobs }`.
 * Two overlapping globs are fine only when one lies inside the other and the OUTER group denies the inner one.
 */
function disjointProblems(groups) {
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const x = groups[i];
      const y = groups[j];
      for (const gx of x.globs) {
        for (const gy of y.globs) {
          if (!globsOverlap([gx], [gy])) continue;
          if (gx === gy) out.push(`groups ${x.name} and ${y.name} both own ${gx}`);
          else if (covered(gx, [gy])) { if (!covered(gx, y.denyGlobs || [])) out.push(`${x.name} owns ${gx}, inside ${y.name}'s ${gy}, and ${y.name} does not deny it`); }
          else if (covered(gy, [gx])) { if (!covered(gy, x.denyGlobs || [])) out.push(`${y.name} owns ${gy}, inside ${x.name}'s ${gx}, and ${x.name} does not deny it`); }
          else out.push(`${x.name}'s ${gx} and ${y.name}'s ${gy} overlap and neither contains the other`);
        }
      }
    }
  }
  return out;
}

module.exports = { covered, disjointProblems };
