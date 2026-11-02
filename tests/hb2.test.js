'use strict';
// H-B2 harness (protocol amendment 4): the sealing tool the seeding agent runs, the set and freeze selected
// by environment, and the freeze builder. Nothing here uses a real key or a real seed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { seal, validate } = require('../bench/pilot/hb2/seal');
const freeze = require('../bench/pilot/hb2/freeze');
const seeds = require('../bench/pilot/phase2-seeds');

const ROOT = path.join(__dirname, '..');
const PATCH = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a = 1\n+a = 2\n';
const COMMIT = 'a'.repeat(40);

function set() {
  return {
    mealieCommit: COMMIT,
    seeds: [
      { id: 'u01', intended: false, kind: 'default-value', files: ['x.py'], patch: PATCH, description: 'the default of a is 2 instead of 1', observableBy: 'GET /api/x with no parameters', verification: { scope: 'full' } },
      { id: 'i01', intended: true, kind: 'message-text', files: ['x.py'], patch: PATCH, description: 'the message says a is 2 as requested', observableBy: 'GET /api/x', verification: { scope: 'full' }, contract: [{ surface: 'http', target: 'GET /api/x', inputClass: 'any request', expected: 'a is 2 now' }] },
    ],
  };
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb2-'));
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'key'), key + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(set()));
  return { dir, key };
}

