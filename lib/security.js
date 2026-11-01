'use strict';
// Security as a capability (Phase 3, Part C). Before a change that touches
// routes, auth, permissions or ownership is delivered, the standard
// access-control test battery runs against the project's OWN FastAPI app in an
// isolated candidate worktree with the network closed: an access matrix (role
// x endpoint x ownership compared to the declared policy, with a field-leak
// oracle on every 2xx a non-owner receives), IDOR/BOLA probes (a non-owner must
// not read another role's object; a write must not accept privileged fields:
// mass assignment), auth-flow checks (logout and password-reset single-use) and
// targeted input probes on the changed endpoints (a SQL probe adds a boolean
// differential to the error oracle). Every request goes to the app under test
// through FastAPI's TestClient; nothing targets a third party. A matrix cell
// that disagrees with the declared policy, a leaked field, an IDOR leak, a
// persisted injected field, or a new endpoint with no reviewed policy refuses
// delivery unless a reviewer waives it with a rationale.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EccodeError, newId, matchesAny } = require('./util');
const worktree = require('./worktree');
const common = require('./guards/common');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'guards', 'access_probe.py');
const OWNERSHIPS = ['own', 'other', 'none'];
const OWNERSHIP_SET = new Set(OWNERSHIPS);
const EXPECTED_SET = new Set(['allow', 'deny']);
// Paths and content that mean the change can affect access control.
const SECURITY_RE = /auth|permission|role|owner|login|logout|token|session|password|credential|privilege|acl|rbac|scope|tenant/i;
const MODEL_FILE = /(^|\/)models?(\/|\.|$)|schema|entit|(^|\/)orm(\/|\.|$)/i;
const OWNERSHIP_FIELD = /\b(owner_id|user_id|account_id|tenant_id|created_by|owner|belongs_to)\b/;

function securityConfig(root) {
  return common.exists(path.join(root, '.eccode', 'security.json')) ? require('./util').readJson(path.join(root, '.eccode', 'security.json'), {}) : {};
}

/** The resolved roles: security.json's override if present, else behavior.json's; a level is inferred when absent. */
function rolesFor(bcfg, scfg) {
  const base = (scfg.roles && scfg.roles.length ? scfg.roles : bcfg.roles) || [];
  return base.map((r) => ({
    name: r.name,
    headers: r.headers || {},
    level: typeof r.level === 'number' ? r.level : (Object.keys(r.headers || {}).length ? 1 : 0),
  }));
}

/** The HTTP endpoints the change reached, as "METHOD /path". */
function reachedEndpoints(root, state) {
  try {
    return require('./behavior').surfacesOf(root, state).surfaces.filter((s) => s.kind === 'http').map((s) => s.target);
  } catch {
    return [];
  }
}

/** Whether the change reached `endpoint` ("METHOD /path"): an exact match, or the same method on a path the endpoint ends with (a route declared without its router's mount prefix). */
function reachedMatch(reached, endpoint) {
  if (reached.has(endpoint)) return true;
  const [method, path] = endpoint.split(/\s+/, 2);
  for (const r of reached) {
    const [rm, rp] = r.split(/\s+/, 2);
    if (rp && (rm === method || rm === 'ANY') && path && path.endsWith(rp)) return true;
  }
  return false;
}

/** The declared policy cells (committed security.policy events win over the configured ones). */
function declaredCells(state, scfg) {
  const map = new Map();
  const key = (c) => `${c.role}\t${c.endpoint}\t${c.ownership}`;
  for (const c of scfg.policy || []) if (EXPECTED_SET.has(c.expected)) map.set(key(c), c.expected);
  for (const p of (state.guards && state.guards.security && state.guards.security.policies) || []) {
    for (const c of p.cells || []) if (EXPECTED_SET.has(c.expected)) map.set(key(c), c.expected);
  }
  return map;
}

