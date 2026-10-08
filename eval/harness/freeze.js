#!/usr/bin/env node
'use strict';
// Freeze the evaluation suite: content hashes of every task (repo, grader,
// solution, naive, meta), the shared kit, the targets and the org rules.
//   node eval/harness/freeze.js            write eval/suite/frozen.json
//   node eval/harness/freeze.js --verify   exit 1 if anything differs from frozen.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listTasks, sha256Dir, KIT_DIR } = require('./lib');

const file = path.join(__dirname, '..', 'suite', 'frozen.json');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const now = {
  kit: sha256Dir(KIT_DIR),
  targets: sha(path.join(__dirname, '..', 'suite', 'targets.json')),
  orgRules: sha(path.join(__dirname, '..', 'suite', 'org-rules.md')),
  tasks: Object.fromEntries(listTasks().map((t) => [t.id, { split: t.split, relation: t.relation || null, sha256: sha256Dir(t.dir) }])),
};
if (process.argv.includes('--verify')) {
  const frozen = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diffs = [];
  for (const k of ['kit', 'targets', 'orgRules']) if (frozen[k] !== now[k]) diffs.push(k);
  for (const id of new Set([...Object.keys(frozen.tasks), ...Object.keys(now.tasks)])) if (!frozen.tasks[id] || !now.tasks[id] || frozen.tasks[id].sha256 !== now.tasks[id].sha256) diffs.push(`task ${id}`);
  console.log(diffs.length ? `FROZEN SUITE CHANGED: ${diffs.join(', ')}` : `frozen suite intact (${Object.keys(now.tasks).length} tasks)`);
  process.exit(diffs.length ? 1 : 0);
}
fs.writeFileSync(file, JSON.stringify({ frozenAt: new Date().toISOString(), ...now }, null, 2));
console.log(`froze ${Object.keys(now.tasks).length} tasks`);