test('seal: a valid set is sealed, the manifest carries counts and hashes, and the plaintext is destroyed', () => {
  const { dir } = workspace();
  const r = seal({ plainFile: path.join(dir, 'plain.json'), keyFile: path.join(dir, 'key'), outDir: path.join(dir, 'out') });
  assert.deepStrictEqual(r.counts, { unintended: 1, intended: 1, total: 2 });
  assert.strictEqual(fs.existsSync(path.join(dir, 'plain.json')), false, 'the plaintext is gone');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'MANIFEST.json'), 'utf8'));
  assert.strictEqual(m.sealedSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'out', 'seeds.sealed'))).digest('hex'));
  assert.deepStrictEqual(m.kinds, ['default-value', 'message-text']);
  assert.ok(!JSON.stringify(m).includes('diff --git'), 'no patch text in the manifest');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seal: the sealed set unseals with the right key through ECCODE_SEED_DIR, and not with another', () => {
  const { dir, key } = workspace();
  seal({ plainFile: path.join(dir, 'plain.json'), keyFile: path.join(dir, 'key'), outDir: path.join(dir, 'out') });
  const unseal = (k) => spawnSync(process.execPath, ['-e', "const s=require(process.argv[1]);const set=s.unseal();console.log(set.seeds.map(x=>x.id).join(','))", path.join(ROOT, 'bench/pilot/phase2-seeds.js')], { env: { ...process.env, ECCODE_SEED_DIR: path.join(dir, 'out'), ECCODE_SEED_KEY: k }, encoding: 'utf8' });
  const ok = unseal(key);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(ok.stdout.trim(), 'u01,i01');
  const bad = unseal(crypto.randomBytes(32).toString('hex'));
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /unable to authenticate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seal: the command line prints counts and hashes only, never the key or the plaintext', () => {
  const { dir, key } = workspace();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/hb2/seal.js'), '--plain', path.join(dir, 'plain.json'), '--key-file', path.join(dir, 'key'), '--out-dir', path.join(dir, 'out')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sealed: 1 unintended, 1 intended \(2 seeds\), \d+ bytes; plaintextSha256 [0-9a-f]{64}; sealedSha256 [0-9a-f]{64}; plaintext destroyed\n$/);
  for (const secret of [key, 'diff --git', 'GET /api/x', 'a is 2 now']) assert.ok(!(r.stdout + r.stderr).includes(secret), `the output does not contain ${secret.slice(0, 8)}`);
  // A bad key file is refused without echoing its content.
  fs.writeFileSync(path.join(dir, 'badkey'), 'not-a-key-but-secret-looking-text');
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(set()));
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/hb2/seal.js'), '--plain', path.join(dir, 'plain.json'), '--key-file', path.join(dir, 'badkey'), '--out-dir', path.join(dir, 'out2')], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0);
  assert.ok(!(bad.stdout + bad.stderr).includes('secret-looking'));
  assert.strictEqual(fs.existsSync(path.join(dir, 'plain.json')), true, 'a refused seal does not destroy the plaintext');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seal: a malformed set is refused with every problem named and nothing written', () => {
  const cases = [
    [(s) => { s.mealieCommit = 'abc'; }, /40-hex/],
    [(s) => { s.seeds[1].id = 'u01'; }, /duplicate id/],
    [(s) => { delete s.seeds[1].contract; }, /declares its contract/],
    [(s) => { s.seeds[0].contract = [{ surface: 'http', target: 't', inputClass: 'long enough', expected: 'long enough' }]; }, /unintended seed declares no contract/],
    [(s) => { s.seeds[0].patch = 'not a diff'; }, /unified diff/],
    [(s) => { s.seeds[1].contract = [{ surface: 'ftp', target: 't', inputClass: 'c', expected: 'e' }]; }, /surface must be http, function or cli/],
    [(s) => { s.seeds[1].contract = [{ surface: 'http', target: 'GET /x', inputClass: 'any', expected: 'long enough' }]; }, /inputClass is required \(>= 5/],
    [(s) => { s.seeds[1].contract = [{ surface: 'http', target: 'GET /x', inputClass: 'long enough', expected: 'no' }]; }, /expected is required \(>= 5/],
    [(s) => { s.seeds[0].files = []; }, /files/],
    [(s) => { s.seeds = []; }, /non-empty/],
    [(s) => { s.seeds[0].kind = 'whatever'; }, /kind must be one of status-code/],
    [(s) => { delete s.seeds[0].description; }, /description is required/],
    [(s) => { s.seeds[0].observableBy = 'the response changes'; }, /observableBy must start with the HTTP request/],
  ];
  for (const [mutate, re] of cases) {
    const s = set();
    mutate(s);
    assert.match(validate(s).join('\n'), re);
  }
  const { dir } = workspace();
  const s = set();
  s.seeds[0].kind = 'nonsense';
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(s));
  assert.throws(() => seal({ plainFile: path.join(dir, 'plain.json'), keyFile: path.join(dir, 'key'), outDir: path.join(dir, 'out') }), /kind must be one of/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'out')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seal: with a checkout it refuses a patch that does not apply to the clean tree at the commit', () => {
  const { dir } = workspace();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'x.py'), 'a = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const s = set();
  s.mealieCommit = head;
  assert.deepStrictEqual(validate(s, { mealie: repo }), []);
  s.seeds[0].patch = PATCH.replace('-a = 1', '-a = 9');
  assert.match(validate(s, { mealie: repo }).join('\n'), /seed u01: the patch does not apply/);
  s.mealieCommit = 'b'.repeat(40);
  assert.match(validate(s, { mealie: repo }).join('\n'), /not bbbbbbbbbbbb/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the H-B2 freeze lists everything the rule covers plus the Mealie configuration, runner and sealing tool, and ECCODE_FREEZE_FILE selects it', () => {
  const f = freeze.build(ROOT);
  const names = Object.keys(f.files);
  for (const n of seeds.freezeList(ROOT)) assert.ok(names.includes(n), `${n} is in the freeze`);
  for (const n of freeze.EXTRA) assert.ok(names.includes(n), `${n} is in the freeze`);
  assert.ok(names.includes('lib/behavior.js') && names.includes('scripts/behavior/probe_runner.py'));
  assert.ok(Object.values(f.files).every((h) => /^[0-9a-f]{64}$/.test(h)), 'no file is missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb2-freeze-'));
  const file = path.join(dir, 'freeze.json');
  fs.writeFileSync(file, JSON.stringify(f));
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/phase2-seeds.js'), 'check'], { cwd: ROOT, env: { ...process.env, ECCODE_FREEZE_FILE: file }, encoding: 'utf8' });
  const ok = run();
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^frozen: \d+ files/);
  // One byte of a frozen value changed in the selected freeze: refused, and the registered v1 freeze is not what was consulted.
  f.files['lib/behavior.js'] = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(f));
  const bad = run();
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /NOT FROZEN[\s\S]*lib\/behavior\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});
