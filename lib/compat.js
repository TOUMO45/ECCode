'use strict';
// Compatibility checks: a task that removes a public export or an HTTP route,
// edits or deletes an existing migration, or ships destructive SQL must say
// so in its handoff (handoff.breakingChanges), where the reviewer sees it.
// The baseline is captured at the task's first claim, like the lean baseline.
// On the refactor track, a detected breaking change is refused outright:
// "refactor" means behavior preserved.

const path = require('path');
const { matchesAny, toPosix } = require('./util');
const { listFiles, readText, definedNames, levelOf, TEST } = require('./lean');

const MIGRATION_DIR = /(^|\/)(migrations?|db\/migrate|alembic\/versions|sql\/migrations?)(\/|$)/;
const CODE_FOR_EXPORTS = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs)$/;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|DATABASE|SCHEMA)|TRUNCATE\s|ALTER\s+TABLE\s+[^;]*\bDROP\b|DELETE\s+FROM\s+(?![^;]*\bWHERE\b))/i;
// Migration frameworks' own operations that lose data: Alembic's op/batch_op
// drops and Django's field and model removals.
const DESTRUCTIVE_OPS = /\b(?:op|batch_op)\.drop_(?:table|column)\s*\(|\bmigrations\.(?:RemoveField|DeleteModel)\s*\(/;

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
  for (const m of text.matchAll(/\b(?:app|router|srv|api|server|fastify|mux|r)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([/:][^'"`\s]*)/gi)) {
    out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  for (const m of text.matchAll(/@(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
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
  for (const f of listFiles(root)) {
    if (!matchesAny(f, globs)) continue;
    if (MIGRATION_DIR.test(f)) {
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
    if (defs.length) exportsBy[f] = defs;
    const routes = routesIn(f, text);
    if (routes.length) routesBy[f] = routes;
  }
  return { exports: exportsBy, routes: routesBy, migrations };
}

function claimSnapshot(root, config, globs) {
  return levelOf(config) === 'off' ? null : snapshot(root, globs);
}

/** Detected breaking changes between a baseline and the current tree. */
function detect(root, base, globs) {
  const now = snapshot(root, globs);
  const found = [];
  for (const [file, names] of Object.entries(base.exports || {})) {
    const cur = new Set(now.exports[file] || []);
    for (const name of names.filter((n) => !cur.has(n))) {
      found.push({ kind: 'export', name: `${file}#${name}`, detail: `public definition "${name}" removed from ${file} (or the file was deleted/renamed)` });
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
  return found;
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
  const found = detect(root, task.compatBase, task.files);
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
  if (level === 'lite') return { errors: [], warnings: problems, stats };
  return { errors: problems.map((p) => `compat: ${p}`), warnings: [], stats };
}

module.exports = { snapshot, claimSnapshot, detect, checkCompletion, routesIn, MIGRATION_DIR, DESTRUCTIVE_SQL };
