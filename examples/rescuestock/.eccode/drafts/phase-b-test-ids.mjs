// delivery-lead check (phase b-foundation): which test names in the test files carry no criterion or finding id?
// Static scan of test/describe/it/suite calls whose first argument is a string literal. Per file it prints the
// count of named and unnamed declarations and the unnamed names, so the phase review can judge whether an unnamed
// test proves a criterion or only supports one.
// Usage: node phase-b-test-ids.mjs <test file>...
import { readFileSync } from 'node:fs';

const ID = /^(RS-\d{2}|NFR\d|F-TR-\d+|SEC-\d+|ARCH-\d+|F-PL-\d+)\b/;
const CALL = /\b(?:test|it|describe|suite)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
let total = 0;
let totalNamed = 0;
for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, 'utf8');
  const named = [];
  const unnamed = [];
  for (const m of src.matchAll(CALL)) (ID.test(m[2]) ? named : unnamed).push(m[2]);
  total += unnamed.length;
  totalNamed += named.length;
  console.log(`${f}: named ${named.length}, unnamed ${unnamed.length}`);
  for (const n of unnamed) console.log(`    - ${n}`);
}
console.log(`declarations named: ${totalNamed}; unnamed: ${total}`);
