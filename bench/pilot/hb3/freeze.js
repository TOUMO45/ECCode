'use strict';
// Writes the H-B3 freeze (protocol 2026-11-03-hb3.md, step 4): the sha256 of every file the detector-v3 pipeline loads, by the same
// rule as the registered freeze (bench/pilot/phase2-seeds.js freezeList) plus the files the rule does not cover (the Mealie
// configuration generator, its setup script, the per-seed runner and the sealing tool). The commit that contains this file's output is
// the freeze commit; the measurement runs from a worktree at it, where
//   ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check
// must say frozen. The v1 and v2 freezes (bench/pilot/phase2-freeze.json, phase2-freeze-v2.json) are not touched.
//   node bench/pilot/hb3/freeze.js [--out bench/pilot/phase2-freeze-v3.json]
const fs = require('fs');
const path = require('path');
const seeds = require('../phase2-seeds');
const { EXTRA: EXTRA2 } = require('../hb2/freeze');

// The v2 extras (configuration generator, setup script, per-seed runner, the H-B2 sealing tool) and the H-B3 sealing tool the seeding agent runs.
const EXTRA = [...EXTRA2, 'bench/pilot/hb3/seal.js'];

const ROOT = path.join(__dirname, '..', '..', '..');

function build(root = ROOT) {
  const files = [...new Set([...seeds.freezeList(root), ...EXTRA])].sort();
  return {
    version: 3,
    frozenAt: new Date().toISOString(),
    implementationCommit: 'see-protocol', // the commit containing this file; its hash is recorded in bench/protocols/2026-11-03-hb3.md
    predecessors: [
      'bench/pilot/phase2-freeze.json (v1, commit 4fbb80ed23ed58c059ba6bc99fb6318c61562257)',
      'bench/pilot/phase2-freeze-v2.json (v2, commit 72d89a6)',
    ],
    note: 'The H-B3 pipeline (detector v3), frozen by content hash before any seed of the new set existed. Rule: bench/pilot/phase2-seeds.js freezeList (the require closure of lib/behavior.js, the CLI entry, the argument parser, the probe runner and the seed harness) plus the Mealie configuration generator, its setup script, the per-seed runner and the sealing tool. Select it with ECCODE_FREEZE_FILE. The report tool and the analysis scripts are not frozen: they compute no diff result.',
    files: seeds.hashes(root, files),
  };
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'bench/pilot/phase2-freeze-v3.json');
  const f = build();
  const missing = Object.entries(f.files).filter(([, h]) => h === 'missing').map(([n]) => n);
  if (missing.length) { process.stderr.write(`missing: ${missing.join(', ')}\n`); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(f, null, 2) + '\n');
  process.stdout.write(`wrote ${path.relative(ROOT, out)}: ${Object.keys(f.files).length} files\n`);
}

module.exports = { build, EXTRA };
