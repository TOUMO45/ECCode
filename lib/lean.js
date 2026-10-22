'use strict';
// Lean change discipline, enforced and measured (idea adapted from Ponytail,
// see NOTICE). Agents are asked to reuse before they write; the engine makes
// the costly kinds of "more" visible to the independent reviewer:
//   - every dependency a task adds is declared with a reason
//   - every deferred shortcut is marked in code and declared in the handoff
//   - code that changes without a test states why no test is needed
// It also measures what each task added and removed, maps what already exists
// (so reuse costs no search), and keeps a ledger of deferred shortcuts.
// Levels: off (nothing), lite (measure and warn), full (refuse), strict
// (also: dependencies pre-approved in the plan, markers name an upgrade trigger).

const fs = require('fs');
const path = require('path');
const { matchesAny, toPosix } = require('./util');
const { git } = require('./project');

const LEVELS = ['off', 'lite', 'full', 'strict'];
const SKIP_DIRS = /(^|\/)(\.git|\.eccode|node_modules|bower_components|vendor|dist|build|out|coverage|target|\.next|\.nuxt|\.venv|venv|__pycache__)(\/|$)/;
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|py|go|rs|rb|java|kt|kts|scala|cs|php|swift|c|cc|cpp|h|hpp|sh)$/;
const TEST = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$/;
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i;
const GENERATED = /\.(min|d|gen|generated|pb)\.[a-z]+$|(^|\/)(migrations|generated|__generated__)\//;
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/;
const MAX_TEXT_BYTES = 512 * 1024;
// A deferral marker in a code comment ("shortcut" or Ponytail's older "ponytail" keyword),
// written as: <keyword>: <the limit>, <when to upgrade>.
const MARKER = /(?:\/\/|\/\*+|#|--|<!--|^\s*\*)\s*(?:shortcut|ponytail):\s*(.*?)\s*(?:\*\/|-->)?\s*$/;
const TRIGGER = /[,;]\s*\S|\b(when|until|once|if|after|before|upgrade)\b/i;

function levelOf(config) {
  return (config && config.lean && config.lean.level) || 'full';
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Dependency names compare case- and separator-insensitively (PEP 503 style). */
function norm(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/** Project files (tracked and untracked, .gitignore honored), posix paths relative to root. */
function listFiles(root) {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (out !== null) return [...new Set(out.split('\0').filter(Boolean))].filter((f) => !SKIP_DIRS.test(f));
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (SKIP_DIRS.test(rel)) continue;
      if (ent.isDirectory()) walk(rel);
      else if (ent.isFile()) files.push(rel);
    }
  })('');
  return files;
}

/** File content as text, or null for missing, large or binary files. */
function readText(root, rel) {
  try {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) return null;
    const buf = fs.readFileSync(abs);
    // Parsing only (hashes read bytes elsewhere): normalize CRLF checkouts.
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function pyRequirement(spec) {
  const s = spec.replace(/#.*/, '').trim();
  if (!s || s.startsWith('-')) return null; // -r, -e, --index-url …
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? norm(m[1]) : null;
}

function goRequires(text) {
  const names = [];
  let block = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) block = true;
    else if (block && line === ')') block = false;
    else {
      const m = block ? line.match(/^(\S+)\s+v\S+(.*)$/) : line.match(/^require\s+(\S+)\s+v\S+(.*)$/);
      if (m && !/\/\/\s*indirect/.test(m[2])) names.push(m[1]);
    }
  }
  return names;
}

