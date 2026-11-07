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
  // Every path is judged where it really lands (C2-4: a symlink inside the drafts namespace must not lead out of it).
  const real = resolveReal(root, rel);
  if (real.outside) return `${rel} resolves outside the project (${real.real}); a group role cannot write there`;
  const eff = real.rel;
  const own = `.eccode/drafts/${group}/`;
  // E2-2: a file with more than one hard link shares its bytes with another name, which may be another group's.
  let st = null;
  try { st = fs.lstatSync(path.join(root, eff)); } catch { /* a new file */ }
  if (st && st.isFile() && st.nlink > 1) return `${eff} has ${st.nlink} hard links: a write would also change the other names of the same file, so a group role cannot write a hard-linked file`;
  if (CONFIG_FILES.includes(eff)) return `GF-CONF-1: ${eff} is engine configuration, pinned by the orchestrator or the user; ${role} cannot write it (ask for a change through a message)`;
  if (eff !== rel && rel.startsWith('.eccode/') && !eff.startsWith(own)) return `${rel} resolves to ${eff} through a symlink: a group role writes drafts only under ${own}, and the record and other groups' files never through a link`;
  if (eff.startsWith('.eccode/')) {
    if (!eff.startsWith('.eccode/drafts/')) return eff === rel ? null : `${rel} resolves to ${eff} through a symlink`; // the record and artifact rules of the hook decide
    return eff.startsWith(own) ? null
      : `drafts are namespaced per group: ${role} (group ${group}) writes only under ${own} (L-GF-4: this narrows the shared scratch area, it does not close it)`;
  }
  if (!gf.seal) return null; // group roles hold no claim before G1 is sealed; the hook's claimed-task rule answers
  const loaded = ownershipOps.loadMap(store);
  if (!loaded.map) return `${loaded.problems.map((p) => `${p.rule}: ${p.message}`).join('; ')}; group roles cannot write project files until the ownership map can be trusted again`;
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

/**
 * GF-RUN-1: a group role has no shell in a Greenfield-Senior project (design 18.4). Returns the denial or null; decided
 * the same way as `policy` (an initialised record with `gf.project.initialized`), failing closed when it cannot.
 */
function shellDenial(root, role) {
  const group = C.groupOf(role);
  if (!group || group === 'orchestrator') return null;
  try {
    const { Store } = require('../store');
    const store = new Store(root);
    if (!store.isInitialized()) return null;
    if (!project(store.readEvents()).initialized) return null;
    return `GF-RUN-1: in a Greenfield-Senior project a group role has no shell. ${role} runs commands through the runner: gf_run on its eccode server, with a command the plan pins or a pinned form of pytest, alembic, serve (uvicorn), ruff, semgrep, gitleaks, trivy or playwright (design 18.4)`;
  } catch (e) {
    return `GF-RUN-1: whether this is a Greenfield-Senior project could not be decided (${e && e.message ? e.message : e}); a group role's shell is refused until it can`;
  }
}

module.exports = { policy, shellDenial, resolveReal, CONTRACT_PATHS };
