"""S3.1 I7 direct check (B-7) on a tree: start `uvicorn app.main:app` from <tree> on a free port, register and log in
an owner, create task 1, then GET /v1/tasks/<id> as the owner and anonymously for canonical and non-canonical ids.
Prints one line per request (status code) and a verdict. usage: python ids-check.py <tree>
Run with `env -u ECCODE_SEED_KEY`; uses a scratch DATABASE_URL in a temp dir.
"""

import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

tree = sys.argv[1]
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
tmp = tempfile.mkdtemp(prefix="ids-check-")
env = {k: v for k, v in os.environ.items() if k not in ("ECCODE_SEED_KEY", "ADMIN_EMAIL", "TOKEN_TTL_SECONDS")}
env.update(DATABASE_URL=f"sqlite:///{tmp}/db.sqlite", PYTHONDONTWRITEBYTECODE="1")
proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                        cwd=tree, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def req(method, path, body=None, token=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"content-type": "application/json"} if body is not None else {}
    if token:
        h["authorization"] = f"Bearer {token}"
    c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, data


try:
    for _ in range(100):
        try:
            req("GET", "/v1/tasks")
            break
        except OSError:
            time.sleep(0.1)
    assert req("POST", "/v1/register", {"email": "owner@example.com", "password": "owner-pass-123"})[0] == 201
    st, data = req("POST", "/v1/login", {"email": "owner@example.com", "password": "owner-pass-123"})
    token = json.loads(data)["access_token"]
    st, data = req("POST", "/v1/tasks", {"title": "one"}, token)
    assert st == 201 and json.loads(data)["id"] == 1, (st, data)
    bad = []
    for raw in ["1", "+1", "01", "1.0", "%201", "%2B1", "-0", "1%20"]:
        st_o, _ = req("GET", f"/v1/tasks/{raw}", token=token)
        st_a, _ = req("GET", f"/v1/tasks/{raw}")
        print(f"GET /v1/tasks/{raw:6s} owner={st_o} anonymous={st_a}")
        if raw != "1" and st_o == 200:
            bad.append(raw)
        if raw == "1" and st_o != 200:
            bad.append("1 (canonical id not 200)")
    print("B-7 PRESENT: non-canonical ids answered 200 for " + ", ".join(bad) if bad else "B-7 ABSENT: only the canonical id 1 answers 200")
finally:
    proc.terminate()
    proc.wait(timeout=10)
