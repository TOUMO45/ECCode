// delivery-lead check (phase b-foundation): which tests in a TAP log of `npm test` carry no criterion or finding id?
// Groups unnamed tests by test file and reports, per file, named/unnamed counts and the unnamed names.
// Usage: node phase-b-test-ids.mjs <evidence log>
import { readFileSync } from 'node:fs';

const ID = /^(RS-\d{2}|NFR\d|F-TR-\d+|SEC-\d+|ARCH-\d+|F-PL-\d+)\b/;
const lines = readFileSync(process.argv[2], 'utf8').split('\n');
const files = new Map();
let file = null;
for (const line of lines) {
  const sub = line.match(/^# Subtest: (\/\S+\.test\.js)$/);
  if (sub) { file = sub[1].replace(/^.*?\/rescuestock\//, ''); continue; }
  const ok = line.match(/^\s+(?:not )?ok \d+ - (.*?)(?: # .*)?$/);
  if (!ok || !file) continue;
  const name = ok[1];
  const entry = files.get(file) || { named: 0, unnamed: [] };
  if (ID.test(name)) entry.named++; else entry.unnamed.push(name);
  files.set(file, entry);
}
let total = 0;
for (const [f, e] of [...files].sort()) {
  total += e.unnamed.length;
  console.log(`${f}: named ${e.named}, unnamed ${e.unnamed.length}`);
  for (const n of e.unnamed) console.log(`    - ${n}`);
}
console.log(`unnamed total: ${total}`);
