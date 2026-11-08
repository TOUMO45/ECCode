import sys, pathlib, tempfile
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "review-clone"))
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
d = tempfile.mkdtemp()
c = TestClient(create_app(Settings(f"sqlite:///{d}/t.db", None, 86400)), raise_server_exceptions=False)
c.post("/v1/register", json={"email": "a@example.com", "password": "password-123"})
h = {"Authorization": "Bearer " + c.post("/v1/login", json={"email": "a@example.com", "password": "password-123"}).json()["access_token"]}
lo, hi = 20, 6000
while lo < hi:
    mid = (lo + hi) // 2
    if c.get("/v1/tasks/" + "9" * mid, headers=h).status_code == 404: lo = mid + 1
    else: hi = mid
r = c.get("/v1/tasks/" + "9" * lo, headers=h)
print("first digit count giving non-404:", lo, r.status_code, r.text)
print("4300 digits:", c.get("/v1/tasks/" + "9" * 4300, headers=h).status_code, "-4300:", c.get("/v1/tasks/-" + "9" * 4300, headers=h).status_code)
from datetime import timedelta
for ttl in (10**10, 10**11, 2 * 10**11, 3 * 10**11, 10**12):
    try:
        from app.models import utcnow; utcnow() + timedelta(seconds=ttl); ok = "ok"
    except Exception as e: ok = type(e).__name__ + ": " + str(e)
    print("ttl", ttl, ok)
