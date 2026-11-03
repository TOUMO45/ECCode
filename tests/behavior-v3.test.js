'use strict';
// Detector v3 (docs/design/hb3-detector-v3.md, protocol 2026-11-03-hb3.md): the example generator makes the inputs v2 could not
// (the uuid family from a list of ids that exist, mixed-case emails, padded names, minLength, time and uri, a confirmation field
// equal to its sibling), and changes hidden behind those inputs are seen. Every claim is paired with the same thing on the frozen
// v2 tree, materialized from git, so the tests cannot pass by accident.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { materialize, python } = require('./fixtures/phase2/build');
const { frozenTreeFromGit, HB2_FREEZE_COMMIT } = require('./helpers');
const { loadConfig } = require('../lib/config');
const { init } = require('../lib/project');
const behavior = require('../lib/behavior');
const runner = require('../bench/pilot/phase2-hb/run');

const ROOT = path.join(__dirname, '..');
const VAULT = path.join(__dirname, 'fixtures', 'phase2', 'vault');
const py = python();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE2 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
if (py.python) process.env.ECCODE_PYTHON = py.python;
const PY = py.python;

function v2Tree() {
  return frozenTreeFromGit(HB2_FREEZE_COMMIT, ['bench/pilot/phase2-freeze-v2.json', 'bench/pilot/hb2']);
}

