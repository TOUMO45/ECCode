"""Live uvicorn probes: duplicate-email race, admin race, write contention, clean startup."""
import collections
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from conftest import CLONE

PY = sys.executable


def _start(port, env, cwd):
    p = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                          "--port", str(port), "--log-level", "warning"], cwd=cwd, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            httpx.get(base + "/v1/tasks", timeout=0.5)
            return p, base
        except httpx.HTTPError:
            time.sleep(0.1)
    p.kill()
    raise RuntimeError(p.stdout.read().decode())


@pytest.fixture(scope="module")
def server():
    d = tempfile.mkdtemp(prefix="probe-race-")
    env = {"PATH": os.environ["PATH"], "DATABASE_URL": f"sqlite:///{d}/race.db",
           "ADMIN_EMAIL": "admin@example.com"}
    p, base = _start(18090, env, str(CLONE))
    yield base
    p.terminate()
    p.wait(5)


def _par(fn, args, n=24):
    with ThreadPoolExecutor(n) as ex:
        return list(ex.map(fn, args))


def test_duplicate_email_race(server):
    variants = ["race@example.com", "Race@example.com", "RACE@EXAMPLE.COM", " race@example.com"]
    bodies = [variants[i % 4] for i in range(24)]
    rs = _par(lambda e: httpx.post(server + "/v1/register", json={"email": e,
                                   "password": "password-123"}, timeout=30), bodies)
    c = collections.Counter(r.status_code for r in rs)
    print("dup race:", c)
    assert c[201] == 1 and c[409] == 23, c


def test_admin_race(server):
    variants = ["admin@example.com", "Admin@Example.com", "ADMIN@example.com "]
    rs = _par(lambda e: httpx.post(server + "/v1/register", json={"email": e,
                                   "password": "password-123"}, timeout=30),
              [variants[i % 3] for i in range(24)])
    roles = [r.json()["role"] for r in rs if r.status_code == 201]
    c = collections.Counter(r.status_code for r in rs)
    print("admin race:", c, roles)
    assert roles == ["admin"] and c[409] == 23


def test_write_contention(server):
    httpx.post(server + "/v1/register", json={"email": "w@example.com",
                                             "password": "password-123"})
    rs = _par(lambda _: httpx.post(server + "/v1/login", json={"email": "w@example.com",
                                   "password": "password-123"}, timeout=30), range(24))
    c = collections.Counter(r.status_code for r in rs)
    print("login contention:", c)
    assert c[200] == 24, c
    tok = rs[0].json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    rs = _par(lambda i: httpx.post(server + "/v1/tasks", json={"title": f"t{i}"}, headers=h,
                                   timeout=30), range(48))
    c = collections.Counter(r.status_code for r in rs)
    print("create contention:", c)
    assert c[201] == 48
    ids = [t["id"] for t in httpx.get(server + "/v1/tasks", headers=h).json()]
    assert ids == sorted(ids) and len(ids) == 48


def test_clean_checkout_startup(tmp_path):
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path)}
    before = set(pathlib.Path(tempfile.gettempdir()).glob("tasktracker-*.db"))
    p, base = _start(18091, env, str(CLONE))
    try:
        r = httpx.post(base + "/v1/register", json={"email": "admin@example.com",
                                                    "password": "password-123"})
        assert r.status_code == 201 and r.json()["role"] == "user"
        tok = httpx.post(base + "/v1/login", json={"email": "admin@example.com",
                                                   "password": "password-123"}).json()
        h = {"Authorization": f"Bearer {tok['access_token']}"}
        assert httpx.post(base + "/v1/tasks", json={"title": "x"}, headers=h).status_code == 201
        assert httpx.get(base + "/v1/tasks").status_code == 401
    finally:
        p.terminate()
        p.wait(5)
    assert not (CLONE / "app.db").exists()
    after = set(pathlib.Path(tempfile.gettempdir()).glob("tasktracker-*.db"))
    assert after - before, "no scratch db in temp dir"
