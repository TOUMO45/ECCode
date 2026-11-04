'use strict';
// The contract files of a sealed project: which hash each is expected to have now. The seal records the hashes
// of G1; every recorded amendment moves one file's expected hash to its new value (rule GF-FRZ-5 checks the
// chain; GF-FRZ-2 compares the expected hash with the bytes on disk).
const fs = require('fs');
const path = require('path');
const { sha256 } = require('../util');

/** { 'contracts/openapi.json': sha256, ... } as of the last recorded amendment. */
function currentHashes(gf) {
  const cur = {};
  if (!gf.seal) return cur;
  for (const [p, h] of Object.entries(gf.seal.hashes)) if (p.startsWith('contracts/')) cur[p] = h;
  for (const am of gf.amendments) if (Object.prototype.hasOwnProperty.call(cur, am.contract)) cur[am.contract] = am.toSha;
  return cur;
}

/** The bytes' hash of a project file, or null when it is missing. */
function fileHash(root, rel) {
  try { return sha256(fs.readFileSync(path.join(root, rel))); } catch { return null; }
}

/** GF-FRZ-2: contract files whose bytes differ from the sealed (or last amended) hash. */
function drift(root, gf) {
  const out = [];
  for (const [p, expected] of Object.entries(currentHashes(gf))) {
    const actual = fileHash(root, p);
    if (actual === null) out.push({ rule: 'GF-FRZ-2', message: `${p} is missing; it was sealed at ${expected.slice(0, 12)}` });
    else if (actual !== expected) out.push({ rule: 'GF-FRZ-2', message: `${p} differs from its sealed (or last amended) hash: expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}; a contract changes only by a recorded amendment` });
  }
  return out;
}

module.exports = { currentHashes, fileHash, drift };
