'use strict';
// The H-B3 sealing tool (protocol 2026-11-03-hb3.md step 6): the H-B2 checks plus the three things the owner asked of the new set -
// at least 4 unintended seeds in each of the 10 classes, 6 to 10 intended seeds, and for every seed a statement that the declared
// change was SHOWN (the request exercised on the patched and on the unpatched application, the two responses described).
// Synthetic sets only; no key or seed of any real set is used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const seal3 = require('../bench/pilot/hb3/seal');
const { CLASSES } = require('../bench/pilot/hb2/seal');

const ROOT = path.join(__dirname, '..');
const PATCH = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a = 1\n+a = 2\n';
const EVIDENCE = 'GET /api/x answers {"a": 1} on the unpatched application and {"a": 2} on the patched one';

function seed(id, kind, intended) {
  return {
    id, intended, kind, files: ['x.py'], patch: PATCH, description: `the value of a is 2 instead of 1 (${id})`, observableBy: 'GET /api/x',
    verification: { scope: 'full', shown: true, evidence: EVIDENCE },
    ...(intended ? { contract: [{ surface: 'http', target: 'GET /api/x', inputClass: 'any request', expected: 'a is 2 now' }] } : {}),
  };
}
function fullSet() {
  const seeds = [];
  for (const kind of CLASSES) for (let i = 0; i < 4; i++) seeds.push(seed(`u-${kind}-${i}`, kind, false));
  for (let i = 0; i < 6; i++) seeds.push(seed(`i-${i}`, CLASSES[i], true));
  return { mealieCommit: 'a'.repeat(40), seeds };
}

test('a complete set (4 unintended in each of 10 classes, 6 intended, every seed shown) passes', () => {
  assert.deepStrictEqual(seal3.validate(fullSet()), []);
});

test('fewer than 4 unintended seeds in a class is refused, naming the class and the count', () => {
  const s = fullSet();
  s.seeds = s.seeds.filter((x) => x.id !== 'u-boundary-3' && x.id !== 'u-boundary-2');
  assert.match(seal3.validate(s).join('\n'), /class boundary: 2 unintended seeds, at least 4 are required/);
  const t = fullSet();
  t.seeds = t.seeds.filter((x) => x.kind !== 'ordering' || x.intended);
  assert.match(seal3.validate(t).join('\n'), /class ordering: 0 unintended seeds/);
});

test('intended seeds: 6 to 10', () => {
  const few = fullSet();
  few.seeds = few.seeds.filter((x) => x.id !== 'i-5');
  assert.match(seal3.validate(few).join('\n'), /5 intended seeds, 6 to 10 are required/);
  const many = fullSet();
  for (let i = 6; i < 11; i++) many.seeds.push(seed(`i-${i}`, CLASSES[i % 10], true));
  assert.match(seal3.validate(many).join('\n'), /11 intended seeds, 6 to 10 are required/);
  const ten = fullSet();
  for (let i = 6; i < 10; i++) ten.seeds.push(seed(`i-${i}`, CLASSES[i % 10], true));
  assert.deepStrictEqual(seal3.validate(ten), []);
});

test('every seed, intended or not, must say it was shown, with evidence', () => {
  const cases = [
    [(s) => { delete s.seeds[0].verification.shown; }, /seed u-status-code-0: verification\.shown must be true/],
    [(s) => { s.seeds[0].verification.shown = false; }, /seed u-status-code-0: verification\.shown must be true/],
    [(s) => { s.seeds[0].verification.evidence = 'ok'; }, /seed u-status-code-0: verification\.evidence/],
    [(s) => { delete s.seeds[40].verification.evidence; }, /seed i-0: verification\.evidence/],
    [(s) => { s.seeds[40].verification.shown = 'yes'; }, /seed i-0: verification\.shown must be true/],
  ];
  for (const [mutate, re] of cases) {
    const s = fullSet();
    mutate(s);
    assert.match(seal3.validate(s).join('\n'), re);
  }
});

test('the checks of H-B2 still apply (commit, kinds, contracts, patches)', () => {
  const s = fullSet();
  s.mealieCommit = 'abc';
  s.seeds[3].kind = 'whatever';
  s.seeds[40].contract = [{ surface: 'ftp', target: 't', inputClass: 'c', expected: 'e' }];
  const p = seal3.validate(s).join('\n');
  assert.match(p, /40-hex/);
  assert.match(p, /kind must be one of status-code/);
  assert.match(p, /surface must be http, function or cli/);
});

test('minimums can be switched off for small test sets only through the options, never on the command line', () => {
  const small = { mealieCommit: 'a'.repeat(40), seeds: [seed('u1', 'boundary', false), seed('i1', 'format', true)] };
  assert.ok(seal3.validate(small).length > 0);
  assert.deepStrictEqual(seal3.validate(small, { minimums: false }), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb3-seal-'));
  fs.writeFileSync(path.join(dir, 'key'), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(small));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/hb3/seal.js'), '--plain', path.join(dir, 'plain.json'), '--key-file', path.join(dir, 'key'), '--out-dir', path.join(dir, 'out'), '--no-minimums'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'there is no --no-minimums flag');
  assert.ok(!fs.existsSync(path.join(dir, 'out')));
  assert.ok(fs.existsSync(path.join(dir, 'plain.json')), 'a refused seal keeps the plaintext');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sealing: a valid set is sealed through the command line, only counts and hashes are printed, the plaintext is destroyed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb3-seal-'));
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'key'), key + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(fullSet()));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/hb3/seal.js'), '--plain', path.join(dir, 'plain.json'), '--key-file', path.join(dir, 'key'), '--out-dir', path.join(dir, 'out')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sealed: 40 unintended, 6 intended \(46 seeds\), \d+ bytes; plaintextSha256 [0-9a-f]{64}; sealedSha256 [0-9a-f]{64}; plaintext destroyed\n$/);
  for (const secret of [key, 'diff --git', EVIDENCE, 'GET /api/x']) assert.ok(!(r.stdout + r.stderr).includes(secret), `the output does not contain ${secret.slice(0, 12)}`);
  assert.ok(!fs.existsSync(path.join(dir, 'plain.json')));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'seeds.sealed')));
  // A refused set prints the problems but not the evidence text of the seeds.
  const bad = fullSet();
  bad.seeds[0].verification.shown = false;
  fs.writeFileSync(path.join(dir, 'plain2.json'), JSON.stringify(bad));
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/hb3/seal.js'), '--plain', path.join(dir, 'plain2.json'), '--key-file', path.join(dir, 'key'), '--out-dir', path.join(dir, 'out2')], { encoding: 'utf8' });
  assert.notStrictEqual(r2.status, 0);
  assert.match(r2.stderr, /verification\.shown must be true/);
  assert.ok(!(r2.stdout + r2.stderr).includes(key));
  assert.ok(fs.existsSync(path.join(dir, 'plain2.json')) && !fs.existsSync(path.join(dir, 'out2')));
  fs.rmSync(dir, { recursive: true, force: true });
});
