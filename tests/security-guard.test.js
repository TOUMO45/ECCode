'use strict';
// Security guard (Phase 3, Part C) against a small, self-contained FastAPI app:
// the access matrix agrees with the declared policy and the IDOR, field,
// mass-assignment and input probes pass on the safe app; four one-line breaks
// are each caught by the oracle built for them and refuse delivery:
//   - the owner check removed from GET /notes/{note_id}: a member reads another
//     member's note (IDOR/BOLA);
//   - GET /users/{user_id} returning the email and the password hash to any
//     user (field leak, against the declared field policy);
//   - PATCH /notes/{note_id} applying an owner_id sent in the body (mass
//     assignment, seen on the read-back);
//   - /search concatenating the term into the SQL (boolean differential: a
//     tautology returns more rows than a contradiction).
// Every request goes to the app under test through FastAPI's TestClient with
// the network closed. Needs an interpreter with fastapi and httpx
// (ECCODE_PYTHON); without one these tests skip and say so, and fail instead
// when ECCODE_REQUIRE_PHASE3=1 (CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const security = require('../lib/security');
const guards = require('../lib/guards');

function detectPython() {
  const candidates = [process.env.ECCODE_PYTHON, '/root/.cache/eccode/phase3-venv/bin/python', 'python3'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', 'import fastapi, httpx'], { encoding: 'utf8' });
    if (r.status === 0) return { python: py };
  }
  return { python: null, reason: `no interpreter with fastapi and httpx (tried ${candidates.join(', ')}); set ECCODE_PYTHON to one` };
}

const py = detectPython();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE3 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
if (py.python) process.env.ECCODE_PYTHON = py.python;

// A minimal FastAPI app: two members (tok-a, tok-b), one admin (tok-admin);
// each member owns one note; GET /notes/{id} is 404 to a non-owner (safe);
// PATCH /notes/{id} rewrites the text and ignores an owner_id in the body
// (safe); GET /users/{id} is a public profile of id and name only (safe);
// /admin/stats is admin-only; /search is a parameterized LIKE over an
// in-memory sqlite table (safe).
const OWNER_CHECK = `    if note["owner_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="not found")
`;
const PROFILE_VIEW = '    return {"id": row["id"], "name": row["name"]}\n';
const LEAKY_VIEW = '    return {"id": row["id"], "name": row["name"], "email": row["email"], "password_hash": row["password_hash"]}\n';
const PATCH_APPLY = '    note["text"] = patch.text  # owner_id in the body is ignored\n';
const PATCH_MASS = '    note["text"] = patch.text\n    if patch.owner_id is not None:\n        note["owner_id"] = patch.owner_id\n';
const SEARCH_SAFE = '    rows = DB.execute("SELECT name FROM products WHERE name LIKE ?", ("%" + q + "%",)).fetchall()\n';
const SEARCH_CONCAT = '    rows = DB.execute("SELECT name FROM products WHERE name LIKE \'%" + q + "%\'").fetchall()\n';
const APP = `import sqlite3

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="notes")

TOKENS = {
    "tok-a": {"id": "a", "role": "member"},
    "tok-b": {"id": "b", "role": "member"},
    "tok-admin": {"id": "admin", "role": "admin"},
}
USERS = {
    "a": {"id": "a", "name": "Ann", "email": "ann@example.test", "password_hash": "hash-a"},
    "b": {"id": "b", "name": "Bob", "email": "bob@example.test", "password_hash": "hash-b"},
    "admin": {"id": "admin", "name": "Root", "email": "root@example.test", "password_hash": "hash-root"},
}
NOTES = {}
_next = {"id": 1}
DB = sqlite3.connect(":memory:", check_same_thread=False)
DB.execute("CREATE TABLE products (name TEXT)")
DB.executemany("INSERT INTO products VALUES (?)", [("lamp",), ("desk",), ("chair",)])
DB.commit()


class NewNote(BaseModel):
    text: str


class NotePatch(BaseModel):
    text: str
    owner_id: str | None = None


def user_of(authorization):
    if not authorization:
        return None
    token = authorization.replace("Bearer ", "").strip()
    return TOKENS.get(token)


def require_user(authorization):
    user = user_of(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return user


@app.post("/notes", status_code=201)
def create_note(note: NewNote, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    nid = _next["id"]
    _next["id"] += 1
    NOTES[nid] = {"id": nid, "owner_id": user["id"], "text": note.text}
    return NOTES[nid]


@app.get("/notes")
def list_notes(authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    return {"items": [n for n in NOTES.values() if n["owner_id"] == user["id"]]}


@app.get("/notes/{note_id}")
def get_note(note_id: int, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    note = NOTES.get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="not found")
${OWNER_CHECK}    return note


@app.patch("/notes/{note_id}")
def patch_note(note_id: int, patch: NotePatch, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    note = NOTES.get(note_id)
    if note is None or note["owner_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="not found")
${PATCH_APPLY}    return note


@app.get("/users/{user_id}")
def get_user(user_id: str, authorization: str | None = Header(default=None)):
    require_user(authorization)
    row = USERS.get(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
${PROFILE_VIEW}

@app.get("/admin/stats")
def admin_stats(authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return {"notes": len(NOTES)}


@app.get("/search")
def search(q: str = "", authorization: str | None = Header(default=None)):
    require_user(authorization)
${SEARCH_SAFE}    return {"query": q, "items": [r[0] for r in rows]}
`;

