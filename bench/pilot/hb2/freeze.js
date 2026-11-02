'use strict';
// Writes the H-B2 freeze (protocol amendment 4): the sha256 of every file the H-B pipeline loads, by the
// same rule as the registered freeze (bench/pilot/phase2-seeds.js freezeList) plus the files the rule does
// not cover. The commit that contains this file's output is the freeze commit; the measurement runs from a
// worktree at it, where `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v2.json node bench/pilot/phase2-seeds.js check` must say frozen.
//   node bench/pilot/hb2/freeze.js [--out bench/pilot/phase2-freeze-v2.json]
const fs = require('fs');
const path = require('path');
const seeds = require('../phase2-seeds');

const ROOT = path.join(__dirname, '..', '..', '..');
const EXTRA = ['bench/pilot/phase2-hb/config.js', 'bench/pilot/phase2-hb/mealie_setup.py', 'bench/pilot/phase2-hb/run.js', 'bench/pilot/hb2/seal.js'];

function build(root = ROOT) {
  const files = [...new Set([...seeds.freezeList(root), ...EXTRA])].sort();
  return {
    version: 2,
    frozenAt: new Date().toISOString(),
    implementationCommit: 'see-protocol',  // the commit containing this file; its hash is recorded in bench/protocols/2026-10-28-phase2.md (amendment 4)
    predecessor: 'bench/pilot/phase2-freeze.json (v1, commit 4fbb80ed23ed58c059ba6bc99fb6318c61562257), still measured from its own worktree',
    note: 'The H-B2 pipeline, frozen by content hash before any seed of the new set existed. Rule: bench/pilot/phase2-seeds.js freezeList (the require closure of lib/behavior.js, the CLI entry, the argument parser, the probe runner and the seed harness) plus the Mealie configuration generator, its setup script, the per-seed runner and the sealing tool. Select it with ECCODE_FREEZE_FILE.',
    files: seeds.hashes(root, files),
  };
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'bench/pilot/phase2-freeze-v2.json');
  const f = build();
  const missing = Object.entries(f.files).filter(([, h]) => h === 'missing').map(([n]) => n);
  if (missing.length) { process.stderr.write(`missing: ${missing.join(', ')}\n`); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(f, null, 2) + '\n');
  process.stdout.write(`wrote ${path.relative(ROOT, out)}: ${Object.keys(f.files).length} files\n`);
}

module.exports = { build, EXTRA };
