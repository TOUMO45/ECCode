'use strict';
// Behavior diff (Phase 2). Before a fix, feature or refactor is delivered,
// the engine knows which observable behaviour changed: the baseline (the
// work item's base commit) and the candidate (the working tree) run the same
// probe corpus in two isolated worktrees, outputs are normalized, fields that
// differ between two baseline runs are excluded as nondeterministic, and every
// remaining difference is classified against the declared behaviour contract.
// An unexplained difference refuses delivery unless a reviewer amends the
// contract; a refactor explains nothing; a result is stale once the tree
// changes; the reviewer re-runs the diff; a result that reached no probe is
// labelled insufficient-coverage and never passes silently; a contract
// declared after a result exists is refused.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const evidence = require('./evidence');
const { git, gitHead, gitChangedFiles } = require('./project');
const { EccodeError, newId, sha256, sha256File, writeFileAtomic, toPosix, exists, readJson } = require('./util');
const lean = require('./lean');
const bugs = require('./bugs');
const compat = require('./compat');

const DIFF_TRACKS = new Set(['fix', 'feature', 'refactor']);
const SURFACES = new Set(['http', 'function', 'cli']);
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];
const CLI_ENTRY = /^if\s+__name__\s*==\s*['"]__main__['"]|^\s*(?:import|from)\s+(?:argparse|click|typer)\b|^\s*(?:import|from)\s+sys\b[\s\S]*sys\.argv/m;
const SCHEMA = /\bCREATE\s+TABLE\b|\bColumn\s*\(|\bmapped_column\s*\(|\b__tablename__\b/;

// Default normalizers: timestamps, UUIDs, memory addresses, durations.
const NORMALIZERS = [
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: '<uuid>' },
  { name: 'iso-timestamp', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, to: '<timestamp>' },
  { name: 'address', re: /\b0x[0-9a-fA-F]{6,}\b/g, to: '<address>' },
  { name: 'object-at', re: /<([\w.]+) object at <address>>/g, to: '<$1 object>' },
];

function onDiffTrack(state) {
  return Boolean(state.behavior && state.work && DIFF_TRACKS.has(state.work.track) && state.work.status === 'active');
}

function assertDiffTrack(state) {
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  if (!DIFF_TRACKS.has(state.work.track)) throw new EccodeError('TRACK_RULE', `The behavior diff runs on fix, feature and refactor work items; ${state.work.id} is on the ${state.work.track} track (quick and debug skip it by design)`);
  if (state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', `Work item ${state.work.id} is ${state.work.status}`);
}

function assertReviewer(config, actor, what) {
  const allowed = [...new Set([...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];
  if (!allowed.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not ${what}; reviewers: ${allowed.join(', ')}`);
}

function behaviorConfig(root) {
  return readJson(path.join(root, '.eccode', 'behavior.json'), {});
}

function pythonFor(root, flag) {
  return require('./lab').pythonFor(root, flag);
}

/** Files changed since the work item's base, outside the record. */
function changedFiles(root, state) {
  const base = state.work && state.work.baseCommit;
  return ((base && gitChangedFiles(root, base)) || []).map(toPosix).filter((f) => !f.startsWith('.eccode/'));
}

/** sha256 over the changed files' paths and contents: the identity of the candidate tree. */
function treeFingerprint(root, state) {
  const parts = changedFiles(root, state).sort().map((f) => {
    const abs = path.join(root, f);
    return `${f}\t${exists(abs) && fs.statSync(abs).isFile() ? sha256File(abs) : 'deleted'}`;
  });
  return sha256(parts.join('\n'));
}

// ------------------------------------------------------------ routing

/**
 * The public surfaces a change reaches: HTTP routes declared in changed or
 * dependent files, non-test definitions other files import, CLI entry points
 * and database schema, plus whatever impact names. Honest reading: almost
 * every code change reaches one; quick is the track for the ones that may
 * skip the diff.
 */
function surfacesOf(root, state) {
  const changed = changedFiles(root, state);
  const code = changed.filter((f) => bugs.isCode(f) && !lean.TEST.test(f));
  const surfaces = [];
  let dependents = [];
  const dependentsOf = new Map();
  if (code.length) {
    try {
      const { impact } = require('./codebase');
      dependents = impact(root, code).dependents.map((d) => d.file);
      for (const f of code) dependentsOf.set(f, impact(root, [f]).dependents.length);
    } catch {
      dependents = [];
    }
  }
  const base = state.work && state.work.baseCommit;
  for (const f of code) {
    const now = lean.readText(root, f) || '';
    const before = (base && git(root, ['show', `${base}:${f}`])) || '';
    const routes = [...new Set([...compat.routesIn(f, now), ...compat.routesIn(f, before)])];
    for (const r of routes) surfaces.push({ kind: 'http', target: r, file: f });
    if (compat.MIGRATION_FILE.test(f) || SCHEMA.test(now) || SCHEMA.test(before)) surfaces.push({ kind: 'schema', target: f, file: f });
    if (CLI_ENTRY.test(now) || /^bin\//.test(f)) surfaces.push({ kind: 'cli', target: f, file: f });
    const importedElsewhere = (dependentsOf.get(f) || 0) > 0;
    const defs = f.endsWith('.py') || /\.(js|ts|mjs|cjs)$/.test(f) ? lean.definedNames(f, now) : [];
    if (importedElsewhere && defs.length) for (const d of defs) surfaces.push({ kind: 'function', target: `${f}::${d}`, file: f });
  }
  // Routes declared in dependents (a changed helper reaches them).
  for (const d of dependents.filter((f) => !lean.TEST.test(f))) {
    for (const r of compat.routesIn(d, lean.readText(root, d) || '')) surfaces.push({ kind: 'http', target: r, file: d, via: 'dependent' });
  }
  const seen = new Set();
  return { changed, code, dependents, surfaces: surfaces.filter((s) => !seen.has(`${s.kind} ${s.target}`) && seen.add(`${s.kind} ${s.target}`)) };
}

function route(store, config, actor) {
  const pre = store.state();
  assertDiffTrack(pre);
  const { changed, code, surfaces } = surfacesOf(store.root, pre);
  const decision = surfaces.length ? 'run' : 'skip';
  const reasons = surfaces.length
    ? [`the change reaches ${surfaces.length} public surface(s): ${surfaces.slice(0, 8).map((s) => `${s.kind} ${s.target}`).join(', ')}${surfaces.length > 8 ? ', …' : ''}`]
    : [code.length ? `no public surface found in ${code.length} changed code file(s) (no route, no definition imported elsewhere, no CLI entry, no schema)` : `no code file changed (${changed.length} file(s) changed)`];
  const data = { id: newId('rt'), decision, reasons, surfaces: surfaces.slice(0, 200), changedFiles: changed.slice(0, 200), treeFingerprint: treeFingerprint(store.root, pre) };
  store.commit('behavior.routing', actor, data, (state) => assertDiffTrack(state));
  return data;
}

// ----------------------------------------------------------- contract

function validEntries(entries) {
  const list = Array.isArray(entries) ? entries : entries && Array.isArray(entries.entries) ? entries.entries : null;
  if (!list || !list.length) throw new EccodeError('INVALID_INPUT', 'A behaviour contract is a non-empty list of entries {surface: http|function|cli, target, inputClass, expected}');
  return list.map((e, i) => {
    if (!e || typeof e !== 'object') throw new EccodeError('INVALID_INPUT', `entry ${i}: not an object`);
    if (!SURFACES.has(e.surface)) throw new EccodeError('INVALID_INPUT', `entry ${i}: surface must be http, function or cli`);
    for (const k of ['target', 'inputClass', 'expected']) if (typeof e[k] !== 'string' || e[k].trim().length < (k === 'target' ? 1 : 5)) throw new EccodeError('INVALID_INPUT', `entry ${i}: ${k} is required${k === 'target' ? '' : ' (>= 5 chars)'}`);
    return { surface: e.surface, target: e.target.trim(), inputClass: e.inputClass.trim(), expected: e.expected.trim() };
  });
}

/** Declare the intended behaviour changes, before any diff result exists. */
function contract(store, config, actor, entries) {
  const list = validEntries(entries);
  const authors = [...new Set([...config.roles.design.authors, ...config.roles.plan.authors, ...config.roles.phase.authors, 'orchestrator'])];
  if (!authors.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not declare the behaviour contract; authors: ${authors.join(', ')}`);
  return store.commit('behavior.contract', actor, { id: newId('bc'), entries: list }, (state) => {
    assertDiffTrack(state);
    if (state.work.track === 'refactor') throw new EccodeError('CONTRACT_REFUSED', 'A refactor declares no behaviour change: every difference the diff finds is unexplained by definition. Run it as a fix or feature work item if behaviour must change.');
    if (state.behavior.results.length) throw new EccodeError('CONTRACT_AFTER_DIFF', `A behaviour contract is declared before the diff runs; ${state.behavior.results.length} result(s) exist already (${state.behavior.results[state.behavior.results.length - 1].id}). An unexplained difference is explained only by a reviewer's amendment: eccode behavior amend --result <id> --file <entries.json> --reason "<why>" --actor <reviewer>.`);
  }).event.data;
}

function amend(store, config, actor, { result, entries, reason } = {}) {
  assertReviewer(config, actor, 'amend the behaviour contract');
  const list = validEntries(entries);
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new EccodeError('INVALID_INPUT', '--reason (>= 10 chars) says why each difference is accepted');
  return store.commit('behavior.contract.amended', actor, { id: newId('bca'), amends: result, entries: list, reason: reason.trim() }, (state) => {
    assertDiffTrack(state);
    const r = state.behavior.results.find((x) => x.id === result);
    if (!r) throw new EccodeError('NOT_FOUND', `Unknown behaviour diff result ${result}`);
    if (r.by === actor) throw new EccodeError('ROLE_NOT_ALLOWED', 'The reviewer who amends the contract is not the one whose run produced the result it amends');
  }).event.data;
}

function waive(store, config, actor, { result, reason } = {}) {
  assertReviewer(config, actor, 'waive probe coverage');
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new EccodeError('INVALID_INPUT', '--reason (>= 10 chars) says why the uncovered surface is acceptable');
  return store.commit('behavior.waiver', actor, { id: newId('bw'), result, reason: reason.trim() }, (state) => {
    assertDiffTrack(state);
    const r = state.behavior.results.find((x) => x.id === result);
    if (!r) throw new EccodeError('NOT_FOUND', `Unknown behaviour diff result ${result}`);
    if (r.coverage !== 'insufficient-coverage') throw new EccodeError('INVALID_TRANSITION', `Result ${result} has coverage ${r.coverage}; only insufficient-coverage is waived`);
  }).event.data;
}

// ------------------------------------------------------- normalization

function normalizeValue(value, normalizers, ignore, unordered, at = '$') {
  if (typeof value === 'string') {
    let s = value;
    for (const n of normalizers) s = s.replace(n.re, n.to);
    return s;
  }
  if (Array.isArray(value)) {
    const items = value.map((v, i) => normalizeValue(v, normalizers, ignore, unordered, `${at}[${i}]`));
    return unordered.has(at) ? [...items].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (ignore.has(k)) continue;
      out[k] = normalizeValue(value[k], normalizers, ignore, unordered, `${at}.${k}`);
    }
    return out;
  }
  return value;
}

/** Leaf paths whose values differ between two normalized outputs. */
function diffPaths(a, b, at = '$', out = []) {
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    out.push({ path: at, baseline: a, candidate: b });
    return out;
  }
  const keys = ta === 'array' ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) diffPaths(a === undefined ? undefined : a[k], b === undefined ? undefined : b[k], ta === 'array' ? `${at}[${k}]` : `${at}.${k}`, out);
  return out;
}

/** Remove the nondeterministic paths from a normalized output. */
function withoutPaths(value, paths) {
  if (!paths.length) return value;
  const clone = JSON.parse(JSON.stringify(value === undefined ? null : value));
  for (const p of paths) {
    const parts = p.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '');
    let cur = clone;
    for (let i = 0; i < parts.length - 1 && cur; i++) cur = cur[parts[i]];
    if (cur && typeof cur === 'object') {
      const last = parts[parts.length - 1];
      if (Array.isArray(cur)) cur[Number(last)] = '<nondeterministic>';
      else cur[last] = '<nondeterministic>';
    }
  }
  return clone;
}

// --------------------------------------------------------------- diff

function targetMatches(entry, probe) {
  if (entry.surface !== probe.surface) return false;
  const t = entry.target;
  if (probe.surface === 'http') {
    const [m, p] = probe.target.split(' ');
    const [em, ep] = t.includes(' ') ? t.split(' ') : ['ANY', t];
    if (em !== 'ANY' && em.toUpperCase() !== m) return false;
    return ep === p || ep === '*' || (ep.endsWith('*') && p.startsWith(ep.slice(0, -1)));
  }
  return t === probe.target || probe.target.endsWith(`::${t}`) || t === '*';
}

function worktreeAt(root, sha, label) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-behavior-${label}-`));
  const wt = path.join(tmp, label);
  if (git(top, ['worktree', 'add', '--detach', '--quiet', wt, sha]) === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new EccodeError('GIT_FAILED', `Could not create the ${label} worktree at ${sha.slice(0, 12)}`);
  }
  const treeRoot = path.join(wt, prefix);
  for (const d of DEP_DIRS) {
    if (exists(path.join(root, d)) && !exists(path.join(treeRoot, d))) fs.symlinkSync(path.join(root, d), path.join(treeRoot, d), process.platform === 'win32' ? 'junction' : 'dir');
  }
  // The project's behavior configuration travels with the tree, never the record.
  const cfg = path.join(root, '.eccode', 'behavior.json');
  if (exists(cfg)) {
    fs.mkdirSync(path.join(treeRoot, '.eccode'), { recursive: true });
    fs.copyFileSync(cfg, path.join(treeRoot, '.eccode', 'behavior.json'));
  }
  const remove = () => {
    git(top, ['worktree', 'remove', '--force', wt]);
    git(top, ['worktree', 'prune']);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { root: treeRoot, tmp, remove };
}

/** The working tree's changes laid over a worktree at HEAD: the candidate. */
function overlay(root, treeRoot, files) {
  for (const f of files) {
    const src = path.join(root, f);
    const dst = path.join(treeRoot, f);
    if (exists(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else fs.rmSync(dst, { force: true });
  }
}

function sideEnv(cfg, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = String(v).replace(/\{tmp\}/g, tmp);
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.ECCODE_BEHAVIOR_TMP = tmp;
  return env;
}

function q(a) {
  return /^[\w./:@+=,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`;
}