const ROLES = [
  { name: 'member-a', level: 1, headers: { Authorization: 'Bearer tok-a' } },
  { name: 'member-b', level: 1, headers: { Authorization: 'Bearer tok-b' } },
  { name: 'admin', level: 2, headers: { Authorization: 'Bearer tok-admin' } },
  { name: 'anonymous', level: 0, headers: {} },
];

const NOTE_EP = 'GET /notes/{note_id}';
const PATCH_EP = 'PATCH /notes/{note_id}';
const USER_EP = 'GET /users/{user_id}';
const NONE_EPS = ['GET /notes', 'POST /notes', 'GET /admin/stats', 'GET /search'];

function expectedFor(role, endpoint, ownership) {
  const auth = role.level > 0;
  if (endpoint === NOTE_EP || endpoint === PATCH_EP) return ownership === 'own' ? (auth ? 'allow' : 'deny') : 'deny';
  if (endpoint === USER_EP) return ownership === 'none' ? 'deny' : (auth ? 'allow' : 'deny');
  if (endpoint === 'GET /admin/stats') return role.level >= 2 ? 'allow' : 'deny';
  return auth ? 'allow' : 'deny';
}

function policyCells() {
  const cells = [];
  for (const role of ROLES) {
    // Every authenticated role creates a note of its own (the admin too), so every own/other/none cell is declared.
    for (const endpoint of [NOTE_EP, PATCH_EP, USER_EP]) for (const ownership of ['own', 'other', 'none']) cells.push({ role: role.name, endpoint, ownership, expected: expectedFor(role, endpoint, ownership) });
    for (const endpoint of NONE_EPS) cells.push({ role: role.name, endpoint, ownership: 'none', expected: expectedFor(role, endpoint, 'none') });
  }
  return cells;
}

const SECURITY_JSON = {
  roles: ROLES,
  objects: [
    {
      kind: 'note',
      idParam: 'note_id',
      list: { method: 'GET', path: '/notes', itemsField: 'items', idField: 'id' },
      create: { method: 'POST', path: '/notes', json: { text: 'a private note' }, idField: 'id' },
    },
    {
      kind: 'user',
      idParam: 'user_id',
      item: { method: 'GET', path: '/users/{user_id}' },
      owned: { 'member-a': 'a', 'member-b': 'b', admin: 'admin' },
    },
  ],
  // A non-owner may see a profile's id and name, nothing else.
  fields: [{ endpoint: USER_EP, allow: ['id', 'name'] }],
  policy: policyCells(),
  inputs: [{ endpoint: 'GET /search', param: 'q', in: 'query', kind: 'sql', role: 'member-a' }],
};

