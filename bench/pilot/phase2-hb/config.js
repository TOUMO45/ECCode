'use strict';
// The H-B probe configuration for a Mealie checkout, from a stated deterministic
// rule (docs/design/phase3-plan.md section 0.C): nothing here is chosen per seed,
// and the seed kind labels are never read. The output is byte-identical on every
// run for the same checkout and frozen tree paths.
//   node bench/pilot/phase2-hb/config.js <mealie checkout> <frozen ECCode tree> [--write]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The probe identities (detector v3, S3). Their ids are reserved (…00a1 to …00a4) and are not among the example ids (…0001 to …0003),
// so that a DELETE probe on an example id cannot remove the user a later probe authenticates as. mealie_setup.py creates them.
const PROBE_USERS = [
  { role: 'user', id: '00000000-0000-4000-8000-0000000000a1', username: 'eccode-probe-user', flags: {} },
  { role: 'admin', id: '00000000-0000-4000-8000-0000000000a2', username: 'eccode-probe-admin', flags: { admin: true } },
  { role: 'inviter', id: '00000000-0000-4000-8000-0000000000a3', username: 'eccode-probe-inviter', flags: { can_invite: true } },
  { role: 'organizer', id: '00000000-0000-4000-8000-0000000000a4', username: 'eccode-probe-organizer', flags: { can_organize: true } },
];
const USER_ID = PROBE_USERS[0].id;
const ADMIN_ID = PROBE_USERS[1].id;
// The ids that exist in every table after the setup (mealie_setup.py renumbers each GUID table in creation order): the generator's
// uuid inputs take them, one variant per id.
const EXAMPLE_IDS = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const SECRET = 'eccode-phase2-hb-fixed-secret-2026'; // written by mealie_setup.py under DATA_DIR

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** An HS256 JWT Mealie accepts as a long-lived token for the user `id`: a constant for a constant secret and id. */
function token(id) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ long_token: 'eccode-hb', id }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function behaviorConfig(checkout, frozenTree, { nltkData = process.env.NLTK_DATA || '' } = {}) {
  const python = path.join(path.resolve(checkout), '.venv', 'bin', 'python');
  const setup = path.join(path.resolve(frozenTree), 'bench', 'pilot', 'phase2-hb', 'mealie_setup.py');
  const tokens = Object.fromEntries(PROBE_USERS.map((p) => [p.role, token(p.id)]));
  return {
    app: 'mealie.app:app',
    env: {
      DATA_DIR: '{tmp}/data',
      TESTING: 'True',
      PRODUCTION: 'True',
      ALLOW_SIGNUP: 'True',
      ...(nltkData ? { NLTK_DATA: nltkData } : {}),
      ...Object.fromEntries(PROBE_USERS.map((p) => [`ECCODE_HB_${p.role.toUpperCase()}_TOKEN`, tokens[p.role]])),
    },
    exampleIds: EXAMPLE_IDS,
    setup: `${python} ${setup}`,
    roles: [
      { name: 'anonymous', headers: {} },
      ...PROBE_USERS.map((p) => ({ name: p.role, headers: { Authorization: `Bearer ${tokens[p.role]}` } })),
    ],
    normalizers: [],
    // Mealie generates a random avatar for every user it creates, so the size of its data directory differs from run to run
    // (a census of 2,481 probes with six baseline runs found no other unexcluded nondeterminism: bench/pilot/hb2/edit-check.js).
    // With two baseline runs a two-valued field agrees by chance, so these fields are excluded outright.
    ignoreFields: ['dataDirSize', 'tempDirSize', 'backupsDirSize', 'groupsDirSize', 'recipesDirSize', 'userDirSize'],
    unordered: [],
  };
}

function write(checkout, frozenTree, opts) {
  const cfg = behaviorConfig(checkout, frozenTree, opts);
  const dir = path.join(checkout, '.eccode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

if (require.main === module) {
  const [checkout, frozen, flag] = process.argv.slice(2);
  if (!checkout || !frozen) {
    process.stderr.write('usage: config.js <mealie checkout> <frozen ECCode tree> [--write]\n');
    process.exit(2);
  }
  const cfg = flag === '--write' ? write(checkout, frozen) : behaviorConfig(checkout, frozen);
  process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { behaviorConfig, write, token, PROBE_USERS, EXAMPLE_IDS, USER_ID, ADMIN_ID, SECRET };
