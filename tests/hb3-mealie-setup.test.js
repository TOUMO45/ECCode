'use strict';
// Detector v3, S1 to S4 (docs/design/hb3-detector-v3.md): the Mealie configuration of the H-B probes. Five roles with constant
// tokens, ids that exist (the first three of every table are the same three on every fresh setup, and they are the config's
// `exampleIds`), a richer generic dataset, and a setup that is the same on two fresh databases. The probe identities are kept
// out of the example ids so a DELETE probe cannot remove the user a later probe authenticates as.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../bench/pilot/phase2-hb/config');

const ROOT = path.join(__dirname, '..');
const MEALIE = process.env.ECCODE_MEALIE_DIR || '/root/.cache/eccode/mealie-seed';
const PYTHON = path.join(MEALIE, '.venv', 'bin', 'python');
const NLTK = process.env.NLTK_DATA || '/root/.cache/eccode/nltk_data';
const have = fs.existsSync(PYTHON) && fs.existsSync(path.join(MEALIE, 'mealie', 'app.py'));
const skipMealie = have ? false : (process.env.ECCODE_REQUIRE_MEALIE === '1' ? (() => { throw new Error(`no Mealie checkout at ${MEALIE}`); })() : `no Mealie checkout at ${MEALIE}`);

const EXAMPLE = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const RESERVED = (n) => `00000000-0000-4000-8000-0000000000a${n}`;
const ROLE_NAMES = ['anonymous', 'user', 'admin', 'inviter', 'organizer'];

test('config: five roles with constant tokens, exampleIds, and the probe identities outside the example ids', () => {
  const a = config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' });
  assert.deepStrictEqual(a, config.behaviorConfig('/x/mealie', '/y/eccode', { nltkData: '/n' }), 'deterministic');
  assert.deepStrictEqual(a.roles.map((r) => r.name), ROLE_NAMES);
  assert.deepStrictEqual(a.exampleIds, EXAMPLE);
  assert.deepStrictEqual(a.roles[0].headers, {});
  const probes = config.PROBE_USERS;
  assert.deepStrictEqual(probes.map((p) => p.role), ['user', 'admin', 'inviter', 'organizer']);
  assert.deepStrictEqual(probes.map((p) => p.id), [1, 2, 3, 4].map(RESERVED));
  for (const p of probes) {
    assert.ok(!EXAMPLE.includes(p.id), 'a probe identity is not an example id');
    const role = a.roles.find((r) => r.name === p.role);
    assert.strictEqual(role.headers.Authorization, `Bearer ${config.token(p.id)}`);
    assert.strictEqual(a.env[`ECCODE_HB_${p.role.toUpperCase()}_TOKEN`], config.token(p.id));
    const [, payload] = config.token(p.id).split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(payload, 'base64').toString()), { long_token: 'eccode-hb', id: p.id });
  }
  // The permissions: inviter and organizer each hold exactly one permission beyond a plain user; admin all.
  const flags = Object.fromEntries(probes.map((p) => [p.role, p.flags]));
  assert.deepStrictEqual(flags.user, {});
  assert.deepStrictEqual(flags.inviter, { can_invite: true });
  assert.deepStrictEqual(flags.organizer, { can_organize: true });
  assert.strictEqual(flags.admin.admin, true);
  const setup = fs.readFileSync(path.join(ROOT, 'bench/pilot/phase2-hb/mealie_setup.py'), 'utf8');
  for (const p of probes) assert.ok(setup.includes(`"${p.id}"`), `${p.id} in the setup script`);
  assert.ok(setup.includes(`"${config.SECRET}"`), 'the secret in the setup script');
  assert.deepStrictEqual(a.ignoreFields.slice(0, 6), ['dataDirSize', 'tempDirSize', 'backupsDirSize', 'groupsDirSize', 'recipesDirSize', 'userDirSize']);
  assert.deepStrictEqual([a.normalizers, a.unordered], [[], []]);
});

// ---------------------------------------------------------------------------------------------------------------------

