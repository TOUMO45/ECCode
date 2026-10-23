'use strict';
// Codebase index: what each source file defines, what it imports, and who
// depends on it. Built with per-language regexes and resolved against the real
// file list, cached incrementally under .eccode/cache/, so onboarding and
// impact analysis work on large repositories without reading every file twice.
// Regex parsing misses dynamic imports/reflection; limits are stated in the
// onboard brief rather than hidden.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, exists, toPosix, matchesAny, commandEnv } = require('./util');
const { git } = require('./project');
const { listFiles, readText, definedNames, SKIP_DIRS, TEST, GENERATED } = require('./lean');

// The cache is keyed on this file's content, so a parser change (new import
// or dynamic-load patterns) invalidates entries built by the old parser.
const INDEX_VERSION = `2:${require('crypto').createHash('sha256').update(require('fs').readFileSync(__filename)).digest('hex').slice(0, 16)}`;
const LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js',
  py: 'py', go: 'go', rs: 'rs', rb: 'rb', java: 'java', kt: 'java', kts: 'java', php: 'php', cs: 'other', swift: 'other',
};
const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

function langOf(file) {
  return LANG[path.posix.extname(file).slice(1)] || null;
}

/** Strip // and /* *​/ comments so JSON-with-comments (tsconfig) parses. */
function parseJsonc(text) {
  try {
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** tsconfig/jsconfig path aliases as [{prefix, suffix, targets:[{prefix,suffix}]}]. */
function aliases(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = exists(path.join(root, name)) && parseJsonc(fs.readFileSync(path.join(root, name), 'utf8'));
    const co = cfg && cfg.compilerOptions;
    if (!co || !co.paths) continue;
    const baseUrl = co.baseUrl || '.';
    return Object.entries(co.paths).map(([pat, targets]) => {
      const [prefix, suffix = ''] = pat.split('*');
      return {
        prefix,
        suffix,
        targets: [].concat(targets).map((t) => {
          const [tp, ts = ''] = t.split('*');
          return { prefix: toPosix(path.posix.join(baseUrl, tp)), suffix: ts };
        }),
      };
    });
  }
  return [];
}

// A file using dynamic module loading cannot be fully resolved statically:
// the index marks it, and impact() reports such files as possibly affected
// instead of silently missing them.
const DYNAMIC = {
  js: /\brequire\s*\(\s*[^'")]|\bimport\s*\(\s*[^'")]|=\s*require\s*[;,)\n]|\bcreateRequire\s*\(/,
  py: /\bimportlib\b|__import__\s*\(|\bgetattr\s*\(\s*(?:sys\.modules|importlib)/,
  java: /Class\.forName\s*\(|\.getMethod\s*\(|\.loadClass\s*\(/,
  rb: /\bconst_get\b|\bObject\.const_get\b|\bsend\s*\(\s*:/,
  php: /\b(require|include)(_once)?\s*\(?\s*\$|\bcall_user_func\b/,
};

function usesDynamicImports(lang, text) {
  return Boolean(DYNAMIC[lang] && DYNAMIC[lang].test(text));
}

function importSpecs(lang, text) {
  const out = [];
  const push = (re, map) => {
    for (const m of text.matchAll(re)) out.push(map ? map(m) : m[1]);
  };
  if (lang === 'js') {
    push(/(?:^|[^.\w])import\s+[\w${},*\s]*?from\s*['"]([^'"]+)['"]/gm);
    push(/(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]/g);
    push(/(?:^|[^.\w])import\s+['"]([^'"]+)['"]/gm);
    push(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    push(/(?:^|[^.\w])export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm);
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^\n]*)/gm)) {
      out.push(m[1]);
      // Each imported name may itself be a submodule ("from . import schemas").
      // The "?" marks it optional: unresolved candidates are dropped silently.
      for (const name of m[2].replace(/[()#].*/, '').split(',')) {
        const n = name.trim().split(/\s+as\s+/)[0];
        if (/^\w+$/.test(n)) out.push(`?${m[1]}${m[1].endsWith('.') ? '' : '.'}${n}`);
      }
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
      for (const name of m[1].split(',')) out.push(name.trim().split(/\s+as\s+/)[0]);
    }
  } else if (lang === 'go') {
    push(/^import\s+(?:\w+\s+)?"([^"]+)"/gm);
    for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
      out.push(...[...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    }
  } else if (lang === 'rs') {
    push(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm, (m) => `mod:${m[1]}`);
    push(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+crate::([\w:]+)/gm, (m) => `crate:${m[1]}`);
  } else if (lang === 'java') {
    push(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;?/gm);
  } else if (lang === 'rb') {
    push(/^\s*require_relative\s+['"]([^'"]+)['"]/gm, (m) => `rel:${m[1]}`);
  } else if (lang === 'php') {
    push(/^\s*(?:require|include)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*['"]\/?([^'"]+)['"]/gm, (m) => `rel:${m[1]}`);
  }
  return [...new Set(out)];
}

/** Resolve one import spec to project files/dirs; [] = external or unresolved. */
function resolveSpec(ctx, file, spec) {
  const { fileSet, root, alias, goModule } = ctx;
  const dir = path.posix.dirname(file);
  const lang = langOf(file);
  const tryFile = (p) => {
    const clean = toPosix(path.posix.normalize(p)).replace(/^\.\//, '');
    if (clean.startsWith('..')) return null;
    if (fileSet.has(clean)) return clean;
    for (const ext of JS_EXTS) if (fileSet.has(clean + ext)) return clean + ext;
    for (const ext of JS_EXTS) if (fileSet.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
    return null;
  };
  if (lang === 'js') {
    let p = spec.split('?')[0];
    if (!p.startsWith('.') && !p.startsWith('/')) {
      const a = alias.find((x) => p.startsWith(x.prefix) && p.endsWith(x.suffix));
      if (!a) return [];
      const mid = p.slice(a.prefix.length, p.length - a.suffix.length || undefined);
      for (const t of a.targets) {
        const hit = tryFile(`${t.prefix}${mid}${t.suffix}`);
        if (hit) return [hit];
      }
      return [];
    }
    const hit = tryFile(p.startsWith('.') ? path.posix.join(dir, p) : p.slice(1));
    return hit ? [hit] : [];
  }
  if (lang === 'py') {
    let baseDir = '';
    let name = spec;
    const dots = spec.match(/^\.+/);
    if (dots) {
      baseDir = dots[0].length === 1 ? dir : toPosix(path.posix.join(dir, ...Array(dots[0].length - 1).fill('..')));
      name = spec.slice(dots[0].length);
    }
    const rel = name.split('.').filter(Boolean).join('/');
    // The import root of a file is its nearest ancestor that is not a package
    // (no __init__.py): Lib/ for Lib/asyncio/events.py, as on sys.path.
    let importRoot = dir;
    while (importRoot !== '.' && fileSet.has(`${importRoot}/__init__.py`)) importRoot = path.posix.dirname(importRoot);
    for (const base of dots ? [baseDir] : [...new Set(['', 'src', importRoot === '.' ? '' : importRoot, dir])]) {
      for (const cand of [rel ? `${path.posix.join(base, rel)}.py` : null, path.posix.join(base, rel, '__init__.py')]) {
        if (cand) {
          const clean = toPosix(path.posix.normalize(cand));
          if (fileSet.has(clean)) return [clean];
        }
      }
    }
    return [];
  }
  if (lang === 'go') {
    if (goModule && spec.startsWith(goModule)) {
      const sub = spec.slice(goModule.length).replace(/^\//, '');
      return ctx.dirSet.has(sub) ? [`${sub || '.'}/`] : [];
    }
    return [];
  }
  if (lang === 'rs') {
    const [kind, rest] = spec.split(/:(.*)/s);
    const names = kind === 'mod' ? [rest] : rest.split('::').slice(0, 1);
    const bases = kind === 'mod' ? [dir, `${dir}/${path.posix.basename(file, '.rs')}`] : ['src'];
    for (const base of bases) {
      for (const cand of [`${base}/${names[0]}.rs`, `${base}/${names[0]}/mod.rs`]) {
        if (fileSet.has(toPosix(path.posix.normalize(cand)))) return [toPosix(path.posix.normalize(cand))];
      }
    }
    return [];
  }
  if (lang === 'java') {
    const parts = spec.split('.');
    if (spec.endsWith('.*')) {
      const sub = parts.slice(0, -1).join('/');
      const hits = [...fileSet].filter((f) => /\.(java|kt)$/.test(f) && path.posix.dirname(f).endsWith(sub));
      return hits.slice(0, 20);
    }
    for (const ext of ['.java', '.kt']) {
      const suffix = parts.join('/') + ext;
      const hit = [...fileSet].find((f) => f === suffix || f.endsWith('/' + suffix));
      if (hit) return [hit];
    }
    return [];
  }
  if (lang === 'rb' || lang === 'php') {
    const rel = spec.replace(/^rel:/, '');
    for (const cand of [path.posix.join(dir, rel), path.posix.join(dir, rel) + (lang === 'rb' ? '.rb' : '')]) {
      const clean = toPosix(path.posix.normalize(cand));
      if (fileSet.has(clean)) return [clean];
    }
    return [];
  }
  return [];
}

function cacheFile(root) {
  return path.join(root, '.eccode', 'cache', 'codebase.json');
}

/**
 * Build (or incrementally refresh) the index: { files: {rel: {lang, lines,
 * defs, imports, external}}, builtAt }. Cache entries are reused while a
 * file's size+mtime match; imports are re-resolved every build, so renames
 * invalidate resolution without invalidating parsing.
 */
function indexProject(root, { refresh = false } = {}) {
  // The installed toolkit (.claude/) is tooling, not project code. Excluded
  // here only: the secrets scan still reads .claude/settings.json and friends.
  const all = listFiles(root).filter((f) => !/^\.claude\//.test(f));
  // Named, not silent: what the index does NOT cover is reported alongside it.
  const skipped = { generated: [], unreadable: [] };
  const files = all.filter((f) => {
    if (!langOf(f) || SKIP_DIRS.test(f)) return false;
    if (GENERATED.test(f)) {
      skipped.generated.push(f);
      return false;
    }
    return true;
  });
  const fileSet = new Set(files);
  const dirSet = new Set(files.map((f) => path.posix.dirname(f)).map((d) => (d === '.' ? '' : d)));
  const goMod = fileSet.has('go.mod') || exists(path.join(root, 'go.mod')) ? readText(root, 'go.mod') : null;
  const goModule = goMod && (goMod.match(/^module\s+(\S+)/m) || [])[1];
  const ctx = { fileSet, dirSet, root, alias: aliases(root), goModule };

  const cached = !refresh && exists(cacheFile(root)) ? readJson(cacheFile(root), null) : null;
  const old = cached && cached.version === INDEX_VERSION ? cached.entries : {};
  const entries = {};
  let reused = 0;
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(path.join(root, f));
    } catch {
      continue;
    }
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (old[f] && old[f].key === key) {
      entries[f] = old[f];
      reused += 1;
      continue;
    }
    const text = readText(root, f);
    if (text === null) {
      skipped.unreadable.push(f);
      continue;
    }
    entries[f] = {
      key,
      lang: langOf(f),
      lines: text.split('\n').length,
      defs: definedNames(f, text),
      specs: importSpecs(langOf(f), text),
      dynamic: usesDynamicImports(langOf(f), text),
    };
  }
  const index = { version: INDEX_VERSION, builtAt: new Date().toISOString(), reused, skipped, files: {} };
  for (const [f, e] of Object.entries(entries)) {
    const internal = new Set();
    const external = [];
    for (const spec of e.specs) {
      const optional = spec.startsWith('?');
      const hits = resolveSpec(ctx, f, optional ? spec.slice(1) : spec);
      if (hits.length) hits.forEach((h) => h !== f && internal.add(h));
      else if (!optional) external.push(spec.replace(/^(mod|crate|rel):/, ''));
    }
    index.files[f] = { lang: e.lang, lines: e.lines, defs: e.defs, imports: [...internal].sort(), external: [...new Set(external)].sort(), ...(e.dynamic ? { dynamic: true } : {}) };
  }
  if (exists(path.join(root, '.eccode'))) writeJson(cacheFile(root), { version: INDEX_VERSION, entries });
  return index;
}

/** Reverse edges: file -> files that import it (Go dirs expand to their files). */
function dependentsMap(index) {
  const map = new Map();
  const add = (target, by) => {
    if (!map.has(target)) map.set(target, new Set());
    map.get(target).add(by);
  };
  for (const [f, e] of Object.entries(index.files)) {
    for (const imp of e.imports) {
      if (imp.endsWith('/')) {
        const dir = imp === './' ? '' : imp.slice(0, -1);
        for (const g of Object.keys(index.files)) {
          if (g !== f && path.posix.dirname(g) === (dir || '.')) add(g, f);
        }
      } else add(imp, f);
    }
  }
  return map;
}

// A file under a test path is a runnable test when its name says so or it
// defines tests; otherwise it is test support (helpers, fixtures, conftest,
// runners), which affects tests but is not one to run.
const TEST_NAME = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go|rb)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+(Test|Tests|Spec)\.(java|kt|php)|[^/]+_spec\.rb)$/;
const TEST_DEFINES = { // keyed by the index's language codes (LANG)
  js: /(^|[^.\w])(test|it|describe)(\.(only|skip|each))?\s*\(/m,
  py: /^\s*(async\s+)?def test_?\w*\s*\(|^class \w*Tests?\b[^:]*\((unittest\.)?TestCase\)/m,
  go: /^func Test\w*\(\w+ \*testing\.T\)/m,
  java: /@Test\b/,
  rb: /^\s*(it|describe|test|context)\s+['"]/m,
  php: /function test\w*\s*\(/,
  rs: /#\[(tokio::)?test\]/,
};

function isRunnableTest(root, file, lang) {
  if (TEST_NAME.test(file)) return true;
  // Runners collect by name before content: go test only *_test.go, pytest
  // and unittest discovery only test*.py.
  if (lang === 'go' || (lang === 'py' && !/^test/.test(path.posix.basename(file)))) return false;
  const re = TEST_DEFINES[lang];
  const text = re ? readText(root, file) : null;
  return Boolean(text && re.test(text));
}

/**
 * Module of each file: its top-level directory (or the file itself at the
 * root), except that a directory holding most of the code and several code
 * subdirectories (a src/ or Lib/ layout) is opened one level, so modules are
 * its children instead of one module that holds everything.
 */
function moduleResolver(files) {
  const open = new Set();
  let prefix = '';
  for (let depth = 0; depth < 3; depth++) {
    const groups = new Map();
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest.includes('/')) continue;
      const [seg, ...below] = rest.split('/');
      if (!groups.has(seg)) groups.set(seg, { n: 0, subdirs: new Set() });
      const g = groups.get(seg);
      g.n += 1;
      if (below.length > 1) g.subdirs.add(below[0]);
    }
    const [seg, g] = [...groups.entries()].sort((a, b) => b[1].n - a[1].n)[0] || [];
    if (!seg || g.n < 0.6 * files.length || g.subdirs.size < 2) break;
    prefix = `${prefix}${seg}/`;
    open.add(prefix);
  }
  return (f) => {
    let p = '';
    for (;;) {
      const rest = f.slice(p.length);
      const seg = rest.split('/')[0];
      if (rest.includes('/') && open.has(`${p}${seg}/`)) p = `${p}${seg}/`;
      else return `${p}${seg}`;
    }
  };
}

/**
 * Impact of changing `targets`: every file that depends on them (with BFS
 * distance), ranked within a distance by how much depends on them in turn;
 * the runnable tests that cover them (test support is listed apart); and the
 * modules touched, largest first.
 */
function impact(root, targets, { index } = {}) {
  const idx = index || indexProject(root);
  const rev = dependentsMap(idx);
  const known = targets.map((t) => toPosix(path.normalize(t))).filter((t) => idx.files[t]);
  const unknown = targets.map((t) => toPosix(path.normalize(t))).filter((t) => !idx.files[t]);
  const dist = new Map(known.map((t) => [t, 0]));
  const queue = [...known];
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of rev.get(cur) || []) {
      if (!dist.has(dep)) {
        dist.set(dep, dist.get(cur) + 1);
        queue.push(dep);
      }
    }
  }
  const reach = (f) => (rev.get(f) ? rev.get(f).size : 0);
  const affected = [...dist.entries()]
    .map(([file, distance]) => ({ file, distance, reach: reach(file) }))
    .sort((a, b) => a.distance - b.distance || b.reach - a.reach || a.file.localeCompare(b.file));
  const underTest = affected.filter((a) => TEST.test(a.file));
  const runnable = underTest.filter((a) => isRunnableTest(root, a.file, idx.files[a.file] && idx.files[a.file].lang));
  const tests = runnable.map((a) => a.file);
  const testSupport = underTest.filter((a) => !runnable.includes(a)).map((a) => a.file);
  const code = affected.filter((a) => !TEST.test(a.file));
  const moduleOf = moduleResolver(Object.keys(idx.files).filter((f) => !TEST.test(f)));
  const counts = new Map();
  for (const a of code) counts.set(moduleOf(a.file), (counts.get(moduleOf(a.file)) || 0) + 1);
  const moduleCounts = [...counts.entries()].map(([module, files]) => ({ module, files })).sort((a, b) => b.files - a.files || a.module.localeCompare(b.module));
  const modules = moduleCounts.map((m) => m.module);
  const untested = code.filter((a) => a.distance === 0 && !tests.length).map((a) => a.file);
  // Conservative: dynamic loaders may reach the targets through paths the
  // static index cannot see, so they are named instead of silently missed.
  const dynamicCallers = Object.entries(idx.files)
    .filter(([f, e]) => e.dynamic && !dist.has(f))
    .map(([f]) => f)
    .sort();
  // Static edges into the impact set and dynamic loaders inside it, so a
  // runtime trace can report direct edges static analysis did not see.
  const staticEdges = [];
  for (const [f, e] of Object.entries(idx.files)) {
    for (const imp of e.imports || []) if (dist.has(imp)) staticEdges.push(`${f} -> ${imp}`);
  }
  const dynamicInGraph = [...dist.keys()].filter((f) => idx.files[f] && idx.files[f].dynamic).sort();
  const skipped = idx.skipped || { generated: [], unreadable: [] };
  return { targets: known, notIndexed: unknown, affected, dependents: code.filter((a) => a.distance > 0), tests, testSupport, modules, moduleCounts, untested, dynamicCallers, dynamicInGraph, staticEdges, notCovered: { generated: skipped.generated.length, unreadable: skipped.unreadable.length } };
}

/**
 * Run a command under the runtime load tracers (Node require hook + Python
 * audit hook) and collect the module loads it actually performed. This is the
 * ground truth that static analysis cannot provide: dynamic requires and
 * reflective imports resolve here because they are OBSERVED, not parsed.
 */
// The JVM tracer is a Java agent compiled on first use and cached by source
// hash (zero-dependency: needs only the JDK's javac and jar). null when no
// JDK is available; the trace result then says JVM classes were not traced.
function javaAgentJar(traceDir) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const src = path.join(traceDir, 'EccodeTraceAgent.java');
  const hash = require('crypto').createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `eccode-java-agent-${hash}`);
  const jar = path.join(dir, 'agent.jar');
  if (fs.existsSync(jar)) return jar;
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-java-build-'));
  try {
    const opts = { encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: '' } };
    if (spawnSync('javac', ['-d', path.join(build, 'classes'), src], opts).status !== 0) return null;
    fs.writeFileSync(path.join(build, 'manifest.txt'), 'Premain-Class: EccodeTraceAgent\n');
    if (spawnSync('jar', ['cfm', path.join(build, 'agent.jar'), path.join(build, 'manifest.txt'), '-C', path.join(build, 'classes'), '.'], opts).status !== 0) return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(build, 'agent.jar'), jar);
    return jar;
  } catch {
    return fs.existsSync(jar) ? jar : null;
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
}

// JVM class names (app/Plugin, app/Plugin$Inner, app/UtilKt) -> project
// source files by package path: src/main/java/app/Plugin.java, app/Util.kt.
function classToSource(root, classNames) {
  const sources = listFiles(root).filter((f) => /\.(java|kt)$/.test(f));
  const out = new Map();
  for (const cls of classNames) {
    const outer = cls.split('$')[0];
    const candidates = [outer, outer.endsWith('Kt') ? outer.slice(0, -2) : null].filter(Boolean);
    const hit = sources.find((f) => {
      const noExt = f.replace(/\.(java|kt)$/, '');
      return candidates.some((c) => noExt === c || noExt.endsWith(`/${c}`));
    });
    if (hit) out.set(cls, hit);
  }
  return out;
}

function traceRun(root, command, { timeoutMs = 600000, rootSpellings } = {}) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-trace-')), 'edges.jsonl');
  fs.writeFileSync(file, '');
  const traceDir = path.join(__dirname, '..', 'scripts', 'trace');
  // Canonicalize: module loaders report real paths, so a symlinked root (macOS
  // /var/folders -> /private/var/folders) would otherwise match no loads at all.
  let realRoot;
  try { realRoot = fs.realpathSync(path.resolve(root)); } catch { realRoot = path.resolve(root); }
  // Windows CI temp dirs are 8.3 short paths (C:\\Users\\RUNNER~1): Node keeps that form,
  // while the JVM and PHP report the long one. Tracers accept either spelling.
  let altRoot = realRoot;
  try { altRoot = fs.realpathSync.native(path.resolve(root)); } catch { /* keep realRoot */ }
  // --import (for the ESM loader) exists since Node 18.18; an unknown flag in
  // NODE_OPTIONS aborts every node process, so older runtimes get CJS-only tracing.
  // The ESM loader also needs module.register (Node >= 18.19 / 20.6); where it
  // is missing, ESM imports are not traced and the result says so.
  const esmTraced = typeof require('module').register === 'function';
  const esmImport = esmTraced
    ? ` --import ${JSON.stringify(require('url').pathToFileURL(path.join(traceDir, 'esm-register.mjs')).href)}`
    : '';
  // PHP: an ini file in a scan directory loads the include tracer through
  // auto_prepend_file. A blank PHP_INI_SCAN_DIR entry keeps PHP's default
  // scan directory, so installed extensions still load.
  const agentJar = javaAgentJar(traceDir);
  const phpIniDir = path.join(path.dirname(file), 'php-ini');
  fs.mkdirSync(phpIniDir);
  fs.writeFileSync(path.join(phpIniDir, 'zz-eccode-trace.ini'), `auto_prepend_file="${path.join(traceDir, 'php-tracer.php').replace(/\\/g, '/')}"\n`);
  const env = commandEnv({
    ECCODE_TRACE_FILE: file,
    // rootSpellings overrides the two spellings (tests use it to prove every
    // tracer honors the second one, which only Windows produces naturally).
    ECCODE_TRACE_ROOT: (rootSpellings ? rootSpellings[0] : realRoot) + path.sep,
    ECCODE_TRACE_ROOT_ALT: (rootSpellings ? rootSpellings[1] : altRoot) + path.sep,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(traceDir, 'node-tracer.cjs'))}${esmImport}`.trim(),
    PYTHONPATH: `${traceDir}${process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''}`,
    RUBYOPT: `${process.env.RUBYOPT || ''} -r${path.join(traceDir, 'ruby-tracer.rb')}`.trim(),
    PHP_INI_SCAN_DIR: `${process.env.PHP_INI_SCAN_DIR || ''}${path.delimiter}${phpIniDir}`,
    ...(agentJar ? { JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ''} -javaagent:${agentJar}`.trim() } : {}),
  });
  const res = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env });
  const edges = [];
  const loaded = new Set();
  const lines = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch { /* torn line at process death */ }
  }
  const classes = [...new Set(lines.flatMap((e) => [e.toClass, e.fromClass]).filter(Boolean))];
  const srcOf = classes.length ? classToSource(root, classes) : new Map();
  for (const e of lines) {
    const to = e.to || srcOf.get(e.toClass);
    const from = e.from || srcOf.get(e.fromClass);
    if (to) loaded.add(to);
    if (from && to && from !== to) edges.push({ from, to });
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return { exitCode: typeof res.status === 'number' ? res.status : 1, edges, loaded: [...loaded].sort(), esmTraced, jvmTraced: Boolean(agentJar) };
}

