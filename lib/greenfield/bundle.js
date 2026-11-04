'use strict';
// Locates the stage artifacts of a gate submission, loads them defensively (size cap, byte-order mark, invalid
// JSON, symlinks, paths outside the project), runs the stage validators and cross-validates against the
// artifacts of the gates that already approved (read back from disk at their approved hashes).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./constants');
const prdStage = require('./stages/prd');
const architectureStage = require('./stages/architecture');
const contractsStage = require('./stages/contracts');
const threatStage = require('./stages/threat');
const breakdownStage = require('./stages/breakdown');
const estimatesStage = require('./stages/estimates');
const snapshots = require('./snapshots');
const { problem: P } = require('./stages/common');

const MAX_BYTES = 8 * 1024 * 1024;
const GATES = ['architecture', 'design', 'plan'];

/** artifact key -> file name. Contract files must live at contracts/<name>. */
const ARTIFACT = {
  prd: 'prd.json', architecture: 'architecture.json',
  openapi: 'openapi.json', dbSchema: 'db-schema.json', migrationsPlan: 'migrations-plan.json', accessMatrix: 'access-matrix.json', fixtures: 'fixtures.json', events: 'events.json',
  threat: 'threat-model.json', breakdown: 'breakdown.json', plan: 'plan.json', estimates: 'estimates.json',
};
const CONTRACT_KEYS = ['openapi', 'dbSchema', 'migrationsPlan', 'accessMatrix', 'fixtures', 'events'];
const RULE_OF = {
  prd: 'GF-PRD-1', architecture: 'GF-ARC-1', openapi: 'GF-CON-1', dbSchema: 'GF-CON-2', migrationsPlan: 'GF-CON-2', accessMatrix: 'GF-CON-3',
  fixtures: 'GF-CON-4', events: 'GF-CON-4', threat: 'GF-THR-1', breakdown: 'GF-WBS-1', plan: 'GF-WBS-1', estimates: 'GF-EST-1',
};
const REQUIRED = {
  architecture: ['prd', 'architecture'],
  design: ['openapi', 'dbSchema', 'migrationsPlan', 'accessMatrix', 'fixtures', 'threat'],
  plan: ['plan', 'breakdown', 'estimates'],
};
const STAGE_FILES = { prd: ['prd'], architecture: ['architecture'], contracts: CONTRACT_KEYS, threat: ['threat'], breakdown: ['breakdown', 'plan'], estimates: ['estimates'] };
const NAMES = new Set(Object.values(ARTIFACT));
/** The only gate at which each artifact may be submitted: a file is matched by name, so a name belongs to one gate. */
const ARTIFACT_GATE = {
  prd: 'architecture', architecture: 'architecture',
  openapi: 'design', dbSchema: 'design', migrationsPlan: 'design', accessMatrix: 'design', fixtures: 'design', events: 'design', threat: 'design',
  plan: 'plan', breakdown: 'plan', estimates: 'plan',
};
const keyOf = (name) => Object.keys(ARTIFACT).find((k) => ARTIFACT[k] === name);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Which submitted files are stage artifacts of `gate`, by file name. Returns { found: {key: {rel, abs}}, problems }. */
function locate(root, files, gate) {
  const found = {};
  const problems = [];
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  for (const entry of files) {
    // an entry is a project-relative path, or { rel, abs } when the bytes come from a snapshot of an approved contract
    const f = typeof entry === 'string' ? entry : entry.rel;
    const r = path.relative(root, path.resolve(root, f));
    const abs = typeof entry === 'string' ? path.resolve(root, f) : entry.abs;
    if (r.startsWith('..') || path.isAbsolute(r)) { problems.push(P('GF-ART-2', f, `${f} is outside the project`)); continue; }
    const rel = r.split(path.sep).join('/');
    const name = path.posix.basename(rel);
    const key = keyOf(name);
    if (!key) continue;
    if (gate && ARTIFACT_GATE[key] !== gate) { problems.push(P('GF-ART-2', rel, `${rel} is a ${ARTIFACT_GATE[key]}-gate artifact and cannot be part of a ${gate} submission`)); continue; }
    if (CONTRACT_KEYS.includes(key) && rel !== `contracts/${name}`) { problems.push(P('GF-ART-2', rel, `${rel}: a contract file lives at contracts/${name}`)); continue; }
    if (found[key]) { problems.push(P('GF-ART-2', rel, `two artifacts named ${name} in one submission (${found[key].rel} and ${rel})`)); continue; }
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* reported below */ }
    if (!st) { problems.push(P(RULE_OF[key], rel, `${rel} does not exist`)); continue; }
    if (st.isSymbolicLink()) { problems.push(P('GF-ART-2', rel, `${rel} is a symlink; a stage artifact must be a regular file`)); continue; }
    if (!st.isFile()) { problems.push(P('GF-ART-2', rel, `${rel} is not a regular file`)); continue; }
    let real = null;
    try { real = fs.realpathSync(abs); } catch { /* handled below */ }
    if (real === null || !(real === realRoot || real.startsWith(realRoot + path.sep))) { problems.push(P('GF-ART-2', rel, `${rel} resolves outside the project (a symlinked directory)`)); continue; }
    found[key] = { rel, abs };
  }
  return { found, problems };
}

