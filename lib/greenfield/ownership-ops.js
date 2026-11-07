'use strict';
// Operations on the ownership map (GF-OWN-1, GF-OWN-5): reading the sealed map back from the approved bytes,
// reviewer amendments, the check that runs before a rescope, and the audit's replay of both.
//
// The map is NOT trusted from the log: its source is the sealed breakdown.json, whose bytes must hash to what
// the seal recorded. Amendments are applied only when they are valid (a reviewer, a chain, a recorded message, a
// map that still passes the disjointness and reserved-path checks), so a forged amendment widens nothing; the
// audit reports it.
const fs = require('fs');
const path = require('path');
const tasks = require('../tasks');
const { newId, sha256 } = require('../util');
const events = require('./events');
const ownership = require('./ownership');
const wrap = require('./wrap');
const { reviewersOf } = require('./roles');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const P1 = (message) => ({ rule: 'GF-OWN-1', message });
const P5 = (message) => ({ rule: 'GF-OWN-5', message });
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function configOf(store, config) {
  return config || require('../config').loadConfig(store.root);
}

/** The sealed breakdown's map before any amendment: `{ map, problems }`; map is null when it cannot be trusted. */
function sealedBase(store, gf) {
  if (!gf.initialized) return { map: null, problems: [] };
  if (!gf.seal) return { map: null, problems: [P1('G1 is not sealed: the ownership map exists once the plan is approved and sealed')] };
  const rel = Object.keys(gf.seal.hashes).find((x) => path.posix.basename(x) === 'breakdown.json');
  if (!rel) return { map: null, problems: [P1('the seal records no breakdown.json: there is no ownership map')] };
  let bytes;
  try { bytes = fs.readFileSync(path.join(store.root, rel)); } catch { return { map: null, problems: [P1(`${rel} is missing; it was sealed at ${gf.seal.hashes[rel].slice(0, 12)}`)] }; }
  const found = sha256(bytes);
  if (found !== gf.seal.hashes[rel]) {
    return { map: null, problems: [P1(`${rel} differs from the sealed bytes (sealed ${gf.seal.hashes[rel].slice(0, 12)}, found ${found.slice(0, 12)}): the ownership map is not used until the file is restored`)] };
  }
  try { return { map: ownership.mapOf(JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''))), problems: [] }; } catch { return { map: null, problems: [P1(`${rel} is not valid JSON`)] }; }
}

/**
 * Walk the amendments in log order against the map they find. Returns the problems of the invalid ones and the map
 * that results from the valid ones; an invalid amendment is skipped (it changes nothing).
 */
function replayAmendments(base, gf, config) {
  const problems = [];
  let map = base;
  const reviewers = reviewersOf(config);
  for (const am of gf.ownershipAmendments) {
    const here = [];
    const E = (m) => here.push({ ...P5(`ownership amendment ${am.id} (seq ${am.seq}): ${m}`), seq: am.seq });
    if (!reviewers.includes(am.actor)) E(`${am.actor} is not a reviewer (reviewers: ${reviewers.join(', ')}); the map changes only by a reviewer amendment`);
    if (!map.groups[am.group]) E(`unknown group ${am.group}`);
    else {
      if (!sameList(am.from, map.groups[am.group].globs)) E(`from (${am.from.join(', ')}) is not the globs in force for ${am.group} (${map.groups[am.group].globs.join(', ')})`);
      for (const g of am.to) if (!ownership.validGlob(g)) E(`${JSON.stringify(g)} is not a valid ownership glob`);
    }
    if (!gf.messages.some((m) => m.id === am.message && m.seq < am.seq)) E(`message ${am.message} is not a recorded earlier message`);
    if (!here.length) {
      const next = ownership.effectiveMap(map, [am]);
      for (const m of ownership.mapProblems(next)) E(`the resulting map is invalid: ${m}`);
      if (!here.length) { map = next; continue; }
    }
    problems.push(...here);
  }
  return { map, problems };
}

/** The effective map: `{ map, problems }`. map is null when the sealed bytes cannot be trusted. */
function loadMap(store, config) {
  const gf = project(store.readEvents());
  const base = sealedBase(store, gf);
  if (!base.map) return { map: null, problems: base.problems };
  return { map: replayAmendments(base.map, gf, configOf(store, config)).map, problems: [] };
}

function requireGf(store) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
}