/**
 * Run the diff: two worktrees, a corpus generated in the baseline, the
 * baseline run `runs` times and the candidate once, normalized, compared and
 * classified. Returns the recorded result.
 */
function diff(store, config, actor, { runs, python, task, timeoutMs } = {}) {
  const root = store.root;
  const pre = store.state();
  assertDiffTrack(pre);
  const cfg = behaviorConfig(root);
  const py = pythonFor(root, python || cfg.python);
  const base = pre.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', 'The behavior diff needs the work item\'s git base commit');
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!baseSha) throw new EccodeError('NOT_FOUND', `Unknown base ${base}`);
  const head = gitHead(root);
  const { changed, surfaces } = surfacesOf(root, pre);
  const fingerprint = treeFingerprint(root, pre);
  const routes = surfaces.filter((s) => s.kind === 'http').map((s) => ({ method: s.target.split(' ')[0], path: s.target.split(' ')[1] }));
  const functions = surfaces.filter((s) => s.kind === 'function' && s.target.endsWith('.py') === false && /\.py::/.test(s.target)).map((s) => s.target);
  const baselineRuns = Math.max(2, Number(runs || config.behavior.baselineRuns));
  const script = path.join(__dirname, '..', 'scripts', 'behavior', 'probe_runner.py');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-behavior-'));
  const evs = [];
  let corpus;
  const outputs = { baseline: [], candidate: null };
  const notes = [];
  const baseline = worktreeAt(root, baseSha, 'baseline');
  const candidate = worktreeAt(root, head, 'candidate');
  try {
    overlay(root, candidate.root, changed);
    fs.writeFileSync(path.join(work, 'routes.json'), JSON.stringify(routes));
    fs.writeFileSync(path.join(work, 'functions.json'), JSON.stringify(functions));
    const cfgPath = (side) => path.join(side.root, '.eccode', 'behavior.json');
    const runProbe = (side, label, args, extraEnv) => {
      const sideTmp = fs.mkdtempSync(path.join(work, `${label.replace(/[^\w]+/g, '-')}-`));
      const env = { ...sideEnv(cfg, sideTmp), ...extraEnv };
      const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
      const setup = cfg.setup ? `${cfg.setup} && ` : '';
      const command = `${envPrefix ? `env ${envPrefix} ` : ''}sh -c ${q(`${setup}${q(py)} ${q(script)} ${args.map(q).join(' ')}`)}`;
      const ev = evidence.runCommand(store, actor, { label: `behavior: ${label}`, command, task, purpose: 'check', timeoutMs: timeoutMs || 1200000, externalCwd: side.root, cwdLabel: `${label} worktree`, extra: { behavior: label } });
      evs.push(ev.id);
      if (ev.integrity) throw new EccodeError('INTEGRITY', `behavior ${label}: ${ev.integrity.join('; ')}`);
      return ev;
    };
    const corpusFile = path.join(work, 'corpus.json');
    const gen = runProbe(baseline, 'generate corpus', ['generate', '--config', cfgPath(baseline), '--routes', path.join(work, 'routes.json'), '--functions', path.join(work, 'functions.json'), '--out', corpusFile]);
    if (!exists(corpusFile)) throw new EccodeError('BEHAVIOR_FAILED', `Probe generation produced no corpus (ev:${gen.id}, exit ${gen.exitCode}):\n${gen.outputTail}`);
    corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
    notes.push(...(corpus.errors || []));
    for (let k = 1; k <= baselineRuns; k++) {
      const out = path.join(work, `baseline-${k}.json`);
      const ev = runProbe(baseline, `baseline run ${k}`, ['run', '--config', cfgPath(baseline), '--corpus', corpusFile, '--out', out]);
      if (!exists(out)) throw new EccodeError('BEHAVIOR_FAILED', `Baseline run ${k} produced no output (ev:${ev.id}):\n${ev.outputTail}`);
      const r = JSON.parse(fs.readFileSync(out, 'utf8'));
      notes.push(...(r.errors || []).map((e) => `baseline run ${k}: ${e}`));
      outputs.baseline.push(r.results);
    }
    const out = path.join(work, 'candidate.json');
    const ev = runProbe(candidate, 'candidate run', ['run', '--config', cfgPath(candidate), '--corpus', corpusFile, '--out', out]);
    if (!exists(out)) throw new EccodeError('BEHAVIOR_FAILED', `The candidate run produced no output (ev:${ev.id}):\n${ev.outputTail}`);
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    notes.push(...(r.errors || []).map((e) => `candidate: ${e}`));
    outputs.candidate = r.results;
  } finally {
    baseline.remove();
    candidate.remove();
    fs.rmSync(work, { recursive: true, force: true });
  }
  // The candidate must still be the tree that was diffed.
  if (treeFingerprint(root, store.state()) !== fingerprint) throw new EccodeError('STALE', 'The working tree changed while the behavior diff ran; run it again');

  const normalizers = [...NORMALIZERS, ...((cfg.normalizers || []).map((n, i) => ({ name: n.name || `custom-${i}`, re: new RegExp(n.pattern, n.flags || 'g'), to: n.replace === undefined ? '<normalized>' : n.replace })))];
  const ignore = new Set(cfg.ignoreFields || []);
  const unordered = new Set(cfg.unordered || []);
  const norm = (v) => normalizeValue(v, normalizers, ignore, unordered);
  const probes = corpus.probes || [];
  const differences = [];
  const nondeterministic = [];
  let dropped = 0;
  let executed = 0;
  for (const p of probes) {
    const b = outputs.baseline.map((run) => run[p.id]);
    const c = outputs.candidate[p.id];
    if (b.some((x) => x === undefined) || c === undefined) continue;
    executed += 1;
    const nb = b.map(norm);
    const nc = norm(c);
    // Flakiness: fields that differ between baseline runs are excluded.
    const flaky = new Set();
    for (let k = 1; k < nb.length; k++) for (const d of diffPaths(nb[0], nb[k])) flaky.add(d.path);
    if (flaky.has('$') || (flaky.size && ['status', 'exception', 'returned'].some((k) => flaky.has(`$.${k}`)))) {
      dropped += 1;
      nondeterministic.push({ probe: p.id, dropped: true, paths: [...flaky] });
      continue;
    }
    if (flaky.size) nondeterministic.push({ probe: p.id, dropped: false, paths: [...flaky] });
    const paths = [...flaky];
    const left = withoutPaths(nb[0], paths);
    const right = withoutPaths(nc, paths);
    const ds = diffPaths(left, right);
    if (!ds.length) continue;
    differences.push({ probe: p.id, surface: p.surface, target: p.target, role: p.role || null, input: p.input, baseline: left, candidate: right, paths: ds.slice(0, 50), sha256: sha256(JSON.stringify({ input: p.input, baseline: left, candidate: right })) });
  }
  // Classification against the contract (and reviewer amendments).
  const entries = pre.work.track === 'refactor' ? [] : [...pre.behavior.contracts.flatMap((c) => c.entries.map((e) => ({ ...e, from: c.id }))), ...pre.behavior.amendments.flatMap((a) => a.entries.map((e) => ({ ...e, from: a.id })))];
  for (const d of differences) {
    const match = entries.find((e) => targetMatches(e, d));
    d.classification = match ? 'expected' : 'unexplained';
    d.contract = match ? match.from : null;
  }
  const unexplained = differences.filter((d) => d.classification === 'unexplained').length;
  const surfaceTargets = new Set(surfaces.map((s) => `${s.kind} ${s.target}`));
  const reached = probes.filter((p) => outputs.candidate[p.id] !== undefined && (surfaceTargets.has(`${p.surface} ${p.target}`) || surfaceTargets.has(`http ANY ${(p.target || '').split(' ')[1]}`))).length;
  const coverage = executed > 0 && (reached > 0 || !surfaces.length) ? 'ok' : 'insufficient-coverage';
  const coverageNote = coverage === 'ok' ? null : (executed === 0 ? `no probe executed (${notes[0] || 'no probe generated'})` : `no probe reached the ${surfaces.length} impacted surface(s)`);
  const id = newId('bd');
  const artifactRel = `.eccode/behavior/${id}.json`;
  const artifact = { id, base: baseSha, head, treeFingerprint: fingerprint, probes: probes.length, executed, dropped, surfaces, corpusSha256: sha256(JSON.stringify(corpus)), nondeterministic, differences, notes, outputs: { baseline: outputs.baseline[0], candidate: outputs.candidate } };
  const text = JSON.stringify(artifact, null, 2) + '\n';
  writeFileAtomic(path.join(root, artifactRel), text);
  const data = {
    id, base: baseSha, head, treeFingerprint: fingerprint, probes: probes.length, executed, dropped, reached,
    nondeterministic: nondeterministic.slice(0, 100),
    differences: differences.map((d) => ({ probe: d.probe, surface: d.surface, target: d.target, role: d.role, input: d.input, paths: d.paths.slice(0, 10), sha256: d.sha256, classification: d.classification, contract: d.contract })).slice(0, 200),
    unexplained, expected: differences.length - unexplained, coverage, coverageNote,
    evidence: evs, notes: notes.slice(0, 50), track: pre.work.track, task: task || null,
    artifact: artifactRel, artifactSha256: sha256(text),
  };
  store.commit('behavior.diff.result', actor, data, (state) => assertDiffTrack(state));
  return data;
}