function load(entry, key) {
  const size = fs.statSync(entry.abs).size;
  if (size > MAX_BYTES) return { problem: P('GF-ART-2', entry.rel, `${entry.rel} is too large (${size} bytes; the limit is ${MAX_BYTES})`) };
  const buf = fs.readFileSync(entry.abs);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return { doc: JSON.parse(text), sha256: sha256(buf) }; } catch (e) { return { problem: P(RULE_OF[key], entry.rel, `${entry.rel} is not valid JSON: ${e.message}`) }; }
}

function loadSet(root, files, gate) {
  const { found, problems } = locate(root, files, gate);
  const docs = {};
  const hashes = {};
  const rels = {};
  for (const [key, entry] of Object.entries(found)) {
    const r = load(entry, key);
    if (r.problem) { problems.push(r.problem); continue; }
    docs[key] = r.doc;
    hashes[key] = r.sha256;
    rels[key] = entry.rel;
  }
  return { found, docs, hashes, rels, problems };
}

/** The stage artifacts a gate was approved with, read back from disk; a file that changed since is GF-ART-DRIFT and is left out. */
function approvedSet(root, base, gateId) {
  const g = base && base.gates && base.gates[gateId];
  const sub = g && g.status === 'approved' ? (g.submissions || []).find((s) => s.id === g.approvedSubmission) : null;
  if (!sub) return { approved: false, files: [], drift: [] };
  const files = [];
  const drift = [];
  for (const a of sub.artifacts || []) {
    if (!NAMES.has(path.posix.basename(a.path))) continue;
    let cur = null;
    try { cur = sha256(fs.readFileSync(path.join(root, a.path))); } catch { /* missing */ }
    if (cur === a.sha256) files.push(a.path);
    else if (a.path.startsWith('contracts/') && snapshots.read(root, a.sha256)) {
      // the live contract moved on (an amendment, or a tamper that GF-FRZ-2 reports); the approved bundle is still validated at its approved bytes
      files.push({ rel: a.path, abs: snapshots.pathOf(root, a.sha256) });
    } else drift.push(P('GF-ART-DRIFT', a.path, `${a.path} changed after the ${gateId} gate approved it`));
  }
  return { approved: true, files, drift };
}

/**
 * Validate the stage artifacts of one gate submission. `files` are the submitted paths. Returns
 * { problems: [{rule, path, message}], registrations: [{stage, files: [{path, sha256}]}] }.
 */
function validateGate(root, gateId, files, base, config) {
  if (!GATES.includes(gateId)) return { problems: [], registrations: [] };
  // The public entry takes paths only. (Entries with a ready-made absolute path exist for snapshots and are internal.)
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || f === '')) {
    return { problems: [P('GF-ART-2', 'artifacts', 'every artifact must be a non-empty path string (a path, not an object)')], registrations: [] };
  }
  return validateEntries(root, gateId, files, base, config);
}

/** A validator that throws is a problem report, never a crash: the input is hostile by assumption. */
function guarded(rule, label, fn) {
  try { return fn(); } catch (e) { return [P(rule, label, `${label} could not be validated: ${e && e.message ? e.message : String(e)}`)]; }
}

