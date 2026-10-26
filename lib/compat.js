'use strict';
// Compatibility checks: a task that removes a public export or an HTTP route,
// edits or deletes an existing migration, or ships destructive SQL must say
// so in its handoff (handoff.breakingChanges), where the reviewer sees it.
// The baseline is captured at the task's first claim, like the lean baseline.
// On the refactor track, a detected breaking change is refused outright:
// "refactor" means behavior preserved.

const fs = require('fs');
const path = require('path');
const { matchesAny, toPosix } = require('./util');
const { listFiles, readText, definedNames, levelOf, TEST } = require('./lean');

const MIGRATION_DIR = /(^|\/)(migrations?|db\/migrate|alembic\/versions|sql\/migrations?)(\/|$)/;
// A file a migration tool runs: under alembic/versions, or in a migrations
// directory with a versioned or dated name (0004_x.py, 20240101_x.rb,
// V2__x.sql, prisma's 20240101_x/migration.sql). A migrations/ directory of
// ordinary modules (Mealie's importers from other apps) holds none.
const MIGRATION_FILE = /(^|\/)alembic\/versions\/[^/]+$|(^|\/)(migrations?|db\/migrate|sql\/migrations?)\/(\d|V\d)[^/]*(\/[^/]+)?$/;
const CODE_FOR_EXPORTS = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs)$/;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|DATABASE|SCHEMA)|TRUNCATE\s|ALTER\s+TABLE\s+[^;]*\bDROP\b|DELETE\s+FROM\s+(?![^;]*\bWHERE\b))/i;
// Migration frameworks' own operations that lose data: Alembic's op/batch_op
// drops and Django's field and model removals.
const DESTRUCTIVE_OPS = /\b(?:op|batch_op)\.drop_(?:table|column)\s*\(|\bmigrations\.(?:RemoveField|DeleteModel)\s*\(/;
const MAIN_GUARD = /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m;
const IMPORT_LINE = /^\s*(?:from|import)\s[^\n]*/gm;

/**
 * A standalone Python script (run as `python dir/x.py`): a main guard, no
 * __init__.py beside it, and no project file's import line naming it. Its
 * definitions have no importer a removal could break.
 */
function isScript(root, file, text, importLines) {
  if (!file.endsWith('.py') || !MAIN_GUARD.test(text)) return false;
  if (fs.existsSync(path.join(root, path.dirname(file), '__init__.py'))) return false;
  const stem = new RegExp(`\\b${path.basename(file, '.py').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return !importLines.some((line) => stem.test(line));
}

/**
 * The part of a new migration that runs forwards: a Python migration's
 * upgrade() body when it has one (its downgrade() is expected to drop what
 * upgrade added), otherwise the whole file.
 */
function forwardPart(file, text) {
  if (!file.endsWith('.py')) return text;
  const m = text.match(/^def upgrade\([^)]*\)[^\n]*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m);
  return m ? m[1] : text;
}

/** "METHOD /path" routes declared in a file (express/fastify-style, decorators, Go mux). */
function routesIn(file, text) {
  const out = new Set();
  // Routers of any name ending in Router/_router (userRouter, user_router), beside the usual ones.
  for (const m of text.matchAll(/\b(?:app|router|srv|api|server|fastify|mux|r|\w+Router|\w+_router)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([/:][^'"`\s]*)/gi)) {
    out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  for (const m of text.matchAll(/@(?:\w+_)?(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
    out.add(`${m[1] === 'route' ? 'ANY' : m[1].toUpperCase()} ${m[2]}`);
  }
  for (const m of text.matchAll(/\b(?:http\.)?(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g)) out.add(`ANY ${m[1]}`);
  return [...out].sort();
}

/** Public surface of the files inside `globs`: exports, routes, migration hashes. */
function snapshot(root, globs) {
  const { sha256File } = require('./util');
  const exportsBy = {};
  const routesBy = {};
  const migrations = {};
  const pythonDefs = [];
  const importLines = [];
  for (const f of listFiles(root)) {
    if (!matchesAny(f, globs)) continue;
    if (MIGRATION_FILE.test(f)) {
      try {
        migrations[f] = sha256File(path.join(root, f));
      } catch { /* deleted while scanning */ }
      continue;
    }
    // Test helpers are not public API: their callers are tests, which the change runs.
    if (!CODE_FOR_EXPORTS.test(f) || TEST.test(toPosix(f))) continue;
    const text = readText(root, f);
    if (text === null) continue;
    const defs = definedNames(f, text);
    if (f.endsWith('.py')) {
      importLines.push(...(text.match(IMPORT_LINE) || []));
      if (defs.length) pythonDefs.push({ f, text, defs });
    } else if (defs.length) exportsBy[f] = defs;
    const routes = routesIn(f, text);
    if (routes.length) routesBy[f] = routes;
  }
  for (const { f, text, defs } of pythonDefs) if (!isScript(root, f, text, importLines)) exportsBy[f] = defs;
  return { exports: exportsBy, routes: routesBy, migrations };
}

function claimSnapshot(root, config, globs) {
  return levelOf(config) === 'off' ? null : snapshot(root, globs);
}

/** Detected breaking changes between a baseline and the current tree. */
function detect(root, base, globs) {
  return detectAll(root, base, globs).breaking;
}

/**
 * Breaking changes, and moves: a definition gone from one file and newly
 * defined in another is a move, not a removal. Callers in the project were
 * updated (the change's checks run them); one outside it importing the old
 * path would break, which is why moves are still reported.
 */
function detectAll(root, base, globs) {
  const now = snapshot(root, globs);
  const found = [];
  const moved = [];
  const before = base.exports || {};
  for (const [file, names] of Object.entries(before)) {
    const cur = new Set(now.exports[file] || []);
    for (const name of names.filter((n) => !cur.has(n))) {
      const to = Object.keys(now.exports).find((g) => g !== file && now.exports[g].includes(name) && !(before[g] || []).includes(name));
      if (to) moved.push({ name, from: file, to });
      else found.push({ kind: 'export', name: `${file}#${name}`, detail: `public definition "${name}" removed from ${file} (or the file was deleted/renamed)` });
    }
  }
  for (const [file, routes] of Object.entries(base.routes || {})) {
    const cur = new Set(now.routes[file] || []);
    for (const r of routes.filter((x) => !cur.has(x))) {
      found.push({ kind: 'route', name: r, detail: `HTTP route "${r}" removed from ${file}` });
    }
  }
  for (const [file, hash] of Object.entries(base.migrations || {})) {
    if (now.migrations[file] === undefined) found.push({ kind: 'migration', name: file, detail: `existing migration ${file} was deleted; applied migrations are history, add a new one instead` });
    else if (now.migrations[file] !== hash) found.push({ kind: 'migration', name: file, detail: `existing migration ${file} was edited; databases that already ran it will diverge, add a new migration instead` });
  }
  for (const file of Object.keys(now.migrations).filter((f) => !(f in (base.migrations || {})))) {
    const text = forwardPart(file, readText(root, file) || '');
    const sql = text.match(DESTRUCTIVE_SQL);
    const hit = sql || text.match(DESTRUCTIVE_OPS);
    if (hit) found.push({ kind: 'destructive-migration', name: file, detail: `new migration ${file} contains ${sql ? 'destructive SQL' : 'a destructive migration operation'} (${hit[0].trim().replace(/\s*\($/, '').replace(/\s+/g, ' ')})` });
  }
  return { breaking: found, moved };
}

/**
 * Compatibility rules for a task completion. Returns {errors, warnings, stats}.
 * full/strict: every detected breaking change must be declared in
 * handoff.breakingChanges (same kind and name); refactor refuses them all;
 * strict also requires plan pre-approval (task.allowedBreaking). lite: warnings.
 */
function checkCompletion(root, config, state, task, handoff) {
  const level = levelOf(config);
  if (level === 'off' || !task.compatBase) return { errors: [], warnings: [], stats: null };
  const { breaking: found, moved } = detectAll(root, task.compatBase, task.files);
  const declared = (Array.isArray(handoff.breakingChanges) ? handoff.breakingChanges : []).filter((b) => b && typeof b === 'object');
  const stats = { breaking: found.map(({ kind, name }) => ({ kind, name })), declaredBreaking: declared.length };
  const problems = [];
  const track = state.work && state.work.track;
  for (const f of found) {
    if (track === 'refactor') {
      problems.push(`refactor track preserves behavior, but: ${f.detail}. Restore it, or run this change as a feature/fix work item instead.`);
      continue;
    }
    const match = declared.find((b) => b.kind === f.kind && b.name === f.name);
    if (!match) {
      problems.push(`${f.detail}. Declare it in handoff.breakingChanges ({kind: "${f.kind}", name: "${f.name}", reason, migration}) so the reviewer decides with eyes open — or restore it.`);
    } else if (level === 'strict' && !(task.allowedBreaking || []).includes(f.name)) {
      problems.push(`breaking change "${f.name}" is not pre-approved in the plan (task.allowedBreaking); lean.level is strict`);
    }
  }
  for (const b of declared) {
    if (!found.some((f) => f.kind === b.kind && f.name === b.name)) {
      problems.push(`handoff declares a breaking change the engine cannot see (${b.kind} "${b.name}"); use the detected name exactly, or drop the entry`);
    }
  }
  const moves = moved.map((m) => `compat: "${m.name}" moved from ${m.from} to ${m.to}; anything outside this project importing it from ${m.from} would break (re-export it there if so)`);
  if (level === 'lite') return { errors: [], warnings: [...problems, ...moves], stats };
  return { errors: problems.map((p) => `compat: ${p}`), warnings: moves, stats };
}

module.exports = { snapshot, claimSnapshot, detect, detectAll, checkCompletion, routesIn, MIGRATION_DIR, MIGRATION_FILE, DESTRUCTIVE_SQL };
