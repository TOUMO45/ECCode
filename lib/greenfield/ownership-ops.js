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
const { newId, sha256, matchesAny } = require('../util');
const { projectRelative, gitChangedFiles } = require('../project');
const events = require('./events');
const ownership = require('./ownership');
const wrap = require('./wrap');
const { reviewersOf } = require('./roles');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const P1 = (message) => ({ rule: 'GF-OWN-1', message });
const P3 = (message) => ({ rule: 'GF-OWN-3', message });
const P4 = (message) => ({ rule: 'GF-OWN-4', message });
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

/** GF-OWN-3: a completion lists only files of the completing actor's group (judged on paths, not on who says so). */
function completionProblems(map, actor, filesChanged) {
  const group = ownership.groupOfRole(map, actor);
  if (!group) return [P3(`${actor} is in no group and cannot complete a Greenfield-Senior task`)];
  const out = [];
  for (const f of Array.isArray(filesChanged) ? filesChanged : []) {
    if (typeof f !== 'string') { out.push(P3(`${JSON.stringify(f)} is not a path`)); continue; }
    const n = ownership.normalizePath(f);
    if (n === null) { out.push(P3(`${f} is outside the project or not a relative path`)); continue; }
    if (n.startsWith('.eccode/drafts/')) continue; // the frozen engine always allows drafts
    const owner = ownership.ownerOfPath(map, n);
    if (owner !== group) out.push(P3(owner === null ? `${n} is owned by no group: a completion lists only files of ${group}` : `${n} belongs to ${owner}, not to ${group}`));
  }
  return out;
}

/** The check that runs before the frozen completion: the map must be trustworthy and the listed files the actor's group's. */
function completionCheck(store, actor, handoff) {
  const loaded = loadMap(store);
  if (!loaded.map) return loaded.problems;
  const list = handoff && typeof handoff === 'object' && Array.isArray(handoff.filesChanged) ? handoff.filesChanged : [];
  const rel = list.map((f) => { if (typeof f !== 'string') return f; try { return projectRelative(store.root, f); } catch { return f; } });
  return completionProblems(loaded.map, actor, rel);
}

/**
 * GF-OWN-4: every changed path is owned by a group that completed a task declaring it. `tasks` are the engine's
 * tasks; only a task that is done counts, and it must list the path in filesChanged and cover it with its files.
 */
function attribution({ map, tasks: list, changed }) {
  if (!map) return [P1('no usable ownership map: attribution cannot be established')];
  const done = (list || []).filter((t) => t.status === 'done');
  const out = [];
  for (const f of changed || []) {
    if (typeof f !== 'string' || f.startsWith('.eccode/')) continue;
    const n = ownership.normalizePath(f);
    if (n === null) { out.push(P4(`${f} is outside the project`)); continue; }
    const owner = ownership.ownerOfPath(map, n);
    if (owner === null) { out.push(P4(`${n} was changed and is owned by no group`)); continue; }
    const declared = done.some((t) => ownership.groupOfRole(map, t.owner) === owner && matchesAny(n, t.files) && (t.filesChanged || []).some((x) => ownership.normalizePath(x) === n));
    if (!declared) out.push(P4(`${n} was changed but no completed task of ${owner} declares it`));
  }
  return out;
}

/** `eccode-gf attribute`: the paths changed since `base` against the record. Never throws. */
function attribute(store, base) {
  const loaded = loadMap(store);
  if (!loaded.map) return { ok: false, problems: loaded.problems, changed: [] };
  const changed = gitChangedFiles(store.root, base);
  if (!changed) return { ok: false, problems: [P4(`cannot list the changes since ${base}: it is not a commit of this repository`)], changed: [] };
  const problems = attribution({ map: loaded.map, tasks: Object.values(store.state().tasks), changed });
  return { ok: problems.length === 0, problems, changed };
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
  for (const ev of log) {
    if (ev.type !== 'task.completed') continue;
    const map = ownership.mapAt(base.map, valid, ev.seq);
    // The actor string is asserted (L-GF-17); the task's owner is a fact of the reviewed plan. A completion is judged
    // against both: the actor must be the owner, and the files must be the actor's group's.
    const owner = state.tasks[ev.data.task] && state.tasks[ev.data.task].owner;
    if (owner && owner !== ev.actor) out.push({ ...P3(`task ${ev.data.task} was completed by ${ev.actor}, but it is owned by ${owner}`), seq: ev.seq });
    for (const p of completionProblems(map, ev.actor, ev.data.filesChanged)) out.push({ ...P3(`task ${ev.data.task} was completed by ${ev.actor} at seq ${ev.seq}: ${p.message}`), seq: ev.seq });
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

module.exports = { loadMap, amend, rescope, rescopeProblems, describe, auditProblems, replayAmendments, sealedBase, completionProblems, completionCheck, attribution, attribute };
