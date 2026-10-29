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

test('the freeze: the real sealed set verifies against its manifest, and a changed implementation is refused', () => {
  const v = seeds.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.counts.intended, 5);
  assert.ok(v.counts.unintended >= 15);
  const freeze = seeds.assertFrozen();
  assert.ok(freeze.files['lib/behavior.js'] && freeze.files['scripts/behavior/probe_runner.py']);
  // A root where behavior.js differs by one byte.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-freeze-'));
  for (const f of Object.keys(freeze.files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', f), path.join(root, f));
  }
  assert.doesNotThrow(() => seeds.assertFrozen(root));
  fs.appendFileSync(path.join(root, 'lib/behavior.js'), '\n');
  assert.throws(() => seeds.assertFrozen(root), /differs from the frozen one/);
  fs.rmSync(root, { recursive: true, force: true });
});
