'use strict';
// Path-scoped permissions for the group roles, evaluated by the PreToolUse hook (scripts/hooks/guard.js) for every
// file-tool write and every literal shell write target. This is the managed path's write check: GF-OWN-2 (the path
// belongs to the writer's group), GF-FRZ-1 (a sealed contract file is the api group's, and only while an amendment
// request for it is open) and the per-group drafts namespace. The existing rule that the write also lies inside a
// claimed task's globs stays in the hook and runs after this.
//
// It fails closed: inside a Greenfield-Senior project, a group role whose ownership cannot be determined (the map's
// bytes differ from the seal, the record cannot be read) is refused rather than allowed. It is a check in the hook,
// so with the hook off nothing here runs; the audit (ownership-ops.js, contracts.js) is what then detects.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const ownership = require('./ownership');
const ownershipOps = require('./ownership-ops');
const { project } = require('./projection');
const { CONFIG_FILES } = require('./pin');

const CONTRACT_PATHS = new Set([...C.CONTRACT_FILES, ...C.OPTIONAL_CONTRACT_FILES]);

/** Where a project-relative path really lands once symlinked directories are followed: `{rel}` or `{outside, real}`. */
function resolveReal(root, rel) {
  const realRoot = fs.realpathSync(root);
  let cur = path.join(root, rel);
  const tail = [];
  for (;;) {
    try { fs.lstatSync(cur); break; } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return { outside: true, real: cur };
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  let real;
  try { real = path.join(fs.realpathSync(cur), ...tail); } catch { return { outside: true, real: cur }; }
  const relative = path.relative(realRoot, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { outside: true, real };
  return { rel: relative.split(path.sep).join('/') };
}

function denialFor(root, store, gf, role, group, rel) {
  if (CONFIG_FILES.includes(rel)) return `GF-CONF-1: ${rel} is engine configuration, pinned by the orchestrator or the user; ${role} cannot write it (ask for a change through a message)`;
  if (rel.startsWith('.eccode/')) {
    if (!rel.startsWith('.eccode/drafts/')) return null; // the record and artifact rules of the hook decide
    return rel.startsWith(`.eccode/drafts/${group}/`) ? null
      : `drafts are namespaced per group: ${role} (group ${group}) writes only under .eccode/drafts/${group}/ (L-GF-4: this narrows the shared scratch area, it does not close it)`;
  }
  if (!gf.seal) return null; // group roles hold no claim before G1 is sealed; the hook's claimed-task rule answers
  const loaded = ownershipOps.loadMap(store);
  if (!loaded.map) return `${loaded.problems.map((p) => `${p.rule}: ${p.message}`).join('; ')}; group roles cannot write project files until the ownership map can be trusted again`;
  const real = resolveReal(root, rel);
  if (real.outside) return `${rel} resolves outside the project (${real.real}); a group role cannot write there`;
  const eff = real.rel;
  if (CONTRACT_PATHS.has(eff)) {
    if (group !== 'api') return `GF-FRZ-1: ${eff} is a sealed contract file, writable by the api group only (${role} is in ${group}); ask api for an amendment through a message`;
    if (!Object.prototype.hasOwnProperty.call(gf.seal.hashes, eff)) return `GF-FRZ-1: ${eff} is a contract file that is not in the seal; a new contract file is a design change, not a write`;
    const open = gf.requests.some((r) => r.contract === eff && !gf.amendments.some((a) => a.request === r.id));
    if (!open) return `GF-FRZ-1: ${eff} is sealed: the api group may write it only while an amendment request for it is open (eccode-gf amend request, then a reviewer applies it)`;
    return null;
  }
  const owner = ownership.ownerOfPath(loaded.map, eff);
  if (owner === group) return null;
  if (owner === null) return `${eff} is owned by no group (GF-OWN-2): ask the orchestrator to have a reviewer amend the ownership map (eccode-gf ownership amend) before ${role} writes it`;
  return `${eff} belongs to ${owner}, not to ${group} (GF-OWN-2): ask ${owner} through a message (eccode-gf message send), or have a reviewer amend the map`;
}

/**
 * `null` when the project is not a Greenfield-Senior project or `role` is in no group (the hook's existing rules
 * apply unchanged); otherwise `{ group, denial }`, `denial` being a reason string or null.
 */
function policy(root, role, rel) {
  const group = C.groupOf(role);
  if (!group || group === 'orchestrator') return null;
  try {
    const { Store } = require('../store');
    const store = new Store(root);
    if (!store.isInitialized()) return null;
    const gf = project(store.readEvents());
    if (!gf.initialized) return null;
    return { group, denial: denialFor(root, store, gf, role, group, rel) };
  } catch (e) {
    return { group, denial: `GF-OWN-1: the ownership policy could not be evaluated (${e && e.message ? e.message : e}); Greenfield-Senior group roles are refused until it can` };
  }
}

module.exports = { policy, resolveReal, CONTRACT_PATHS };
