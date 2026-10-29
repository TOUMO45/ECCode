'use strict';
// Seed validity (bench/protocols/2026-10-28-phase2.md §4a): every seed of the
// sealed set is applied alone to a clean Mealie checkout at the registered
// commit and the FULL backend suite is run. The worker receives only the
// sealed file and the key from ECCODE_SEED_KEY; it prints one line per seed,
// "<id> pass" or "<id> fail", and nothing else about a seed. With --prune it
// re-seals the set without the failing seeds (same key, fresh IV), updates
// the manifest's counts and hashes, and prints the final count.
//   ECCODE_SEED_KEY=<hex> MEALIE=/root/.cache/eccode/mealie-seed NLTK_DATA=/root/.cache/eccode/nltk_data \
//     node bench/pilot/phase2-seed-validate.js [--prune] [--only s01,s02] [--out results.json]
// The suite runs with Mealie's own invocation (uv run pytest, 4 workers,
// UV_FROZEN=1); it takes about 2 minutes per seed on 4 cores.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const seeds = require('./phase2-seeds');
const { encrypt, sha256 } = require('./phase2-reseal');

const DIR = path.join(__dirname, '..', 'suites', 'phase2-seeds');
const SUITE = ['run', 'pytest', 'tests', '-p', 'no:cacheprovider', '-n', '4', '--dist', 'loadfile', '-o', 'addopts=-ra', '-q'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function clean(checkout, commit) {
  git(checkout, ['checkout', '-q', '--', '.']);
  git(checkout, ['clean', '-fdq', '--', 'mealie', 'tests']);
  if (git(checkout, ['rev-parse', 'HEAD']) !== commit) git(checkout, ['checkout', '-q', commit]);
  if (git(checkout, ['status', '--porcelain'])) throw new Error('the checkout is not clean');
}

function runSuite(checkout, timeoutMs) {
  const r = spawnSync('uv', SUITE, { cwd: checkout, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, UV_FROZEN: '1', PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const summary = ((r.stdout || '').split('\n').reverse().find((l) => /passed|failed|error/.test(l)) || '').trim();
  return { passed: r.status === 0, summary: summary.replace(/\x1b\[[0-9;]*m/g, '') };
}

function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  const prune = argv.includes('--prune');
  const checkout = process.env.MEALIE;
  if (!checkout) throw new Error('MEALIE must point at a Mealie checkout with its uv environment');
  const key = process.env.ECCODE_SEED_KEY;
  const set = seeds.unseal(key);
  clean(checkout, set.mealieCommit);
  const results = [];
  for (const s of set.seeds) {
    if (only && !only.includes(s.id)) continue;
    const r = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: checkout, input: s.patch, encoding: 'utf8' });
    let verdict;
    let summary = '';
    if (r.status !== 0) verdict = 'fail';
    else ({ passed: verdict, summary } = runSuite(checkout, 40 * 60 * 1000)), (verdict = verdict ? 'pass' : 'fail');
    clean(checkout, set.mealieCommit);
    results.push({ id: s.id, verdict, summary });
    process.stdout.write(`${s.id} ${verdict}\n`);
  }
  if (out) fs.writeFileSync(out, JSON.stringify(results.map(({ id, verdict }) => ({ id, verdict })), null, 2) + '\n');
  if (prune) {
    const failing = new Set(results.filter((r) => r.verdict === 'fail').map((r) => r.id));
    const kept = { ...set, seeds: set.seeds.filter((s) => !failing.has(s.id)), validatedAt: new Date().toISOString(), validation: { fullSuite: true, dropped: [...failing] } };
    const plain = Buffer.from(JSON.stringify(kept));
    const sealed = Buffer.from(JSON.stringify(encrypt(plain, Buffer.from(key, 'hex'))));
    const manifestFile = path.join(DIR, 'MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.counts = { unintended: kept.seeds.filter((s) => !s.intended).length, intended: kept.seeds.filter((s) => s.intended).length, total: kept.seeds.length };
    manifest.kinds = kept.seeds.map((s) => s.kind);
    manifest.verification = { full: kept.seeds.length, partial: 0, validatedAt: kept.validatedAt, dropped: [...failing] };
    manifest.plaintextSha256 = sha256(plain);
    manifest.sealedSha256 = sha256(sealed);
    fs.writeFileSync(path.join(DIR, 'seeds.sealed'), sealed);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(`final count: ${manifest.counts.unintended} unintended, ${manifest.counts.intended} intended (${failing.size} dropped); plaintextSha256 ${manifest.plaintextSha256}; sealedSha256 ${manifest.sealedSha256}\n`);
  }
  return results.some((r) => r.verdict === 'fail') ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { runSuite, clean };
