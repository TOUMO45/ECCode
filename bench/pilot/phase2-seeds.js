'use strict';
// The sealed H-B seed set (bench/protocols/2026-10-28-phase2.md §4a): unseal
// with the user's key at measurement time, check the registered hashes,
// apply one seed to a Mealie checkout, or list the seeds. The plaintext is
// never written into this repository.
//   node bench/pilot/phase2-seeds.js verify                      # hashes against the manifest, no key needed
//   ECCODE_SEED_KEY=<hex> node bench/pilot/phase2-seeds.js list
//   ECCODE_SEED_KEY=<hex> node bench/pilot/phase2-seeds.js apply <id> <mealie checkout>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'suites', 'phase2-seeds');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const FREEZE = path.join(__dirname, 'phase2-freeze.json');

/** The behavior diff implementation must be the frozen one; otherwise the measurement is refused. */
function assertFrozen(root = path.join(__dirname, '..', '..')) {
  const freeze = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
  const changed = [];
  for (const [file, expected] of Object.entries(freeze.files)) {
    const abs = path.join(root, file);
    const actual = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : 'missing';
    if (actual !== expected) changed.push(`${file}: ${actual.slice(0, 12)} (frozen ${expected.slice(0, 12)})`);
  }
  if (changed.length) throw new Error(`the behavior diff implementation differs from the frozen one (commit ${freeze.commit.slice(0, 12)}): ${changed.join('; ')}. H-B is measured on the frozen implementation only; re-register before measuring a changed one.`);
  return freeze;
}

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8'));
}

function sealedBytes() {
  return fs.readFileSync(path.join(DIR, 'seeds.sealed'));
}

/** The plaintext seed set, checked against the manifest's registered hash. */
function unseal(keyHex = process.env.ECCODE_SEED_KEY) {
  if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('ECCODE_SEED_KEY must be the 64-hex key the user holds');
  const m = manifest();
  const raw = sealedBytes();
  if (sha256(raw) !== m.sealedSha256) throw new Error(`seeds.sealed does not match the registered hash ${m.sealedSha256}`);
  const sealed = JSON.parse(raw.toString('utf8'));
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(sealed.iv, 'hex'));
  d.setAuthTag(Buffer.from(sealed.tag, 'hex'));
  const plain = Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]);
  if (sha256(plain) !== m.plaintextSha256) throw new Error(`the unsealed set does not match the registered plaintext hash ${m.plaintextSha256}`);
  return JSON.parse(plain.toString('utf8'));
}

function verify() {
  const m = manifest();
  const ok = sha256(sealedBytes()) === m.sealedSha256;
  return { ok, sealedSha256: m.sealedSha256, plaintextSha256: m.plaintextSha256, counts: m.counts, mealieCommit: m.mealieCommit };
}

/** Apply one seed's patch to a clean Mealie checkout at the registered commit. */
function apply(id, checkout, keyHex) {
  assertFrozen();
  const set = unseal(keyHex);
  const seed = set.seeds.find((s) => s.id === id);
  if (!seed) throw new Error(`no seed ${id}`);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
  if (head !== set.mealieCommit) throw new Error(`${checkout} is at ${head}, not the registered ${set.mealieCommit}`);
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
  if (dirty) throw new Error(`${checkout} is not clean`);
  const r = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: checkout, input: seed.patch, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git apply failed for ${id}: ${r.stderr}`);
  return { id: seed.id, intended: seed.intended, kind: seed.kind, files: seed.files, contract: seed.contract || null, verification: seed.verification };
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'verify') process.stdout.write(JSON.stringify({ ...verify(), frozen: assertFrozen().files }, null, 2) + '\n');
  else if (cmd === 'list') for (const s of unseal().seeds) process.stdout.write(`${s.id} ${s.intended ? 'intended  ' : 'unintended'} ${s.kind} (${s.verification && s.verification.scope})\n`);
  else if (cmd === 'apply') process.stdout.write(JSON.stringify(apply(a, b), null, 2) + '\n');
  else {
    process.stderr.write('usage: phase2-seeds.js verify | list | apply <id> <mealie checkout>\n');
    process.exit(2);
  }
}

module.exports = { unseal, verify, apply, assertFrozen, sha256 };