// -------------------------------------------------------------- gates

function latestResult(state) {
  const rs = state.behavior.results;
  return rs.length ? rs[rs.length - 1] : null;
}

/** Unexplained differences of a result not yet covered by an amendment. */
function stillUnexplained(state, r) {
  const amended = state.behavior.amendments.filter((a) => a.amends === r.id).flatMap((a) => a.entries);
  return r.differences.filter((d) => d.classification === 'unexplained' && !amended.some((e) => targetMatches(e, d)));
}

/**
 * The track rules of the diff, checked when the last gate is submitted and at
 * delivery: routing recorded and still true, a fresh result with nothing
 * unexplained, coverage ok or waived.
 */
function trackProblems(state, root) {
  if (!onDiffTrack(state)) return [];
  const problems = [];
  const routing = state.behavior.routing;
  if (!routing) return ['behavior: no risk routing recorded for this work item. Run eccode behavior route --actor <any role>; it records whether the change reaches a public surface and the diff must run.'];
  const now = root ? surfacesOf(root, state) : null;
  if (routing.decision === 'skip') {
    if (now && now.surfaces.length) problems.push(`behavior: routing recorded skip, but the change now reaches ${now.surfaces.length} public surface(s) (${now.surfaces.slice(0, 3).map((s) => `${s.kind} ${s.target}`).join(', ')}); run eccode behavior route again, then the diff`);
    return problems;
  }
  const r = latestResult(state);
  if (!r) return ['behavior: routing says the diff must run and no result is recorded. Run eccode behavior diff --actor <owner>.'];
  if (root && treeFingerprint(root, state) !== r.treeFingerprint) problems.push(`behavior: result ${r.id} is stale: the tree changed after the diff ran. Run eccode behavior diff again.`);
  const open = stillUnexplained(state, r);
  if (open.length) problems.push(`behavior: ${open.length} unexplained difference(s) in ${r.id}: ${open.slice(0, 5).map((d) => `${d.surface} ${d.target}${d.role ? ` as ${d.role}` : ''} (${d.paths.map((p) => p.path).slice(0, 3).join(', ')})`).join('; ')}${open.length > 5 ? '; …' : ''}. ${state.work.track === 'refactor' ? 'A refactor changes no behaviour: revert the change, or run it as a fix or feature.' : 'Declare intended changes before the diff (eccode behavior contract), or have a reviewer amend the contract (eccode behavior amend).'}`);
  if (r.coverage === 'insufficient-coverage' && !state.behavior.waivers.some((w) => w.result === r.id)) problems.push(`behavior: result ${r.id} has insufficient coverage (${r.coverageNote}); add probes (.eccode/behavior.json: app, roles, recorded requests) and run the diff again, or have a reviewer waive it (eccode behavior waive --result ${r.id})`);
  return problems;
}

