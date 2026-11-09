import itertools
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

TREE = Path("/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree")
PY = "/root/.cache/eccode/phase3-venv/bin/python"
sys.path.insert(0, str(TREE))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import create_app  # noqa: E402

ADMIN = "boss@example.com"
PW = "correct-horse-1"
_n = itertools.count()


def uniq(prefix="u"):
    return f"{prefix}{next(_n)}_{os.getpid()}@example.com"


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "probe.db"


@pytest.fixture
def client(db_path, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", ADMIN)
    monkeypatch.delenv("TOKEN_TTL_SECONDS", raising=False)
    with TestClient(create_app(f"sqlite:///{db_path}"), raise_server_exceptions=False) as c:
        yield c


def reg(c, email=None, pw=PW):
    email = email or uniq()
    r = c.post("/v1/register", json={"email": email, "password": pw})
    assert r.status_code == 201, r.text
    return r.json()


def tok(c, email, pw=PW):
    r = c.post("/v1/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def H(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture
def mk(client):
    def _mk(email=None):
        u = reg(client, email)
        u["h"] = H(tok(client, u["email"]))
        return u
    return _mk


@pytest.fixture
def alice(mk):
    return mk()


@pytest.fixture
def bob(mk):
    return mk()


@pytest.fixture
def admin(mk):
    u = mk(ADMIN)
    assert u["role"] == "admin"
    return u


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Live:
    def __init__(self, cwd, env, port):
        self.base = f"http://127.0.0.1:{port}"
        self.proc = subprocess.Popen(
            [PY, "-m", "uvicorn", "app.main:app", "--port", str(port), "--log-level", "warning"],
            cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("server exited: " + self.proc.stdout.read().decode())
            try:
                httpx.get(self.base + "/v1/tasks", timeout=1)
                return
            except httpx.HTTPError:
                time.sleep(0.2)
        raise RuntimeError("server did not start")

    def stop(self):
        self.proc.terminate()
        try:
            out, _ = self.proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            out, _ = self.proc.communicate()
        return out.decode(errors="replace")


def base_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in ("DATABASE_URL", "ADMIN_EMAIL", "TOKEN_TTL_SECONDS")}
    env.update(extra)
    return env


@pytest.fixture
def live(tmp_path):
    servers = []

    def _start(cwd=TREE, **env):
        s = Live(cwd, base_env(**env), free_port())
        servers.append(s)
        return s
    yield _start
    for s in servers:
        s.stop()
