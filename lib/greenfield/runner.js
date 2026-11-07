'use strict';
// GF-RUN-2: the Greenfield runner (design 18.4). In a Greenfield-Senior project a group role has no shell (GF-RUN-1),
// so its commands run here: a command the plan pins (the frozen engine's approved list), or a pinned form of one of
// eight tools. The run goes through the frozen evidence runner, called through its exports object, whose integrity
// window fails a run that changes the record or a tracked file outside the caller's claimed ownership; this module
// adds the check of new untracked files outside the caller's group (reported, not a log event: L-GF-29).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { globsOverlap } = require('../util');
const evidence = require('../evidence');
const ownership = require('./ownership');
const { ruleError } = require('./errors');

const P = (message) => ({ rule: 'GF-RUN-2', message });
const WORD = /^[A-Za-z0-9_./:=,@+-]+$/;
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUM = /^[0-9]{1,4}$/;
const PATHV = /^(?!.*\.\.)[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const { CACHE } = require('./run-check');
const SERVE_SCRIPT = path.join(__dirname, 'serve-check.js');
const RUN_CHECK = path.join(__dirname, 'run-check.js');

function words(command) {
  const s = String(command == null ? '' : command);
  if (!s.trim()) return { problems: [P('a run names its command')] };
  if (s !== s.trim() || s.includes('  ') || !s.split(' ').every((w) => WORD.test(w))) {
    return { problems: [P(`"${s.replace(/\n/g, '\\n')}" contains shell syntax or a character other than letters, digits and _ . / : = , @ + -: the runner takes words separated by single spaces`)] };
  }
  return { words: s.split(' ') };
}

function projectPath(w, out) {
  if (w === '.') return '.';
  const n = ownership.normalizePath(w.split('::')[0]);
  if (n === null) { out.push(P(`${w} is outside the project or not a relative path`)); return null; }
  if (n === '.eccode' || n.startsWith('.eccode/')) { out.push(P(`${w} is part of the ECCode record`)); return null; }
  return n;
}

/** Flags of a pinned form: `true` takes no value, a RegExp is the `--flag=value` pattern, `{next}` takes the next word. */
function flagsAndPaths(ws, allowed, out, { paths: pathsOk = true } = {}) {
  const paths = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w.startsWith('-')) {
      const eq = w.indexOf('=');
      const name = eq > 0 ? w.slice(0, eq) : w;
      const spec = Object.prototype.hasOwnProperty.call(allowed, name) ? allowed[name] : undefined;
      if (spec === undefined) out.push(P(`flag ${name} is not in the pinned form`));
      else if (spec === true) { if (eq > 0) out.push(P(`flag ${name} takes no value`)); }
      else if (spec.next) { const v = ws[++i]; if (v === undefined || !spec.next.test(v)) out.push(P(`flag ${name} needs a value matching ${spec.next}`)); }
      else if (eq < 0 || !spec.test(w.slice(eq + 1))) out.push(P(`flag ${name} needs a value matching ${spec}`));
      continue;
    }
    if (!pathsOk) { out.push(P(`${w} is not an argument of the pinned form`)); continue; }
    const n = projectPath(w, out);
    if (n !== null) paths.push(n);
  }
  return paths;
}

const PYTEST = { '-q': true, '-x': true, '-v': true, '-rA': true, '--tb': /^(short|line|no)$/, '--maxfail': NUM, '-k': { next: ID }, '--cov': PATHV, '--cov-report': /^term$/ };
const REV = /^(head|heads|base|[+-][0-9]{1,3}|[0-9a-f]{4,40})$/;
const LIST = (names) => new RegExp(`^(${names})(,(${names}))*$`);

