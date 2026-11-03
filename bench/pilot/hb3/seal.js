'use strict';
// Seals the seed set for H-B3 (protocol 2026-11-03-hb3.md, step 6). Run by the independent seeding agent, so that the plaintext never
// reaches the implementer. It is the H-B2 sealing tool (bench/pilot/hb2/seal.js: the same format, key handling, encryption, manifest and
// destruction of the plaintext) behind three further checks the owner asked of the new set:
//   - at least 4 unintended seeds in each of the 10 classes,
//   - 6 to 10 intended seeds,
//   - for EVERY seed `verification.shown === true` and `verification.evidence` (>= 40 characters): the request was exercised on the
//     patched and on the unpatched application and the two responses differ in the described way. A seed that cannot be shown is not
//     sealed. (H-B2 required this of no seed; the intended seeds of H-B2 were mostly accepted without the diff seeing anything.)
// It prints counts and hashes only; the key and the plaintext are never printed, logged or kept.
//   node bench/pilot/hb3/seal.js --plain <seeds.json> --key-file <file with 64 hex> --out-dir <dir> [--mealie <checkout at the commit>] [--sealed-by <text>] [--keep-plain]
const base = require('../hb2/seal');

const CLASSES = base.CLASSES;
const MIN_PER_CLASS = 4;
const INTENDED = [6, 10];
const EVIDENCE_MIN = 40;

/** The problems of a set under the H-B3 rules (the H-B2 rules first). `minimums: false` is for tests of the tool and is not reachable from the command line. */
function validate(set, { mealie, minimums = true } = {}) {
  const problems = base.validate(set, { mealie });
  if (!set || !Array.isArray(set.seeds)) return problems;
  for (const s of set.seeds) {
    if (!s || typeof s.id !== 'string') continue;
    const v = s.verification || {};
    if (v.shown !== true) problems.push(`seed ${s.id}: verification.shown must be true (the request must have been shown to differ between the unpatched and the patched application)`);
    else if (typeof v.evidence !== 'string' || v.evidence.trim().length < EVIDENCE_MIN) problems.push(`seed ${s.id}: verification.evidence must describe the request and the two responses (>= ${EVIDENCE_MIN} characters)`);
  }
  if (minimums) {
    for (const kind of CLASSES) {
      const n = set.seeds.filter((s) => s && !s.intended && s.kind === kind).length;
      if (n < MIN_PER_CLASS) problems.push(`class ${kind}: ${n} unintended seeds, at least ${MIN_PER_CLASS} are required`);
    }
    const intended = set.seeds.filter((s) => s && s.intended).length;
    if (intended < INTENDED[0] || intended > INTENDED[1]) problems.push(`${intended} intended seeds, ${INTENDED[0]} to ${INTENDED[1]} are required`);
  }
  return problems;
}

function seal(options) {
  const fs = require('fs');
  let set;
  try { set = JSON.parse(fs.readFileSync(options.plainFile, 'utf8')); } catch { throw new Error('the plaintext is not valid JSON'); }
  const problems = validate(set, { mealie: options.mealie });
  if (problems.length) throw new Error(`the seed set is not valid:\n  ${problems.slice(0, 30).join('\n  ')}`);
  return base.seal(options);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const need = (n) => { const v = arg(argv, n); if (!v) { process.stderr.write('usage: seal.js --plain <seeds.json> --key-file <file> --out-dir <dir> [--mealie <checkout>] [--sealed-by <text>] [--keep-plain]\n'); process.exit(2); } return v; };
  const known = new Set(['--plain', '--key-file', '--out-dir', '--mealie', '--sealed-by', '--keep-plain']);
  const unknown = argv.filter((a) => a.startsWith('--') && !known.has(a));
  if (unknown.length) { process.stderr.write(`unknown option: ${unknown.join(', ')}\n`); process.exit(2); }
  try {
    const r = seal({ plainFile: need('--plain'), keyFile: need('--key-file'), outDir: need('--out-dir'), mealie: arg(argv, '--mealie'), sealedBy: arg(argv, '--sealed-by'), keepPlain: argv.includes('--keep-plain') });
    process.stdout.write(`sealed: ${r.counts.unintended} unintended, ${r.counts.intended} intended (${r.counts.total} seeds), ${r.bytes} bytes; plaintextSha256 ${r.plaintextSha256}; sealedSha256 ${r.sealedSha256}; plaintext ${r.plaintextDestroyed ? 'destroyed' : 'kept'}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { validate, seal, CLASSES, MIN_PER_CLASS, INTENDED };