function ownershipsFor(endpoint) {
  const p = endpoint.split(' ')[1] || endpoint;
  return /\{/.test(p) ? OWNERSHIPS : ['none'];
}

/** Run one probe subcommand in the candidate worktree and return its parsed JSON output. */
function runProbe(store, actor, { subcommand, runspec, endpoints, task, timeoutMs, python }) {
  const state = store.state();
  common.assertActive(state);
  const base = state.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', `The security ${subcommand} probe needs the work item's git base commit`);
  const bcfg = common.behaviorConfig(store.root);
  if (!bcfg.app) throw new EccodeError('INVALID_INPUT', 'The security guard needs .eccode/behavior.json "app": "<module>:<attr>"');
  const py = require('./lab').pythonFor(store.root, python || bcfg.python);
  const evs = [];
  const notes = [];
  let out = null;
  worktree.withSides(store.root, base, ({ candidate }) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-security-${subcommand}-`));
    try {
      const specFile = path.join(work, 'runspec.json');
      fs.writeFileSync(specFile, JSON.stringify(runspec));
      const args = [`${common.sh(py)} ${common.sh(SCRIPT)} ${subcommand} --app ${common.sh(bcfg.app)} --config ${common.sh(specFile)} --out ${common.sh(path.join(work, 'out.json'))}`];
      if (endpoints && endpoints.length) {
        const epFile = path.join(work, 'endpoints.json');
        fs.writeFileSync(epFile, JSON.stringify(endpoints));
        args[0] += ` --endpoints ${common.sh(epFile)}`;
      }
      const sideTmp = fs.mkdtempSync(path.join(work, 'side-'));
      const outFile = path.join(work, 'out.json');
      const ev = common.runInSide(store, actor, { guard: 'security', label: subcommand, side: candidate, command: args[0], env: common.sideEnv(bcfg, sideTmp), setup: bcfg.setup, task, timeoutMs, evs });
      if (!fs.existsSync(outFile)) throw new EccodeError('GUARD_FAILED', `the security ${subcommand} probe produced no output (ev:${ev.id}):\n${ev.outputTail}`);
      out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      notes.push(...(out.errors || []).map((e) => `${subcommand}: ${e}`));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  return { out, evs, notes };
}

// ------------------------------------------------------------- policy

