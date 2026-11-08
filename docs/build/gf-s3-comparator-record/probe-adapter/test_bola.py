"""BOLA/IDOR, mass assignment, admin escalation probes."""
import statistics
import time

import pytest

from conftest import hdr, login, make_client, reg, user

STRIP = {"date"}


def _hdrs(r):
    return {k.lower(): v for k, v in r.headers.items() if k.lower() not in STRIP}


def _setup(c):
    a, ha = user(c, "alice@example.com")
    b, hb = user(c, "bob@example.com")
    ta = c.post("/v1/tasks", json={"title": "A secret", "description": "alice-desc"}, headers=ha)
    tb = c.post("/v1/tasks", json={"title": "B secret", "description": "bob-desc"}, headers=hb)
    assert ta.status_code == tb.status_code == 201
    return a, ha, b, hb, ta.json(), tb.json()


def test_cross_user_get_patch_both_directions(client):
    a, ha, b, hb, ta, tb = _setup(client)
    unknown = 999999
    for (h, foreign, owner_h) in ((hb, ta, ha), (ha, tb, hb)):
        g = client.get(f"/v1/tasks/{foreign['id']}", headers=h)
        gu = client.get(f"/v1/tasks/{unknown}", headers=h)
        assert g.status_code == 404 and gu.status_code == 404
        assert g.content == gu.content == b'{"detail":"Task not found"}'
        assert _hdrs(g) == _hdrs(gu)
        for body in ({"title": "pwned"}, {"status": "done"}, {"description": "x"}):
            p = client.patch(f"/v1/tasks/{foreign['id']}", json=body, headers=h)
            pu = client.patch(f"/v1/tasks/{unknown}", json=body, headers=h)
            assert p.status_code == pu.status_code == 404
            assert p.content == pu.content and _hdrs(p) == _hdrs(pu)
        # invalid body: same answer for foreign and unknown (validation before lookup)
        p = client.patch(f"/v1/tasks/{foreign['id']}", json={}, headers=h)
        pu = client.patch(f"/v1/tasks/{unknown}", json={}, headers=h)
        assert p.status_code == pu.status_code == 422 and p.content == pu.content
        after = client.get(f"/v1/tasks/{foreign['id']}", headers=owner_h).json()
        assert after == foreign


def test_list_no_leak_and_admin_sees_all(client):
    a, ha, b, hb, ta, tb = _setup(client)
    la = client.get("/v1/tasks", headers=ha).json()
    lb = client.get("/v1/tasks", headers=hb).json()
    assert [t["id"] for t in la] == [ta["id"]]
    assert [t["id"] for t in lb] == [tb["id"]]
    _, hadm = user(client, "admin@example.com")
    ladm = client.get("/v1/tasks", headers=hadm).json()
    assert [t["id"] for t in ladm] == sorted([ta["id"], tb["id"]])


def test_timing_foreign_vs_unknown(client):
    a, ha, b, hb, ta, tb = _setup(client)

    def med(path):
        xs = []
        for _ in range(40):
            t0 = time.perf_counter()
            client.get(path, headers=hb)
            xs.append(time.perf_counter() - t0)
        return statistics.median(xs)

    f, u = med(f"/v1/tasks/{ta['id']}"), med("/v1/tasks/999999")
    print("timing foreign/unknown median s", f, u)
    assert 0.33 < f / u < 3


@pytest.mark.parametrize("raw", ["0", "-1", "999999", str(2**63 - 1), str(2**63),
                                 str(-(2**63) - 1), "1" + "0" * 30, "9" * 5000])
def test_out_of_range_ids_404(client, raw):
    _, h = user(client, "x@example.com")
    _, hadm = user(client, "admin@example.com")
    for hh in (h, hadm):
        assert client.get(f"/v1/tasks/{raw}", headers=hh).status_code == 404, raw
        assert client.patch(f"/v1/tasks/{raw}", json={"title": "t"},
                            headers=hh).status_code == 404, raw


def test_alternate_id_spellings_never_bypass(client):
    a, ha, b, hb, ta, tb = _setup(client)
    i = ta["id"]
    seen = {}
    for raw in [f"+{i}", f"0{i}", f" {i}", f"{i} ", f"{i}.0", f"{i}e0", "１", f"{i}_0",
                "abc", "1.5", "0x1", "%20", "null", "true"]:
        r = client.get(f"/v1/tasks/{raw}", headers=hb)
        seen[raw] = r.status_code
        assert r.status_code in (404, 422), (raw, r.status_code, r.text)
        assert "A secret" not in r.text
        ro = client.get(f"/v1/tasks/{raw}", headers=ha)
        seen[raw] = (r.status_code, ro.status_code)
    print("alt-id statuses (other, owner):", seen)
    assert client.get("/v1/tasks/abc", headers=hb).status_code == 422


@pytest.mark.parametrize("body", [
    {"owner_id": 2}, {"id": 77}, {"created_at": "2000-01-01T00:00:00Z"}, {"role": "admin"},
    {"title": "ok", "owner_id": 2}, {"title": "ok", "extra": 1}, {"title": {"x": 1}},
    {"title": ["a"]}, {"status": {"v": "done"}}, {"title": None}, {"description": None},
    {"status": None}, {"status": "DONE"}, {"status": "archived"}, {"title": 5},
    {"title": True}, {"description": 3}, {"title": "  "}, {"title": "x" * 201},
    {"description": "x" * 2001}, {}, {"owner": {"id": 2}},
])
def test_patch_mass_assignment(client, body):
    a, ha, b, hb, ta, tb = _setup(client)
    _, hadm = user(client, "admin@example.com")
    for h in (ha, hadm):
        r = client.patch(f"/v1/tasks/{ta['id']}", json=body, headers=h)
        assert r.status_code == 422, (body, r.status_code, r.text)
    assert client.get(f"/v1/tasks/{ta['id']}", headers=ha).json() == ta


