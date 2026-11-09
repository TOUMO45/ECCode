"""Manual reproduction of R-1..R-5 and the additional candidates on a target tree, over a live uvicorn.
usage: python repro.py <tree>   (prints one line per case: id, request, status, body excerpt)"""
import os, subprocess, sys, tempfile, time, socket
import httpx
TREE = sys.argv[1]; PY = sys.executable

def start(extra):
    d = tempfile.mkdtemp(prefix="repro-"); s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ("ECCODE_SEED_KEY", "DATABASE_URL", "ADMIN_EMAIL", "TOKEN_TTL_SECONDS")}
    env.update({"DATABASE_URL": f"sqlite:///{d}/r.db", "PYTHONDONTWRITEBYTECODE": "1", **extra})
    p = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--port", str(port)], cwd=TREE, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try: httpx.get(base + "/v1/tasks", timeout=0.5); break
        except httpx.HTTPError: time.sleep(0.05)
    CUR["p"] = p
    return p, httpx.Client(base_url=base, timeout=30)

CUR = {}

def show(case, fn, req):
    try:
        r = fn()
        out = f"{r.status_code} | {r.text[:160]}"
    except httpx.HTTPError as e:
        out = f"TRANSPORT ERROR {type(e).__name__}: {str(e)[:80]}"
    p = CUR.get("p")
    alive = "server alive" if (p is not None and p.poll() is None) else f"SERVER EXITED rc={p.poll() if p else None}"
    print(f"{case} | {req} -> {out} | {alive}".replace("\n", " "))

def token(c, email="u@example.com"):
    c.post("/v1/register", json={"email": email, "password": "password-123"})
    return {"Authorization": "Bearer " + c.post("/v1/login", json={"email": email, "password": "password-123"}).json()["access_token"]}

for ttl in ("1000000000000", "99999999999999999999"):
    p, c = start({"TOKEN_TTL_SECONDS": ttl})
    show("R-1", lambda: c.post("/v1/register", json={"email": "a@example.com", "password": "password-123"}), f"TTL={ttl} POST /v1/register")
    show("R-1", lambda: c.post("/v1/login", json={"email": "a@example.com", "password": "password-123"}), f"TTL={ttl} POST /v1/login")
    p.terminate()
p, c = start({"ADMIN_EMAIL": "admin@example.com"}); h = token(c)
for n in (4300, 4301, 5000):
    show("R-2", lambda: c.get("/v1/tasks/" + "9" * n, headers=h), f"GET /v1/tasks/<{n} nines>")
for path in ("/docs", "/redoc", "/openapi.json"):
    show("R-3", lambda: c.get(path), f"anonymous GET {path}")
show("R-4", lambda: c.post("/v1/tasks", content=b"{bad", headers={"content-type": "application/json"}), "anonymous POST /v1/tasks body {bad")
show("R-4", lambda: c.patch("/v1/tasks/1", content=b"{bad", headers={"content-type": "application/json"}), "anonymous PATCH /v1/tasks/1 body {bad")
show("R-4", lambda: c.post("/v1/tasks", json={"title": ""}), "anonymous POST /v1/tasks {title:''}")
show("R-5", lambda: c.post("/v1/tasks", json={"title": "\x1f"}, headers=h), "POST /v1/tasks title U+001F")
show("A-1", lambda: c.post("/v1/register", json={"email": "a@example.com", "password": "Sup3rS"}), "POST /v1/register short password Sup3rS")
show("A-1", lambda: c.post("/v1/register", json={"password": "Sup3rSecretPw!"}), "POST /v1/register missing email")
raw = lambda s: s.encode()
show("A-2", lambda: c.post("/v1/register", content=raw('{"email":"a\\ud800@example.com","password":"password-123"}'), headers={"content-type": "application/json"}), "POST /v1/register email with lone surrogate \\ud800")
show("A-2", lambda: c.post("/v1/login", content=raw('{"email":"u@example.com","password":"pass\\ud800word1"}'), headers={"content-type": "application/json"}), "POST /v1/login password with \\ud800")
show("A-2", lambda: c.post("/v1/tasks", content=raw('{"title":"t\\ud800"}'), headers={**h, "content-type": "application/json"}), "POST /v1/tasks title with \\ud800")
show("A-3", lambda: c.post("/v1/login", json={"email": "u@example.com", "password": "x" * 280}), "POST /v1/login 280-char password (not counted)")
show("A-4", lambda: c.post("/v1/register", json={"email": "a@b.c", "password": "password-123"}), "POST /v1/register a@b.c (not counted)")
p.terminate()
