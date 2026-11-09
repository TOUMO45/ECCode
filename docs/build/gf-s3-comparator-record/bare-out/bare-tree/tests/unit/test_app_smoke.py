import os
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_default_database_url_is_in_tempdir(monkeypatch, tmp_path):
    import tempfile

    from app import config

    monkeypatch.delenv("DATABASE_URL", raising=False)
    url = config.database_url()
    assert url.startswith("sqlite:///")
    path = Path(url.removeprefix("sqlite:///"))
    assert path.parent == Path(tempfile.gettempdir())
    assert path.resolve() != (ROOT / "app.db").resolve()


def test_uvicorn_starts_with_no_env(tmp_path):
    port = free_port()
    env = {"PATH": os.environ.get("PATH", ""), "TMPDIR": str(tmp_path)}  # nothing else: no DATABASE_URL etc.
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                if httpx.get(f"{base}/v1/tasks").status_code == 401:
                    break
            except httpx.TransportError:
                time.sleep(0.1)
        else:
            raise AssertionError("server did not start")
        r = httpx.post(f"{base}/v1/register", json={"email": "smoke@example.com", "password": "correct-horse-1"})
        assert r.status_code == 201
        assert r.json()["role"] == "user"
        tok = httpx.post(f"{base}/v1/login", json={"email": "smoke@example.com", "password": "correct-horse-1"})
        h = {"Authorization": f"Bearer {tok.json()['access_token']}"}
        assert httpx.post(f"{base}/v1/tasks", json={"title": "t"}, headers=h).status_code == 201
        assert httpx.post(f"{base}/v1/logout", headers=h).status_code == 204
    finally:
        proc.terminate()
        out = proc.communicate(timeout=10)[0].decode()
    db = tmp_path / "task_tracker.db"
    assert db.exists(), out
    assert not (ROOT / "app.db").exists()
    tables = {r[0] for r in sqlite3.connect(db).execute("select name from sqlite_master where type='table'")}
    assert {"users", "auth_tokens", "tasks", "alembic_version"} <= tables