/** Declare the access policy: cells of role x endpoint x ownership -> allow|deny. Security review only. */
function policy(store, config, actor, cells) {
  const reviewers = [...new Set([...config.roles.phase.reviewers, ...config.roles.verification.reviewers].filter((r) => r === 'security-reviewer'))];
  const allowed = [...new Set([...config.roles.design.authors, ...reviewers, 'security-reviewer'])];
  if (!allowed.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not declare the access policy; allowed: ${allowed.join(', ')}`);
  if (!Array.isArray(cells) || !cells.length) throw new EccodeError('INVALID_INPUT', 'a policy is a non-empty list of cells {role, endpoint: "METHOD /path", ownership: own|other|none, expected: allow|deny}');
  const list = cells.map((c, i) => {
    if (!c || typeof c !== 'object') throw new EccodeError('INVALID_INPUT', `cell ${i}: not an object`);
    if (typeof c.role !== 'string' || !c.role) throw new EccodeError('INVALID_INPUT', `cell ${i}: role is required`);
    if (typeof c.endpoint !== 'string' || !/^\S+\s+\S/.test(c.endpoint)) throw new EccodeError('INVALID_INPUT', `cell ${i}: endpoint must be "METHOD /path"`);
    if (!OWNERSHIP_SET.has(c.ownership)) throw new EccodeError('INVALID_INPUT', `cell ${i}: ownership must be own, other or none`);
    if (!EXPECTED_SET.has(c.expected)) throw new EccodeError('INVALID_INPUT', `cell ${i}: expected must be allow or deny`);
    return { role: c.role, endpoint: c.endpoint.trim(), ownership: c.ownership, expected: c.expected };
  });
  return store.commit('security.policy', actor, { id: newId('sp'), cells: list }, (s) => common.assertActive(s)).event.data;
}

// ------------------------------------------------------------- matrix

function matrix(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const bcfg = common.behaviorConfig(store.root);
  const scfg = securityConfig(store.root);
  const roles = rolesFor(bcfg, scfg);
  if (!roles.length) throw new EccodeError('INVALID_INPUT', 'the security matrix needs roles in .eccode/security.json or .eccode/behavior.json');
  const declared = declaredCells(state, scfg);
  const endpoints = [...new Set([...declared.keys()].map((k) => k.split('\t')[1]).concat(reachedEndpoints(store.root, state)))];
  const cells = [];
  for (const role of roles) for (const endpoint of endpoints) for (const ownership of ownershipsFor(endpoint)) cells.push({ role: role.name, endpoint, ownership });
  if (!cells.length) throw new EccodeError('INVALID_INPUT', 'the security matrix has no cell: no policy is declared and the change reaches no HTTP endpoint');
  const objects = scfg.objects || [];
  const fields = scfg.fields || [];
  const { out, evs, notes } = runProbe(store, actor, { subcommand: 'matrix', runspec: { roles, objects, cells, fields }, task, timeoutMs, python });
  const observedBy = new Map((out.cells || []).map((c) => [`${c.role}\t${c.endpoint}\t${c.ownership}`, c]));
  const rows = cells.map((c) => {
    const key = `${c.role}\t${c.endpoint}\t${c.ownership}`;
    const o = observedBy.get(key);
    const expected = declared.has(key) ? declared.get(key) : null;
    const observed = o ? o.observed : null;
    const status = o ? o.status : null;
    const match = expected === null ? null : observed === expected;
    // The field-leak oracle: fields of another principal's object this role saw that the field policy does not allow.
    const leaked = (o && o.leaked) || [];
    const unknownFields = (o && o.unknownFields) || [];
    return { role: c.role, endpoint: c.endpoint, ownership: c.ownership, expected, observed, status, match, leaked, unknownFields, ...(o && o.ownerRole ? { ownerRole: o.ownerRole } : {}) };
  });
  const unexplained = rows.filter((r) => (r.expected !== null && r.match === false) || r.leaked.length).length;
  const unknown = rows.filter((r) => r.expected === null).length;
  const unknownFields = rows.filter((r) => r.unknownFields.length).length;
  const fp = common.fingerprint(store.root, state);
  const id = newId('smx');
  const art = common.writeArtifact(store, id, { id, cells: rows, raw: out, notes, evidence: evs });
  const data = { id, cells: rows, unexplained, unknown, unknownFields, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('security.matrix.result', actor, data, (s) => common.assertActive(s)).event.data;
}

// --------------------------------------------------------------- idor

function idor(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const bcfg = common.behaviorConfig(store.root);
  const scfg = securityConfig(store.root);
  const roles = rolesFor(bcfg, scfg);
  const objects = scfg.objects || [];
  if (!objects.length) throw new EccodeError('INVALID_INPUT', 'the IDOR probe needs .eccode/security.json "objects": [{kind, idParam, list, create}]');
  const endpoints = reachedEndpoints(store.root, state);
  const { out, evs, notes } = runProbe(store, actor, { subcommand: 'idor', runspec: { roles, objects, endpoints, fields: scfg.fields || [] }, task, timeoutMs, python });
  // A `read` probe is a non-owner fetching A's object; a `mass-assignment` probe is an owner's write carrying privileged fields, read back.
  const probes = (out.probes || []).map((p) => ({ kind: p.probe || 'read', endpoint: p.endpoint, as: p.as, relationship: p.relationship, ownerRole: p.ownerRole, status: p.status, leaked: p.leaked || [], unknownFields: p.unknownFields || [], ...(p.probe === 'mass-assignment' ? { injected: p.injected || {}, persisted: p.persisted || [] } : {}), fail: Boolean(p.fail) }));
  const unexplained = probes.filter((p) => p.fail).length;
  const fp = common.fingerprint(store.root, state);
  const id = newId('sid');
  const art = common.writeArtifact(store, id, { id, probes: out.probes || [], notes, evidence: evs });
  const data = { id, probes, unexplained, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('security.idor.result', actor, data, (s) => common.assertActive(s)).event.data;
}

// ------------------------------------------------------------ authflow

function authflow(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const scfg = securityConfig(store.root);
  const roles = rolesFor(common.behaviorConfig(store.root), scfg);
  if (!scfg.authFlows || !Object.keys(scfg.authFlows).length) throw new EccodeError('INVALID_INPUT', 'the auth-flow check needs .eccode/security.json "authFlows": {login, logout, reset}');
  const { out, evs, notes } = runProbe(store, actor, { subcommand: 'authflow', runspec: { roles, authFlows: scfg.authFlows, objects: scfg.objects || [] }, task, timeoutMs, python });
  const checks = (out.checks || []).map((c) => ({ name: c.name, kind: c.kind, passed: Boolean(c.passed), detail: c.detail }));
  const flagged = checks.filter((c) => !c.passed).length;
  const fp = common.fingerprint(store.root, state);
  const id = newId('saf');
  const art = common.writeArtifact(store, id, { id, checks: out.checks || [], notes, evidence: evs });
  const data = { id, checks, flagged, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('security.authflow.result', actor, data, (s) => common.assertActive(s)).event.data;
}

// --------------------------------------------------------------- input

function inputProbes(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  common.assertActive(state);
  const bcfg = common.behaviorConfig(store.root);
  const scfg = securityConfig(store.root);
  const roles = rolesFor(bcfg, scfg);
  const reached = new Set(reachedEndpoints(store.root, state));
  const all = scfg.inputs || [];
  // Targeted, and focused on the changed endpoints when the change reaches any (else every configured input).
  const focused = reached.size ? all.filter((i) => reachedMatch(reached, i.endpoint)) : [];
  const chosen = focused.length ? focused : all;
  if (!chosen.length) throw new EccodeError('INVALID_INPUT', 'the input probe needs .eccode/security.json "inputs": [{endpoint, param, in, kind}]');
  const { out, evs, notes } = runProbe(store, actor, { subcommand: 'input', runspec: { roles, inputs: chosen, objects: scfg.objects || [] }, task, timeoutMs, python });
  const probes = (out.probes || []).map((p) => ({ endpoint: p.endpoint, param: p.param, in: p.in, kind: p.kind, payload: p.payload, status: p.status, flagged: Boolean(p.flagged), evidence: p.evidence, ...(p.differential ? { differential: p.differential.map((d) => ({ flagged: Boolean(d.flagged), detail: d.detail })) } : {}) }));
  const flagged = probes.filter((p) => p.flagged).length;
  const fp = common.fingerprint(store.root, state);
  const id = newId('sin');
  const art = common.writeArtifact(store, id, { id, probes: out.probes || [], notes, evidence: evs });
  const data = { id, probes, flagged, notes, evidence: evs, treeFingerprint: fp, ...art, ...(task ? { task } : {}) };
  return store.commit('security.input.result', actor, data, (s) => common.assertActive(s)).event.data;
}

// ------------------------------------------------------------- routing

/** Whether the project has opted into the security capability: an app to probe and objects or a policy to probe it with. */
function configured(root) {
  const bcfg = common.behaviorConfig(root);
  const scfg = securityConfig(root);
  return Boolean(bcfg.app && ((scfg.objects && scfg.objects.length) || (scfg.policy && scfg.policy.length)));
}

/** Whether the change can affect access control: a security-shaped code file, an HTTP surface, or a model with an ownership field. Only when the capability is configured. */
function required(root, state, changed, surfaces) {
  if (!state.work || state.work.track === 'quick' || !configured(root)) return false;
  const files = (changed || worktree.changedSince(root, state.work && state.work.baseCommit)).filter((f) => !require('./lean').TEST.test(f) && require('./bugs').isCode(f));
  const surf = surfaces || reachedSurfaces(root, state);
  if (surf.some((s) => s.kind === 'http')) return true;
  for (const f of files) {
    if (SECURITY_RE.test(f)) return true;
    const text = require('./lean').readText(root, f) || '';
    if (SECURITY_RE.test(text)) return true;
    if (MODEL_FILE.test(f) && OWNERSHIP_FIELD.test(text)) return true;
  }
  return false;
}

function reachedSurfaces(root, state) {
  try {
    return require('./behavior').surfacesOf(root, state).surfaces;
  } catch {
    return [];
  }
}

function reason(root, state, changed, surfaces) {
  const surf = surfaces || reachedSurfaces(root, state);
  const http = surf.filter((s) => s.kind === 'http');
  if (http.length) return `the change reaches ${http.length} HTTP endpoint(s): ${http.slice(0, 4).map((s) => s.target).join(', ')}${http.length > 4 ? ', …' : ''}`;
  const files = (changed || worktree.changedSince(root, state.work && state.work.baseCommit)).filter((f) => !require('./lean').TEST.test(f) && require('./bugs').isCode(f));
  const hit = files.find((f) => SECURITY_RE.test(f) || SECURITY_RE.test(require('./lean').readText(root, f) || ''));
  if (hit) return `a changed file touches auth, permissions, roles or ownership: ${hit}`;
  const model = files.find((f) => MODEL_FILE.test(f) && OWNERSHIP_FIELD.test(require('./lean').readText(root, f) || ''));
  if (model) return `a changed model carries an ownership field: ${model}`;
  return 'the change can affect access control';
}

// --------------------------------------------------------------- gates

function freshest(list, fp) {
  return [...(list || [])].reverse().find((x) => x.treeFingerprint === fp) || null;
}

function deliveryProblems(state, root) {
  if (!state.work || !state.guards || state.work.track === 'quick' || !root) return [];
  const changed = worktree.changedSince(root, state.work.baseCommit);
  const surfaces = reachedSurfaces(root, state);
  if (!required(root, state, changed, surfaces)) return [];
  const sec = state.guards.security || {};
  const fp = common.fingerprint(root, state);
  const waived = (resultId) => new Set((state.guards.waivers || []).filter((w) => w.guard === 'security' && w.result === resultId).map((w) => w.finding));
  const problems = [];

  const mx = freshest(sec.matrix, fp);
  if (!mx) problems.push('security guard: no access matrix matches the current tree (eccode security matrix --actor <owner>)');
  else {
    const w = waived(mx.id);
    for (const c of mx.cells) {
      const finding = `${c.role} ${c.endpoint} ${c.ownership}`;
      if (w.has(finding)) continue;
      const waive = `(eccode guard waive --guard security --result ${mx.id} --finding ${JSON.stringify(finding)} --reason ...)`;
      if (c.expected !== null && c.match === false) problems.push(`security guard: ${c.role} on ${c.endpoint} (${c.ownership}) is declared ${c.expected} but observed ${c.observed} (HTTP ${c.status}). Fix the access check, correct the policy, or a reviewer waives it ${waive}`);
      if ((c.leaked || []).length) problems.push(`security guard: ${c.role} on ${c.endpoint} (${c.ownership}) sees field(s) of ${c.ownerRole || 'another role'}'s object the field policy does not allow: ${c.leaked.join(', ')} (HTTP ${c.status}). Drop the field(s) from the response to a non-owner, or a reviewer waives it ${waive}`);
      else if ((c.unknownFields || []).length && c.match !== false) problems.push(`security guard: ${c.role} on ${c.endpoint} (${c.ownership}) sees field(s) no field policy covers: ${c.unknownFields.join(', ')}. A field a non-owner may see needs a reviewed allow-list in .eccode/security.json "fields" (it is not safe by default), or a reviewer waives it ${waive}`);
    }
    const unknown = mx.cells.filter((c) => c.expected === null && !w.has(`${c.role} ${c.endpoint} ${c.ownership}`));
    if (unknown.length) {
      const eps = [...new Set(unknown.map((c) => c.endpoint))];
      problems.push(`security guard: ${unknown.length} matrix cell(s) on ${eps.slice(0, 4).join(', ')}${eps.length > 4 ? ', …' : ''} have no declared policy. A new endpoint needs a reviewed policy before delivery (eccode security policy --actor security-reviewer --file policy.json), then re-run the matrix`);
    }
  }

  const id = freshest(sec.idor, fp);
  if (!id) problems.push('security guard: no IDOR probe matches the current tree (eccode security idor --actor <owner>)');
  else {
    const w = waived(id.id);
    for (const p of id.probes) {
      const finding = `${p.endpoint} as ${p.as}`;
      if (!p.fail || w.has(finding)) continue;
      const waive = `(eccode guard waive --guard security --result ${id.id} --finding ${JSON.stringify(finding)} --reason ...)`;
      if (p.kind === 'mass-assignment') problems.push(`security guard: ${p.endpoint} as ${p.as} accepted privileged field(s) from the body and persisted them: ${(p.persisted || []).map((f) => `${f}=${JSON.stringify((p.injected || {})[f])}`).join(', ')} (HTTP ${p.status}; mass assignment). Reject or ignore the field(s) on write, or a reviewer waives it ${waive}`);
      else problems.push(`security guard: ${p.endpoint} as ${p.as} (${p.relationship}) reaches ${p.ownerRole}'s object: HTTP ${p.status}${p.leaked && p.leaked.length ? `, leaked field(s) ${p.leaked.join(', ')}` : ''}. Enforce the ownership check${p.leaked && p.leaked.length ? ' or drop the field(s) from the response to a non-owner' : ''}, or a reviewer waives it ${waive}`);
    }
  }

  // Auth-flow and input results are reported; a flagged failure not waived blocks.
  const af = freshest(sec.authflow, fp);
  if (af) { const w = waived(af.id); for (const c of af.checks) if (!c.passed && !w.has(c.name)) problems.push(`security guard: auth-flow check "${c.name}" failed (${c.detail}). Fix it, or a reviewer waives it (eccode guard waive --guard security --result ${af.id} --finding ${JSON.stringify(c.name)} --reason ...)`); }
  const inp = freshest(sec.input, fp);
  if (inp) { const w = waived(inp.id); for (const p of inp.probes) { const finding = `${p.endpoint} ${p.param} ${p.kind}`; if (p.flagged && !w.has(finding)) problems.push(`security guard: input probe ${p.kind} on ${p.endpoint} (${p.param}) took effect: ${p.evidence}. Sanitize or reject the input, or a reviewer waives it (eccode guard waive --guard security --result ${inp.id} --finding ${JSON.stringify(finding)} --reason ...)`); } }
  return problems;
}

