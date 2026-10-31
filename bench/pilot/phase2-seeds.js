'use strict';
// The sealed H-B seed set (bench/protocols/2026-10-28-phase2.md §4a): unseal
// with the user's key at measurement time, check the registered hashes,
// apply one seed to a Mealie checkout, or list the seeds. The plaintext is
// never written into this repository.
//   node bench/pilot/phase2-seeds.js verify                      # hashes against the manifest, no key needed
//   node bench/pilot/phase2-seeds.js check                       # the frozen H-B pipeline against the working tree, no key needed
//   node bench/pilot/phase2-seeds.js freeze-list                 # the files the freeze rule covers today
//   ECCODE_SEED_KEY=<hex> node bench/pilot/phase2-seeds.js list
//   ECCODE_SEED_KEY=<hex> node bench/pilot/phase2-seeds.js apply <id> <mealie checkout>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'suites', 'phase2-seeds');
const REPO = path.join(__dirname, '..', '..');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const FREEZE = path.join(__dirname, 'phase2-freeze.json');

// The freeze rule (protocol §4a). H-B's result is produced by everything the
// `eccode behavior diff` command can load, so the frozen set is: the require
// closure of lib/behavior.js (the engine, its normalizers, surface detection,
// evidence, store and configuration defaults), the CLI entry and its
// argument parser, the probe runner (probe generation and replay), and the
// seed harness (apply, validate, reseal). lib/bench.js is the H-A harness
// and is excluded on purpose: it never runs the diff.
const FREEZE_ROOTS = ['lib/behavior.js'];
const FREEZE_EXTRA = ['bin/eccode.js', 'lib/cli-args.js', 'scripts/behavior/probe_runner.py', 'bench/pilot/phase2-seeds.js', 'bench/pilot/phase2-seed-validate.js', 'bench/pilot/phase2-reseal.js'];

/** Relative require() targets of one JavaScript file, resolved to repository-relative paths. */
function requiresOf(root, file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/require\((?:'|")(\.[^'"]+)(?:'|")\)/g)) {
    let r = path.posix.join(path.posix.dirname(file), m[1]);
    if (!/\.(js|json|cjs|mjs)$/.test(r)) {
      if (fs.existsSync(path.join(root, `${r}.js`))) r = `${r}.js`;
      else if (fs.existsSync(path.join(root, r, 'index.js'))) r = `${r}/index.js`;
    }
    if (fs.existsSync(path.join(root, r))) out.push(r);
  }
  return out;
}

/** The files the freeze rule covers in `root` today: the closure of the roots, plus the extras. Sorted. */
function freezeList(root = REPO) {
  const seen = new Set();
  const queue = [...FREEZE_ROOTS];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith('.js')) queue.push(...requiresOf(root, f));
  }
  for (const f of FREEZE_EXTRA) seen.add(f);
  return [...seen].sort();
}

/** sha256 of every file in the list (or 'missing'). */
function hashes(root, files) {
  const out = {};
  for (const f of files) {
    const abs = path.join(root, f);
    out[f] = fs.existsSync(abs) && fs.statSync(abs).isFile() ? sha256(fs.readFileSync(abs)) : 'missing';
  }
  return out;
}

/** The whole H-B pipeline must be the frozen one; otherwise the measurement is refused. */
function assertFrozen(root = REPO) {
  const freeze = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
  const changed = [];
  const actual = hashes(root, Object.keys(freeze.files));
  for (const [file, expected] of Object.entries(freeze.files)) {
    if (actual[file] !== expected) changed.push(`${file}: ${actual[file].slice(0, 12)} (frozen ${expected.slice(0, 12)})`);
  }
  if (changed.length) throw new Error(`the H-B pipeline differs from the frozen one (implementation commit ${String(freeze.implementationCommit || freeze.commit).slice(0, 12)}): ${changed.join('; ')}. H-B is measured on the frozen pipeline only; re-register before measuring a changed one.`);
  return freeze;
}

/** Frozen or not, without throwing: {ok, changed: [...], unlisted: [...]} ; unlisted are files the rule covers today that the freeze does not. */
function check(root = REPO) {
  const freeze = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
  const actual = hashes(root, Object.keys(freeze.files));
  const changed = Object.entries(freeze.files).filter(([f, h]) => actual[f] !== h).map(([f]) => f);
  const unlisted = freezeList(root).filter((f) => !(f in freeze.files));
  return { ok: changed.length === 0 && unlisted.length === 0, changed, unlisted, files: Object.keys(freeze.files).length, implementationCommit: freeze.implementationCommit || freeze.commit, frozenAt: freeze.frozenAt };
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
  else if (cmd === 'check') {
    const c = check();
    process.stdout.write(`${c.ok ? 'frozen' : 'NOT FROZEN'}: ${c.files} files, implementation commit ${String(c.implementationCommit).slice(0, 12)}, frozen at ${c.frozenAt}${c.changed.length ? `\nchanged: ${c.changed.join(', ')}` : ''}${c.unlisted.length ? `\nnot in the freeze but covered by the rule: ${c.unlisted.join(', ')}` : ''}\n`);
    process.exit(c.ok ? 0 : 1);
  } else if (cmd === 'freeze-list') process.stdout.write(freezeList().join('\n') + '\n');
  else if (cmd === 'list') for (const s of unseal().seeds) process.stdout.write(`${s.id} ${s.intended ? 'intended  ' : 'unintended'} ${s.kind} (${s.verification && s.verification.scope})\n`);
  else if (cmd === 'apply') process.stdout.write(JSON.stringify(apply(a, b), null, 2) + '\n');
  else {
    process.stderr.write('usage: phase2-seeds.js verify | check | freeze-list | list | apply <id> <mealie checkout>\n');
    process.exit(2);
  }
}

module.exports = { unseal, verify, apply, assertFrozen, check, freezeList, hashes, sha256, FREEZE_ROOTS, FREEZE_EXTRA };
