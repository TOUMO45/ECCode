'use strict';
// The H-B probe configuration for a Mealie checkout, from a stated deterministic
// rule (docs/design/phase3-plan.md section 0.C): nothing here is chosen per seed,
// and the seed kind labels are never read. The output is byte-identical on every
// run for the same checkout and frozen tree paths.
//   node bench/pilot/phase2-hb/config.js <mealie checkout> <frozen ECCode tree> [--write]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
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
  const userToken = token(USER_ID);
  const adminToken = token(ADMIN_ID);
  return {
    app: 'mealie.app:app',
    env: {
      DATA_DIR: '{tmp}/data',
      TESTING: 'True',
      PRODUCTION: 'True',
      ALLOW_SIGNUP: 'True',
      ...(nltkData ? { NLTK_DATA: nltkData } : {}),
      ECCODE_HB_USER_TOKEN: userToken,
      ECCODE_HB_ADMIN_TOKEN: adminToken,
    },
    setup: `${python} ${setup}`,
    roles: [
      { name: 'anonymous', headers: {} },
      { name: 'user', headers: { Authorization: `Bearer ${userToken}` } },
      { name: 'admin', headers: { Authorization: `Bearer ${adminToken}` } },
    ],
    normalizers: [],
    ignoreFields: [],
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

module.exports = { behaviorConfig, write, token, USER_ID, ADMIN_ID, SECRET };
