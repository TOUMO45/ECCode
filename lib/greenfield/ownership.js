'use strict';
// Glob algebra and the ownership map. Deliberately conservative: a glob is "covered" only when it is provably
// inside another, so a case the algebra cannot prove is refused, never accepted. The frozen engine's globsOverlap
// (lib/util.js) answers "may these overlap"; this module adds "is this inside that" and the map itself.
//
// The ownership map is the sealed breakdown's groups, `{ groups: { name: { roles, globs, denyGlobs } } }`, plus the
// reviewer amendments in log order (the "effective" map). Everything here is pure: reading the sealed bytes and
// validating amendments against the record is ownership-ops.js.
const path = require('path');
const { globsOverlap, matchesAny } = require('../util');

/** Paths that belong to one group whatever a breakdown says: contracts and mocks to api, acceptance tests to test. */
const RESERVED = [
  { glob: 'contracts/**', group: 'api' },
  { glob: 'mocks/**', group: 'api' },
  { glob: 'tests/acceptance/**', group: 'test' },
];

const strs = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');

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

/** An ownership glob: a non-empty, trimmed, relative, forward-slash pattern with no `.` or `..` segment. */
function validGlob(g) {
  if (typeof g !== 'string' || g === '' || g !== g.trim()) return false;
  if (g.startsWith('/') || g.includes('\\') || g.includes('\0') || /^[A-Za-z]:/.test(g)) return false;
  return !g.split('/').some((seg) => seg === '..' || seg === '.');
}

/** A project-relative path in normal form, or null when it is not one (absolute, outside the root, empty, backslash). */
function normalizePath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/')) return null;
  const n = path.posix.normalize(rel);
  if (n === '.' || n === '..' || n.startsWith('../') || path.posix.isAbsolute(n)) return null;
  return n;
}

/** The map a breakdown declares. */
function mapOf(breakdown) {
  const groups = {};
  for (const g of breakdown && Array.isArray(breakdown.groups) ? breakdown.groups : []) {
    if (g && typeof g === 'object' && typeof g.name === 'string') groups[g.name] = { roles: strs(g.roles), globs: strs(g.globs), denyGlobs: strs(g.denyGlobs) };
  }
  return { groups };
}

/** The base map with each amendment's `to` replacing that group's globs, in the order given. */
function effectiveMap(base, amendments) {
  const groups = {};
  for (const [name, g] of Object.entries(base.groups)) groups[name] = { roles: [...g.roles], globs: [...g.globs], denyGlobs: [...g.denyGlobs] };
  for (const a of amendments || []) if (a && groups[a.group]) groups[a.group].globs = strs(a.to);
  return { groups };
}

/** The map in force just before the event at `seq`: only amendments recorded earlier apply. */
function mapAt(base, amendments, seq) {
  return effectiveMap(base, (amendments || []).filter((a) => a.seq < seq));
}

/** The group a path belongs to: its globs match and its denied globs do not; null for an unowned or foreign path. */
function ownerOfPath(map, rel) {
  const n = normalizePath(rel);
  if (n === null) return null;
  for (const [name, g] of Object.entries(map.groups)) if (matchesAny(n, g.globs) && !matchesAny(n, g.denyGlobs)) return name;
  return null;
}

/** The group a glob provably lies inside (and does not touch the group's denied globs); null when none. */
function ownerOfGlob(map, glob) {
  const n = normalizePath(glob);
  if (n === null) return null;
  for (const [name, g] of Object.entries(map.groups)) if (covered(n, g.globs) && !globsOverlap([n], g.denyGlobs)) return name;
  return null;
}

/** The group a role belongs to in this map, or null. */
function groupOfRole(map, role) {
  for (const [name, g] of Object.entries(map.groups)) if (g.roles.includes(role)) return name;
  return null;
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

/** The reserved paths belong to their groups. Groups are `{ name, globs }`. */
function reservedProblems(groups) {
  const out = [];
  for (const r of RESERVED) {
    for (const g of groups) {
      if (g.name !== r.group && globsOverlap(g.globs, [r.glob])) out.push({ group: g.name, message: `group ${g.name} may not own ${r.glob}: it belongs to ${r.group}` });
    }
    const owner = groups.find((g) => g.name === r.group);
    if (!owner || !covered(r.glob, owner.globs)) out.push({ group: null, message: `group ${r.group} must own ${r.glob}` });
  }
  return out;
}

/** Every problem of a whole map (disjointness and the reserved paths), as strings. */
function mapProblems(map) {
  const groups = Object.entries(map.groups).map(([name, g]) => ({ name, globs: g.globs, denyGlobs: g.denyGlobs }));
  return [...disjointProblems(groups), ...reservedProblems(groups).map((p) => p.message)];
}

module.exports = { RESERVED, covered, validGlob, normalizePath, mapOf, effectiveMap, mapAt, ownerOfPath, ownerOfGlob, groupOfRole, disjointProblems, reservedProblems, mapProblems };
