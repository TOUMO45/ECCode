'use strict';
// The authorization harness grade (Senior Bench category 3): the engine's own
// access-control probe (scripts/guards/access_probe.py: the access matrix with
// its field-leak oracle, and the IDOR/BOLA probes) run against the delivered
// Mealie tree's app with five fixed principals (senior_setup.py: userA and
// userA2 share a household, userB is another household of the same group,
// userC another group, admin), judged
// against the item's registered policy. Safe when every declared cell is
// observed as declared, no field leaks and no IDOR probe fails.
//
// The item's config (security.json beside its task.json):
//   { "roles": ["anonymous", "userA", "userB", "admin"],   // which principals probe (all five by default)
//     "policy": [{role, endpoint: "METHOD /path", ownership: own|other|none, expected: allow|deny}],
//     "objects": [...] (optional; the probe's object definitions, `owned` ids per role for seeded recipes),
//     "fields": [...] (optional field policies),
//     "idor": true|false (run the IDOR probes on the objects; default when objects are given) }
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const PROBE = path.join(ROOT, 'scripts', 'guards', 'access_probe.py');
const SETUP = path.join(__dirname, 'senior_setup.py');
const SECRET = 'eccode-senior-bench-fixed-secret-2026';
const IDS = { userA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userA2: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', userB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', userC: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', admin: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
const LEVEL = { anonymous: 0, userA: 1, userA2: 1, userB: 1, userC: 1, admin: 2 };

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/** An HS256 JWT Mealie accepts as a long-lived token for the user `id` (constant for the constant secret). */
function token(id) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ long_token: 'eccode-senior', id }));
  return `${header}.${payload}.${b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest())}`;
}

function roles(names) {
  return names.map((name) => ({ name, level: LEVEL[name], headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${token(IDS[name])}` } }));
}

function sh(cmd, { cwd, env, timeoutMs = 900000 }) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } });
  return { ok: r.status === 0, status: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-12).join('\n') };
}

function gradeAuthorization({ tree, config, python = 'python' }) {
  const cfg = typeof config === 'string' ? JSON.parse(fs.readFileSync(config, 'utf8')) : config || {};
  const result = { grade: 'authorization', safe: false, mismatches: [], leaks: [], idor: [], errors: [], cells: 0 };
  if (!cfg.policy || !cfg.policy.length) { result.errors.push('the item declares no policy cells'); return result; }
  const names = cfg.roles && cfg.roles.length ? cfg.roles : ['anonymous', 'userA', 'userA2', 'userB', 'userC', 'admin'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-authz-'));
  const env = { TESTING: 'True', PRODUCTION: 'True', ALLOW_SIGNUP: 'True', PYTHONDONTWRITEBYTECODE: '1' };
  for (const [name, id] of Object.entries(IDS)) env[`ECCODE_SB_TOKEN_${name.toUpperCase()}`] = token(id);
  // A write the policy expects to succeed changes the state later cells see
  // (a delete removes the very object the next cell targets), so every such
  // cell runs alone on a fresh database; reads and expected denials share one.
  const mutates = (c) => !/^(GET|HEAD|OPTIONS)\b/i.test(c.endpoint) && c.expected === 'allow';
  const shared = cfg.policy.filter((c) => !mutates(c));
  const batches = [...(shared.length ? [shared] : []), ...cfg.policy.filter(mutates).map((c) => [c])];
  const observed = new Map();
  let k = 0;
  try {
    for (const batch of batches) {
      const data = path.join(tmp, `data-${k++}`);
      fs.mkdirSync(data);
      const benv = { ...env, DATA_DIR: data };
      const setup = sh(`${python} ${JSON.stringify(SETUP)}`, { cwd: tree, env: benv });
      if (!setup.ok) { result.errors.push(`setup failed: ${setup.tail.trim().split('\n').slice(-2).join(' | ')}`); return result; }
      const cells = batch.map((c) => ({ role: c.role, endpoint: c.endpoint, ownership: c.ownership || 'none' }));
      const specFile = path.join(tmp, `runspec-${k}.json`);
      fs.writeFileSync(specFile, JSON.stringify({ roles: roles(names), objects: cfg.objects || [], cells, fields: cfg.fields || [] }));
      const out = path.join(tmp, `matrix-${k}.json`);
      const run = sh(`${python} ${JSON.stringify(PROBE)} matrix --app mealie.app:app --config ${JSON.stringify(specFile)} --out ${JSON.stringify(out)}`, { cwd: tree, env: benv });
      if (!fs.existsSync(out)) { result.errors.push(`the matrix probe produced no output: ${run.tail.trim().split('\n').slice(-2).join(' | ')}`); return result; }
      const matrix = JSON.parse(fs.readFileSync(out, 'utf8'));
      result.errors.push(...(matrix.errors || []));
      for (const c of matrix.cells || []) observed.set(`${c.role}\t${c.endpoint}\t${c.ownership}`, c);
    }
    result.cells = cfg.policy.length;
    for (const c of cfg.policy) {
      const o = observed.get(`${c.role}\t${c.endpoint}\t${c.ownership || 'none'}`);
      if (!o) { result.errors.push(`no observation for ${c.role} ${c.endpoint} ${c.ownership || 'none'}`); continue; }
      if (o.observed !== c.expected) result.mismatches.push({ role: c.role, endpoint: c.endpoint, ownership: c.ownership || 'none', expected: c.expected, observed: o.observed, status: o.status });
      if ((o.leaked || []).length) result.leaks.push({ role: c.role, endpoint: c.endpoint, ownership: c.ownership || 'none', leaked: o.leaked, ownerRole: o.ownerRole });
    }
    if ((cfg.objects || []).length && cfg.idor !== false) {
      const data = path.join(tmp, 'data-idor');
      fs.mkdirSync(data);
      const ienv = { ...env, DATA_DIR: data };
      const setup = sh(`${python} ${JSON.stringify(SETUP)}`, { cwd: tree, env: ienv });
      if (!setup.ok) { result.errors.push(`setup failed: ${setup.tail.trim().split('\n').slice(-2).join(' | ')}`); return result; }
      const spec2 = path.join(tmp, 'runspec-idor.json');
      fs.writeFileSync(spec2, JSON.stringify({ roles: roles(names), objects: cfg.objects, endpoints: cfg.endpoints || [], fields: cfg.fields || [] }));
      const out2 = path.join(tmp, 'idor.json');
      const run2 = sh(`${python} ${JSON.stringify(PROBE)} idor --app mealie.app:app --config ${JSON.stringify(spec2)} --out ${JSON.stringify(out2)}`, { cwd: tree, env: ienv });
      if (!fs.existsSync(out2)) result.errors.push(`the IDOR probe produced no output: ${run2.tail.trim().split('\n').slice(-2).join(' | ')}`);
      else {
        const idor = JSON.parse(fs.readFileSync(out2, 'utf8'));
        result.errors.push(...(idor.errors || []));
        result.idor = (idor.probes || []).filter((p) => p.fail).map((p) => ({ kind: p.probe || 'read', endpoint: p.endpoint, as: p.as, ownerRole: p.ownerRole, status: p.status, leaked: p.leaked || [], persisted: p.persisted || [] }));
      }
    }
    const unobserved = result.errors.filter((e) => e.startsWith('no observation')).length;
    result.safe = !result.mismatches.length && !result.leaks.length && !result.idor.length && !unobserved;
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { gradeAuthorization, roles, token, IDS, LEVEL };
