'use strict';
// Security guard (Phase 3, Part C) against a small, self-contained FastAPI app:
// the access matrix agrees with the declared policy and the IDOR probes pass on
// the safe app; a one-line break (the owner check removed from GET
// /notes/{note_id}) makes a member read another member's note, which the IDOR
// probe flags and delivery refuses. Every request goes to the app under test
// through FastAPI's TestClient with the network closed. Needs an interpreter
// with fastapi and httpx (ECCODE_PYTHON); without one these tests skip and say
// so, and fail instead when ECCODE_REQUIRE_PHASE3=1 (CI).
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
// /admin/stats is admin-only; /search uses an in-memory substring match (no SQL).
const OWNER_CHECK = `    if note["owner"] != user["id"]:
        raise HTTPException(status_code=404, detail="not found")
`;
const APP = `from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="notes")

TOKENS = {
    "tok-a": {"id": "a", "role": "member"},
    "tok-b": {"id": "b", "role": "member"},
    "tok-admin": {"id": "admin", "role": "admin"},
}
NOTES = {}
_next = {"id": 1}


class NewNote(BaseModel):
    text: str


def user_of(authorization):
    if not authorization:
        return None
    token = authorization.replace("Bearer ", "").strip()
    return TOKENS.get(token)


@app.post("/notes", status_code=201)
def create_note(note: NewNote, authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    nid = _next["id"]
    _next["id"] += 1
    NOTES[nid] = {"id": nid, "owner": user["id"], "text": note.text}
    return NOTES[nid]


@app.get("/notes")
def list_notes(authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return {"items": [n for n in NOTES.values() if n["owner"] == user["id"]]}


@app.get("/notes/{note_id}")
def get_note(note_id: int, authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    note = NOTES.get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="not found")
${OWNER_CHECK}    return note


@app.get("/admin/stats")
def admin_stats(authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return {"notes": len(NOTES)}


@app.get("/search")
def search(q: str = "", authorization: str | None = Header(default=None)):
    user = user_of(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    hits = [n for n in NOTES.values() if q and q in n["text"] and n["owner"] == user["id"]]
    return {"query": q, "count": len(hits)}
`;

const ROLES = [
  { name: 'member-a', level: 1, headers: { Authorization: 'Bearer tok-a' } },
  { name: 'member-b', level: 1, headers: { Authorization: 'Bearer tok-b' } },
  { name: 'admin', level: 2, headers: { Authorization: 'Bearer tok-admin' } },
  { name: 'anonymous', level: 0, headers: {} },
];

const ID_EP = 'GET /notes/{note_id}';
const NONE_EPS = ['GET /notes', 'POST /notes', 'GET /admin/stats', 'GET /search'];

function expectedFor(role, endpoint, ownership) {
  const auth = role.level > 0;
  if (endpoint === ID_EP) return ownership === 'own' ? (auth ? 'allow' : 'deny') : 'deny';
  if (endpoint === 'GET /admin/stats') return role.level >= 2 ? 'allow' : 'deny';
  return auth ? 'allow' : 'deny';
}

function policyCells() {
  const cells = [];
  for (const role of ROLES) {
    for (const ownership of ['own', 'other', 'none']) cells.push({ role: role.name, endpoint: ID_EP, ownership, expected: expectedFor(role, ID_EP, ownership) });
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
  ],
  policy: policyCells(),
  inputs: [{ endpoint: 'GET /search', param: 'q', in: 'query', kind: 'sql' }],
};

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-security-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.py'), APP);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'safe app'], { cwd: dir });
  const store = init(dir, { name: 'notes', idea: 'access control demo', track: 'fix' });
  const config = loadConfig(dir);
  fs.writeFileSync(path.join(dir, '.eccode', 'behavior.json'), JSON.stringify({ app: 'app:app', roles: [{ name: 'anonymous', headers: {} }] }, null, 2));
  fs.writeFileSync(path.join(dir, '.eccode', 'security.json'), JSON.stringify(SECURITY_JSON, null, 2));
  return { dir, store, config };
}

