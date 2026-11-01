'use strict';
// Migration safety (Phase 3, B.1; Alembic/SQLAlchemy first). Static analysis
// of every migration file the change adds or edits: long-lock operations
// (NOT NULL without a default, type changes, index creation without
// CONCURRENTLY, table rewrites), irreversible operations (drop column or
// table, destructive SQL) and a missing downgrade; the expand/contract rule
// for renames and type changes; and the rollback proof: on a seeded copy of
// the database in the candidate worktree, upgrade → downgrade → upgrade, the
// schema before and after compared as evidence. Delivery refuses a migration
// without an analysis and a proof at the current tree, or with a blocking
// finding no reviewer waived.
const fs = require('fs');
const path = require('path');
const compat = require('../compat');
const evidence = require('../evidence');
const { git } = require('../project');
const { EccodeError, newId, sha256, writeFileAtomic, toPosix, exists, readJson } = require('../util');
const worktree = require('../worktree');

const DUMP_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'guards', 'schema_dump.py');

/** The body of a top-level `def name(` in a Python file. */
function bodyOf(text, name) {
  const m = text.match(new RegExp(`^def ${name}\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

function stripComments(body) {
  return body.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
}

/** Every `op.x(...)` / `batch_op.x(...)` call with its full argument text (balanced parentheses) and line. */
function calls(body) {
  const out = [];
  const re = /\b(op|batch_op)\.([a-z_]+)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth += 1;
      else if (body[i] === ')') depth -= 1;
      i += 1;
    }
    const args = body.slice(re.lastIndex, i - 1);
    out.push({ scope: m[1], op: m[2], args, line: body.slice(0, m.index).split('\n').length });
  }
  return out;
}

const q = (s) => `'${s}'`;

/**
 * Findings for one migration file's text. Each: {kind, severity: blocking|warning, line, message, fix}.
 * `offset` is the line of the upgrade body's first line in the file.
 */
function analyzeText(file, text) {
  const findings = [];
  const up = bodyOf(text, 'upgrade');
  const down = bodyOf(text, 'downgrade');
  const upLine = up ? text.slice(0, text.indexOf(up)).split('\n').length : 1;
  const add = (kind, severity, line, message, fix) => findings.push({ kind, severity, file, line, message, fix });
  if (!file.endsWith('.py')) {
    if (compat.DESTRUCTIVE_SQL.test(text)) add('destructive-sql', 'blocking', 1, 'destructive SQL (drop, truncate, unconditional delete) in a migration: data is lost and cannot be restored by a downgrade', 'split the removal into a later contract migration after the data is no longer read, or a reviewer waives it (eccode guard waive --guard migration)');
    return findings;
  }
  if (up === null) add('no-upgrade', 'blocking', 1, 'no upgrade() in the migration', 'every Alembic migration defines upgrade()');
  const downBody = down === null ? '' : stripComments(down).trim();
  if (down === null || downBody === '' || downBody === 'pass' || /^raise\b/.test(downBody)) add('missing-downgrade', 'blocking', down === null ? 1 : text.slice(0, text.indexOf(down)).split('\n').length, 'downgrade() is missing or empty: the migration cannot be rolled back', 'write the downgrade that reverses every operation of upgrade(), and prove it (eccode guard migration --proof)');
  if (!up) return findings;
  const body = stripComments(up);
  for (const c of calls(body)) {
    const line = upLine + c.line - 1;
    const a = c.args;
    if (c.op === 'drop_column' || c.op === 'drop_table') add(c.op.replace('_', '-'), 'blocking', line, `${c.op} loses data irreversibly (${a.split(',').slice(0, 2).map((s) => s.trim()).join(', ')})`, 'ship the drop as the contract step of a later migration, after no code reads it, with a reviewer\'s waiver (eccode guard waive --guard migration --finding <id> --reason ...)');
    if (c.op === 'add_column' && /nullable\s*=\s*False/.test(a) && !/server_default\s*=/.test(a)) add('not-null-no-default', 'blocking', line, 'NOT NULL column added without a server_default: fails on existing rows and rewrites or locks the table', 'add the column nullable (expand), backfill, then set NOT NULL in a later migration (contract), or give it a server_default');
    if (c.op === 'alter_column') {
      if (/new_column_name\s*=/.test(a)) add('rename-in-place', 'blocking', line, 'column renamed in place: every running instance that reads the old name breaks during the deploy', 'express it as expand (add the new column), backfill, switch the code, contract (drop the old column) across separate migrations, or a reviewer waives it');
      if (/type_\s*=/.test(a)) add('type-change', 'blocking', line, 'column type changed in place: a table rewrite under lock, and readers of the old type break', 'expand with a new column of the new type, backfill, switch, contract; or a reviewer waives it');
      if (/nullable\s*=\s*False/.test(a) && !/UPDATE\s/i.test(body)) add('set-not-null-no-backfill', 'warning', line, 'column set NOT NULL without a backfill (no UPDATE in this migration): fails when a row holds NULL', 'backfill before setting NOT NULL');
    }
    if (c.op === 'rename_table') add('rename-table', 'blocking', line, 'table renamed in place: readers of the old name break during the deploy', 'expand/contract, or a reviewer waives it');
    if (c.op === 'create_index' && !/postgresql_concurrently\s*=\s*True/.test(a)) add('index-not-concurrent', 'warning', line, 'index created without postgresql_concurrently=True: a long lock on a large table on PostgreSQL', 'create it with postgresql_concurrently=True (outside a transaction) or at a quiet time');
    if (c.op === 'execute' && compat.DESTRUCTIVE_SQL.test(a)) add('destructive-sql', 'blocking', line, 'destructive SQL in op.execute', 'a later contract migration, or a reviewer\'s waiver');
    if (c.op === 'drop_constraint' && /unique/i.test(a)) add('drop-unique', 'warning', line, 'a unique constraint is dropped: duplicates become possible (the race probe covers duplicate inserts)', 'keep the constraint or add the race probe\'s operation for it');
  }
  return findings;
}

/** The migration files the change touches since `base`, each with its status. */
function migrationFiles(root, base) {
  const changed = worktree.changedSince(root, base);
  return changed.filter((f) => compat.MIGRATION_FILE.test(f)).map((f) => {
    const abs = path.join(root, f);
    const existedAtBase = Boolean(base && git(root, ['cat-file', '-e', `${base}:${f}`]) !== null);
    return { file: f, status: !exists(abs) ? 'deleted' : existedAtBase ? 'edited' : 'added' };
  });
}

/** Static analysis of the change's migrations, recorded as migration.analysis with its artifact. */
function analyze(store, config, actor, { task } = {}) {
  const state = store.state();
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  const base = state.work.baseCommit;
  const files = migrationFiles(store.root, base);
  const findings = [];
  for (const m of files) {
    if (m.status !== 'added') {
      findings.push({ kind: m.status === 'deleted' ? 'migration-deleted' : 'applied-migration-edited', severity: 'blocking', file: m.file, line: 1, message: `${m.file} existed at the base commit and was ${m.status}: a migration already applied somewhere must never change`, fix: 'add a new migration instead; a reviewer waives this only for a migration that never ran' });
      if (m.status === 'deleted') continue;
    }
    findings.push(...analyzeText(m.file, fs.readFileSync(path.join(store.root, m.file), 'utf8')));
  }
  findings.forEach((f, i) => { f.id = `mf${i + 1}`; });
  const fingerprint = require('../behavior').treeFingerprint(store.root, state);
  const id = newId('mig');
  const rel = `.eccode/guards/${id}.json`;
  const artifact = { id, files, findings, treeFingerprint: fingerprint };
  const text = JSON.stringify(artifact, null, 2) + '\n';
  fs.mkdirSync(path.join(store.root, '.eccode', 'guards'), { recursive: true });
  writeFileAtomic(path.join(store.root, rel), text);
  const data = { id, files: files.map((m) => m.file), findings, blocking: findings.filter((f) => f.severity === 'blocking').length, treeFingerprint: fingerprint, artifact: rel, artifactSha256: sha256(text), ...(task ? { task } : {}) };
  return store.commit('migration.analysis', actor, data, (s) => { if (!s.work || s.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', 'No active work item'); }).event.data;
}

function guardsConfig(root) {
  return readJson(path.join(root, '.eccode', 'guards.json'), {});
}

function sh(cmd) {
  return /^[\w./:@+=,-]+$/.test(cmd) ? cmd : `'${String(cmd).replace(/'/g, "'\\''")}'`;
}