function validateEntries(root, gateId, files, base, config) {
  const own = loadSet(root, files, gateId);
  const problems = [...own.problems];
  if (gateId === 'plan') {
    // The frozen plan gate imports its tasks from the first .json artifact it is given (lib/gates.js), not from plan.json.
    const first = [...new Set(files.map((f) => (typeof f === 'string' ? f : f.rel)))].find((f) => f.endsWith('.json'));
    if (first !== undefined && path.posix.basename(first.split(path.sep).join('/')) !== 'plan.json') {
      problems.push(P('GF-WBS-1', 'plan.json', `the frozen plan gate imports its tasks from the first .json artifact (${first}); plan.json must be listed first, or the engine's tasks are not the validated plan`));
    }
  }
  const prior = { docs: {}, hashes: {} };
  for (const g of GATES.slice(0, GATES.indexOf(gateId))) {
    const a = approvedSet(root, base, g);
    if (!a.approved) { problems.push(P('GF-ORD-1', g, `the ${g} gate is not approved, so ${gateId} cannot be validated against it`)); continue; }
    problems.push(...a.drift);
    const set = loadSet(root, a.files, g);
    problems.push(...set.problems);
    Object.assign(prior.docs, set.docs);
    Object.assign(prior.hashes, set.hashes);
  }
  for (const key of REQUIRED[gateId]) {
    if (!own.found[key] && !own.problems.some((p) => p.path.endsWith(ARTIFACT[key]))) problems.push(P(RULE_OF[key], ARTIFACT[key], `${ARTIFACT[key]} is missing from the submission`));
  }
  const d = own.docs;
  if (gateId === 'architecture') {
    if (d.prd) problems.push(...guarded('GF-PRD-1', 'prd.json', () => prdStage.validate(d.prd, { base })));
    if (d.architecture) problems.push(...guarded('GF-ARC-1', 'architecture.json', () => architectureStage.validate(d.architecture, { base, docs: { prd: d.prd } })));
  } else if (gateId === 'design') {
    const contracts = {};
    for (const k of CONTRACT_KEYS) if (d[k] !== undefined) contracts[k] = d[k];
    problems.push(...guarded('GF-CON-1', 'contracts', () => contractsStage.validate(contracts, { docs: { prd: prior.docs.prd } })));
    if (d.threat) problems.push(...guarded('GF-THR-1', 'threat-model.json', () => threatStage.validate(d.threat, { docs: { openapi: d.openapi, prd: prior.docs.prd, architecture: prior.docs.architecture }, hashes: { accessMatrix: own.hashes.accessMatrix } })));
  } else {
    if (d.breakdown) problems.push(...guarded('GF-WBS-1', 'breakdown.json', () => breakdownStage.validate(d.breakdown, { config, docs: { prd: prior.docs.prd, openapi: prior.docs.openapi, plan: d.plan } })));
    if (d.estimates) problems.push(...guarded('GF-EST-1', 'estimates.json', () => estimatesStage.validate(d.estimates, { docs: { breakdown: d.breakdown } })));
  }
  const registrations = C.GATE_STAGES[gateId].map((stage) => ({
    stage,
    files: STAGE_FILES[stage].filter((k) => own.rels[k]).map((k) => ({ path: own.rels[k], sha256: own.hashes[k] })),
  })).filter((r) => r.files.length);
  return { problems, registrations };
}

/**
 * Re-validate every approved gate at its approved hashes (seal and audit). Duplicates are collapsed.
 * `stateFor(gate)` gives the record as it stood when that gate was approved (a question recorded later is not
 * a defect of an earlier approval); without it the current state is used.
 */
function validateApproved(root, base, config, { stateFor } = {}) {
  const all = [];
  for (const gate of GATES) {
    const a = approvedSet(root, base, gate);
    if (!a.approved) continue;
    all.push(...a.drift);
    all.push(...validateEntries(root, gate, a.files, (stateFor && stateFor(gate)) || base, config).problems);
  }
  const seen = new Set();
  return { problems: all.filter((p) => { const k = `${p.rule}|${p.message}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

/** path -> sha256 of every stage artifact in the approved submissions of the three document gates. */
function approvedHashes(state) {
  const out = {};
  for (const g of GATES) {
    const gate = state.gates && state.gates[g];
    const sub = gate && gate.status === 'approved' ? (gate.submissions || []).find((s) => s.id === gate.approvedSubmission) : null;
    if (!sub) continue;
    for (const a of sub.artifacts || []) {
      const key = keyOf(path.posix.basename(a.path));
      if (key && ARTIFACT_GATE[key] === g) out[a.path] = a.sha256;
    }
  }
  return out;
}

/** The single hash that stands for the PRD and the contract files, from path -> sha256. */
function contractsHashOf(hashes) {
  const lines = Object.keys(hashes)
    .filter((p) => p.startsWith('contracts/') || path.posix.basename(p) === 'prd.json')
    .sort()
    .map((p) => `${p}:${hashes[p]}\n`)
    .join('');
  return sha256(lines);
}

module.exports = { approvedHashes, contractsHashOf, validateGate, validateApproved, locate, loadSet, approvedSet, ARTIFACT, ARTIFACT_GATE, CONTRACT_KEYS, STAGE_FILES, REQUIRED, sha256 };
