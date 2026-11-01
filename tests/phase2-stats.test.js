'use strict';
// The Phase 2 benchmark's own instruments: the item-level statistics, the
// implementation freeze, and the reseal of the H-B seed set (on throwaway
// files; the real sealed set is never touched by a test).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const stats = require('../bench/pilot/phase2-analysis');
const reseal = require('../bench/pilot/phase2-reseal');
const seeds = require('../bench/pilot/phase2-seeds');
const { mulberry32 } = require('../lib/bench');

test('paired permutation: exact for k <= 20, symmetric, p = 1 for no effect, small for a consistent one', () => {
  const none = stats.pairedPermutation([0.1, -0.1, 0.2, -0.2, 0, 0.3, -0.3]);
  assert.strictEqual(none.exact, true);
  assert.ok(none.p > 0.5, `no effect: p ${none.p}`);
  const all = stats.pairedPermutation(Array(10).fill(0.3));
  assert.strictEqual(all.p, 2 / 1024, 'ten identical positive differences: only the two extreme sign patterns reach the statistic');
  const mc = stats.pairedPermutation(Array(25).fill(0).map((_, i) => (i % 5 === 0 ? -0.1 : 0.2)), { resamples: 5000, seed: 1 });
  assert.strictEqual(mc.exact, false);
  assert.ok(mc.p < 0.01, `Monte Carlo: p ${mc.p}`);
});

test('mixed-effects logit recovers a simulated arm effect and item variance, and finds none when there is none', () => {
  const rnd = mulberry32(11);
  const sim = (delta) => {
    const rows = [];
    for (let i = 0; i < 24; i++) {
      const u = (rnd() - 0.5) * 3;
      for (let r = 0; r < 6; r++) {
        rows.push({ item: i, arm: 0, y: rnd() < 1 / (1 + Math.exp(-u)) ? 1 : 0 });
        rows.push({ item: i, arm: 1, y: rnd() < 1 / (1 + Math.exp(-(u + delta))) ? 1 : 0 });
      }
    }
    return rows;
  };
  const effect = stats.mixedLogit(sim(1.0));
  assert.ok(effect.b1 > 0.5 && effect.b1 < 1.6, `b1 ${effect.b1}`);
  assert.ok(effect.sigma > 0.4 && effect.sigma < 1.6, `sigma ${effect.sigma}`);
  assert.ok(effect.p < 0.05, `p ${effect.p}`);
  const none = stats.mixedLogit(sim(0));
  assert.ok(Math.abs(none.b1) < 0.5, `b1 ${none.b1}`);
  assert.ok(none.p > 0.05, `p ${none.p}`);
});

test('power simulation: more items give more power, and the item-level test is not the run-level one', () => {
  const few = stats.powerSimulation({ items: 6, runs: 6, tau: 1.0, sims: 120, seed: 3 });
  const many = stats.powerSimulation({ items: 30, runs: 6, tau: 1.0, sims: 120, seed: 3 });
  assert.ok(many.power > few.power, `${few.power} -> ${many.power}`);
  assert.ok(many.mcnemarPower >= many.power - 0.05, 'McNemar on runs is at least as permissive, which is why it is secondary');
  const nothing = stats.powerSimulation({ items: 20, runs: 6, tau: 1.0, deltaLogit: 0, sims: 200, seed: 5 });
  assert.ok(nothing.power < 0.12, `type I error about alpha: ${nothing.power}`);
});

