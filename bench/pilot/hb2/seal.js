'use strict';
// Seals a seed set for H-B2 (protocol amendment 4). Run by the independent seeding agent, so that the
// plaintext never reaches the implementer: it reads the plaintext and a key FILE, checks the set,
// writes seeds.sealed and MANIFEST.json, and destroys the plaintext. It prints counts and hashes only;
// the key and the plaintext are never printed, logged or kept.
//   node bench/pilot/hb2/seal.js --plain <seeds.json> --key-file <file with 64 hex> --out-dir <dir> [--mealie <checkout at the commit>] [--sealed-by <text>] [--keep-plain]
// The plaintext is { mealieCommit, seeds: [{ id, intended, kind, files, patch, description, observableBy, contract?, verification: { scope } }] };
// kind is one of CLASSES (the registered taxonomy); observableBy names the HTTP request that shows the change.
// an intended seed carries its contract (entries { surface, target, inputClass, expected }), an unintended one none.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { encrypt, decrypt, sha256 } = require('../phase2-reseal');
const { validEntries } = require('../../../lib/behavior');

// The registered seed classes (protocol amendment 4); a report is made per class.
const CLASSES = ['status-code', 'message-text', 'default-value', 'boundary', 'permission', 'field-exposure', 'validation', 'ordering', 'side-effect', 'format'];

function validate(set, { mealie } = {}) {
  const problems = [];
  if (!set || typeof set !== 'object') return ['the plaintext is not an object'];
  if (!/^[0-9a-f]{40}$/.test(set.mealieCommit || '')) problems.push('mealieCommit must be a full 40-hex commit');
  if (!Array.isArray(set.seeds) || !set.seeds.length) return [...problems, 'seeds must be a non-empty array'];
  const ids = new Set();
  for (const s of set.seeds) {
    const at = `seed ${s && s.id}`;
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(s.id)) { problems.push(`${at}: id must be lowercase letters, digits, - or _`); continue; }
    if (ids.has(s.id)) problems.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (typeof s.intended !== 'boolean') problems.push(`${at}: intended must be true or false`);
    if (!CLASSES.includes(s.kind)) problems.push(`${at}: kind must be one of ${CLASSES.join(', ')}`);
    if (typeof s.description !== 'string' || s.description.trim().length < 10) problems.push(`${at}: description is required`);
    if (typeof s.observableBy !== 'string' || !/^[A-Z]+ \//.test(s.observableBy.trim())) problems.push(`${at}: observableBy must start with the HTTP request that shows the change, e.g. GET /api/...`);
    if (!Array.isArray(s.files) || !s.files.length || s.files.some((f) => typeof f !== 'string')) problems.push(`${at}: files must list the touched files`);
    if (typeof s.patch !== 'string' || !/^(diff --git|--- )/m.test(s.patch)) problems.push(`${at}: patch must be a unified diff`);
    if (!s.verification || typeof s.verification.scope !== 'string') problems.push(`${at}: verification.scope is required`);
    if (s.intended) {
      if (!Array.isArray(s.contract) || !s.contract.length) problems.push(`${at}: an intended seed declares its contract`);
      else {
        // The engine's own rule decides what a contract is: a seed whose contract it refuses would be recorded as a miss it did not earn.
        try { validEntries(s.contract); } catch (e) { problems.push(`${at}: ${e.message}`); }
      }
    } else if (s.contract) problems.push(`${at}: an unintended seed declares no contract`);
  }
  if (mealie && !problems.length) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mealie, encoding: 'utf8' }).stdout.trim();
    if (head !== set.mealieCommit) problems.push(`the checkout is at ${head.slice(0, 12)}, not ${set.mealieCommit.slice(0, 12)}`);
    else for (const s of set.seeds) {
      const r = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd: mealie, input: s.patch, encoding: 'utf8' });
      if (r.status !== 0) problems.push(`seed ${s.id}: the patch does not apply to a clean checkout`);
    }
  }
  return problems;
}

function seal({ plainFile, keyFile, outDir, mealie, sealedBy, keepPlain = false }) {
  const keyHex = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('the key file must hold exactly 64 lowercase hex characters (nothing printed)');
  const key = Buffer.from(keyHex, 'hex');
  const plain = fs.readFileSync(plainFile);
  let set;
  try { set = JSON.parse(plain.toString('utf8')); } catch { throw new Error('the plaintext is not valid JSON'); }
  const problems = validate(set, { mealie });
  if (problems.length) throw new Error(`the seed set is not valid:\n  ${problems.slice(0, 20).join('\n  ')}`);
  const sealed = Buffer.from(JSON.stringify(encrypt(plain, key)));
  if (!decrypt(JSON.parse(sealed.toString('utf8')), key).equals(plain)) throw new Error('round-trip check failed; nothing written');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    mealieCommit: set.mealieCommit,
    mealieRepo: 'https://github.com/mealie-recipes/mealie.git',
    counts: { unintended: set.seeds.filter((s) => !s.intended).length, intended: set.seeds.filter((s) => s.intended).length, total: set.seeds.length },
    kinds: set.seeds.map((s) => s.kind),
    verification: { full: 0, partial: set.seeds.length, note: 'the validator re-seals with its own full-suite verdict (--prune)' },
    plaintextSha256: sha256(plain),
    sealedSha256: sha256(sealed),
    sealed: { file: 'seeds.sealed', alg: 'aes-256-gcm', keyLocation: 'a file outside the repository, generated before the seeding agent started; the implementer never read it' },
    createdAt: new Date().toISOString(),
    sealedBy: sealedBy || 'the independent seeding agent',
  };
  fs.writeFileSync(path.join(outDir, 'seeds.sealed'), sealed);
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (!keepPlain) {
    fs.writeFileSync(plainFile, Buffer.alloc(plain.length));
    fs.rmSync(plainFile, { force: true });
  }
  plain.fill(0);
  key.fill(0);
  return { counts: manifest.counts, plaintextSha256: manifest.plaintextSha256, sealedSha256: manifest.sealedSha256, bytes: sealed.length, plaintextDestroyed: !keepPlain };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const need = (n) => { const v = arg(argv, n); if (!v) { process.stderr.write('usage: seal.js --plain <seeds.json> --key-file <file> --out-dir <dir> [--mealie <checkout>] [--sealed-by <text>] [--keep-plain]\n'); process.exit(2); } return v; };
  try {
    const r = seal({ plainFile: need('--plain'), keyFile: need('--key-file'), outDir: need('--out-dir'), mealie: arg(argv, '--mealie'), sealedBy: arg(argv, '--sealed-by'), keepPlain: argv.includes('--keep-plain') });
    process.stdout.write(`sealed: ${r.counts.unintended} unintended, ${r.counts.intended} intended (${r.counts.total} seeds), ${r.bytes} bytes; plaintextSha256 ${r.plaintextSha256}; sealedSha256 ${r.sealedSha256}; plaintext ${r.plaintextDestroyed ? 'destroyed' : 'kept'}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { seal, validate, CLASSES };
