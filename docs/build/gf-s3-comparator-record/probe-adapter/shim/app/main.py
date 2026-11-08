"""Shim create_app(): starts a real uvicorn on the target tree (PROBE_TARGET_TREE) with the settings as env vars,
and returns an ASGI app that forwards every request to it over HTTP. TestClient(create_app(...)) therefore works
unchanged. With no settings it passes the (possibly monkeypatched) os.environ, as the in-process app would read it.
If the target never answers, every request gets 502 {"detail": "probe-adapter: upstream unreachable ..."}."""
import atexit
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

import httpx

TARGET = pathlib.Path(os.environ["PROBE_TARGET_TREE"]).resolve()
PY = sys.executable
LOGDIR = pathlib.Path(os.environ.get("PROBE_SERVER_LOGS") or tempfile.mkdtemp(prefix="probe-srv-logs-"))
LOGDIR.mkdir(parents=True, exist_ok=True)
_PROCS = []
_HOP = {"content-length", "transfer-encoding", "content-encoding", "connection"}


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _env(settings):
    env = {k: v for k, v in os.environ.items() if k != "ECCODE_SEED_KEY" and not k.startswith("PYTEST")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if settings is not None:
        for key, val in (("DATABASE_URL", settings.database_url), ("ADMIN_EMAIL", settings.admin_email),
                         ("TOKEN_TTL_SECONDS", settings.token_ttl_seconds)):
            if val is None:
                env.pop(key, None)
            else:
                env[key] = str(val)
    return env


def kill_all():
    for p in _PROCS:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()


atexit.register(kill_all)


class _Proxy:
    def __init__(self, base, log):
        self.base, self.log = base, log
        self.http = httpx.Client(timeout=30)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                m = await receive()
                if m["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif m["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        raw = scope.get("raw_path") or scope["path"].encode()
        url = self.base + raw.decode("latin-1")
        if scope.get("query_string"):
            url += "?" + scope["query_string"].decode("latin-1")
        # header values are sent with surrounding OWS stripped (RFC 9110 5.5): h11 refuses to emit trailing
        # whitespace, and a real server never receives it (calibration-1 artifact on "Bearer ").
        headers = [(k.decode("latin-1"), v.decode("latin-1").strip(" 	")) for k, v in scope["headers"]
                   if k.lower() not in (b"host", b"content-length")]
        try:
            r = self.http.request(scope["method"], url, headers=headers, content=body)
            status, content = r.status_code, r.content
            out = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in r.headers.multi_items()
                   if k.lower() not in _HOP]
        except httpx.HTTPError as e:
            status = 502
            content = json.dumps({"detail": f"probe-adapter: upstream unreachable: {type(e).__name__} "
                                            f"(server log {self.log})"}).encode()
            out = [(b"content-type", b"application/json")]
        out.append((b"content-length", str(len(content)).encode()))
        await send({"type": "http.response.start", "status": status, "headers": out})
        await send({"type": "http.response.body", "body": content})


def create_app(settings=None):
    port = _free_port()
    log = LOGDIR / f"srv-{port}-{int(time.time() * 1000)}.log"
    fh = open(log, "wb")
    p = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port),
                          "--log-level", "warning"], cwd=TARGET, env=_env(settings), stdout=fh,
                         stderr=subprocess.STDOUT)
    _PROCS.append(p)
    base = f"http://127.0.0.1:{port}"
    for _ in range(300):
        if p.poll() is not None:
            break
        try:
            httpx.get(base + "/v1/tasks", timeout=0.5)
            break
        except httpx.HTTPError:
            time.sleep(0.05)
    return _Proxy(base, str(log))