// shortcut: line-based TOML reading (sections, keys, string arrays), not a full parser; switch to a real parser if manifests with inline tables or multi-line strings show up.
function tomlDependencies(cargo, text) {
  const names = [];
  let section = '';
  let inArray = false;
  const collect = (body) => {
    for (const m of body.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const n = pyRequirement(m[1] !== undefined ? m[1] : m[2]);
      if (n) names.push(n);
    }
    return !body.replace(/"[^"]*"|'[^']*'/g, '').includes(']');
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (inArray) {
      inArray = collect(line);
      continue;
    }
    const header = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (header) {
      section = header[1];
      const table = cargo && section.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/);
      if (table) names.push(table[1]);
      continue;
    }
    if (cargo) {
      const key = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section) && line.match(/^([\w-]+)\s*=/);
      if (key) names.push(key[1]);
    } else if ((section === 'project' && /^dependencies\s*=\s*\[/.test(line)) || (section === 'project.optional-dependencies' && /^[\w.-]+\s*=\s*\[/.test(line))) {
      inArray = collect(line.slice(line.indexOf('[') + 1));
    } else if (/^tool\.poetry\.(dependencies|dev-dependencies|group\.[\w-]+\.dependencies)$/.test(section)) {
      const key = line.match(/^([\w.-]+)\s*=/);
      if (key && key[1] !== 'python') names.push(norm(key[1]));
    }
  }
  return names;
}

/** Direct dependency names declared in a manifest file. */
function dependencyNames(file, text) {
  const base = path.posix.basename(toPosix(file));
  let names = [];
  if (base === 'package.json') {
    let pkg = null;
    try {
      pkg = JSON.parse(text);
    } catch {
      return [];
    }
    names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys((pkg && pkg[k]) || {}));
  } else if (base.startsWith('requirements')) names = text.split('\n').map(pyRequirement).filter(Boolean);
  else if (base === 'go.mod') names = goRequires(text);
  else if (base === 'Cargo.toml' || base === 'pyproject.toml') names = tomlDependencies(base === 'Cargo.toml', text);
  return [...new Set(names)].sort();
}

/** Deferral markers in a text: [{line, text}]. */
function markersIn(text) {
  const found = [];
  text.split('\n').forEach((l, i) => {
    const m = l.match(MARKER);
    if (m) found.push({ line: i + 1, text: m[1] });
  });
  return found;
}

function hasTrigger(markerText) {
  return TRIGGER.test(markerText);
}

/** Dependencies and markers inside a set of ownership globs; the baseline taken at claim time. */
function snapshot(root, globs) {
  const deps = {};
  const markers = {};
  for (const f of listFiles(root)) {
    if (!matchesAny(f, globs) || PROSE.test(f)) continue;
    const text = readText(root, f);
    if (text === null) continue;
    if (MANIFEST.test(f)) deps[f] = dependencyNames(f, text);
    const found = markersIn(text);
    if (found.length) markers[f] = found.map((m) => m.text);
  }
  return { deps, markers };
}

/** Baseline for a claim, or null when lean checks are off. */
function claimSnapshot(root, config, globs) {
  return levelOf(config) === 'off' ? null : snapshot(root, globs);
}

/** Items of `a` not matched one-for-one in `b` (multiset difference). */
function without(a, b) {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) || 0) + 1);
  return a.filter((x) => {
    const n = left.get(x) || 0;
    if (n) left.set(x, n - 1);
    return !n;
  });
}

/** Lines added/removed since the base commit; untracked files count as all added. */
function lineStats(root, baseCommit, files) {
  if (!baseCommit || !files.length) return { linesAdded: null, linesRemoved: null };
  let added = 0;
  let removed = 0;
  const seen = new Set();
  for (const row of (git(root, ['diff', '--numstat', '--relative', baseCommit, '--', ...files]) || '').split('\n').filter(Boolean)) {
    const [a, r, f] = row.split('\t');
    seen.add(f);
    if (a !== '-') {
      added += Number(a);
      removed += Number(r);
    }
  }
  const untracked = new Set((git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...files]) || '').split('\0').filter(Boolean));
  for (const f of files) {
    if (seen.has(f) || !untracked.has(f)) continue;
    const text = readText(root, f);
    if (text) added += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return { linesAdded: added, linesRemoved: removed };
}

/**
 * Lean rules for a task completion. `task` is the claimed task (its
 * leanBase from the first claim, and claim.baseCommit); `gitChanged` lists
 * files git shows changed since the claim. Returns {errors, stats}: errors only at full/strict,
 * the same problems become stats.warnings at lite.
 */