/** The corpus a runner generates for the vault fixture (all its operations are impacted by naming its one source file). */
function corpusOf(runnerPath, { exampleIds = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-v3-corpus-'));
  const cp = path.join(dir, 'vault');
  fs.cpSync(VAULT, cp, { recursive: true });
  if (!exampleIds) {
    const cfg = JSON.parse(fs.readFileSync(path.join(cp, '.eccode', 'behavior.json'), 'utf8'));
    delete cfg.exampleIds;
    fs.writeFileSync(path.join(cp, '.eccode', 'behavior.json'), JSON.stringify(cfg));
  }
  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(['vault/app.py']));
  fs.writeFileSync(path.join(dir, 'empty.json'), '[]');
  const r = spawnSync(PY, [runnerPath, 'generate', '--config', path.join(cp, '.eccode', 'behavior.json'), '--routes', path.join(dir, 'empty.json'), '--functions', path.join(dir, 'empty.json'), '--files', path.join(dir, 'files.json'), '--out', path.join(dir, 'corpus.json')], { cwd: cp, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return corpus.probes.filter((p) => p.surface === 'http');
}
const on = (probes, target) => probes.filter((p) => p.target === target);

test('uuid family: a uuid4 path id is a valid id from exampleIds, one variant per id; without exampleIds it is a valid synthetic uuid; v2 sent "alpha"', { skip }, (t) => {
  const v2 = v2Tree();
  if (!v2.dir) return t.skip(v2.reason);
  try {
    const v3 = on(corpusOf(path.join(ROOT, 'scripts/behavior/probe_runner.py')), 'GET /api/items/{item_id}');
    const urls = [...new Set(v3.map((p) => p.input.url))].sort();
    assert.deepStrictEqual(urls, ['/api/items/00000000-0000-4000-8000-000000000001', '/api/items/00000000-0000-4000-8000-000000000002']);
    assert.strictEqual(v3.length, 3 * 2, 'at least three variants (two ids, the first reused), two roles');
    const bare = on(corpusOf(path.join(ROOT, 'scripts/behavior/probe_runner.py'), { exampleIds: false }), 'GET /api/items/{item_id}');
    assert.ok(bare.every((p) => /^\/api\/items\/00000000-0000-4000-8000-\d{12}$/.test(p.input.url)), 'valid synthetic uuids without exampleIds');
    const old = on(corpusOf(path.join(v2.dir, 'scripts/behavior/probe_runner.py')), 'GET /api/items/{item_id}');
    assert.ok(old.length > 0 && old.every((p) => !/^\/api\/items\/[0-9a-f]{8}-/.test(p.input.url)), `v2 never sends a valid id (uuid4 is not recognised): ${[...new Set(old.map((p) => p.input.url))]}`);
  } finally { fs.rmSync(v2.dir, { recursive: true, force: true }); }
});

test('formats: a mixed-case email, a padded name that meets minLength, time and uri values; v2 made none of them', { skip }, (t) => {
  const v2 = v2Tree();
  if (!v2.dir) return t.skip(v2.reason);
  try {
    const now = corpusOf(path.join(ROOT, 'scripts/behavior/probe_runner.py'));
    const old = corpusOf(path.join(v2.dir, 'scripts/behavior/probe_runner.py'));
    const emails = (probes) => on(probes, 'POST /api/accounts').map((p) => p.input.json && p.input.json.email).filter(Boolean);
    const names = (probes) => on(probes, 'POST /api/accounts').map((p) => p.input.json && p.input.json.display_name).filter(Boolean);
    assert.ok(emails(now).some((e) => e !== e.toLowerCase()), `a mixed-case email: ${emails(now)}`);
    assert.ok(!emails(old).some((e) => e !== e.toLowerCase()), 'v2: emails were lower case');
    assert.ok(names(now).some((n) => n !== n.trim()) && names(now).every((n) => n.length >= 3), `padded names that meet minLength 3: ${JSON.stringify(names(now))}`);
    assert.ok(!names(old).every((n) => n.length >= 3), 'v2: a name shorter than minLength');
    assert.ok(on(now, 'GET /api/slots').every((p) => /^\d{2}:\d{2}:\d{2}$/.test(p.input.query.at)), 'a time value');
    assert.ok(on(old, 'GET /api/slots').every((p) => !/^\d{2}:\d{2}:\d{2}$/.test(p.input.query.at)), 'v2 never sends a time');
    assert.ok(on(now, 'POST /api/links').every((p) => /^https:\/\/example\.test\//.test(p.input.json.link)), 'a uri value');
    assert.ok(on(old, 'POST /api/links').every((p) => !/^https?:\/\//.test(p.input.json.link)), 'v2 never sends a uri');
  } finally { fs.rmSync(v2.dir, { recursive: true, force: true }); }
});

test('confirmation field: it equals its sibling, and the sibling meets minLength; v2 sent two different values', { skip }, (t) => {
  const v2 = v2Tree();
  if (!v2.dir) return t.skip(v2.reason);
  try {
    const now = on(corpusOf(path.join(ROOT, 'scripts/behavior/probe_runner.py')), 'POST /api/signup').filter((p) => p.input.json);
    assert.ok(now.length > 0 && now.every((p) => p.input.json.password === p.input.json.passwordConfirm && p.input.json.password.length >= 8), JSON.stringify(now.map((p) => p.input.json)));
    const old = on(corpusOf(path.join(v2.dir, 'scripts/behavior/probe_runner.py')), 'POST /api/signup').filter((p) => p.input.json);
    assert.ok(old.some((p) => p.input.json.password !== p.input.json.passwordConfirm || p.input.json.password.length < 8));
  } finally { fs.rmSync(v2.dir, { recursive: true, force: true }); }
});

const CHANGES = {
  item: { file: 'vault/app.py', find: 'f"{item[\'price_cents\'] / 100:.2f}"', replace: 'f"{item[\'price_cents\'] / 100:.1f}"' },
  email: { file: 'vault/app.py', find: '"email": body.email.lower()', replace: '"email": body.email' },
  name: { file: 'vault/app.py', find: '"display_name": body.display_name.strip()', replace: '"display_name": body.display_name' },
  signup: { file: 'vault/app.py', find: '"length": len(body.password)', replace: '"length": len(body.password) + 1' },
  slot: { file: 'vault/app.py', find: 'at.hour // 6', replace: 'at.hour // 4' },
  link: { file: 'vault/app.py', find: '"host": body.link.host}', replace: '"host": body.link.host, "scheme": body.link.scheme}' },
  comment: { file: 'vault/app.py', find: 'app = FastAPI(title="vault")', replace: 'app = FastAPI(title="vault")  # a comment, nothing else' },
};

function vaultWith(change) {
  const m = materialize(VAULT);
  return { ...m, apply: () => {
    const f = path.join(m.dir, change.file);
    const text = fs.readFileSync(f, 'utf8');
    assert.strictEqual(text.split(change.find).length - 1, 1, `${change.find}: occurs once`);
    fs.writeFileSync(f, text.replace(change.find, change.replace));
  } };
}

function suitePasses(dir) {
  return spawnSync(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-W', 'ignore'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).status === 0;
}

/** The real route -> diff path on the engine at ROOT (v3). */
function v3Diff(change) {
  const s = vaultWith(change);
  try {
    const store = init(s.dir, { name: 'vault', idea: 'v3 fixture', track: 'fix' });
    const config = loadConfig(s.dir);
    s.apply();
    assert.ok(suitePasses(s.dir), 'the fixture suite still passes after the change');
    assert.strictEqual(behavior.route(store, config, 'backend-engineer').decision, 'run');
    const d = behavior.diff(store, config, 'backend-engineer', {});
    assert.strictEqual(store.audit().ok, true);
    return d;
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
}

for (const name of ['item', 'email', 'name', 'signup', 'slot', 'link']) {
  test(`end to end: the "${name}" change is invisible to the frozen v2 and flagged by v3`, { skip }, (t) => {
    const v2 = v2Tree();
    if (!v2.dir) return t.skip(v2.reason);
    try {
      const s = vaultWith(CHANGES[name]);
      let record;
      try {
        record = runner.runSeed({ tree: v2.dir, checkout: s.dir, commit: null, seedId: name, apply: () => { s.apply(); return { id: name, intended: false, kind: name, contract: null, verification: { scope: 'full' } }; }, configure: () => {}, runs: 2 });
      } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
      assert.strictEqual(record.error, undefined, record.error);
      assert.strictEqual(record.flagged, false, `v2 must not see it: ${JSON.stringify(record)}`);
      const d = v3Diff(CHANGES[name]);
      assert.strictEqual(d.coverage, 'ok', d.coverageNote);
      assert.ok(d.unexplained >= 1, `v3 flags it; notes: ${d.notes.join('; ')}`);
    } finally { fs.rmSync(v2.dir, { recursive: true, force: true }); }
  });
}

test('end to end: a comment-only change gives zero differences on v3 (the noise floor on the fixture)', { skip }, () => {
  const d = v3Diff(CHANGES.comment);
  assert.strictEqual(d.differences.length, 0, JSON.stringify(d.differences.slice(0, 2)));
  assert.strictEqual(d.unexplained, 0);
});
