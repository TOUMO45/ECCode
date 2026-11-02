'use strict';
// The Round 1-lite registration hashes (bench/protocols/2026-11-02-senior-ambiguous-r1lite.md sections 4 and 8):
// the harness the grade and labels depend on, the 16 ambiguous items (request and registered question), and the
// bare screening records the ECCode arm is compared with. Written once, before the first ECCode run; any
// later difference is reported and the comparison is not made.
//   node bench/suites/senior/_tools/r1lite-freeze.js            write r1lite-freeze.json
//   node bench/suites/senior/_tools/r1lite-freeze.js --verify   check every hash; exit 1 on a difference
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const OUT = path.join(__dirname, 'r1lite-freeze.json');
const SCREENING = 'bench/pilot-results/2026-11-01-senior-screening.ambiguous.jsonl';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

function filesUnder(root, rel) {
  const dir = path.join(root, rel);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = posix(path.join(rel, e.name));
    if (e.isDirectory()) out.push(...filesUnder(root, r));
    else out.push(r);
  }
  return out;
}

/** Every file the registration pins, relative to root, sorted. */
function pinned(root = ROOT) {
  const tools = filesUnder(root, 'bench/suites/senior/_tools').filter((f) => !f.endsWith('/r1lite-freeze.json'));
  const items = fs.readdirSync(path.join(root, 'bench/suites/senior')).filter((d) => /^\d+-ambiguous-/.test(d)).sort();
  const itemFiles = items.flatMap((d) => filesUnder(root, `bench/suites/senior/${d}`));
  return { files: [...new Set([...tools, 'lib/bench.js', ...itemFiles])].sort(), items };
}

function build(root = ROOT) {
  const { files, items } = pinned(root);
  const hashes = {};
  for (const f of files) hashes[f] = sha256(fs.readFileSync(path.join(root, f)));
  const screening = fs.readFileSync(path.join(root, SCREENING));
  return {
    protocol: 'bench/protocols/2026-11-02-senior-ambiguous-r1lite.md',
    frozenAt: new Date().toISOString(),
    items: items.length,
    // The records are one batch header ({ type, suite, tasks, … }) and one record per run ({ task, variant, run, … }).
    screening: { file: SCREENING, sha256: sha256(screening), runs: screening.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.task && r.variant).length },
    files: hashes,
  };
}

/** [] when every pinned hash still holds; otherwise one line per difference. */
function verify(root = ROOT, freeze = JSON.parse(fs.readFileSync(OUT, 'utf8'))) {
  const problems = [];
  for (const [f, h] of Object.entries(freeze.files)) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) problems.push(`${f}: missing`);
    else if (sha256(fs.readFileSync(abs)) !== h) problems.push(`${f}: changed`);
  }
  const { files } = pinned(root);
  for (const f of files) if (!(f in freeze.files)) problems.push(`${f}: not in the freeze`);
  const abs = path.join(root, freeze.screening.file);
  if (!fs.existsSync(abs)) problems.push(`${freeze.screening.file}: missing`);
  else if (sha256(fs.readFileSync(abs)) !== freeze.screening.sha256) problems.push(`${freeze.screening.file}: changed`);
  return problems;
}

if (require.main === module) {
  if (process.argv.includes('--verify')) {
    const problems = verify();
    process.stdout.write(problems.length ? `NOT FROZEN:\n  ${problems.join('\n  ')}\n` : 'frozen: every pinned hash holds\n');
    process.exit(problems.length ? 1 : 0);
  }
  const f = build();
  fs.writeFileSync(OUT, JSON.stringify(f, null, 2) + '\n');
  process.stdout.write(`wrote ${posix(path.relative(ROOT, OUT))}: ${Object.keys(f.files).length} files, ${f.items} items, ${f.screening.runs} screening runs, screening sha256 ${f.screening.sha256}\n`);
}

module.exports = { build, verify, pinned, SCREENING };
