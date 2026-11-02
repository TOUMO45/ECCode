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
const { frozenTreeFromGit } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const py = python();
if (py.python) process.env.ECCODE_PYTHON = py.python;

test('the Mealie configuration is deterministic and chooses nothing per seed', () => {
  const a = config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' });
  const b = config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.app, 'mealie.app:app');
  assert.deepStrictEqual(a.roles.map((r) => r.name), ['anonymous', 'user', 'admin']);
  assert.deepStrictEqual([a.normalizers, a.unordered], [[], []]);
  // The only ignored fields are the six storage sizes of Mealie's admin endpoints (random avatars make them differ per run); a seventh is a registration.
  assert.deepStrictEqual(a.ignoreFields, ['dataDirSize', 'tempDirSize', 'backupsDirSize', 'groupsDirSize', 'recipesDirSize', 'userDirSize']);
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

test('the runner accepts the freeze commit\'s tree, refuses a tree whose frozen files differ, and refuses HEAD once Phase 3 changed the engine', (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb-tree-'));
  for (const f of ['bench/pilot/phase2-seeds.js', 'bench/pilot/phase2-freeze.json', 'lib/behavior.js', 'bin/eccode.js']) {
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(copy, f));
  }
  assert.throws(() => runner.assertFrozenTree(copy), /not the frozen H-B pipeline/);
  fs.rmSync(copy, { recursive: true, force: true });
  const headFrozen = require('../bench/pilot/phase2-seeds').check(ROOT).ok;
  if (headFrozen) assert.match(runner.assertFrozenTree(ROOT), /^frozen: \d+ files/);
  else assert.throws(() => runner.assertFrozenTree(ROOT), /not the frozen H-B pipeline/);
  const tree = frozenTreeFromGit();
  if (!tree.dir) return t.skip(tree.reason);
  assert.match(runner.assertFrozenTree(tree.dir), /^frozen: 33 files/);
  fs.rmSync(tree.dir, { recursive: true, force: true });
});

test('the runner flags a seeded unintended change and passes a declared one through the fixture, and archives each seed\'s audited engine record', { skip: py.python ? false : py.reason }, () => {
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb-archive-'));
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
      archiveDir: archive,
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
  // Each seed's engine record outlived the cleanup: audited, hashed, and readable as events.
  for (const r of [r1, r2]) {
    assert.strictEqual(r.audit.ok, true, JSON.stringify(r.audit));
    assert.match(r.audit.message, /^Audit OK: \d+ events/);
    assert.ok(r.archive.files >= 3, JSON.stringify(r.archive));
    const dir = r.archive.dir;
    const manifest = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8');
    assert.strictEqual(require('crypto').createHash('sha256').update(manifest).digest('hex'), r.archive.manifestSha256);
    for (const line of manifest.trim().split('\n')) {
      const [hash, file] = line.split(/  /);
      assert.strictEqual(require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex'), hash, `${file} matches its manifest line`);
    }
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const result = events.find((e) => e.type === 'behavior.diff.result');
    assert.ok(result, 'the diff result is an event of the archived log');
    assert.strictEqual(result.data.id, r.result);
    assert.ok(fs.existsSync(path.join(dir, result.data.artifact.replace(/^\.eccode\//, ''))), 'its artifact is archived');
  }
  // A record that is edited after the archive no longer matches its manifest.
  fs.appendFileSync(path.join(r1.archive.dir, 'events.jsonl'), ' ');
  const manifest = fs.readFileSync(path.join(r1.archive.dir, 'MANIFEST.sha256'), 'utf8');
  const line = manifest.split('\n').find((l) => l.endsWith('  events.jsonl'));
  assert.notStrictEqual(require('crypto').createHash('sha256').update(fs.readFileSync(path.join(r1.archive.dir, 'events.jsonl'))).digest('hex'), line.split(/  /)[0]);
  fs.rmSync(archive, { recursive: true, force: true });
});
