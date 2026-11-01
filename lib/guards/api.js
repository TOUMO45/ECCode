'use strict';
// API compatibility (Phase 3, B.2). The OpenAPI schema of the app and the
// signatures of the change's Python functions, baseline against candidate,
// classified: breaking (an endpoint or field removed, a type changed, a
// parameter made required), additive, or none. A breaking change must be
// declared in the design decision's interfaces and in the behavior contract;
// otherwise delivery refuses it. Machine-detected, not agent-declared.
const fs = require('fs');
const os = require('os');
const path = require('path');
const evidence = require('../evidence');
const lean = require('../lean');
const { EccodeError, newId, sha256, writeFileAtomic, exists, readJson } = require('../util');
const worktree = require('../worktree');

const OPENAPI_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'guards', 'openapi_dump.py');
const SIGNATURE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'guards', 'signature_dump.py');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function sh(cmd) {
  return /^[\w./:@+=,-]+$/.test(cmd) ? cmd : `'${String(cmd).replace(/'/g, "'\\''")}'`;
}

function resolveRef(schema, components) {
  if (schema && schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return resolveRef(components[name] || {}, components);
  }
  return schema || {};
}

function typeOf(schema, components) {
  const s = resolveRef(schema, components);
  if (s.type) return Array.isArray(s.type) ? s.type.filter((t) => t !== 'null').join('|') : s.type;
  for (const k of ['anyOf', 'oneOf']) if (s[k]) return s[k].map((x) => typeOf(x, components)).filter((t) => t !== 'null').sort().join('|');
  if (s.properties) return 'object';
  return 'any';
}

/** The properties of a schema as {name: {type, required}} (one level, refs resolved). */
function props(schema, components) {
  const s = resolveRef(schema, components);
  const required = new Set(s.required || []);
  const out = {};
  for (const [k, v] of Object.entries(s.properties || {})) out[k] = { type: typeOf(v, components), required: required.has(k) };
  return out;
}

function responseSchema(op) {
  for (const code of ['200', '201', '2XX']) {
    const r = op.responses && op.responses[code];
    const content = r && r.content && (r.content['application/json'] || Object.values(r.content)[0]);
    if (content && content.schema) return content.schema;
  }
  return null;
}

function bodySchema(op) {
  const rb = op.requestBody && op.requestBody.content;
  const content = rb && (rb['application/json'] || Object.values(rb)[0]);
  return content ? content.schema : null;
}