function checkCompletion(root, config, task, handoff, gitChanged) {
  const level = levelOf(config);
  if (level === 'off') return { errors: [], stats: null };
  const claim = task.claim || {};
  const listed = asArray(handoff.filesChanged).filter((f) => typeof f === 'string').map((f) => toPosix(path.normalize(f)));
  const touched = [...new Set([...listed, ...asArray(gitChanged).filter((f) => matchesAny(f, task.files))])].filter((f) => !f.startsWith('.eccode/'));
  const problems = [];
  const stats = {
    level,
    files: touched.length,
    ...lineStats(root, claim.baseCommit, touched),
    newDependencies: [],
    shortcuts: [],
    testsNotNeeded: typeof handoff.testsNotNeeded === 'string' ? handoff.testsNotNeeded : null,
  };

  if (task.leanBase) {
    const base = task.leanBase;
    const now = snapshot(root, task.files);
    const declared = new Set(asArray(handoff.newDependencies).map((d) => d && norm(d.name)));
    const allowed = new Set(asArray(task.allowedDependencies).map(norm));
    for (const [file, names] of Object.entries(now.deps)) {
      const before = new Set((base.deps[file] || []).map(norm));
      for (const name of names.filter((n) => !before.has(norm(n)))) {
        stats.newDependencies.push({ name, manifest: file });
        if (!declared.has(norm(name))) {
          problems.push(`new dependency "${name}" in ${file} is not declared in handoff.newDependencies; say why the codebase, the standard library and the installed dependencies were not enough`);
        } else if (level === 'strict' && !allowed.has(norm(name))) {
          problems.push(`new dependency "${name}" is not pre-approved in the plan (task.allowedDependencies); lean.level is strict`);
        }
      }
    }
    const declaredShortcuts = asArray(handoff.shortcuts).filter((s) => s && typeof s.file === 'string');
    for (const [file, texts] of Object.entries(now.markers)) {
      const fresh = without(texts, base.markers[file] || []);
      if (!fresh.length) continue;
      stats.shortcuts.push(...fresh.map((text) => ({ file, text })));
      const count = declaredShortcuts.filter((s) => toPosix(path.normalize(s.file)) === file).length;
      if (fresh.length > count) {
        problems.push(`${file} adds ${fresh.length} shortcut marker(s) but handoff.shortcuts declares ${count}: ${fresh.map((t) => JSON.stringify(t)).join(', ')}`);
      }
      if (level === 'strict') {
        for (const t of fresh.filter((x) => !hasTrigger(x))) problems.push(`shortcut marker in ${file} names no upgrade trigger: ${JSON.stringify(t)} (write "<limit>, <when to upgrade>")`);
      }
    }
  } else {
    stats.note = 'claimed without a lean baseline; dependencies and shortcut markers were not compared';
  }

  const code = touched.filter((f) => CODE.test(f) && !TEST.test(f));
  const tests = touched.filter((f) => TEST.test(f));
  stats.codeFiles = code.length;
  stats.testFiles = tests.length;
  if (code.length && !tests.length && !(stats.testsNotNeeded && stats.testsNotNeeded.trim().length >= 10)) {
    problems.push(`code changed (${code.slice(0, 5).join(', ')}${code.length > 5 ? ', …' : ''}) but no test file did; add one test that fails when this logic breaks, or explain in handoff.testsNotNeeded (>= 10 chars)`);
  }
  if (level === 'lite') {
    if (problems.length) stats.warnings = problems;
    return { errors: [], stats };
  }
  return { errors: problems.map((p) => `lean: ${p}`), stats };
}

