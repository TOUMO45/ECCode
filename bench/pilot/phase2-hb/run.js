'use strict';
// The H-B measurement runner (protocol section 4a, docs/design/phase3-plan.md 0.C).
// Every seed of the sealed set is applied alone to a clean Mealie checkout at the
// registered commit and run through `eccode behavior diff` of a FROZEN ECCode
// tree (a git worktree at the tag phase2-hb-freeze, verified by its own
// phase2-seeds.js check). One result line per seed; nothing about a seed's
// files or patch is printed.
//   ECCODE_SEED_KEY=<hex> node bench/pilot/phase2-hb/run.js <frozen ECCode tree> <mealie checkout> [--only s01,s02] [--out results.jsonl]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sh(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function git(cwd, args) {
  const r = sh('git', args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The frozen tree must pass its own freeze check; otherwise nothing runs. */
function assertFrozenTree(tree) {
  const r = sh(process.execPath, [path.join(tree, 'bench', 'pilot', 'phase2-seeds.js'), 'check'], { cwd: tree });
  if (r.status !== 0) throw new Error(`the ECCode tree at ${tree} is not the frozen H-B pipeline:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/** A clean checkout at `commit`, with .eccode/ excluded from git's view and removed. */
function clean(checkout, commit) {
  const exclude = path.join(checkout, '.git', 'info', 'exclude');
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\.eccode\/$/m.test(text)) fs.writeFileSync(exclude, `${text}${text.endsWith('\n') || !text ? '' : '\n'}.eccode/\n`);
  fs.rmSync(path.join(checkout, '.eccode'), { recursive: true, force: true });
  git(checkout, ['checkout', '-q', '--', '.']);
  git(checkout, ['clean', '-fdq', '--', '.']);
  if (commit && git(checkout, ['rev-parse', 'HEAD']) !== commit) git(checkout, ['checkout', '-q', commit]);
  if (git(checkout, ['status', '--porcelain'])) throw new Error('the checkout is not clean');
}

/** One `eccode` call on the frozen tree, JSON out; throws with the CLI's message on a non-zero exit unless `allow` includes it. */
function eccode(tree, checkout, args, { allow = [] } = {}) {
  const r = sh(process.execPath, [path.join(tree, 'bin', 'eccode.js'), ...args, '--json'], { cwd: checkout });
  let json = null;
  const text = r.stdout.trim();
  const start = text.indexOf('{');
  if (start >= 0) {
    try { json = JSON.parse(text.slice(start)); } catch { json = null; }
  }
  if (r.status !== 0 && !allow.includes(r.status)) throw new Error(`eccode ${args.slice(0, 2).join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  return { status: r.status, json, stderr: r.stderr };
}

/**
 * Run one seed. `apply(checkout)` applies the seed and returns {id, intended, kind, contract, verification};
 * `configure(checkout)` writes .eccode/behavior.json. Both are injectable so the runner is testable on a fixture.
 */
function runSeed({ tree, checkout, commit, seedId, apply, configure, runs = 2, timeoutS = 1800 }) {
  clean(checkout, commit);
  eccode(tree, checkout, ['init', '--name', `hb-${seedId}`, '--idea', `H-B measurement of seed ${seedId}`, '--track', 'fix', '--actor', 'orchestrator']);
  configure(checkout);
  const seed = apply(checkout);
  const record = { id: seed.id, intended: Boolean(seed.intended), kind: seed.kind || null, verification: (seed.verification && seed.verification.scope) || null };
  try {
    if (seed.intended && seed.contract) {
      const file = path.join(os.tmpdir(), `eccode-hb-contract-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(seed.contract));
      try { eccode(tree, checkout, ['behavior', 'contract', '--file', file, '--actor', 'technical-designer']); } finally { fs.rmSync(file, { force: true }); }
      record.contract = Array.isArray(seed.contract) ? seed.contract.length : (seed.contract.entries || []).length;
    }
    const route = eccode(tree, checkout, ['behavior', 'route', '--actor', 'backend-engineer']).json;
    record.route = route.decision;
    record.surfaces = (route.surfaces || []).length;
    if (route.decision !== 'run') {
      record.flagged = false;
      record.miss = 'routing skip: no public surface reached';
      return record;
    }
    const d = eccode(tree, checkout, ['behavior', 'diff', '--actor', 'backend-engineer', '--runs', String(runs), '--timeout', String(timeoutS)], { allow: [2] }).json;
    if (!d) throw new Error('the diff produced no JSON result');
    Object.assign(record, { result: d.id, probes: d.probes, executed: d.executed, dropped: d.dropped, differences: d.differences.length, expected: d.expected, unexplained: d.unexplained, coverage: d.coverage, coverageNote: d.coverageNote || null, notes: (d.notes || []).length });
    record.flagged = record.intended ? d.unexplained === 0 && d.coverage === 'ok' : d.unexplained >= 1;
    if (d.coverage !== 'ok') record.miss = `coverage: ${d.coverageNote || d.coverage}`;
    else if (!record.flagged) record.miss = record.intended ? `${d.unexplained} unexplained difference(s) on a declared change (false positive)` : 'no unexplained difference';
    return record;
  } catch (err) {
    record.error = String(err.message).slice(0, 400);
    record.flagged = false;
    return record;
  } finally {
    try { clean(checkout, commit); } catch { /* reported by the next seed */ }
  }
}

function main(argv) {
  const [tree, checkout] = argv;
  if (!tree || !checkout) {
    process.stderr.write('usage: run.js <frozen ECCode tree> <mealie checkout> [--only ids] [--out file]\n');
    return 2;
  }
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  process.stdout.write(`${assertFrozenTree(path.resolve(tree))}\n`);
  const seeds = require(path.join(path.resolve(tree), 'bench', 'pilot', 'phase2-seeds.js'));
  const config = require(path.join(path.resolve(tree), 'bench', 'pilot', 'phase2-hb', 'config.js'));
  const set = seeds.unseal();
  let hits = 0;
  let n = 0;
  for (const s of set.seeds) {
    if (only && !only.includes(s.id)) continue;
    const record = runSeed({
      tree: path.resolve(tree),
      checkout: path.resolve(checkout),
      commit: set.mealieCommit,
      seedId: s.id,
      apply: (dir) => seeds.apply(s.id, dir),
      configure: (dir) => config.write(dir, path.resolve(tree)),
    });
    n += 1;
    if (record.flagged) hits += 1;
    const line = `${record.id} ${record.intended ? 'intended  ' : 'unintended'} ${record.flagged ? 'flagged' : 'MISSED'}${record.miss ? ` (${record.miss})` : ''}${record.error ? ` ERROR ${record.error}` : ''} probes=${record.probes ?? '-'} unexplained=${record.unexplained ?? '-'} coverage=${record.coverage ?? '-'}`;
    process.stdout.write(`${line}\n`);
    if (out) fs.appendFileSync(out, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n');
  }
  process.stdout.write(`${hits}/${n} as expected\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { runSeed, clean, assertFrozenTree, eccode };
