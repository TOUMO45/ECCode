#!/usr/bin/env node
'use strict';
// A1: ECCode's index and onboard brief on Mealie at one commit.
//   - wall time of `eccode onboard` cold, warm, and warm after a one-file edit;
//   - files and lines per language, and source files the index does not read;
//   - intra-project imports resolved and unresolved, per language;
//   - files flagged for dynamic loading.
// Intra-project imports (spec A1): in Python, a name starting with `mealie` or
// `tests`, or a relative import; in TS/JS, a relative import or one through a
// Nuxt alias (~, @, ~~, @@). Optional candidates ("from x import name", where
// name may be a submodule) are not counted: the index drops them by design.
// usage: node bench/pilot/mealie/a1-index.js <commit>   (ECCODE_PILOT_RESULTS overrides the output dir)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('../lib');
const codebase = require('../../../lib/codebase');
const lean = require('../../../lib/lean');

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'eccode.js');
const SOURCE_NOT_INDEXED = ['vue', 'svelte', 'astro'];

function intra(lang, spec) {
  if (lang === 'py') return /^\./.test(spec) || /^(mealie|tests)(\.|$)/.test(spec);
  if (lang === 'js') return /^(\.{1,2}(\/|$)|~~?\/|@@?\/)/.test(spec);
  return false;
}

/** Resolution of every intra-project import spec, through the index's own resolver. */
function importStats(root, index) {
  const files = Object.keys(index.files);
  // The index's own context where ECCode has one (per-directory aliases, JSON
  // assets); the root-only aliases of ECCode before it otherwise.
  const ctx = codebase.resolveContext
    ? codebase.resolveContext(root, lean.listFiles(root), files)
    : { fileSet: new Set(files), dirSet: new Set(files.map((f) => path.posix.dirname(f)).map((d) => (d === '.' ? '' : d))), root, alias: codebase.aliases(root), goModule: null };
  const out = {};
  const unresolved = {};
  for (const f of files) {
    const lang = index.files[f].lang;
    if (lang !== 'py' && lang !== 'js') continue;
    const key = lang === 'py' ? 'python' : 'ts';
    out[key] = out[key] || { specs: 0, resolved: 0, unresolved: 0 };
    unresolved[key] = unresolved[key] || new Map();
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const spec of codebase.importSpecs(lang, text)) {
      if (spec.startsWith('?') || !intra(lang, spec)) continue;
      out[key].specs += 1;
      if (codebase.resolveSpec(ctx, f, spec).length) out[key].resolved += 1;
      else {
        out[key].unresolved += 1;
        const m = unresolved[key];
        const shape = lang === 'js' ? spec.replace(/^(~~?|@@?)\/([^/]+).*/, '$1/$2/…') : spec;
        m.set(shape, { count: ((m.get(shape) || {}).count || 0) + 1, example: (m.get(shape) || {}).example || f });
      }
    }
  }
  for (const [key, s] of Object.entries(out)) {
    s.rate = s.specs ? s.resolved / s.specs : null;
    s.unresolvedList = [...unresolved[key].entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 40).map(([spec, v]) => ({ spec, ...v }));
  }
  return out;
}

function onboardMs(tree) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'onboard', '--json'], { cwd: tree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`onboard failed: ${r.stderr}`);
  return Date.now() - started;
}

function main(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('usage: a1-index.js <full commit sha>');
  const tree = lib.treeAt(lib.MEALIE, commit, fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a1-')));
  try {
    // A checkout, as a user has one: git (the file list honours .gitignore) and
    // an ECCode record directory, where the index cache lives.
    const g = (args) => execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd: tree, stdio: 'ignore' });
    g(['init', '-q']);
    g(['add', '-A']);
    g(['commit', '-qm', 'tree']);
    fs.mkdirSync(path.join(tree, '.eccode'));
    const coldMs = onboardMs(tree);
    const warmMs = onboardMs(tree);
    fs.appendFileSync(path.join(tree, 'mealie', 'app.py'), '\n# eccode pilot: one-file edit\n');
    const editMs = onboardMs(tree);
    const index = codebase.indexProject(tree);
    const byLang = {};
    for (const e of Object.values(index.files)) {
      byLang[e.lang] = byLang[e.lang] || { files: 0, lines: 0 };
      byLang[e.lang].files += 1;
      byLang[e.lang].lines += e.lines;
    }
    const notIndexedSource = {};
    for (const f of lean.listFiles(tree)) {
      const ext = path.extname(f).slice(1);
      if (!SOURCE_NOT_INDEXED.includes(ext) || index.files[f]) continue;
      notIndexedSource[ext] = notIndexedSource[ext] || { files: 0, lines: 0 };
      notIndexedSource[ext].files += 1;
      notIndexedSource[ext].lines += fs.readFileSync(path.join(tree, f), 'utf8').split('\n').length;
    }
    const dynamic = Object.entries(index.files).filter(([, e]) => e.dynamic).map(([f]) => f).sort();
    const result = {
      commit,
      coldMs,
      warmMs,
      editMs,
      byLang,
      skipped: { generated: index.skipped.generated.length, unreadable: index.skipped.unreadable.length },
      notIndexedSource,
      imports: importStats(tree, index),
      dynamicLoaders: { count: dynamic.length, files: dynamic },
    };
    const file = lib.writeResult('a1-index', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
    const r = result.imports;
    process.stdout.write(`${file}\ncold ${coldMs} ms, warm ${warmMs} ms, edit ${editMs} ms; python ${r.python.resolved}/${r.python.specs} resolved, ts ${r.ts ? `${r.ts.resolved}/${r.ts.specs}` : 'none'}; not indexed: ${JSON.stringify(notIndexedSource)}; dynamic ${dynamic.length}\n`);
    return result;
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

module.exports = { intra, importStats };

if (require.main === module) main(process.argv[2]);