/** The pinned form a command is in: {tool, program, writes, migrations, serve, problems}. */
function parse(ws) {
  const out = [];
  const [w0, w1, w2] = ws;
  const notPinned = () => ({ problems: [P(`"${ws.join(' ')}" is not a pinned form of the runner (pytest, alembic, serve for uvicorn, ruff, semgrep, gitleaks, trivy, playwright; design 18.4)`)] });
  if (w0 === 'pytest') return { tool: 'pytest', program: 'pytest', paths: flagsAndPaths(ws.slice(1), PYTEST, out), problems: out };
  if ((w0 === 'python' || w0 === 'python3') && w1 === '-m' && w2 === 'pytest') return { tool: 'pytest', program: w0, paths: flagsAndPaths(ws.slice(3), PYTEST, out), problems: out };
  if (w0 === 'alembic') {
    if (['current', 'history', 'heads', 'check'].includes(w1) && ws.length === 2) return { tool: 'alembic', program: 'alembic', problems: out };
    if ((w1 === 'upgrade' || w1 === 'downgrade') && ws.length === 3 && REV.test(w2)) return { tool: 'alembic', program: 'alembic', problems: out };
    if (w1 === 'revision' && ws.length === 5 && w2 === '--autogenerate' && ws[3] === '-m' && ID.test(ws[4])) return { tool: 'alembic', program: 'alembic', migrations: true, problems: out };
    return { problems: [P(`"${ws.join(' ')}" is not a pinned alembic form (upgrade or downgrade <revision>, current, history, heads, check, revision --autogenerate -m <word>)`)] };
  }
  if (w0 === 'ruff' && w1 === 'check') {
    const paths = flagsAndPaths(ws.slice(2), { '--fix': true, '--output-format': /^(concise|full|json)$/ }, out);
    return { tool: 'ruff', program: 'ruff', writes: ws.includes('--fix') ? paths : null, form: 'ruff check --fix', problems: out };
  }
  if (w0 === 'ruff' && w1 === 'format') {
    const paths = flagsAndPaths(ws.slice(2), { '--check': true }, out);
    return { tool: 'ruff', program: 'ruff', writes: ws.includes('--check') ? null : paths, form: 'ruff format', problems: out };
  }
  if (w0 === 'semgrep' && w1 === 'scan') {
    if (!ws.includes('--metrics=off')) out.push(P('semgrep runs only with --metrics=off'));
    flagsAndPaths(ws.slice(2), { '--metrics': /^off$/, '--config': /^(?!.*\.\.)[A-Za-z0-9_./:@-]+$/, '--error': true, '--json': true }, out);
    return { tool: 'semgrep', program: 'semgrep', problems: out };
  }
  if (w0 === 'gitleaks' && w1 === 'detect') {
    if (!ws.includes('--redact')) out.push(P('gitleaks runs only with --redact, so that no secret reaches the evidence log'));
    flagsAndPaths(ws.slice(2), { '--redact': true, '--no-git': true, '--source': PATHV, '--report-format': /^json$/ }, out, { paths: false });
    return { tool: 'gitleaks', program: 'gitleaks', problems: out };
  }
  if (w0 === 'trivy' && w1 === 'fs') {
    const paths = flagsAndPaths(ws.slice(2), { '--scanners': LIST('vuln|secret|misconfig|license'), '--severity': LIST('UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL'), '--exit-code': NUM, '--offline-scan': true, '--quiet': true }, out);
    if (paths.length !== 1) out.push(P('trivy fs scans exactly one project path'));
    return { tool: 'trivy', program: 'trivy', problems: out };
  }
  if ((w0 === 'npx' && w1 === 'playwright' && w2 === 'test') || (w0 === 'playwright' && w1 === 'test')) {
    flagsAndPaths(ws.slice(w0 === 'npx' ? 3 : 2), { '--project': /^[A-Za-z0-9_-]+$/, '--reporter': /^(line|list|dot|json)$/, '--workers': NUM }, out);
    return { tool: 'playwright', program: w0, problems: out };
  }
  if (w0 === 'serve') {
    const port = Number(ws[3]);
    if (!/^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/.test(w1 || '')) out.push(P('serve names the app as <module>:<attribute>'));
    if (w2 !== '--port' || !/^[0-9]{4,5}$/.test(ws[3] || '') || port < 1024 || port > 65535) out.push(P('serve needs --port <n>, a port from 1024 to 65535'));
    const inner = ws[4] === '--' ? ws.slice(5) : [];
    if (!inner.length) out.push(P('serve ends with -- and a pytest or playwright form'));
    else {
      const f = parse(inner);
      if (f.tool !== 'pytest' && f.tool !== 'playwright') out.push(P(`serve runs a pytest or playwright form as its check, not "${inner.join(' ')}"`));
      else out.push(...f.problems);
    }
    return { tool: 'uvicorn', serve: { target: w1, port, check: inner }, problems: out };
  }
  return notPinned();
}

/**
 * The commands the plan pins: the frozen engine's approved list without its lab reproduction (round 6, F2-2): task
 * checks, the behaviour command and the detected stack checks. The lab flow is unaffected: its reproduction runs
 * through the frozen lab tools of the role that records it (the learning debugger, which is in no group).
 */
function planCommands(store, config) {
  const s = store.state();
  const out = new Set();
  for (const t of Object.values(s.tasks || {})) if (t.verification && typeof t.verification.command === 'string') out.add(t.verification.command.trim());
  if (s.work && typeof s.work.behaviorCommand === 'string') out.add(s.work.behaviorCommand.trim());
  try { for (const ch of require('../stack').checks(store.root, config)) if (ch.available && ch.command) out.add(String(ch.command).trim()); } catch { /* no detectable stack */ }
  return [...out].filter(Boolean);
}

function groupOf(store, config, role) {
  const loaded = require('./ownership-ops').loadMap(store, config);
  return loaded.map ? { map: loaded.map, group: ownership.groupOfRole(loaded.map, role) } : { problems: loaded.problems };
}

