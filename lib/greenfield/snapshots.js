'use strict';
// Content-addressed copies of sealed and amended contract files: .eccode/contracts/<sha256>.json. They let an
// amendment be diffed against exactly what was sealed, and let the approved bundle be re-validated at its approved
// bytes after a legitimate amendment. A snapshot is valid only if its content hashes to its name.
const fs = require('fs');
const path = require('path');
const { sha256, writeFileAtomic, ensureDir } = require('../util');

const DIR = ['.eccode', 'contracts'];

const pathOf = (root, sha) => path.join(root, ...DIR, `${sha}.json`);

/** Copy the live file into the snapshot store, but only if its bytes hash to `expected` (when given). Returns the hash, or null. */
function write(root, rel, expected) {
  let buf;
  try { buf = fs.readFileSync(path.join(root, rel)); } catch { return null; }
  const sha = sha256(buf);
  if (expected && sha !== expected) return null;
  ensureDir(path.join(root, ...DIR));
  const target = pathOf(root, sha);
  if (!fs.existsSync(target)) writeFileAtomic(target, buf);
  return sha;
}

/** The snapshot bytes for `sha`, or null when missing or edited. */
function read(root, sha) {
  try {
    const buf = fs.readFileSync(pathOf(root, sha));
    return sha256(buf) === sha ? buf : null;
  } catch { return null; }
}

module.exports = { pathOf, write, read };