function makeProject(appText = APP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-security-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.py'), APP);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'safe app'], { cwd: dir });
  const store = init(dir, { name: 'notes', idea: 'access control demo', track: 'fix' });
  const config = loadConfig(dir);
  fs.writeFileSync(path.join(dir, '.eccode', 'behavior.json'), JSON.stringify({ app: 'app:app', roles: [{ name: 'anonymous', headers: {} }] }, null, 2));
  fs.writeFileSync(path.join(dir, '.eccode', 'security.json'), JSON.stringify(SECURITY_JSON, null, 2));
  security.policy(store, config, 'security-reviewer', policyCells());
  if (appText !== APP) fs.writeFileSync(path.join(dir, 'app.py'), appText);
  return { dir, store, config };
}

/** The app with one break applied (the find must occur exactly once). */
function broken(find, replace) {
  assert.strictEqual(APP.split(find).length - 1, 1, `the break site occurs once: ${find.slice(0, 40)}`);
  return APP.replace(find, replace);
}

function cleanUp(dir) {
  assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
  fs.rmSync(dir, { recursive: true, force: true });
}

function waiveAll(store, config, dir) {
  const sec = store.state().guards.security;
  const mx = sec.matrix.slice(-1)[0];
  const id = sec.idor.slice(-1)[0];
  const inp = (sec.input || []).slice(-1)[0];
  for (const c of mx.cells.filter((x) => x.match === false || x.leaked.length || x.unknownFields.length)) guards.waive(store, config, 'security-reviewer', { guard: 'security', result: mx.id, finding: `${c.role} ${c.endpoint} ${c.ownership}`, reason: 'accepted for this access-control guard test only' });
  for (const p of id.probes.filter((x) => x.fail)) guards.waive(store, config, 'security-reviewer', { guard: 'security', result: id.id, finding: `${p.endpoint} as ${p.as}`, reason: 'accepted for this access-control guard test only' });
  if (inp) for (const p of inp.probes.filter((x) => x.flagged)) guards.waive(store, config, 'security-reviewer', { guard: 'security', result: inp.id, finding: `${p.endpoint} ${p.param} ${p.kind}`, reason: 'accepted for this access-control guard test only' });
  assert.deepStrictEqual(security.deliveryProblems(store.state(), dir), [], 'waived findings clear the gate');
}

test('the safe app: the matrix agrees with the policy; IDOR, field, mass-assignment and input probes pass', { skip }, () => {
  const { dir, store, config } = makeProject();
  try {
    const mx = security.matrix(store, config, 'backend-engineer', {});
    assert.strictEqual(mx.unexplained, 0, `matrix disagreements: ${JSON.stringify(mx.cells.filter((c) => c.match === false || c.leaked.length))} notes ${mx.notes.join('; ')}`);
    assert.strictEqual(mx.unknown, 0, `undeclared cells: ${JSON.stringify(mx.cells.filter((c) => c.expected === null).slice(0, 3))}`);
    assert.strictEqual(mx.unknownFields, 0, `fields no policy covers: ${JSON.stringify(mx.cells.filter((c) => c.unknownFields.length))}`);
    assert.ok(mx.cells.length >= ROLES.length * 3, `cells: ${mx.cells.length}`);
    // A peer reads a public profile: allowed (200) with only the declared fields, so no leak.
    const profile = mx.cells.find((c) => c.role === 'member-a' && c.endpoint === USER_EP && c.ownership === 'other');
    assert.ok(profile && profile.observed === 'allow' && profile.leaked.length === 0, `peer profile read: ${JSON.stringify(profile)}`);

    const idor = security.idor(store, config, 'backend-engineer', {});
    assert.ok(idor.probes.length > 0, `idor ran probes (notes ${idor.notes.join('; ')})`);
    assert.strictEqual(idor.unexplained, 0, `idor leaks on the safe app: ${JSON.stringify(idor.probes.filter((p) => p.fail))}`);
    const ma = idor.probes.filter((p) => p.kind === 'mass-assignment');
    assert.ok(ma.some((p) => p.endpoint === PATCH_EP && 'owner_id' in p.injected), `a mass-assignment probe injected owner_id on ${PATCH_EP}: ${JSON.stringify(ma.map((p) => [p.endpoint, Object.keys(p.injected)]))}`);
    assert.ok(ma.every((p) => p.persisted.length === 0), 'nothing injected persisted');

    const inp = security.input(store, config, 'backend-engineer', {});
    assert.strictEqual(inp.flagged, 0, `input probe flagged on the safe app: ${JSON.stringify(inp.probes.filter((p) => p.flagged))}`);
    assert.ok(inp.probes[0].differential && inp.probes[0].differential.length >= 2, `the sql probe ran its boolean differential: ${JSON.stringify(inp.probes[0])}`);

    // Nothing blocks delivery on the clean tree.
    assert.deepStrictEqual(security.deliveryProblems(store.state(), dir), []);
    assert.strictEqual(store.audit().ok, true, 'audit');
  } finally {
    cleanUp(dir);
  }
});