/**
 * Merge observed runtime loads into a static impact result: runtime edges add
 * dependents the parser could not see, and targets that the traced command
 * actually loaded are marked as covered by it.
 */
function mergeTrace(result, trace) {
  const targets = new Set(result.targets);
  const known = new Set(result.affected.map((a) => a.file));
  const runtimeDependents = [];
  // Propagate to a fixpoint: loaders log edges in different orders (CommonJS
  // bottom-up, ESM top-down), and a single pass would drop upstream callers.
  for (let changed = true; changed;) {
    changed = false;
    for (const e of trace.edges) {
      if ((targets.has(e.to) || known.has(e.to)) && !known.has(e.from)) {
        known.add(e.from);
        runtimeDependents.push(e.from);
        changed = true;
      }
    }
  }
  // Edges observed into the impact set that the static graph lacks: a file
  // already listed as a dependent may still load a target directly at runtime.
  const staticEdges = new Set(result.staticEdges || []);
  const runtimeOnlyEdges = [...new Set(trace.edges
    .filter((e) => e.from !== e.to && known.has(e.to) && !staticEdges.has(`${e.from} -> ${e.to}`))
    .map((e) => `${e.from} -> ${e.to}`))].sort();
  const sources = new Set(runtimeOnlyEdges.map((x) => x.split(' -> ')[0]));
  return {
    ...result,
    runtime: {
      exitCode: trace.exitCode,
      loadsObserved: trace.loaded.length,
      targetsLoaded: result.targets.filter((t) => trace.loaded.includes(t)),
      targetsNotLoaded: result.targets.filter((t) => !trace.loaded.includes(t)),
      esmTraced: trace.esmTraced !== false,
      jvmTraced: trace.jvmTraced !== false,
      runtimeDependents: runtimeDependents.sort(),
      runtimeOnlyEdges,
      dynamicCallersObserved: [...new Set([
        ...result.dynamicCallers.filter((f) => trace.loaded.includes(f) || trace.edges.some((e) => e.from === f)),
        ...(result.dynamicInGraph || []).filter((f) => sources.has(f)),
      ])].sort(),
    },
  };
}