const ROUTES = [
  '/api/foods/{id}', '/api/units/{id}', '/api/groups/labels/{id}', '/api/organizers/categories/{id}', '/api/organizers/tags/{id}',
  '/api/organizers/tools/{id}', '/api/households/shopping/lists/{id}', '/api/households/shopping/items/{id}', '/api/households/cookbooks/{id}',
  '/api/households/webhooks/{id}', '/api/households/recipe-actions/{id}', '/api/households/mealplans/rules/{id}', '/api/groups/reports/{id}',
  '/api/comments/{id}', '/api/recipes/timeline/events/{id}', '/api/shared/recipes/{id}', '/api/admin/users/{id}', '/api/admin/groups/{id}',
  '/api/admin/households/{id}',
];
// Tables whose first three rows must be the three example ids on every fresh setup.
const THREE = [
  'recipes', 'ingredient_foods', 'ingredient_units', 'multi_purpose_labels', 'tools', 'categories', 'tags', 'shopping_lists',
  'shopping_list_items', 'cookbooks', 'recipe_comments', 'recipe_timeline_events', 'webhook_urls', 'group_reports', 'recipe_actions',
  'group_meal_plan_rules', 'recipe_share_tokens', 'groups', 'households',
];
// Columns that differ between two fresh setups because the application writes a random value there (each is a field the census of
// the noise controls must confirm is normalized or excluded; none is chosen to hide a difference a change could make).
const RANDOM = new Set([]);

let cache;
function fresh() {
  if (cache) return cache;
  const runs = [];
  const cfg = config.behaviorConfig(MEALIE, ROOT, { nltkData: NLTK });
  for (let i = 0; i < 2; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb3-setup-'));
    const env = { ...process.env, UV_FROZEN: '1' };
    for (const [k, v] of Object.entries(cfg.env)) env[k] = String(v).replace('{tmp}', dir);
    const setup = spawnSync(PYTHON, [path.join(ROOT, 'bench/pilot/phase2-hb/mealie_setup.py')], { cwd: MEALIE, env, encoding: 'utf8', timeout: 280000 });
    const inspect = setup.status === 0
      ? spawnSync(PYTHON, [path.join(__dirname, 'fixtures/phase2/inspect_setup.py'), JSON.stringify(cfg.roles), JSON.stringify(ROUTES), JSON.stringify(EXAMPLE)], { cwd: MEALIE, env, encoding: 'utf8', timeout: 280000 })
      : null;
    const line = inspect && (inspect.stdout || '').split('\n').find((l) => l.startsWith('ECCODE_INSPECT '));
    runs.push({ dir, setup, inspect, data: line ? JSON.parse(line.slice('ECCODE_INSPECT '.length)) : null });
  }
  cache = runs;
  process.on('exit', () => { for (const r of runs) fs.rmSync(r.dir, { recursive: true, force: true }); });
  return runs;
}
function ok(run) {
  assert.strictEqual(run.setup.status, 0, `setup: ${run.setup.stdout}\n${run.setup.stderr}`.slice(-3000));
  assert.ok(run.data, `inspect: ${run.inspect && run.inspect.stderr}`.slice(-3000));
  return run.data;
}

test('setup: it succeeds and every call it makes through the API is accepted', { skip: skipMealie }, () => {
  for (const run of fresh()) {
    ok(run);
    assert.match(run.setup.stdout, /eccode hb populate: \d+ call\(s\), 0 not accepted/, run.setup.stdout.slice(-2000));
    assert.match(run.setup.stdout, /eccode hb setup: ok/);
  }
});

test('setup: the first three rows of every entity table are the three example ids, on every fresh setup', { skip: skipMealie }, () => {
  for (const run of fresh()) {
    const d = ok(run);
    for (const t of THREE) {
      const ids = d.tables[t];
      assert.ok(ids && ids.length >= 3, `${t}: at least three rows (${ids && ids.length})`);
      assert.deepStrictEqual(ids.slice(0, 3), EXAMPLE, `${t}: the first three ids`);
    }
    assert.deepStrictEqual(d.fk.violations, [], 'no foreign-key violation after the re-key');
    assert.deepStrictEqual(d.fk.integrity, [['ok']]);
  }
});