test('a removed owner check: the IDOR probe flags the leak and delivery refuses', { skip }, () => {
  const { dir, store, config } = makeProject(broken(OWNER_CHECK, ''));
  try {
    // The change now touches a route with ownership: the guard is required.
    const req = guards.requiredFor(dir, store.state());
    assert.ok(req.required.includes('security'), `security required: ${JSON.stringify(req.reasons)}`);

    const mx = security.matrix(store, config, 'backend-engineer', {});
    const idor = security.idor(store, config, 'backend-engineer', {});
    // A member reads another member's note: 200 with the owner's content.
    const leak = idor.probes.find((p) => p.fail && p.relationship === 'peer' && p.endpoint === NOTE_EP);
    assert.ok(leak, `expected a peer IDOR leak, got ${JSON.stringify(idor.probes.map((p) => ({ as: p.as, rel: p.relationship, status: p.status, fail: p.fail })))}`);
    assert.strictEqual(leak.status, 200, 'the non-owner got 200');
    assert.ok(leak.leaked.length > 0, `leaked fields: ${JSON.stringify(leak.leaked)}`);
    assert.ok(idor.unexplained > 0, 'idor flags at least one leak');
    assert.ok(mx.unexplained > 0, `matrix flags the "other" cells now returning allow: ${JSON.stringify(mx.cells.filter((c) => c.match === false).map((c) => `${c.role} ${c.endpoint} ${c.ownership}`))}`);

    const problems = security.deliveryProblems(store.state(), dir);
    assert.ok(problems.length > 0, 'delivery refuses');
    assert.ok(problems.some((p) => /IDOR|reaches .*object/.test(p)), `an IDOR problem is reported: ${problems.join(' | ')}`);
    waiveAll(store, config, dir);
    assert.strictEqual(store.audit().ok, true, 'audit');
  } finally {
    cleanUp(dir);
  }
});