test('the safe app: the access matrix agrees with the declared policy and the IDOR probes pass', { skip }, () => {
  const { dir, store, config } = makeProject();
  try {
    // A reviewer declares the policy; the matrix then has endpoints to probe.
    security.policy(store, config, 'security-reviewer', policyCells());
    const mx = security.matrix(store, config, 'backend-engineer', {});
    assert.strictEqual(mx.unexplained, 0, `matrix disagreements: ${JSON.stringify(mx.cells.filter((c) => c.match === false))} notes ${mx.notes.join('; ')}`);
    assert.strictEqual(mx.unknown, 0, `undeclared cells: ${JSON.stringify(mx.cells.filter((c) => c.expected === null).slice(0, 3))}`);
    assert.ok(mx.cells.length >= ROLES.length * 3, `cells: ${mx.cells.length}`);

    const idor = security.idor(store, config, 'backend-engineer', {});
    assert.ok(idor.probes.length > 0, `idor ran probes (notes ${idor.notes.join('; ')})`);
    assert.strictEqual(idor.unexplained, 0, `idor leaks on the safe app: ${JSON.stringify(idor.probes.filter((p) => p.fail))}`);

    const inp = security.input(store, config, 'backend-engineer', {});
    assert.strictEqual(inp.flagged, 0, `input probe flagged on the safe app: ${JSON.stringify(inp.probes.filter((p) => p.flagged))}`);

    // Nothing blocks delivery on the clean tree.
    assert.deepStrictEqual(security.deliveryProblems(store.state(), dir), []);
    assert.strictEqual(store.audit().ok, true, 'audit');
    assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a removed owner check: the IDOR probe flags the leak and delivery refuses', { skip }, () => {
  const { dir, store, config } = makeProject();
  try {
    security.policy(store, config, 'security-reviewer', policyCells());
    // The one-line break: remove the owner check from GET /notes/{note_id}.
    const broken = APP.replace(OWNER_CHECK, '');
    assert.notStrictEqual(broken, APP, 'the owner check was removed');
    fs.writeFileSync(path.join(dir, 'app.py'), broken);

    // The change now touches a route with ownership: the guard is required.
    const req = guards.requiredFor(dir, store.state());
    assert.ok(req.required.includes('security'), `security required: ${JSON.stringify(req.reasons)}`);

    const mx = security.matrix(store, config, 'backend-engineer', {});
    const idor = security.idor(store, config, 'backend-engineer', {});
    // A member reads another member's note: 200 with the owner's content.
    const leak = idor.probes.find((p) => p.fail && p.relationship === 'peer');
    assert.ok(leak, `expected a peer IDOR leak, got ${JSON.stringify(idor.probes.map((p) => ({ as: p.as, rel: p.relationship, status: p.status, fail: p.fail })))}`);
    assert.strictEqual(leak.status, 200, 'the non-owner got 200');
    assert.ok(leak.leaked.length > 0, `leaked fields: ${JSON.stringify(leak.leaked)}`);
    assert.ok(idor.unexplained > 0, 'idor flags at least one leak');
    assert.ok(mx.unexplained > 0, `matrix flags the "other" cells now returning allow: ${JSON.stringify(mx.cells.filter((c) => c.match === false).map((c) => `${c.role} ${c.endpoint} ${c.ownership}`))}`);

    const problems = security.deliveryProblems(store.state(), dir);
    assert.ok(problems.length > 0, 'delivery refuses');
    assert.ok(problems.some((p) => /IDOR|reaches .*object/.test(p)), `an IDOR problem is reported: ${problems.join(' | ')}`);

    // A reviewer can waive every reported finding (matrix cells and IDOR probes), and then delivery is clean.
    const freshMx = store.state().guards.security.matrix.slice(-1)[0];
    const freshId = store.state().guards.security.idor.slice(-1)[0];
    for (const c of freshMx.cells.filter((x) => x.match === false)) guards.waive(store, config, 'security-reviewer', { guard: 'security', result: freshMx.id, finding: `${c.role} ${c.endpoint} ${c.ownership}`, reason: 'accepted for this access-control guard test only' });
    for (const p of freshId.probes.filter((x) => x.fail)) guards.waive(store, config, 'security-reviewer', { guard: 'security', result: freshId.id, finding: `${p.endpoint} as ${p.as}`, reason: 'accepted for this access-control guard test only' });
    assert.deepStrictEqual(security.deliveryProblems(store.state(), dir), [], 'waived findings clear the gate');

    assert.strictEqual(store.audit().ok, true, 'audit');
    assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