test('setup: every example id resolves to an entity through a real route (200), for each kind', { skip: skipMealie }, () => {
  const d = ok(fresh()[0]);
  const bad = Object.entries(d.routes).filter(([, s]) => s !== 200).map(([k, s]) => `${k} -> ${s}`);
  assert.deepStrictEqual(bad, []);
  assert.strictEqual(Object.keys(d.routes).length, ROUTES.length * EXAMPLE.length);
  assert.strictEqual(d.public['calendar alpha'], 200, 'the public calendar feed answers for the first string example');
});

test('setup: five roles authenticate as themselves; users: the reserved probe identities, plain users on the example ids', { skip: skipMealie }, () => {
  const d = ok(fresh()[0]);
  assert.deepStrictEqual(d.self.anonymous.status, 401);
  for (const p of config.PROBE_USERS) assert.deepStrictEqual(d.self[p.role], { status: 200, username: p.username }, p.role);
  const byName = Object.fromEntries(d.users.map((u) => [u.username, u]));
  assert.strictEqual(byName['eccode-probe-user'].id, RESERVED(1));
  assert.strictEqual(byName['eccode-probe-admin'].id, RESERVED(2));
  const perms = (u) => [u.admin, u.canInvite, u.canManage, u.canManageHousehold, u.canOrganize];
  assert.deepStrictEqual(perms(byName['eccode-probe-user']), [false, false, false, false, false]);
  assert.deepStrictEqual(perms(byName['eccode-probe-admin']), [true, true, true, true, true]);
  assert.deepStrictEqual(perms(byName['eccode-probe-inviter']), [false, true, false, false, false]);
  assert.deepStrictEqual(perms(byName['eccode-probe-organizer']), [false, false, false, false, true]);
  const plain = d.users.filter((u) => !Object.values(config.PROBE_USERS).some((p) => p.id === u.id) && EXAMPLE.includes(u.id));
  assert.deepStrictEqual(plain.map((u) => u.id), EXAMPLE, 'three plain users on the example ids');
  assert.ok(plain.every((u) => !u.admin), 'plain users are not administrators');
  assert.ok(d.users.every((u) => EXAMPLE.includes(u.id) || config.PROBE_USERS.some((p) => p.id === u.id) || u.id === RESERVED(0)), 'no other id in users');
  // Integer-id tables: the example integers (1, 0, 2 in the generator) hit rows that a probe does not authenticate with.
  assert.ok(d.intIds.group_meal_plans.slice(0, 3).join() === '1,2,3', 'meal plan entries 1, 2, 3');
  const probeTokenIds = d.tokens.filter((t) => config.PROBE_USERS.some((p) => p.id === t.userId) && t.id >= 1000);
  assert.strictEqual(probeTokenIds.length, 4, 'the four probe tokens have ids of 1000 and above');
  assert.ok(d.tokens.filter((t) => t.id < 1000).length >= 3, 'at least three other API tokens on small ids');
});

test('setup: two fresh setups give the same ids and the same data, column by column', { skip: skipMealie }, () => {
  const [a, b] = fresh().map(ok);
  assert.deepStrictEqual(a.tables, b.tables, 'the ids of every GUID table, in order');
  assert.deepStrictEqual(a.counts, b.counts);
  assert.deepStrictEqual(a.intIds, b.intIds);
  const differing = [];
  for (const t of Object.keys(a.columns)) for (const col of Object.keys(a.columns[t])) {
    if (a.columns[t][col] !== b.columns[t][col] && !RANDOM.has(`${t}.${col}`)) differing.push(`${t}.${col}`);
  }
  assert.deepStrictEqual(differing, [], 'columns that differ between two fresh setups (add to RANDOM only with the reason)');
});