/** GF-RUN-2: the problems with running `command` as `role`; empty when it may run. */
function formProblems(store, config, role, command) {
  if (planCommands(store, config).includes(String(command).trim())) return []; // a command the plan pins
  const w = words(command);
  if (w.problems) return w.problems;
  const f = parse(w.words);
  if (f.problems.length) return f.problems;
  if (!f.writes && !f.migrations) return [];
  const out = [];
  const g = groupOf(store, config, role);
  if (!g.map) return g.problems.map((p) => P(`the ownership map cannot be loaded, so a writing form is refused: ${p.message}`));
  if (!g.group) return [P(`${f.form || 'alembic revision'} writes files: only a group role may run it, on its own group's paths (${role} is in no group)`)];
  // R3-1 (round 6): a path given to a writing form is judged as a directory: the caller's group must own it, and no
  // other group may own anything under it.
  const reach = (n, form) => {
    const base = n.replace(/\/+$/, '');
    const dir = n === '.' || !base ? '**' : `${base}/**`;
    const owner = (base && n !== '.' && ownership.ownerOfPath(g.map, base)) || ownership.ownerOfGlob(g.map, dir);
    if (owner !== g.group) return P(`${n} belongs to ${owner || 'no group'}, not to ${g.group}: ${form} writes only the caller's group's paths`);
    const others = Object.entries(g.map.groups).filter(([name, x]) => name !== g.group && globsOverlap([dir], x.globs)).map(([name]) => name);
    if (others.length) return P(`${n} reaches paths of ${others.join(' and ')}: ${form} takes a path as a directory, and every group with paths under it must be ${g.group}`);
    return null;
  };
  if (f.migrations) {
    const p = reach('migrations', 'alembic revision (it writes under migrations/)');
    return p ? [p] : [];
  }
  if (!f.writes.length) return [P(`${f.form} names the paths it writes (at least one, each inside ${g.group}'s paths)`)];
  for (const n of f.writes) { const p = reach(n, f.form); if (p) out.push(p); }
  return out;
}

const installed = (program) => spawnSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).status === 0;
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function serveCommand(s) {
  const py = process.env.ECCODE_GF_PYTHON || 'python3';
  if (!WORD.test(py)) throw ruleError([P('ECCODE_GF_PYTHON must be a path made of letters, digits and _ . / : = , @ + -')]);
  return [quote(process.execPath), quote(SERVE_SCRIPT), py, s.target, String(s.port), '--', ...s.check].join(' ');
}

/** Run `command` as `actor` through the frozen evidence runner. Returns {evidence, status, exitCode, outputTail, problems, ok}. */
function run(store, config, actor, input = {}) {
  const { label, command, purpose, task } = input;
  const refused = [...(typeof label === 'string' && label.trim() ? [] : [P('a run names its label')]), ...formProblems(store, config, actor, command)];
  if (refused.length) throw ruleError(refused);
  const w = words(command);
  const f = w.words ? parse(w.words) : { problems: ['not a pinned form'] };
  const pinnedForm = Boolean(w.words) && f.problems.length === 0;
  // A pinned form runs as its words (no shell); a command the plan pins runs as it was pinned, through sh.
  const inner = pinnedForm ? (f.serve ? serveCommand(f.serve) : w.words.join(' ')) : `sh -c ${quote(String(command).trim())}`;
  // F2-1 (round 6): the wrapper compares the files before and after, and fails a run that changed any file outside the
  // caller's group, whoever claims it; the frozen integrity window applies on top.
  const g = groupOf(store, config, actor);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-run-'));
  const spec = { group: g.group || null, role: actor, map: g.map || null, result: path.join(tmp, 'result.json') };
  fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(spec));
  const real = [quote(process.execPath), quote(RUN_CHECK), quote(path.join(tmp, 'spec.json')), '--', inner].join(' ');
  const ev = evidence.runCommand(store, actor, { label, command: real, purpose: purpose || 'check', task });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(spec.result, 'utf8')); } catch { /* the wrapper did not finish */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  const problems = [];
  if (ev.status !== 'passed' && f.program && !installed(f.program)) problems.push(P(`unverifiable here: ${f.program} is not installed`));
  if (res && res.outside === null) problems.push(P('git could not list the files before and after the run, so the run fails'));
  for (const p of (res && res.outside) || []) problems.push(P(`the run changed ${p}, which belongs to ${(g.map && ownership.ownerOfPath(g.map, p)) || 'no group'}, outside ${g.group ? `${g.group}'s paths` : `any group's paths (${actor} is in no group)`}: the run fails`));
  return { evidence: `ev:${ev.id}`, status: ev.status, exitCode: ev.exitCode, outputTail: ev.outputTail, problems, ok: ev.status === 'passed' && problems.length === 0 };
}

module.exports = { formProblems, run, parse, words, planCommands };
