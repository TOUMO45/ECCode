'use strict';
// t05-redact: differential check of src/triage/redact.js against the approved reference redact() in
// .eccode/artifacts/design/design-vectors.js over seeded random inputs built from card/phone/email/separator pieces.
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const origLog = console.log;
console.log = () => {}; // silence the reference's self-check output
const ref = require(path.join(root, '.eccode/artifacts/design/design-vectors.js'));
console.log = origLog;
const { redact } = require(path.join(root, 'src/triage/redact.js'));

let seed = 0x7f3a;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const PIECES = ['4111', '1111', '5500005555555559', '378282246310005', '12/27', '123', '555', '013', '7742', '+1', '(555)',
  '2026-10-07', 'v2.1', 'a@example.com', 'x.y@sub.example.org', 'abc', '0', '9', '42', '.', '-', ' ', ' ', '\t', '  ', '@'];
const N = 20000;
let mismatches = 0;
for (let i = 0; i < N; i++) {
  let s = '';
  const len = 1 + rnd(14);
  for (let k = 0; k < len; k++) s += PIECES[rnd(PIECES.length)] + (rnd(3) ? ['', ' ', '-', ' ', '\t', '.'][rnd(6)] : '');
  const a = redact(s);
  const b = ref.redact(s);
  if (a.text !== b.text || JSON.stringify(a.counts) !== JSON.stringify(b.counts)) {
    if (mismatches++ < 5) console.error('MISMATCH', JSON.stringify(s), JSON.stringify(a), JSON.stringify(b));
  }
  if (ref.hasLuhnWindow(a.text)) { mismatches++; console.error('LUHN WINDOW LEFT', JSON.stringify(s)); }
}
console.log(`differential: ${N} inputs, ${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
