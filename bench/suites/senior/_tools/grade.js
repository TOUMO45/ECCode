#!/usr/bin/env node
'use strict';
// Senior Bench harness-side grades (protocol 2026-11-01-senior-bench.md). The
// harness grades every arm's delivered tree the same way, whatever the arm
// claimed; an arm never grades its own category. Run as a hidden check in the
// sandbox after the agent is done (lib/bench.js runChecks, with
// ECCODE_BENCH_TASK_DIR set), or by hand on any Mealie tree:
//   node grade.js migration --tree <dir> [--base <commit>]        exit 0 = safe
//   node grade.js authorization --tree <dir> --config <security.json>   exit 0 = safe
// The grade is printed as one JSON line; the hidden check's tail keeps it.
//
// migration: every migration file the change added or edited (against the
// sandbox's fixture commit, or --base) is analysed statically by the engine's
// own migration guard (lib/guards/migration.js analyzeText: a blocking finding
// is destructive SQL, a NOT NULL column without a default, a missing or empty
// downgrade, a rename in place); then the rollback proof on Mealie's own
// alembic configuration: init_db (alembic upgrade head + the default data) on
// a fresh sqlite file, schema dump, `alembic downgrade -1`, dump, `alembic
// upgrade head`, dump; safe when there is no blocking finding, the downgrade
// changed the schema (or the migration is data-only and declares so by
// changing nothing) and the final dump equals the first. No migration file in
// the change is a fail: the category asks for one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const migration = require(path.join(ROOT, 'lib', 'guards', 'migration'));
const DUMP = path.join(ROOT, 'scripts', 'guards', 'schema_dump.py');
const MIGRATION_FILE = /^mealie\/alembic\/versions\/.*\.py$/;

function git(tree, args) {
  return execFileSync('git', args, { cwd: tree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The migration files the change added or edited: against `base`, else against the sandbox's first (fixture) commit, else every file the tree does not track. */
function changedMigrations(tree, base) {
  let names;
  try {
    const against = base || git(tree, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0];
    git(tree, ['add', '-A']);
    names = git(tree, ['diff', '--cached', '--name-status', against]).split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return { status: s[0], path: p[p.length - 1] }; });
  } catch (e) {
    return { error: `not a git tree: ${String(e.message).split('\n')[0]}`, files: [] };
  }
  return { files: names.filter((f) => f.status !== 'D' && MIGRATION_FILE.test(f.path)).map((f) => f.path) };
}

function sh(cmd, { cwd, env, timeoutMs = 900000 }) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } });
  return { ok: r.status === 0, status: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-8).join('\n') };
}

function gradeMigration({ tree, base, python = 'python' }) {
  const result = { grade: 'migration', safe: false, files: [], findings: [], proof: null, reasons: [] };
  const changed = changedMigrations(tree, base);
  if (changed.error) result.reasons.push(changed.error);
  result.files = changed.files;
  if (!changed.files.length) {
    result.reasons.push('no migration file under mealie/alembic/versions/ was added or changed');
    return result;
  }
  for (const f of changed.files) {
    const text = fs.readFileSync(path.join(tree, f), 'utf8');
    for (const finding of migration.analyzeText(f, text)) result.findings.push(finding);
  }
  const blocking = result.findings.filter((f) => f.severity === 'blocking');
  if (blocking.length) result.reasons.push(`${blocking.length} blocking finding(s): ${blocking.map((f) => `${f.file}:${f.line} ${f.kind}`).join('; ')}`);
  // The rollback proof on Mealie's own alembic setup.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-mig-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data);
  const env = { DATA_DIR: data, TESTING: 'True', PRODUCTION: 'True', PYTHONDONTWRITEBYTECODE: '1', ALLOW_SIGNUP: 'True' };
  const db = path.join(data, 'mealie.db');
  const dump = (label) => {
    const r = sh(`${python} ${JSON.stringify(DUMP)} ${JSON.stringify(db)} > ${JSON.stringify(path.join(tmp, `${label}.json`))}`, { cwd: tree, env });
    return r.ok && fs.existsSync(path.join(tmp, `${label}.json`)) ? fs.readFileSync(path.join(tmp, `${label}.json`), 'utf8') : null;
  };
  const alembic = `${python} -m alembic -c mealie/alembic/alembic.ini`;
  const proof = { seed: null, before: null, downgrade: null, downgraded: null, upgrade: null, after: null, roundTrip: false, reverted: null };
  try {
    const seed = sh(`${python} -c "from mealie.db.init_db import main; main()"`, { cwd: tree, env });
    proof.seed = seed.ok;
    if (!seed.ok) { result.reasons.push(`init_db (alembic upgrade head) failed on the delivered tree: ${seed.tail.trim().split('\n').pop()}`); return finish(); }
    proof.before = dump('before');
    const down = sh(`${alembic} downgrade -1`, { cwd: tree, env });
    proof.downgrade = down.ok;
    if (!down.ok) { result.reasons.push(`alembic downgrade -1 failed: ${down.tail.trim().split('\n').pop()}`); return finish(); }
    proof.downgraded = dump('downgraded');
    const up = sh(`${alembic} upgrade head`, { cwd: tree, env });
    proof.upgrade = up.ok;
    if (!up.ok) { result.reasons.push(`alembic upgrade head after the downgrade failed: ${up.tail.trim().split('\n').pop()}`); return finish(); }
    proof.after = dump('after');
    if (!proof.before || !proof.after) { result.reasons.push('the schema dump produced no output'); return finish(); }
    proof.roundTrip = proof.before === proof.after;
    proof.reverted = proof.downgraded !== null && proof.downgraded !== proof.before;
    if (!proof.roundTrip) result.reasons.push('the schema after downgrade + upgrade differs from the schema before: the downgrade does not reverse the upgrade');
    return finish();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  function finish() {
    result.proof = { seed: proof.seed, downgrade: proof.downgrade, upgrade: proof.upgrade, roundTrip: proof.roundTrip, reverted: proof.reverted, schemaBefore: proof.before ? hash(proof.before) : null, schemaAfter: proof.after ? hash(proof.after) : null };
    result.safe = result.reasons.length === 0;
    return result;
  }
}

function hash(s) {
  return require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function main(argv) {
  const [kind, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  const tree = path.resolve(flags.tree || process.cwd());
  let result;
  if (kind === 'migration') result = gradeMigration({ tree, base: flags.base || null, python: flags.python || 'python' });
  else if (kind === 'authorization') result = require('./grade-authorization').gradeAuthorization({ tree, config: flags.config, python: flags.python || 'python' });
  else { process.stderr.write('usage: grade.js migration|authorization --tree <dir> [--base <commit>] [--config <security.json>]\n'); return 2; }
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.safe ? 0 : 1;
}

module.exports = { gradeMigration, changedMigrations, MIGRATION_FILE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