// -------------------------------------------------------------- report

function reportLines(state) {
  const sec = (state.guards && state.guards.security) || {};
  const has = ['policies', 'matrix', 'idor', 'authflow', 'input'].some((k) => (sec[k] || []).length);
  if (!has) return [];
  const lines = ['## Security', ''];
  for (const p of sec.policies || []) lines.push(`Declared policy ${p.id} (${p.by}): ${p.cells.length} cell(s).`);
  if ((sec.policies || []).length) lines.push('');
  const mx = (sec.matrix || [])[sec.matrix.length - 1];
  if (mx) {
    lines.push(`**Access matrix ${mx.id}:** ${mx.cells.length} cell(s), ${mx.unexplained} disagree with the policy or leak a field, ${mx.unknown} undeclared.`, '', '| Role | Endpoint | Ownership | Expected | Observed | | Fields |', '|---|---|---|---|---|---|---|');
    for (const c of mx.cells) lines.push(`| ${c.role} | ${c.endpoint} | ${c.ownership} | ${c.expected || '—'} | ${c.observed || '—'} (${c.status ?? '?'}) | ${c.expected === null ? 'unknown' : c.match ? 'ok' : 'MISMATCH'} | ${(c.leaked || []).length ? `LEAKED ${c.leaked.join(', ')}` : (c.unknownFields || []).length ? `unknown ${c.unknownFields.join(', ')}` : '—'} |`);
    lines.push('');
  }
  const id = (sec.idor || [])[sec.idor.length - 1];
  if (id) {
    lines.push(`**IDOR probes ${id.id}:** ${id.probes.length} probe(s), ${id.unexplained} leak(s).`, '');
    for (const p of id.probes) {
      if (p.kind === 'mass-assignment') lines.push(`- ${p.endpoint} as ${p.as} with injected ${Object.keys(p.injected || {}).join(', ') || 'nothing'}: HTTP ${p.status} — ${p.fail ? `MASS ASSIGNMENT (${(p.persisted || []).join(', ')} persisted)` : 'ignored'}`);
      else lines.push(`- ${p.endpoint} as ${p.as} (${p.relationship}) against ${p.ownerRole}: HTTP ${p.status} — ${p.fail ? `LEAK${p.leaked && p.leaked.length ? ` (${p.leaked.join(', ')})` : ''}` : p.status >= 200 && p.status < 300 ? 'allowed fields only' : 'denied'}`);
    }
    lines.push('');
  }
  const af = (sec.authflow || [])[sec.authflow.length - 1];
  if (af && af.checks.length) {
    lines.push(`**Auth flows ${af.id}:**`, '');
    for (const c of af.checks) lines.push(`- ${c.name}: ${c.passed ? 'ok' : 'FAILED'} (${c.detail})`);
    lines.push('');
  }
  const inp = (sec.input || [])[sec.input.length - 1];
  if (inp && inp.probes.length) {
    lines.push(`**Input probes ${inp.id}:** ${inp.flagged} flagged.`, '');
    for (const p of inp.probes) lines.push(`- ${p.kind} on ${p.endpoint} (${p.param}): ${p.flagged ? 'FLAGGED' : 'clean'} — ${p.evidence}`);
    lines.push('');
  }
  return lines;
}

module.exports = { policy, matrix, idor, authflow, inputProbes, input: inputProbes, required, reason, deliveryProblems, reportLines, rolesFor, declaredCells, ownershipsFor };
