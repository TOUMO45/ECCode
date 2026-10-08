#!/usr/bin/env node
'use strict';
// Freeze the evaluation suite: content hashes of every task (repo, grader,
// solution, naive, meta), the shared kit, the targets and the org rules.
//   node eval/harness/freeze.js            write eval/suite/frozen.json
//   node eval/harness/freeze.js --verify   exit 1 if anything differs from frozen.json
//   node eval/harness/freeze.js --split holdout2 --file frozen-round2.json [--verify]
//     the same for the tasks of one split, in another file (the first file keeps covering its own tasks only)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listTasks, sha256Dir, KIT_DIR } = require('./lib');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? null : process.argv[i + 1];
};
const file = path.join(__dirname, '..', 'suite', arg('file') || 'frozen.json');
const onlySplit = arg('split');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const now = {
  kit: sha256Dir(KIT_DIR),
  targets: sha(path.join(__dirname, '..', 'suite', 'targets.json')),
  orgRules: sha(path.join(__dirname, '..', 'suite', 'org-rules.md')),
  tasks: Object.fromEntries(listTasks().filter((t) => !onlySplit || t.split === onlySplit).map((t) => [t.id, { split: t.split, relation: t.relation || null, sha256: sha256Dir(t.dir) }])),
};
if (process.argv.includes('--verify')) {
  const frozen = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diffs = [];
  for (const k of ['kit', 'targets', 'orgRules']) if (frozen[k] !== now[k]) diffs.push(k);
  // Only the tasks the frozen file lists are compared: later task sets have their own file.
  for (const id of Object.keys(frozen.tasks)) if (!now.tasks[id] || frozen.tasks[id].sha256 !== now.tasks[id].sha256) diffs.push(`task ${id}`);
  console.log(diffs.length ? `FROZEN SUITE CHANGED: ${diffs.join(', ')}` : `frozen suite intact (${Object.keys(now.tasks).length} tasks)`);
  process.exit(diffs.length ? 1 : 0);
}
fs.writeFileSync(file, JSON.stringify({ frozenAt: new Date().toISOString(), ...now }, null, 2));
console.log(`froze ${Object.keys(now.tasks).length} tasks`);