/**
 * The rollback proof: in the candidate worktree, seed a database (the
 * configured seed command upgrades to head and loads data), dump the schema,
 * downgrade one step, upgrade again, dump again; the two dumps must be equal.
 * Configuration (.eccode/guards.json "migration"): env ({tmp} for the
 * database path), seed, upgrade, downgrade, python (optional), databaseEnv
 * (the env variable holding the database path or URL for the dump).
 */
function proof(store, config, actor, { task, timeoutMs } = {}) {
  const state = store.state();
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  const cfg = guardsConfig(store.root).migration;
  if (!cfg || !cfg.seed || !cfg.upgrade || !cfg.downgrade || !cfg.databaseEnv) throw new EccodeError('INVALID_INPUT', 'The rollback proof needs .eccode/guards.json "migration": {env: {<databaseEnv>: "{tmp}/db.sqlite"}, databaseEnv, seed, upgrade, downgrade[, python]}');
  const base = state.work.baseCommit;
  if (!base) throw new EccodeError('NOT_GIT', 'The rollback proof needs the work item\'s git base commit');
  const py = require('../lab').pythonFor(store.root, cfg.python);
  const fingerprint = require('../behavior').treeFingerprint(store.root, state);
  const evs = [];
  let dumps = { before: null, down: null, after: null };
  worktree.withSides(store.root, base, ({ candidate }) => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-migration-'));
    const env = {};
    for (const [k, v] of Object.entries(cfg.env || {})) env[k] = String(v).replace(/\{tmp\}/g, tmp);
    env.PYTHONDONTWRITEBYTECODE = '1';
    const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
    const run = (label, command) => {
      const ev = evidence.runCommand(store, actor, { label: `migration: ${label}`, command: `env ${envPrefix} sh -c ${sh(command)}`, task, purpose: 'check', timeoutMs: timeoutMs || 600000, externalCwd: candidate.root, cwdLabel: 'candidate worktree', extra: { migration: label } });
      evs.push(ev.id);
      if (ev.integrity) throw new EccodeError('INTEGRITY', `migration ${label}: ${ev.integrity.join('; ')}`);
      return ev;
    };
    const dump = (label) => {
      const out = path.join(tmp, `${label}.json`);
      run(`schema ${label}`, `${sh(py)} ${sh(DUMP_SCRIPT)} "$${cfg.databaseEnv}" > ${sh(out)}`);
      return exists(out) ? fs.readFileSync(out, 'utf8') : null;
    };
    try {
      const seed = run('seed', cfg.seed);
      if (seed.exitCode !== 0) throw new EccodeError('GUARD_FAILED', `the seed command failed (ev:${seed.id}):\n${seed.outputTail}`);
      dumps.before = dump('before');
      const down = run('downgrade', cfg.downgrade);
      if (down.exitCode !== 0) throw new EccodeError('GUARD_FAILED', `downgrade failed (ev:${down.id}):\n${down.outputTail}`);
      dumps.down = dump('downgraded');
      const up = run('upgrade', cfg.upgrade);
      if (up.exitCode !== 0) throw new EccodeError('GUARD_FAILED', `upgrade after downgrade failed (ev:${up.id}):\n${up.outputTail}`);
      dumps.after = dump('after');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  if (!dumps.before || !dumps.after) throw new EccodeError('GUARD_FAILED', 'the schema dump produced no output (is sqlalchemy importable by the configured python?)');
  const roundTrip = dumps.before === dumps.after;
  const reverted = dumps.down !== null && dumps.down !== dumps.before;
  const data = { id: newId('mrp'), evidence: evs, schemaBefore: sha256(dumps.before), schemaDowngraded: dumps.down ? sha256(dumps.down) : null, schemaAfter: sha256(dumps.after), roundTrip, reverted, treeFingerprint: fingerprint, ...(task ? { task } : {}) };
  return store.commit('migration.rollback.proof', actor, data, (s) => { if (!s.work || s.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', 'No active work item'); }).event.data;
}

/** Delivery problems: a migration in the change needs a fresh analysis and proof; blocking findings need a reviewer's waiver. */
function deliveryProblems(state, root) {
  if (!state.work || !state.guards) return [];
  const files = root ? migrationFiles(root, state.work.baseCommit) : [];
  if (!files.length) return [];
  const fp = require('../behavior').treeFingerprint(root, state);
  const problems = [];
  const analysis = [...state.guards.migration.analyses].reverse().find((a) => a.treeFingerprint === fp);
  if (!analysis) problems.push(`migration guard: ${files.map((m) => m.file).join(', ')} changed and no migration analysis matches the current tree (eccode guard migration --actor <owner>)`);
  else {
    const waived = new Set(state.guards.waivers.filter((w) => w.guard === 'migration' && w.result === analysis.id).map((w) => w.finding));
    for (const f of analysis.findings.filter((f) => f.severity === 'blocking' && !waived.has(f.id))) problems.push(`migration guard: ${f.file}:${f.line} ${f.kind} (${f.id}): ${f.message}. ${f.fix}`);
  }
  // The rollback proof needs the project's migration commands (.eccode/guards.json "migration"); without them the
  // static analysis stands alone and the report says the rollback was not proven.
  if (guardsConfig(root).migration) {
    const proofRec = [...state.guards.migration.proofs].reverse().find((p) => p.treeFingerprint === fp);
    if (!proofRec) problems.push('migration guard: no rollback proof for the current tree (eccode guard migration --proof --actor <owner>)');
    else if (!proofRec.roundTrip) problems.push(`migration guard: the rollback proof ${proofRec.id} failed: the schema after upgrade → downgrade → upgrade differs from the schema before (ev:${proofRec.evidence.join(', ev:')})`);
  }
  return problems;
}

function reportLines(state) {
  const g = state.guards && state.guards.migration;
  if (!g || (!g.analyses.length && !g.proofs.length)) return [];
  const lines = ['## Migration guard', ''];
  for (const a of g.analyses) lines.push(`- Analysis ${a.id} (${a.files.join(', ') || 'no migration'}): ${a.findings.length} finding(s), ${a.blocking} blocking${a.findings.length ? ': ' + a.findings.map((f) => `${f.kind}@${f.file}:${f.line}`).join(', ') : ''}`);
  for (const p of g.proofs) lines.push(`- Rollback proof ${p.id}: ${p.roundTrip ? 'schema round-trips' : 'SCHEMA DOES NOT ROUND-TRIP'}${p.reverted ? '' : ' (the downgrade changed nothing)'} (ev:${p.evidence.join(', ev:')})`);
  if (g.analyses.length && !g.proofs.length) lines.push('- Rollback NOT proven: no migration commands configured (.eccode/guards.json "migration"), so only the static analysis ran');
  lines.push('');
  return lines;
}

module.exports = { analyzeText, analyze, proof, migrationFiles, deliveryProblems, reportLines, calls, bodyOf };