/** Compare two OpenAPI documents. Returns {breaking: [...], additive: [...]} with {kind, target, detail}. */
function diffOpenapi(before, after) {
  const breaking = [];
  const additive = [];
  const cb = (before.components && before.components.schemas) || {};
  const ca = (after.components && after.components.schemas) || {};
  const ops = (doc) => {
    const out = {};
    for (const [p, methods] of Object.entries(doc.paths || {})) for (const m of METHODS) if (methods[m]) out[`${m.toUpperCase()} ${p}`] = methods[m];
    return out;
  };
  const ob = ops(before);
  const oa = ops(after);
  for (const key of Object.keys(ob)) if (!oa[key]) breaking.push({ kind: 'endpoint-removed', target: key, detail: 'the endpoint no longer exists' });
  for (const key of Object.keys(oa)) if (!ob[key]) additive.push({ kind: 'endpoint-added', target: key, detail: 'new endpoint' });
  for (const key of Object.keys(ob).filter((k) => oa[k])) {
    const b = ob[key];
    const a = oa[key];
    const pb = Object.fromEntries((b.parameters || []).map((p) => [`${p.in}:${p.name}`, p]));
    const pa = Object.fromEntries((a.parameters || []).map((p) => [`${p.in}:${p.name}`, p]));
    for (const [n, p] of Object.entries(pa)) {
      if (!pb[n]) (p.required ? breaking : additive).push({ kind: p.required ? 'parameter-required-added' : 'parameter-added', target: key, detail: `${p.in} parameter ${p.name}${p.required ? ' is required' : ''}` });
      else if (p.required && !pb[n].required) breaking.push({ kind: 'parameter-made-required', target: key, detail: `${p.in} parameter ${p.name} became required` });
      else if (pb[n].schema && p.schema && typeOf(pb[n].schema, cb) !== typeOf(p.schema, ca)) breaking.push({ kind: 'parameter-type-changed', target: key, detail: `${p.in} parameter ${p.name}: ${typeOf(pb[n].schema, cb)} -> ${typeOf(p.schema, ca)}` });
    }
    for (const [n, p] of Object.entries(pb)) if (!pa[n]) (p.required ? breaking : additive).push({ kind: p.required ? 'parameter-required-removed' : 'parameter-removed', target: key, detail: `${p.in} parameter ${p.name} removed` });
    const bb = props(bodySchema(b), cb);
    const ba = props(bodySchema(a), ca);
    for (const [n, f] of Object.entries(ba)) {
      if (!bb[n]) (f.required ? breaking : additive).push({ kind: f.required ? 'body-field-required-added' : 'body-field-added', target: key, detail: `request field ${n}${f.required ? ' is required' : ''}` });
      else if (f.required && !bb[n].required) breaking.push({ kind: 'body-field-made-required', target: key, detail: `request field ${n} became required` });
      else if (bb[n].type !== f.type) breaking.push({ kind: 'body-field-type-changed', target: key, detail: `request field ${n}: ${bb[n].type} -> ${f.type}` });
    }
    for (const n of Object.keys(bb)) if (!ba[n]) breaking.push({ kind: 'body-field-removed', target: key, detail: `request field ${n} removed` });
    const rb = responseSchema(b);
    const ra = responseSchema(a);
    if (rb && !ra) breaking.push({ kind: 'response-removed', target: key, detail: 'the success response lost its schema' });
    if (rb && ra) {
      const tb = typeOf(rb, cb);
      const ta = typeOf(ra, ca);
      if (tb !== ta) breaking.push({ kind: 'response-type-changed', target: key, detail: `${tb} -> ${ta}` });
      const itemsB = tb === 'array' ? resolveRef(rb, cb).items : rb;
      const itemsA = ta === 'array' ? resolveRef(ra, ca).items : ra;
      const fb = props(itemsB, cb);
      const fa = props(itemsA, ca);
      for (const n of Object.keys(fb)) {
        if (!fa[n]) breaking.push({ kind: 'response-field-removed', target: key, detail: `response field ${n} removed` });
        else if (fb[n].type !== fa[n].type) breaking.push({ kind: 'response-field-type-changed', target: key, detail: `response field ${n}: ${fb[n].type} -> ${fa[n].type}` });
      }
      for (const n of Object.keys(fa)) if (!fb[n]) additive.push({ kind: 'response-field-added', target: key, detail: `response field ${n}` });
    }
    const codesB = Object.keys(b.responses || {});
    const codesA = new Set(Object.keys(a.responses || {}));
    for (const c of codesB) if (!codesA.has(c) && c !== 'default') breaking.push({ kind: 'status-removed', target: key, detail: `response ${c} no longer documented` });
  }
  return { breaking, additive };
}

/** Compare two signature dumps (file::name -> {params, returns}). */
function diffSignatures(before, after) {
  const breaking = [];
  const additive = [];
  for (const [name, sb] of Object.entries(before)) {
    if (name.endsWith('<parse-error>')) continue;
    const sa = after[name];
    if (!sa) { breaking.push({ kind: 'function-removed', target: name, detail: 'the function no longer exists at the top level' }); continue; }
    if (sa.error) continue;
    const pb = Object.fromEntries(sb.params.map((p) => [p.name, p]));
    const pa = Object.fromEntries(sa.params.map((p) => [p.name, p]));
    for (const [n, p] of Object.entries(pa)) {
      if (!pb[n] && !p.default && p.kind !== 'var') breaking.push({ kind: 'parameter-required-added', target: name, detail: `parameter ${n} has no default` });
      else if (!pb[n]) additive.push({ kind: 'parameter-added', target: name, detail: `parameter ${n}` });
    }
    for (const n of Object.keys(pb)) if (!pa[n] && pb[n].kind !== 'var') breaking.push({ kind: 'parameter-removed', target: name, detail: `parameter ${n} removed` });
    const posB = sb.params.filter((p) => p.kind === 'positional').map((p) => p.name);
    const posA = sa.params.filter((p) => p.kind === 'positional').map((p) => p.name);
    if (posB.length === posA.length && posB.some((n, i) => posA[i] !== n && pa[n] && pb[posA[i]])) breaking.push({ kind: 'parameter-reordered', target: name, detail: `${posB.join(', ')} -> ${posA.join(', ')}` });
  }
  for (const name of Object.keys(after)) if (!before[name] && !name.endsWith('<parse-error>')) additive.push({ kind: 'function-added', target: name, detail: 'new top-level function' });
  return { breaking, additive };
}