test('reseal: round-trips on a throwaway sealed set, updates only the sealed hash, prints no key, and refuses a wrong key or a mismatched manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-reseal-'));
  const plain = Buffer.from(JSON.stringify({ seeds: [{ id: 's01', patch: 'x' }] }));
  const oldKey = crypto.randomBytes(32);
  const newKey = crypto.randomBytes(32);
  const sealedFile = path.join(dir, 'seeds.sealed');
  const manifestFile = path.join(dir, 'MANIFEST.json');
  const first = Buffer.from(JSON.stringify(reseal.encrypt(plain, oldKey)));
  fs.writeFileSync(sealedFile, first);
  fs.writeFileSync(manifestFile, JSON.stringify({ plaintextSha256: reseal.sha256(plain), sealedSha256: reseal.sha256(first) }));
  assert.throws(() => reseal.reseal({ sealedFile, manifestFile, oldKey: crypto.randomBytes(32), newKey }), /Unsupported state|unable to authenticate|auth/i);
  assert.strictEqual(fs.readFileSync(sealedFile).equals(first), true, 'nothing changed on a wrong key');
  assert.throws(() => reseal.reseal({ sealedFile, manifestFile, oldKey, newKey: oldKey }), /equals the old one/);
  const r = reseal.reseal({ sealedFile, manifestFile, oldKey, newKey });
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.strictEqual(manifest.plaintextSha256, reseal.sha256(plain), 'the plaintext hash is unchanged');
  assert.strictEqual(manifest.sealedSha256, r.sealedSha256);
  assert.strictEqual(reseal.sha256(fs.readFileSync(sealedFile)), r.sealedSha256);
  const back = reseal.decrypt(JSON.parse(fs.readFileSync(sealedFile, 'utf8')), newKey);
  assert.strictEqual(back.equals(plain), true, 'the new key opens it');
  assert.throws(() => reseal.decrypt(JSON.parse(fs.readFileSync(sealedFile, 'utf8')), oldKey), 'the old key no longer does');
  const out = JSON.stringify(r);
  assert.ok(!out.includes(oldKey.toString('hex')) && !out.includes(newKey.toString('hex')) && !out.includes('s01'), 'no key and no plaintext in the result');
  // A manifest that does not match the sealed file: nothing changes.
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, sealedSha256: 'f'.repeat(64) }));
  const before = fs.readFileSync(sealedFile);
  assert.throws(() => reseal.reseal({ sealedFile, manifestFile, oldKey: newKey, newKey: crypto.randomBytes(32) }), /does not match the manifest/);
  assert.strictEqual(fs.readFileSync(sealedFile).equals(before), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the freeze: the real sealed set verifies against its manifest; the freeze commit\'s tree passes and a changed implementation is refused', (t) => {
  const v = seeds.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.counts.intended, 5);
  assert.ok(v.counts.unintended >= 15);
  const freeze = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench/pilot/phase2-freeze.json'), 'utf8'));
  assert.ok(freeze.files['lib/behavior.js'] && freeze.files['scripts/behavior/probe_runner.py']);
  // The two detector files never change: on HEAD their hashes are the ones registered on 2026-10-29.
  const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', f))).digest('hex');
  assert.strictEqual(sha('lib/behavior.js'), 'aabf35fa54c240c99ec003011c987a29f71430a582dd28fcdca0ed00b8c508c6');
  assert.strictEqual(sha('scripts/behavior/probe_runner.py'), '03f949952541c0cd625e4ecbab62aeab25be5c38a16b5b06704ade3dfa35e2b4');
  assert.strictEqual(freeze.files['lib/behavior.js'], sha('lib/behavior.js'));
  assert.strictEqual(freeze.files['scripts/behavior/probe_runner.py'], sha('scripts/behavior/probe_runner.py'));
  const { frozenTreeFromGit } = require('./helpers');
  const tree = frozenTreeFromGit();
  if (!tree.dir) return t.skip(tree.reason);
  // The freeze commit's own tree is frozen; HEAD is checked only for the detector files above (Phase 3 edits the rest, register row 157).
  assert.doesNotThrow(() => seeds.assertFrozen(tree.dir));
  assert.strictEqual(seeds.check(tree.dir).ok, true);
  fs.appendFileSync(path.join(tree.dir, 'lib/behavior.js'), '\n');
  assert.throws(() => seeds.assertFrozen(tree.dir), /differs from the frozen one/);
  fs.rmSync(tree.dir, { recursive: true, force: true });
});

test('the freeze covers the whole H-B pipeline, and a changed or missing harness file is refused', (t) => {
  const freeze = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench/pilot/phase2-freeze.json'), 'utf8'));
  const listed = Object.keys(freeze.files).sort();
  for (const f of ['lib/behavior.js', 'scripts/behavior/probe_runner.py', 'bin/eccode.js', 'lib/compat.js', 'lib/lean.js', 'lib/evidence.js', 'lib/config.js', 'lib/store.js', 'bench/pilot/phase2-seeds.js', 'bench/pilot/phase2-seed-validate.js', 'bench/pilot/phase2-reseal.js', 'bench/pilot/phase2-hb/config.js', 'bench/pilot/phase2-hb/mealie_setup.py', 'bench/pilot/phase2-hb/run.js']) assert.ok(listed.includes(f), `${f} is frozen`);
  assert.ok(!listed.includes('lib/bench.js'), 'the H-A harness is not frozen');
  assert.strictEqual(freeze.implementationCommit, 'e5c57e498d9d00f7c9c29cee1d00752704922a35');
  const { frozenTreeFromGit } = require('./helpers');
  const tree = frozenTreeFromGit();
  if (!tree.dir) return t.skip(tree.reason);
  const root = tree.dir;
  // In the freeze commit's tree, everything the rule covers is listed.
  for (const f of seeds.freezeList(root)) assert.ok(listed.includes(f), `${f} is frozen`);
  assert.doesNotThrow(() => seeds.assertFrozen(root));
  // A harness file edited by one byte.
  fs.appendFileSync(path.join(root, 'bench/pilot/phase2-seed-validate.js'), '\n');
  assert.throws(() => seeds.assertFrozen(root), /the H-B pipeline differs from the frozen one.*phase2-seed-validate\.js/);
  assert.deepStrictEqual(seeds.check(root).changed, ['bench/pilot/phase2-seed-validate.js']);
  // A module of the diff's closure removed.
  fs.rmSync(path.join(root, 'lib/compat.js'));
  assert.throws(() => seeds.assertFrozen(root), /lib\/compat\.js: missing/);
  // A module the rule covers that the freeze does not list is reported by check().
  fs.copyFileSync(path.join(root, 'lib/util.js'), path.join(root, 'lib/extra.js'));
  fs.appendFileSync(path.join(root, 'lib/behavior.js'), "\nrequire('./extra');\n");
  assert.ok(seeds.check(root).unlisted.includes('lib/extra.js'));
  fs.rmSync(root, { recursive: true, force: true });
});