/** A reviewer records that a group's globs change, with a reason and a cited message. */
function amend(store, config, actor, input = {}) {
  requireGf(store);
  const cfg = configOf(store, config);
  const loaded = loadMap(store, cfg);
  if (!loaded.map) throw ruleError(loaded.problems);
  const { group, to, reason, message, from } = input;
  const gf = project(store.readEvents());
  const problems = [];
  const E = (m) => problems.push(P5(m));
  const reviewers = reviewersOf(cfg);
  if (!reviewers.includes(actor)) E(`${actor} is not a reviewer (reviewers: ${reviewers.join(', ')}); the map changes only by a reviewer amendment`);
  const current = loaded.map.groups[group];
  if (!current) E(`unknown group ${group} (groups: ${Object.keys(loaded.map.groups).join(', ')})`);
  if (!Array.isArray(to) || to.length === 0) E('an amendment gives at least one glob (to)');
  else for (const g of to) if (!ownership.validGlob(g)) E(`${JSON.stringify(g)} is not a valid ownership glob (relative, forward slashes, no .. or . segment)`);
  if (typeof reason !== 'string' || reason.trim().length < 30) E('the reason needs 30 characters or more: say what the group needs and why');
  if (typeof message !== 'string' || !message) E('an amendment cites a recorded message (message): the request comes through the record');
  else if (!gf.messages.some((m) => m.id === message)) E(`message ${message} is not a recorded message`);
  if (current && from !== undefined && !sameList(from, current.globs)) E(`from (${[].concat(from).join(', ')}) does not match the globs in force for ${group} (${current.globs.join(', ')}): read the map again`);
  if (current && Array.isArray(to) && to.length && to.every((g) => ownership.validGlob(g))) {
    const next = ownership.effectiveMap(loaded.map, [{ group, to }]);
    for (const m of ownership.mapProblems(next)) E(`the resulting map is invalid: ${m}`);
    for (const t of Object.values(store.state().tasks)) {
      if (!['pending', 'claimed'].includes(t.status) || !current.roles.includes(t.owner)) continue;
      for (const f of t.files) if (!ownership.covered(f, to)) E(`pending task ${t.id} owns ${f}, which the new globs of ${group} do not cover`);
    }
  }
  if (problems.length) throw ruleError(problems);
  const data = { id: newId('own'), group, from: [...current.globs], to: [...to], reason: reason.trim(), message };
  return events.commit(store, 'gf.ownership.amended', actor, data, () => {
    const now = loadMap(store, cfg).map;
    if (!now || !sameList(now.groups[group].globs, data.from)) throw ruleError([P5(`the globs of ${group} changed while this amendment was being recorded; read the map again`)]);
  });
}

/** GF-OWN-5, before a rescope: every new glob must lie inside the task owner's group. */
function rescopeProblems(store, taskId, files) {
  if (!wrap.isEnabled(store)) return [];
  const t = store.state().tasks[taskId];
  const globs = String(files || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (!t || !globs.length) return [];
  const loaded = loadMap(store);
  if (!loaded.map) return loaded.problems;
  const group = ownership.groupOfRole(loaded.map, t.owner);
  if (!group) return [P5(`task ${taskId} is owned by ${t.owner}, who is in no group`)];
  const out = [];
  for (const g of globs) {
    const n = ownership.normalizePath(g);
    if (n === null) { out.push(P5(`${g} is outside the project or not a relative path`)); continue; }
    const owner = ownership.ownerOfGlob(loaded.map, n);
    if (owner === group) continue;
    out.push(P5(owner === null
      ? `${n} is owned by no group: ask a reviewer to amend the ownership map before ${taskId} takes it`
      : `${n} belongs to ${owner}, not to ${group} (${taskId} is owned by ${t.owner})`));
  }
  return out;
}

/** The wrapped rescope: the group check first, then the frozen function. */
function rescope(store, config, taskId, actor, options = {}) {
  const problems = rescopeProblems(store, taskId, options.files);
  if (problems.length) throw ruleError(problems);
  return tasks.rescope(store, config, taskId, actor, options);
}

/** What the map says now, for show commands. */
function describe(store, config) {
  const gf = project(store.readEvents());
  const loaded = loadMap(store, config);
  return { enabled: Boolean(gf.initialized), groups: loaded.map ? loaded.map.groups : null, amendments: gf.ownershipAmendments.length, problems: loaded.problems };
}

/** The audit's GF-OWN-1 / GF-OWN-5 section: the map's bytes, every amendment, every rescope, every engine task. */
function auditProblems(store, config, log, gf, state) {
  const out = [];
  if (!gf.seal) return out;
  const base = sealedBase(store, gf);
  if (!base.map) return base.problems;
  const replay = replayAmendments(base.map, gf, config);
  out.push(...replay.problems);
  const valid = gf.ownershipAmendments.filter((am) => !replay.problems.some((p) => p.seq === am.seq));
  for (const ev of log) {
    if (ev.type !== 'task.rescoped' || !Array.isArray(ev.data.files) || !ev.data.files.length) continue;
    const map = ownership.mapAt(base.map, valid, ev.seq);
    const t = state.tasks[ev.data.task];
    const group = t && ownership.groupOfRole(map, t.owner);
    if (!t) continue;
    if (!group) { out.push({ ...P5(`task ${t.id} was rescoped at seq ${ev.seq} but ${t.owner} is in no group`), seq: ev.seq }); continue; }
    for (const f of ev.data.files) {
      const owner = ownership.ownerOfGlob(map, f);
      if (owner !== group) out.push({ ...P5(`task ${t.id} was rescoped to ${f} at seq ${ev.seq}, which ${owner ? `belongs to ${owner}, not to ${group}` : 'is owned by no group'}`), seq: ev.seq });
    }
  }
  const now = replay.map;
  for (const t of Object.values(state.tasks)) {
    const group = ownership.groupOfRole(now, t.owner);
    if (!group) { out.push(P1(`task ${t.id} is owned by ${t.owner}, who is in no group`)); continue; }
    if (!['pending', 'claimed'].includes(t.status)) continue;
    for (const f of t.files) {
      const owner = ownership.ownerOfGlob(now, f);
      if (owner !== group) out.push(P1(`task ${t.id} (${t.status}) owns ${f}, which ${owner ? `belongs to ${owner}, not to ${group}` : 'is owned by no group'}`));
    }
  }
  return out;
}

module.exports = { loadMap, amend, rescope, rescopeProblems, describe, auditProblems, replayAmendments, sealedBase };
