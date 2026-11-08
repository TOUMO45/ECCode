"""Authentication / session probes."""
import base64
import sqlite3
import statistics
import time

import pytest

from conftest import PW, hdr, login, make_client, reg, user

PROTECTED = [("post", "/v1/logout", None), ("get", "/v1/tasks", None),
             ("post", "/v1/tasks", {"title": "t"}), ("get", "/v1/tasks/1", None),
             ("patch", "/v1/tasks/1", {"title": "t"})]


def _call(c, m, p, body, headers):
    kw = {"headers": headers}
    if body is not None:
        kw["json"] = body
    return getattr(c, m)(p, **kw)


def _assert_401(r):
    assert r.status_code == 401, (r.status_code, r.text)
    assert isinstance(r.json(), dict) and "detail" in r.json()


def test_logout_semantics(client):
    _, h1 = user(client, "a@example.com")
    t2 = login(client, "a@example.com").json()["access_token"]
    client.post("/v1/tasks", json={"title": "t"}, headers=h1)
    r = client.post("/v1/logout", headers=h1)
    assert r.status_code == 204 and r.content == b""
    for m, p, b in PROTECTED:
        _assert_401(_call(client, m, p, b, h1))
    assert client.get("/v1/tasks", headers=hdr(t2)).status_code == 200


def test_logout_only_presented_token(client):
    _, ha = user(client, "a@example.com")
    _, hb = user(client, "b@example.com")
    assert client.post("/v1/logout", headers=hb).status_code == 204
    assert client.get("/v1/tasks", headers=ha).status_code == 200


@pytest.mark.parametrize("val", ["", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Token {t}",
                                 "Bearer {t} extra", "{t}", "Bearer{t}", "Bearer x{t}",
                                 "Bearer " + "A" * 600, "Bearer {t}x", "Bearer {T}"])
def test_malformed_auth_headers(client, val):
    _, h = user(client, "a@example.com")
    t = h["Authorization"].split()[1]
    v = val.replace("{t}", t).replace("{T}", t.upper())
    for m, p, b in PROTECTED:
        _assert_401(_call(client, m, p, b, {"Authorization": v}))


def test_scheme_case_insensitive(client):
    _, h = user(client, "a@example.com")
    t = h["Authorization"].split()[1]
    for v in (f"bearer {t}", f"BEARER {t}", f"Bearer   {t}"):
        assert client.get("/v1/tasks", headers={"Authorization": v}).status_code == 200


def test_expiry_settings(tmp_path):
    c, _ = make_client(tmp_path, ttl=1)
    _, h = user(c, "a@example.com")
    assert c.get("/v1/tasks", headers=h).status_code == 200
    time.sleep(1.3)
    for m, p, b in PROTECTED:
        _assert_401(_call(c, m, p, b, h))


def test_expiry_env(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path/'e.db'}")
    monkeypatch.setenv("TOKEN_TTL_SECONDS", "1")
    c = TestClient(create_app(), raise_server_exceptions=False)
    _, h = user(c, "a@example.com")
    time.sleep(1.3)
    _assert_401(c.get("/v1/tasks", headers=h))


@pytest.mark.parametrize("ttl", ["1000000000000", "99999999999999999999"])
def test_huge_ttl_env_login(tmp_path, monkeypatch, ttl):
    from fastapi.testclient import TestClient

    from app.main import create_app
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path/'h.db'}")
    monkeypatch.setenv("TOKEN_TTL_SECONDS", ttl)
    c = TestClient(create_app(), raise_server_exceptions=False)
    assert reg(c, "a@example.com").status_code == 201
    r = login(c, "a@example.com")
    print("huge ttl", ttl, r.status_code, r.text)
    assert r.status_code == 200, (r.status_code, r.text)


def test_login_enumeration_and_timing(client):
    user(client, "a@example.com")
    r1 = login(client, "a@example.com", "wrong-password")
    r2 = login(client, "nobody@example.com", "wrong-password")
    r3 = login(client, "not-an-email", "wrong-password")
    assert r1.status_code == r2.status_code == r3.status_code == 401
    assert r1.content == r2.content == r3.content
    assert dict(r1.headers) | {"date": ""} == dict(r2.headers) | {"date": ""}

    def med(email):
        xs = []
        for _ in range(8):
            t0 = time.perf_counter()
            login(client, email, "wrong-password")
            xs.append(time.perf_counter() - t0)
        return statistics.median(xs)

    k, u = med("a@example.com"), med("nobody@example.com")
    print("login timing known/unknown", k, u)
    assert 0.5 < k / u < 2


def test_storage(tmp_path):
    c, path = make_client(tmp_path)
    secret = "Unique-Plain-Pw-9"
    reg(c, "a@example.com", secret)
    reg(c, "b@example.com", secret)
    tok = login(c, "a@example.com", secret).json()["access_token"]
    assert len(base64.urlsafe_b64decode(tok + "=" * (-len(tok) % 4))) >= 32
    con = sqlite3.connect(path)
    rows = con.execute("select email, password_hash from users order by id").fetchall()
    h1, h2 = rows[0][1], rows[1][1]
    assert h1 != h2
    for h in (h1, h2):
        scheme, n, r, p, salt, dig = h.split("$")
        assert (scheme, n, r, p) == ("scrypt", "16384", "8", "1")
        assert len(base64.b64decode(salt)) == 16 and len(base64.b64decode(dig)) == 32
    import hashlib
    th = con.execute("select token_hash from auth_tokens").fetchall()
    assert th == [(hashlib.sha256(tok.encode()).hexdigest(),)]
    con.close()
    raw = path.read_bytes()
    for wal in (path.with_name(path.name + "-wal"), path.with_name(path.name + "-journal")):
        if wal.exists():
            raw += wal.read_bytes()
    assert secret.encode() not in raw and tok.encode() not in raw


def test_logout_twice_and_expired_logout(tmp_path):
    c, _ = make_client(tmp_path, ttl=1)
    _, h = user(c, "a@example.com")
    time.sleep(1.3)
    _assert_401(c.post("/v1/logout", headers=h))


def test_login_returns_distinct_tokens(client):
    reg(client, "a@example.com")
    t1 = login(client, "a@example.com").json()
    t2 = login(client, "A@EXAMPLE.COM ").json()
    assert t1["token_type"] == "bearer" and t1["access_token"] != t2["access_token"]
    for t in (t1, t2):
        assert client.get("/v1/tasks", headers=hdr(t["access_token"])).status_code == 200
    assert login(client, "a@example.com", PW + " ").status_code == 401