function hotSpots(root, files, limit = 10) {
  const log = git(root, ['log', '-n', '400', '--name-only', '--pretty=format:']);
  if (log === null) return [];
  const counts = new Map();
  for (const line of log.split('\n').filter(Boolean)) {
    if (files.has(line)) counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([file, changes]) => ({ file, changes }));
}

function entryPoints(root, index) {
  const out = new Set();
  const pkg = exists(path.join(root, 'package.json')) && readJson(path.join(root, 'package.json'), null);
  if (pkg) {
    for (const v of [pkg.main, ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {}))]) {
      const p = v && toPosix(path.posix.normalize(String(v)));
      if (p && index.files[p]) out.add(p);
    }
  }
  for (const f of Object.keys(index.files)) {
    if (/^(src\/)?(index|main|app|server|cli)\.(js|ts|jsx|tsx|mjs|py|rs)$/.test(f) || /^cmd\/[^/]+\/main\.go$/.test(f) || /^(manage|wsgi|asgi)\.py$/.test(f) || f === 'src/lib.rs') out.add(f);
  }
  return [...out].sort();
}

/** Human onboarding brief for the repository, honest about method limits. */
function onboardBrief(root, { refresh = false } = {}) {
  const index = indexProject(root, { refresh });
  const files = Object.entries(index.files);
  const rev = dependentsMap(index);
  const byLang = {};
  for (const [, e] of files) {
    byLang[e.lang] = byLang[e.lang] || { files: 0, lines: 0 };
    byLang[e.lang].files += 1;
    byLang[e.lang].lines += e.lines;
  }
  const byModule = new Map();
  const moduleOf = moduleResolver(files.map(([f]) => f).filter((f) => !TEST.test(f)));
  for (const [f, e] of files) {
    const top = moduleOf(f);
    const mod = top.includes('/') || f.includes('/') ? top : '(files at the root)';
    if (!byModule.has(mod)) byModule.set(mod, { files: 0, lines: 0, tests: 0 });
    const m = byModule.get(mod);
    m.files += 1;
    m.lines += e.lines;
    if (TEST.test(f)) m.tests += 1;
  }
  const depended = [...rev.entries()].map(([f, by]) => ({ f, n: by.size })).sort((a, b) => b.n - a.n).slice(0, 10);
  const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'Dockerfile'].filter((m) => exists(path.join(root, m)));
  const lines = [
    `# Codebase brief (generated ${index.builtAt})`,
    '',
    `**Indexed:** ${files.length} source files. **Manifests:** ${manifests.join(', ') || 'none found'}.`,
    `**Languages:** ${Object.entries(byLang).map(([l, v]) => `${l} (${v.files} files, ${v.lines} lines)`).join(' · ')}`,
    '',
    '## Modules',
    '| Module | Files | Lines | Test files |',
    '|---|---|---|---|',
    ...[...byModule.entries()].sort((a, b) => b[1].lines - a[1].lines).slice(0, 15).map(([m, v]) => `| ${m.startsWith('(') || /\.\w+$/.test(m) ? m : `${m}/`} | ${v.files} | ${v.lines} | ${v.tests} |`),
    byModule.size > 15 ? `| … ${byModule.size - 15} more | | | |` : null,
    '',
    '## Entry points',
    ...entryPoints(root, index).map((f) => `- ${f}`),
    '',
    '## Most depended-on files (change these carefully; run `eccode impact <file>` first)',
    ...depended.map((d) => `- ${d.f} ← ${d.n} dependents`),
    '',
    '## Hot spots (most changed in the last 400 commits)',
    ...hotSpots(root, new Set(Object.keys(index.files))).map((h) => `- ${h.file} (${h.changes} changes)`),
    '',
    ...(files.some(([, e]) => e.dynamic)
      ? ['', `## Files using dynamic module loading (static impact analysis cannot see through these)`, ...files.filter(([, e]) => e.dynamic).map(([f]) => `- ${f}`).slice(0, 15)]
      : []),
    ...((index.skipped.generated.length || index.skipped.unreadable.length)
      ? ['', `## Not indexed (generated or unreadable; their dependents are not tracked)`, ...[...index.skipped.generated, ...index.skipped.unreadable].slice(0, 15).map((f) => `- ${f}`), index.skipped.generated.length + index.skipped.unreadable.length > 15 ? `- … ${index.skipped.generated.length + index.skipped.unreadable.length - 15} more` : null].filter(Boolean)
      : []),
    '',
    '_Method: regex-based index of definitions and imports. Dynamic imports are flagged above rather than resolved; reflection and generated code are missed. Use `eccode map` for per-directory definitions and `eccode impact` before changing shared files._',
  ];
  return { text: lines.filter((l) => l !== undefined).join('\n'), index, modules: byModule.size };
}

module.exports = { indexProject, dependentsMap, impact, onboardBrief, entryPoints, hotSpots, importSpecs, resolveSpec, aliases, traceRun, mergeTrace, moduleResolver, isRunnableTest, LANG };
