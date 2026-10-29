'use strict';
// Re-seal the H-B seed set under a new key, after the first key reached the
// implementer's context (docs/limits.md row 154). Reads the old key from
// ECCODE_SEED_KEY_OLD and the new one from ECCODE_SEED_KEY, decrypts,
// checks the plaintext against the manifest's registered hash, encrypts with
// a fresh IV under the new key, rewrites seeds.sealed and the manifest's
// sealedSha256 (the plaintext hash is unchanged). It prints neither key nor
// any plaintext: only the new sealed hash and the byte counts.
//   ECCODE_SEED_KEY_OLD=<64 hex> ECCODE_SEED_KEY=<64 hex> node bench/pilot/phase2-reseal.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'suites', 'phase2-seeds');
const SEALED = path.join(DIR, 'seeds.sealed');
const MANIFEST = path.join(DIR, 'MANIFEST.json');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function key(name) {
  const v = process.env[name];
  if (!v || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${name} must be a 64-hex key (not printed)`);
  return Buffer.from(v, 'hex');
}

function decrypt(sealed, k) {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(sealed.iv, 'hex'));
  d.setAuthTag(Buffer.from(sealed.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]);
}

function encrypt(plain, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  return { alg: 'aes-256-gcm', iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') };
}

/** Re-seal in place; returns {plaintextSha256, sealedSha256, bytes}. Keys never leave this function. */
function reseal({ sealedFile = SEALED, manifestFile = MANIFEST, oldKey, newKey } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const raw = fs.readFileSync(sealedFile);
  if (sha256(raw) !== manifest.sealedSha256) throw new Error('seeds.sealed does not match the manifest; nothing changed');
  const plain = decrypt(JSON.parse(raw.toString('utf8')), oldKey);
  if (sha256(plain) !== manifest.plaintextSha256) throw new Error('the decrypted set does not match the registered plaintext hash; nothing changed');
  if (oldKey.equals(newKey)) throw new Error('the new key equals the old one; nothing changed');
  const sealed = Buffer.from(JSON.stringify(encrypt(plain, newKey)));
  // The new sealed file must round-trip before anything is replaced.
  const back = decrypt(JSON.parse(sealed.toString('utf8')), newKey);
  if (!back.equals(plain)) throw new Error('round-trip check failed; nothing changed');
  plain.fill(0);
  back.fill(0);
  fs.writeFileSync(sealedFile, sealed);
  manifest.sealedSha256 = sha256(sealed);
  manifest.resealedAt = new Date().toISOString();
  manifest.sealed = { ...(manifest.sealed || {}), keyLocation: 'held by the user only; the first key was retired (docs/limits.md row 154)' };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { plaintextSha256: manifest.plaintextSha256, sealedSha256: manifest.sealedSha256, bytes: sealed.length };
}

if (require.main === module) {
  const r = reseal({ oldKey: key('ECCODE_SEED_KEY_OLD'), newKey: key('ECCODE_SEED_KEY') });
  process.stdout.write(`resealed: ${r.bytes} bytes; sealedSha256 ${r.sealedSha256}; plaintextSha256 unchanged ${r.plaintextSha256}\nRegister the new sealedSha256 in bench/protocols/2026-10-28-phase2.md.\n`);
}

module.exports = { reseal, encrypt, decrypt, sha256 };