/** The reviewer's own fresh run, required for a verification approval. */
function reviewProblems(state, root, gateId, reviewer, review, subAt) {
  if (!onDiffTrack(state) || gateId !== 'verification' || review.decision !== 'approve') return [];
  const routing = state.behavior.routing;
  if (!routing || routing.decision !== 'run') return [];
  const mine = state.behavior.results.filter((r) => r.by === reviewer && r.at >= subAt);
  if (!mine.length) return [`verification approval on the ${state.work.track} track requires the behavior diff re-run by the reviewer after submission (eccode behavior diff --actor ${reviewer})`];
  const r = mine[mine.length - 1];
  const problems = [];
  if (root && treeFingerprint(root, state) !== r.treeFingerprint) problems.push(`the reviewer's behavior diff ${r.id} is stale: the tree changed after it ran`);
  const open = stillUnexplained(state, r);
  if (open.length) problems.push(`the reviewer's behavior diff ${r.id} has ${open.length} unexplained difference(s); amend the contract (eccode behavior amend) or request changes`);
  return problems;
}

function deliveryProblems(state, root) {
  if (!onDiffTrack(state)) return [];
  return trackProblems(state, root);
}

// ------------------------------------------------------------- report

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function reportLines(state) {
  const b = state.behavior;
  if (!b || (!b.routing && !b.results.length)) return [];
  const lines = ['## Behavior diff', ''];
  if (b.routing) lines.push(`**Risk routing:** ${b.routing.decision} — ${mdEscape(b.routing.reasons.join('; '))}`, '');
  for (const c of b.contracts) lines.push(`**Declared behaviour changes (${c.id}, ${c.by}):** ${c.entries.map((e) => `${e.surface} ${e.target}: ${mdEscape(e.expected)}`).join('; ')}`, '');
  for (const r of b.results) {
    lines.push(`**Result ${r.id} (${r.by}, base ${r.base.slice(0, 12)}):** ${r.probes} probes, ${r.executed} executed, ${r.dropped} dropped as nondeterministic, ${r.differences.length} difference(s) (${r.expected} expected, ${r.unexplained} unexplained), coverage ${r.coverage}${r.coverageNote ? ` (${mdEscape(r.coverageNote)})` : ''}; artifact ${r.artifact}.`);
    if (r.differences.length) {
      lines.push('', '| Probe | Classification | Changed fields |', '|---|---|---|');
      for (const d of r.differences.slice(0, 40)) lines.push(`| ${mdEscape(d.probe)} | ${d.classification}${d.contract ? ` (${d.contract})` : ''} | ${mdEscape(d.paths.map((p) => `${p.path}: ${JSON.stringify(p.baseline)} → ${JSON.stringify(p.candidate)}`).join('; '))} |`);
    }
    lines.push('');
  }
  for (const a of b.amendments) lines.push(`**Contract amended by ${a.by} on ${a.amends}:** ${mdEscape(a.reason)} (${a.entries.map((e) => `${e.surface} ${e.target}`).join(', ')})`, '');
  for (const w of b.waivers) lines.push(`**Coverage waived by ${w.by} on ${w.result}:** ${mdEscape(w.reason)}`, '');
  return lines;
}