const DEFS = {
  js: [
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s*\{([^}]*)\}/gm,
    /^module\.exports\s*=\s*\{([^}]*)\}/gm,
    /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
  rs: [/^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod|const)\s+(\w+)/gm],
  java: [/^\s*public\s+(?:(?:static|final|abstract|sealed|partial)\s+)*(?:class|interface|enum|record|struct)\s+(\w+)/gm],
  kt: [/^(?:(?:data|sealed|abstract|open|enum|inline|value)\s+)*(?:class|object|interface|fun)\s+(\w+)/gm],
  rb: [/^\s*(?:class|module)\s+([A-Z][\w:]*)/gm, /^def\s+(?:self\.)?(\w+[?!]?)/gm],
  php: [/^\s*(?:(?:final|abstract)\s+)?(?:class|interface|trait|enum)\s+(\w+)/gm, /^function\s+(\w+)/gm],
};
const LANG = { js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', py: 'py', go: 'go', rs: 'rs', java: 'java', cs: 'java', kt: 'kt', rb: 'rb', php: 'php' };
const SHARED = /(^|\/)(lib|libs|utils?|helpers?|common|shared|core|services?|components?|hooks|models?|schemas?|api)(\/|$)/i;

/** Top-level names a file defines or exports (regex, not a parser: nested and dynamic definitions are missed). */
function definedNames(file, text) {
  const names = [];
  for (const re of DEFS[LANG[path.posix.extname(file).slice(1)]] || []) {
    for (const m of text.matchAll(re)) {
      for (const entry of m[1].split(',')) {
        const e = entry.trim();
        const id = (e.includes(' as ') ? e.split(' as ').pop() : e.split(':')[0]).trim().match(/^[A-Za-z_$][\w$:?!]*/);
        if (id && !id[0].startsWith('_') && id[0] !== 'default' && !names.includes(id[0])) names.push(id[0]);
      }
    }
  }
  return names;
}

/**
 * What already exists, one line per directory (shared code first), within a
 * character budget, so "reuse before you write" costs one command.
 */
function reuseMap(root, { under = '', chars = 4000 } = {}) {
  const prefix = under ? toPosix(path.normalize(under)).replace(/\/+$/, '') + '/' : '';
  const byDir = new Map();
  let files = 0;
  for (const f of listFiles(root)) {
    if ((prefix && !f.startsWith(prefix)) || !LANG[path.posix.extname(f).slice(1)] || TEST.test(f) || GENERATED.test(f)) continue;
    const text = readText(root, f);
    const names = text ? definedNames(f, text) : [];
    if (!names.length) continue;
    files += 1;
    const dir = path.posix.dirname(f);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(`${path.posix.basename(f)}(${names.join(', ')})`);
  }
  const dirs = [...byDir.keys()].sort((a, b) => SHARED.test(b) - SHARED.test(a) || a.localeCompare(b));
  const lines = [];
  let used = 0;
  for (let i = 0; i < dirs.length; i++) {
    let line = `${dirs[i]}/: ${byDir.get(dirs[i]).join(' ')}`;
    if (used + line.length > chars) {
      if (lines.length) {
        const rest = dirs.length - i;
        lines.push(`… ${rest} more director${rest === 1 ? 'y' : 'ies'} (narrow with --path <dir>)`);
        break;
      }
      line = line.slice(0, Math.max(0, chars - 1)) + '…'; // one directory larger than the whole budget
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), directories: dirs.length, files };
}

/** Every deferral marker in the project, flagging those that name no upgrade trigger. */
function debtLedger(root) {
  const items = [];
  for (const f of listFiles(root)) {
    if (PROSE.test(f)) continue;
    const text = readText(root, f);
    if (text === null) continue;
    for (const m of markersIn(text)) items.push({ file: f, line: m.line, text: m.text, trigger: hasTrigger(m.text) });
  }
  return { items, total: items.length, withoutTrigger: items.filter((i) => !i.trigger).length };
}

function formatLedger(ledger) {
  if (!ledger.total) return 'No deferred shortcuts marked in code.';
  const lines = ledger.items.map((i) => `${i.file}:${i.line}  ${i.text}${i.trigger ? '' : '  [no-trigger]'}`);
  lines.push('', `${ledger.total} marker(s), ${ledger.withoutTrigger} without an upgrade trigger.`);
  return lines.join('\n');
}

module.exports = {
  SKIP_DIRS,
  TEST,
  GENERATED,
  readText,
  LEVELS,
  levelOf,
  listFiles,
  dependencyNames,
  markersIn,
  hasTrigger,
  snapshot,
  claimSnapshot,
  checkCompletion,
  definedNames,
  reuseMap,
  debtLedger,
  formatLedger,
};