function behaviorConfig(root) {
  return readJson(path.join(root, '.eccode', 'behavior.json'), {});
}

function sideEnv(cfg, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = String(v).replace(/\{tmp\}/g, tmp);
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

/**
 * Run the diff: the OpenAPI schema (when .eccode/behavior.json names the app)
 * and the signatures of the changed Python files, in both worktrees, recorded as api.diff.
 */
function diff(store, config, actor, { task, timeoutMs, python } = {}) {
  const state = store.state();
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  const base = state.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', 'The API diff needs the work item\'s git base commit');
  const cfg = behaviorConfig(store.root);
  const py = require('../lab').pythonFor(store.root, python || cfg.python);
  const fingerprint = require('../behavior').treeFingerprint(store.root, state);
  const evs = [];
  const notes = [];
  const result = { openapi: null, signatures: null };
  worktree.withSides(store.root, base, ({ baseline, candidate, changed }) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-api-'));
    try {
      const run = (side, label, command, env = {}) => {
        const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
        const ev = evidence.runCommand(store, actor, { label: `api: ${label}`, command: `${envPrefix ? `env ${envPrefix} ` : ''}sh -c ${sh(command)}`, task, purpose: 'check', timeoutMs: timeoutMs || 600000, externalCwd: side.root, cwdLabel: `${label} worktree`, extra: { api: label } });
        evs.push(ev.id);
        if (ev.integrity) throw new EccodeError('INTEGRITY', `api ${label}: ${ev.integrity.join('; ')}`);
        return ev;
      };
      if (cfg.app) {
        const docs = {};
        for (const [name, side] of [['baseline', baseline], ['candidate', candidate]]) {
          const sideTmp = fs.mkdtempSync(path.join(work, `${name}-`));
          const out = path.join(work, `${name}-openapi.json`);
          const setup = cfg.setup ? `${cfg.setup} && ` : '';
          const ev = run(side, `openapi ${name}`, `${setup}${sh(py)} ${sh(OPENAPI_SCRIPT)} ${sh(cfg.app)} > ${sh(out)}`, sideEnv(cfg, sideTmp));
          if (!exists(out) || ev.exitCode !== 0) throw new EccodeError('GUARD_FAILED', `the ${name} OpenAPI dump failed (ev:${ev.id}):\n${ev.outputTail}`);
          docs[name] = JSON.parse(fs.readFileSync(out, 'utf8'));
        }
        result.openapi = diffOpenapi(docs.baseline, docs.candidate);
      } else notes.push('no app configured in .eccode/behavior.json: OpenAPI not compared');
      const pyFiles = changed.filter((f) => f.endsWith('.py') && !lean.TEST.test(f) && exists(path.join(candidate.root, f)));
      const pyFilesBase = changed.filter((f) => f.endsWith('.py') && !lean.TEST.test(f) && exists(path.join(baseline.root, f)));
      if (pyFiles.length || pyFilesBase.length) {
        const dumps = {};
        for (const [name, side, files] of [['baseline', baseline, pyFilesBase], ['candidate', candidate, pyFiles]]) {
          const out = path.join(work, `${name}-signatures.json`);
          if (!files.length) { dumps[name] = {}; continue; }
          const ev = run(side, `signatures ${name}`, `${sh(py)} ${sh(SIGNATURE_SCRIPT)} ${files.map(sh).join(' ')} > ${sh(out)}`);
          if (!exists(out) || ev.exitCode !== 0) throw new EccodeError('GUARD_FAILED', `the ${name} signature dump failed (ev:${ev.id}):\n${ev.outputTail}`);
          dumps[name] = JSON.parse(fs.readFileSync(out, 'utf8'));
        }
        result.signatures = diffSignatures(dumps.baseline, dumps.candidate);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  const breaking = [...((result.openapi && result.openapi.breaking) || []).map((b) => ({ ...b, surface: 'http' })), ...((result.signatures && result.signatures.breaking) || []).map((b) => ({ ...b, surface: 'function' }))];
  const additive = [...((result.openapi && result.openapi.additive) || []).map((b) => ({ ...b, surface: 'http' })), ...((result.signatures && result.signatures.additive) || []).map((b) => ({ ...b, surface: 'function' }))];
  const id = newId('api');
  const rel = `.eccode/guards/${id}.json`;
  const text = JSON.stringify({ id, breaking, additive, notes, evidence: evs }, null, 2) + '\n';
  fs.mkdirSync(path.join(store.root, '.eccode', 'guards'), { recursive: true });
  writeFileAtomic(path.join(store.root, rel), text);
  const data = { id, classification: breaking.length ? 'breaking' : additive.length ? 'additive' : 'none', breaking, additive, notes, evidence: evs, treeFingerprint: fingerprint, artifact: rel, artifactSha256: sha256(text), ...(task ? { task } : {}) };
  return store.commit('api.diff', actor, data, (s) => { if (!s.work || s.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', 'No active work item'); }).event.data;
}

/** A breaking entry as the interface key the design and the contract must name. */
function interfaceKey(b) {
  return b.surface === 'http' ? `http ${b.target}` : `function ${b.target}`;
}

/** Delivery problems when the api guard is required: a fresh diff; every breaking change declared in the design and in the behavior contract. */
function deliveryProblems(state, root) {
  if (!state.work || !state.guards) return [];
  const fp = require('../behavior').treeFingerprint(root, state);
  const d = [...state.guards.api].reverse().find((x) => x.treeFingerprint === fp);
  if (!d) return ['api guard: no API diff matches the current tree (eccode guard api --actor <owner>)'];
  if (!d.breaking.length) return [];
  const problems = [];
  const waived = new Set(state.guards.waivers.filter((w) => w.guard === 'api' && w.result === d.id).map((w) => w.finding));
  const open = d.breaking.filter((b) => !waived.has(`${b.kind}:${b.target}`));
  if (!open.length) return [];
  // In the design: the interfaces of the decision or an amendment.
  problems.push(...require('../design').interfaceProblems(state, open.map(interfaceKey)));
  // In the behavior contract (fix, feature and refactor): a contract entry for every breaking target.
  const contracts = (state.behavior && state.behavior.contracts) || [];
  const matches = (b) => contracts.some((c) => c.entries.some((e) => require('../behavior').targetMatches(e, { surface: b.surface, target: b.target })));
  const undeclared = open.filter((b) => !matches(b));
  if (undeclared.length) problems.push(`api guard: breaking change(s) not declared in the behavior contract: ${undeclared.map((b) => `${b.kind} ${b.target} (${b.detail})`).join('; ')}. Declare them (eccode behavior contract) and in the design (eccode design amend), or a reviewer waives each (eccode guard waive --guard api --result ${d.id} --finding "<kind>:<target>")`);
  return problems;
}

function reportLines(state) {
  const list = (state.guards && state.guards.api) || [];
  if (!list.length) return [];
  const lines = ['## API compatibility', ''];
  for (const d of list) lines.push(`- Diff ${d.id}: ${d.classification}; ${d.breaking.length} breaking (${d.breaking.map((b) => `${b.kind} ${b.target}`).join(', ') || 'none'}), ${d.additive.length} additive${d.notes.length ? `; notes: ${d.notes.join('; ')}` : ''}`);
  lines.push('');
  return lines;
}

module.exports = { diffOpenapi, diffSignatures, diff, deliveryProblems, reportLines, interfaceKey };