function show(state) {
  const b = state.behavior;
  const out = [];
  out.push(b.routing ? `Routing: ${b.routing.decision} (${b.routing.reasons.join('; ')})` : 'Routing: not recorded (eccode behavior route)');
  for (const c of b.contracts) out.push(`Contract ${c.id} by ${c.by}: ${c.entries.map((e) => `${e.surface} ${e.target} [${e.inputClass}] -> ${e.expected}`).join('; ')}`);
  for (const r of b.results) {
    out.push(`Result ${r.id} by ${r.by}: ${r.probes} probes, ${r.executed} executed, ${r.dropped} dropped, ${r.differences.length} differences (${r.unexplained} unexplained), coverage ${r.coverage}${r.coverageNote ? ` (${r.coverageNote})` : ''}`);
    for (const d of r.differences.slice(0, 30)) out.push(`  ${d.classification.padEnd(11)} ${d.probe}: ${d.paths.map((p) => `${p.path} ${JSON.stringify(p.baseline)} -> ${JSON.stringify(p.candidate)}`).join('; ')}`);
    for (const n of r.notes.slice(0, 10)) out.push(`  note: ${n}`);
  }
  for (const a of b.amendments) out.push(`Amendment ${a.id} by ${a.by} on ${a.amends}: ${a.reason}`);
  for (const w of b.waivers) out.push(`Waiver by ${w.by} on ${w.result}: ${w.reason}`);
  return out.join('\n');
}

module.exports = { DIFF_TRACKS, NORMALIZERS, onDiffTrack, surfacesOf, treeFingerprint, route, contract, amend, waive, diff, normalizeValue, diffPaths, withoutPaths, targetMatches, trackProblems, reviewProblems, deliveryProblems, stillUnexplained, reportLines, show };
