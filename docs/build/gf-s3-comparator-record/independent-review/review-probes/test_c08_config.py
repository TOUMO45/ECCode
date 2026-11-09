"""Class 8: config bounds and clean-checkout startup."""
import subprocess
import sys
import time
from datetime import datetime, timezone

import httpx
import pytest

from conftest import PW, TREE, H, uniq


@pytest.mark.parametrize("ttl", ["1", "60", "86400", "31536000", "3153600000"])
def test_ttl_reasonable_values_login_ok(client, monkeypatch, ttl):
    monkeypatch.setenv("TOKEN_TTL_SECONDS", ttl)
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    r = client.post("/v1/login", json={"email": e, "password": PW})
    assert r.status_code == 200


@pytest.mark.parametrize("ttl", ["300000000000", "99999999999999", str(10**20), str(2**63)])
def test_ttl_huge_values_never_500(client, monkeypatch, ttl):
    monkeypatch.setenv("TOKEN_TTL_SECONDS", ttl)
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    r = client.post("/v1/login", json={"email": e, "password": PW})
    assert r.status_code == 200, (ttl, r.status_code, r.text[:80])
    assert client.get("/v1/tasks", headers=H(r.json()["access_token"])).status_code == 200


@pytest.mark.parametrize("ttl", ["abc", "", "  ", "0", "-5", "1.5", "1e3", "86400s", "١٢"])
def test_ttl_nonnumeric_or_nonpositive_falls_back_to_default(client, monkeypatch, ttl, db_path):
    import sqlite3
    monkeypatch.setenv("TOKEN_TTL_SECONDS", ttl)
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    r = client.post("/v1/login", json={"email": e, "password": PW})
    assert r.status_code == 200
    con = sqlite3.connect(db_path)
    c, x = con.execute("select created_at, expires_at from auth_tokens order by id desc limit 1").fetchone()
    con.close()
    delta = (datetime.fromisoformat(x) - datetime.fromisoformat(c)).total_seconds()
    print(f"TTL={ttl!r} -> {delta}s")
    assert delta == 86400 or ttl == "١٢"


def test_ttl_one_second_live(live, tmp_path):
    s = live(DATABASE_URL=f"sqlite:///{tmp_path}/ttl.db", TOKEN_TTL_SECONDS="1")
    e = uniq()
    httpx.post(s.base + "/v1/register", json={"email": e, "password": PW})
    t = httpx.post(s.base + "/v1/login", json={"email": e, "password": PW}).json()["access_token"]
    assert httpx.get(s.base + "/v1/tasks", headers=H(t)).status_code == 200
    time.sleep(1.5)
    assert httpx.get(s.base + "/v1/tasks", headers=H(t)).status_code == 401


def test_clean_checkout_no_env_db_in_tempdir(live, tmp_path):
    co = tmp_path / "checkout"
    co.mkdir()
    subprocess.run(f"git -C {TREE} archive HEAD | tar -x -C {co}", shell=True, check=True)
    tmpdir = tmp_path / "systmp"
    tmpdir.mkdir()
    s = live(cwd=co, TMPDIR=str(tmpdir))
    e = uniq()
    assert httpx.post(s.base + "/v1/register", json={"email": e, "password": PW}).status_code == 201
    t = httpx.post(s.base + "/v1/login", json={"email": e, "password": PW}).json()["access_token"]
    assert httpx.post(s.base + "/v1/tasks", json={"title": "x"}, headers=H(t)).status_code == 201
    print("tmpdir files:", sorted(p.name for p in tmpdir.iterdir()), "checkout db files:", sorted(p.name for p in co.rglob("*.db")))
    assert (tmpdir / "task_tracker.db").exists()
    assert not (co / "app.db").exists() and not list(co.rglob("*.db"))


def test_default_url_function():
    out = subprocess.run([sys.executable, "-I", "-c",
                          f"import sys,tempfile;sys.path.insert(0,{str(TREE)!r});from app.config import database_url;print(database_url(), tempfile.gettempdir())"],
                         capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    print(out.stdout.strip())
    url, tmp = out.stdout.split()
    assert url.startswith("sqlite:///" + tmp) and "app.db" not in url


def test_default_db_file_permissions_and_preseed(live, tmp_path):
    """Default DB lives at a fixed, predictable name in the shared temp dir."""
    import hashlib
    import os
    import sqlite3
    import stat
    tmpdir = tmp_path / "systmp2"
    tmpdir.mkdir()
    s = live(TMPDIR=str(tmpdir))
    httpx.post(s.base + "/v1/register", json={"email": uniq(), "password": PW})
    s.stop()
    db = tmpdir / "task_tracker.db"
    mode = stat.S_IMODE(os.stat(db).st_mode)
    print("default db:", db.name, "mode:", oct(mode))
    # simulate a file planted by someone else before the service starts: seeded admin + known token
    con = sqlite3.connect(db)
    con.execute("insert into users(email,password_hash,role,created_at) values('planted@evil.test','x','admin','2026-01-01 00:00:00')")
    uid = con.execute("select id from users where email='planted@evil.test'").fetchone()[0]
    con.execute("insert into auth_tokens(token_hash,user_id,created_at,expires_at) values(?,?,?,?)",
                (hashlib.sha256(b"planted-token").hexdigest(), uid, "2026-01-01 00:00:00", "2999-01-01 00:00:00"))
    con.commit()
    con.close()
    s2 = live(TMPDIR=str(tmpdir))
    r = httpx.get(s2.base + "/v1/tasks", headers=H("planted-token"))
    print("planted admin token on restart:", r.status_code)
    assert not (mode & 0o004), f"default DB is world-readable: {oct(mode)}"