def test_patch_non_object_bodies(client):
    a, ha, b, hb, ta, tb = _setup(client)
    for raw in (b"[]", b'"x"', b"1", b"null", b'[{"title":"x"}]'):
        r = client.patch(f"/v1/tasks/{ta['id']}", content=raw, headers={
            **ha, "content-type": "application/json"})
        assert r.status_code == 422, (raw, r.status_code, r.text)
    assert client.get(f"/v1/tasks/{ta['id']}", headers=ha).json() == ta


@pytest.mark.parametrize("body", [
    {"title": "t", "owner_id": 1}, {"title": "t", "status": "done"}, {"title": "t", "id": 5},
    {"title": "t", "created_at": "2000-01-01T00:00:00Z"},
])
def test_create_mass_assignment(client, body):
    _, h = user(client, "x@example.com")
    assert client.post("/v1/tasks", json=body, headers=h).status_code == 422
    assert client.get("/v1/tasks", headers=h).json() == []


@pytest.mark.parametrize("extra", [{"role": "admin"}, {"is_admin": True}, {"id": 1},
                                   {"user": {"role": "admin"}}])
def test_register_escalation(client, extra):
    r = client.post("/v1/register", json={"email": "m@example.com", "password": "password-123",
                                          **extra})
    assert r.status_code == 422
    assert reg(client, "m@example.com").json()["role"] == "user"


def test_admin_email_variants(tmp_path):
    c, _ = make_client(tmp_path, admin="admin@example.com")
    # lookalikes must be distinct non-admin accounts (or rejected)
    looks = ["admin@examplе.com", "ａdmin@example.com", "admin@example.com​",
             "admin@example.com.", "admin+x@example.com", "admin@example.co"]
    for e in looks:
        r = reg(c, e)
        assert r.status_code in (201, 422), (e, r.text)
        if r.status_code == 201:
            assert r.json()["role"] == "user", e
    r = reg(c, "  ADMIN@Example.COM \t")
    assert r.status_code == 201 and r.json() == {"id": r.json()["id"],
                                                 "email": "admin@example.com", "role": "admin"}
    for e in ("admin@example.com", "Admin@EXAMPLE.com", " admin@example.com"):
        assert reg(c, e).status_code == 409


def test_kelvin_sign_case_fold(tmp_path):
    c, _ = make_client(tmp_path, admin="kate@example.com")
    r = reg(c, "Kate@example.com")
    print("kelvin register:", r.status_code, r.text)
    if r.status_code == 201 and r.json()["role"] == "admin":
        # only acceptable if it is the very same account (stored email == ADMIN_EMAIL)
        assert r.json()["email"] == "kate@example.com"
        assert reg(c, "kate@example.com").status_code == 409


def test_admin_env_variants(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path/'e.db'}")
    monkeypatch.setenv("ADMIN_EMAIL", "  Boss@Example.COM\n")
    c = TestClient(create_app(), raise_server_exceptions=False)
    assert reg(c, "boss@example.com").json()["role"] == "admin"
    assert reg(c, "other@example.com").json()["role"] == "user"
    monkeypatch.setenv("ADMIN_EMAIL", "")
    assert reg(c, "new@example.com").json()["role"] == "user"


def test_no_admin_when_unset(tmp_path):
    c, _ = make_client(tmp_path, admin=None)
    assert reg(c, "admin@example.com").json()["role"] == "user"


def test_admin_powers_exact(client):
    a, ha, b, hb, ta, tb = _setup(client)
    adm, hadm = user(client, "admin@example.com")
    assert adm["role"] == "admin"
    assert client.get(f"/v1/tasks/{ta['id']}", headers=hadm).json() == ta
    r = client.patch(f"/v1/tasks/{ta['id']}", json={"status": "done", "title": "adm"},
                     headers=hadm)
    assert r.status_code == 200
    j = r.json()
    assert j["owner_id"] == a["id"] and j["status"] == "done" and j["title"] == "adm"
    assert j["created_at"] == ta["created_at"] and j["id"] == ta["id"]
    assert client.get(f"/v1/tasks/{ta['id']}", headers=ha).json() == j
    assert client.get("/v1/tasks/999999", headers=hadm).status_code == 404
    # admin-created task belongs to admin, invisible to alice
    t = client.post("/v1/tasks", json={"title": "adm task"}, headers=hadm).json()
    assert t["owner_id"] == adm["id"]
    assert client.get(f"/v1/tasks/{t['id']}", headers=ha).status_code == 404


def test_token_reuse_across_users(client):
    a, ha, b, hb, ta, tb = _setup(client)
    tok_b = hb["Authorization"].split()[1]
    lr = login(client, "alice@example.com")
    assert lr.json()["access_token"] != tok_b
    assert client.get(f"/v1/tasks/{ta['id']}", headers=hdr(tok_b)).status_code == 404