test('a leaked field: the profile now carries the email and the password hash; the field oracle flags it against the field policy', { skip }, () => {
  const { dir, store, config } = makeProject(broken(PROFILE_VIEW, LEAKY_VIEW));
  try {
    const mx = security.matrix(store, config, 'backend-engineer', {});
    // The status still agrees with the policy (a peer may read a profile): only the field oracle sees the leak.
    const cell = mx.cells.find((c) => c.role === 'member-a' && c.endpoint === USER_EP && c.ownership === 'other');
    assert.ok(cell && cell.match === true, `the cell still matches on status: ${JSON.stringify(cell)}`);
    assert.deepStrictEqual([...cell.leaked].sort(), ['email', 'password_hash'], `leaked fields: ${JSON.stringify(cell)}`);
    assert.ok(mx.unexplained > 0, 'the leak counts as unexplained');
    assert.ok(mx.cells.filter((c) => c.endpoint !== USER_EP).every((c) => c.leaked.length === 0 && c.unknownFields.length === 0), 'no other cell leaks');

    const idor = security.idor(store, config, 'backend-engineer', {});
    const leak = idor.probes.find((p) => p.kind === 'read' && p.endpoint === USER_EP && p.fail);
    assert.ok(leak, `the IDOR read probe flags the profile: ${JSON.stringify(idor.probes.filter((p) => p.endpoint === USER_EP).map((p) => [p.as, p.status, p.leaked, p.fail]))}`);
    assert.deepStrictEqual([...leak.leaked].sort(), ['email', 'password_hash']);
    assert.ok(idor.probes.filter((p) => p.endpoint === NOTE_EP).every((p) => !p.fail), 'the note reads are still denied');

    const problems = security.deliveryProblems(store.state(), dir);
    assert.ok(problems.some((p) => /field policy does not allow: email, password_hash/.test(p)), `the leak refuses delivery: ${problems.join(' | ')}`);
    waiveAll(store, config, dir);
    assert.strictEqual(store.audit().ok, true, 'audit');
  } finally {
    cleanUp(dir);
  }
});

test('mass assignment: PATCH /notes applies an owner_id from the body; the read-back flags the persisted field', { skip }, () => {
  const { dir, store, config } = makeProject(broken(PATCH_APPLY, PATCH_MASS));
  try {
    const mx = security.matrix(store, config, 'backend-engineer', {});
    assert.strictEqual(mx.unexplained, 0, `the matrix cannot see it (the legitimate body still works): ${JSON.stringify(mx.cells.filter((c) => c.match === false || c.leaked.length))}`);
    const idor = security.idor(store, config, 'backend-engineer', {});
    const hit = idor.probes.find((p) => p.kind === 'mass-assignment' && p.endpoint === PATCH_EP && p.fail);
    assert.ok(hit, `a mass-assignment probe failed: ${JSON.stringify(idor.probes.filter((p) => p.kind === 'mass-assignment').map((p) => [p.endpoint, p.as, p.status, p.persisted]))}`);
    assert.deepStrictEqual(hit.persisted, ['owner_id']);
    assert.ok('owner_id' in hit.injected, `owner_id was injected: ${JSON.stringify(hit.injected)}`);
    assert.ok(idor.probes.filter((p) => p.kind === 'read').every((p) => !p.fail), 'the reads are still denied');

    const problems = security.deliveryProblems(store.state(), dir);
    assert.ok(problems.some((p) => /mass assignment/.test(p) && /owner_id/.test(p)), `mass assignment refuses delivery: ${problems.join(' | ')}`);
    waiveAll(store, config, dir);
    assert.strictEqual(store.audit().ok, true, 'audit');
  } finally {
    cleanUp(dir);
  }
});

test('SQL built by concatenation: the boolean differential flags the search though it never errors', { skip }, () => {
  const { dir, store, config } = makeProject(broken(SEARCH_SAFE, SEARCH_CONCAT));
  try {
    security.matrix(store, config, 'backend-engineer', {});
    security.idor(store, config, 'backend-engineer', {});
    const inp = security.input(store, config, 'backend-engineer', {});
    const probe = inp.probes.find((p) => p.kind === 'sql');
    assert.ok(probe && probe.flagged, `the sql probe is flagged: ${JSON.stringify(inp.probes)}`);
    assert.strictEqual(probe.status, 200, 'the injected query succeeded (no 5xx to catch)');
    assert.match(probe.evidence, /boolean differential: the tautology returned \d+ row\(s\) where the false condition returned 0/);
    assert.ok(probe.differential.some((d) => d.flagged), `a pair told the conditions apart: ${JSON.stringify(probe.differential)}`);

    const problems = security.deliveryProblems(store.state(), dir);
    assert.ok(problems.some((p) => /input probe sql on GET \/search \(q\) took effect/.test(p)), `the injection refuses delivery: ${problems.join(' | ')}`);
    waiveAll(store, config, dir);
    assert.strictEqual(store.audit().ok, true, 'audit');
  } finally {
    cleanUp(dir);
  }
});
