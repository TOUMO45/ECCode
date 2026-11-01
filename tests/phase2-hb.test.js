'use strict';
// The H-B runner and the Mealie configuration generator (docs/design/phase3-plan.md 0.C):
// the generator is deterministic; the runner flags a fixture's seeded change through
// init -> contract -> route -> diff on the engine of a given tree; a tree whose
// frozen files differ is refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../bench/pilot/phase2-hb/config');
const runner = require('../bench/pilot/phase2-hb/run');
const { seedChange, python, CHANGES } = require('./fixtures/phase2/build');

const ROOT = path.join(__dirname, '..');
const py = python();
if (py.python) process.env.ECCODE_PYTHON = py.python;

test('the Mealie configuration is deterministic and chooses nothing per seed', () => {
  const a = config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' });
  const b = config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.app, 'mealie.app:app');
  assert.deepStrictEqual(a.roles.map((r) => r.name), ['anonymous', 'user', 'admin']);
  assert.deepStrictEqual([a.normalizers, a.ignoreFields, a.unordered], [[], [], []]);
  assert.strictEqual(a.env.DATA_DIR, '{tmp}/data');
  assert.match(a.setup, /\/x\/mealie\/\.venv\/bin\/python \/y\/eccode\/bench\/pilot\/phase2-hb\/mealie_setup\.py$/);
  // The tokens are constants of the fixed secret and ids: the same JWT every time, and the setup script sees the same strings.
  assert.strictEqual(a.roles[1].headers.Authorization, `Bearer ${config.token(config.USER_ID)}`);
  assert.strictEqual(a.env.ECCODE_HB_ADMIN_TOKEN, config.token(config.ADMIN_ID));
  const [, payload] = config.token(config.USER_ID).split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(payload, 'base64').toString()), { long_token: 'eccode-hb', id: config.USER_ID });
  const setup = fs.readFileSync(path.join(ROOT, 'bench/pilot/phase2-hb/mealie_setup.py'), 'utf8');
  for (const c of [config.USER_ID, config.ADMIN_ID, config.SECRET]) assert.ok(setup.includes(`"${c}"`), `${c} in the setup script`);
});

test('the runner refuses a tree whose frozen files differ, and accepts this one', () => {
  assert.match(runner.assertFrozenTree(ROOT), /^frozen: \d+ files/);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb-tree-'));
  for (const f of ['bench/pilot/phase2-seeds.js', 'bench/pilot/phase2-freeze.json', 'lib/behavior.js', 'bin/eccode.js']) {
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(copy, f));
  }
  assert.throws(() => runner.assertFrozenTree(copy), /not the frozen H-B pipeline/);
  fs.rmSync(copy, { recursive: true, force: true });
});

test('the runner flags a seeded unintended change and passes a declared one through the fixture', { skip: py.python ? false : py.reason }, () => {
  const run = (id) => {
    const s = seedChange(id);
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: s.dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: s.dir });
    const record = runner.runSeed({
      tree: ROOT,
      checkout: s.dir,
      commit: null,
      seedId: id,
      apply: () => { s.apply(); return { id, intended: Boolean(s.change.contract), kind: s.change.kind, contract: s.change.contract || null, verification: { scope: 'full' } }; },
      configure: () => {}, // the fixture carries its own .eccode/behavior.json
      runs: 2,
    });
    fs.rmSync(s.dir, { recursive: true, force: true });
    return record;
  };
  const flagged = CHANGES.find((c) => c.expect === 'flagged');
  const r1 = run(flagged.id);
  assert.strictEqual(r1.error, undefined, r1.error);
  assert.strictEqual(r1.route, 'run');
  assert.strictEqual(r1.flagged, true, JSON.stringify(r1));
  assert.ok(r1.unexplained >= 1);
  const declared = CHANGES.find((c) => c.expect === 'clean' && c.contract);
  const r2 = run(declared.id);
  assert.strictEqual(r2.error, undefined, r2.error);
  assert.strictEqual(r2.intended, true);
  assert.strictEqual(r2.flagged, true, JSON.stringify(r2));
  assert.strictEqual(r2.unexplained, 0);
});
