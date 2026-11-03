'use strict';
// The H-B3 freeze builder (protocol 2026-11-03-hb3.md step 4): it lists what the rule covers plus the Mealie configuration, runner and
// sealing tool, ECCODE_FREEZE_FILE selects it, the earlier freezes are untouched, and one changed byte of a frozen file is refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const freeze = require('../bench/pilot/hb3/freeze');
const seeds = require('../bench/pilot/phase2-seeds');

const ROOT = path.join(__dirname, '..');

test('the H-B3 freeze lists the rule\'s files and the extras, is selected by ECCODE_FREEZE_FILE, and refuses a changed byte', () => {
  const f = freeze.build(ROOT);
  const names = Object.keys(f.files);
  assert.strictEqual(f.version, 3);
  for (const n of seeds.freezeList(ROOT)) assert.ok(names.includes(n), `${n} is in the freeze`);
  for (const n of freeze.EXTRA) assert.ok(names.includes(n), `${n} is in the freeze`);
  for (const n of ['lib/behavior.js', 'scripts/behavior/probe_runner.py', 'bench/pilot/phase2-hb/mealie_setup.py', 'bench/pilot/phase2-hb/config.js', 'bench/pilot/hb2/seal.js', 'bench/pilot/hb3/seal.js']) assert.ok(names.includes(n), n);
  assert.ok(Object.values(f.files).every((h) => /^[0-9a-f]{64}$/.test(h)), 'no file is missing');
  assert.ok(!names.includes('bench/pilot/hb2/report.js'), 'the report computes no diff result and is not frozen');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb3-freeze-'));
  const file = path.join(dir, 'freeze.json');
  fs.writeFileSync(file, JSON.stringify(f));
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bench/pilot/phase2-seeds.js'), 'check'], { cwd: ROOT, env: { ...process.env, ECCODE_FREEZE_FILE: file }, encoding: 'utf8' });
  const ok = run();
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^frozen: \d+ files/);
  f.files['scripts/behavior/probe_runner.py'] = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(f));
  const bad = run();
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /NOT FROZEN[\s\S]*probe_runner\.py/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the earlier freezes are not rewritten by the v3 builder (v1 and v2 hashes stay)', () => {
  const v1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/pilot/phase2-freeze.json'), 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/pilot/phase2-freeze-v2.json'), 'utf8'));
  assert.strictEqual(Object.keys(v1.files).length, 33);
  assert.strictEqual(Object.keys(v2.files).length, 47);
  assert.strictEqual(v2.version, 2);
});
