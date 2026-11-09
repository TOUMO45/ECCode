"""Orchestrator reproduction of reviewer findings B-3, B-7, B-9, B-10. usage: python repro-review.py <tree>"""
import os, subprocess, sys, tempfile, time, socket, stat, glob
import httpx
TREE = sys.argv[1]; PY = sys.executable
def start(env_extra, nodb=False):
    d = tempfile.mkdtemp(); s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ("ECCODE_SEED_KEY", "DATABASE_URL", "ADMIN_EMAIL", "TOKEN_TTL_SECONDS")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if not nodb: env["DATABASE_URL"] = f"sqlite:///{d}/r.db"
    env.update(env_extra)
    p = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--port", str(port)], cwd=TREE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try: httpx.get(base + "/v1/tasks", timeout=0.5); break
        except httpx.HTTPError: time.sleep(0.05)
    return p, base
def req(base, m, path, **kw):
    try:
        with httpx.Client(base_url=base, timeout=30) as c: r = c.request(m, path, **kw); return f"{r.status_code} len={len(r.content)} {r.text[:70]!r}"
    except httpx.HTTPError as e: return "TRANSPORT " + type(e).__name__
p, b = start({})
deep = ('{"a":' * 5000 + '1' + '}' * 5000).encode()
print("B-3 anon POST /v1/login 5000-deep object ->", req(b, "POST", "/v1/login", content=deep, headers={"content-type": "application/json"}))
print("B-3 anon POST /v1/register 5000-deep object ->", req(b, "POST", "/v1/register", content=deep, headers={"content-type": "application/json"}))
with httpx.Client(base_url=b) as c:
    c.post("/v1/register", json={"email": "o@example.com", "password": "password-123"})
    h = {"Authorization": "Bearer " + c.post("/v1/login", json={"email": "o@example.com", "password": "password-123"}).json()["access_token"]}
    c.post("/v1/tasks", json={"title": "t"}, headers=h)
for raw in ("1", "+1", "01", "1.0", "%201", "1_0"):
    print(f"B-7 owner GET /v1/tasks/{raw} ->", req(b, "GET", f"/v1/tasks/{raw}", headers=h))
print("B-10 POST /v1/tasks 5MB title ->", req(b, "POST", "/v1/tasks", json={"title": "x" * 5_000_000}, headers=h)[:30])
p.terminate()
tmp = tempfile.gettempdir(); before = set(glob.glob(tmp + "/*.db"))
p, b = start({}, nodb=True); req(b, "POST", "/v1/register", json={"email": "z@example.com", "password": "password-123"}); p.terminate(); p.wait(5)
new = sorted(set(glob.glob(tmp + "/*.db")) - before) or sorted(glob.glob(tmp + "/*task*.db"))
for f in new: print("B-9 default db:", os.path.basename(f), "mode", oct(stat.S_IMODE(os.stat(f).st_mode)))
