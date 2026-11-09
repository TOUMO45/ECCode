"""Class 5: admin lookalikes and ADMIN_EMAIL configuration."""
import pytest

from conftest import PW

LOOKALIKES = [
    "boss@example.com.", "boss.@example.com", "bo​ss@example.com", "boss@example.com​",
    "ｂoss@example.com", "boss@exаmple.com", "bоss@example.com", "boss@example.co",
    "boss+x@example.com", "boss@example.com\x00", "boss @example.com", "boss@example.com\n.",
    "boss@sub.example.com", "ʙoss@example.com", "BOSS@EXAMPLE.COMİ",
]


@pytest.mark.parametrize("email", LOOKALIKES, ids=lambda s: s.encode("unicode_escape").decode())
def test_lookalike_never_admin(client, email):
    r = client.post("/v1/register", json={"email": email, "password": PW})
    assert r.status_code in (201, 422), r.status_code
    if r.status_code == 201:
        assert r.json()["role"] == "user", r.json()
        assert r.json()["email"] != "boss@example.com"


@pytest.mark.parametrize("email", ["BOSS@EXAMPLE.COM", "Boss@Example.Com", " boss@example.com ", "boss@example.com\t"])
def test_case_variants_get_admin_and_block_real(client, email):
    r = client.post("/v1/register", json={"email": email, "password": PW})
    assert r.status_code == 201
    j = r.json()
    assert j["role"] == "admin" and j["email"] == "boss@example.com"
    assert client.post("/v1/register", json={"email": "boss@example.com", "password": PW}).status_code == 409


def test_kelvin_sign(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "kim@example.com")
    r = client.post("/v1/register", json={"email": "Kim@example.com", "password": PW})
    assert r.status_code == 422 or r.json()["role"] == "user"
    # Kelvin sign in the env value must not silently make the ASCII address admin either way;
    # record what happens (documented behaviour, not asserted as defect)
    monkeypatch.setenv("ADMIN_EMAIL", "Kelvin@example.com")
    r = client.post("/v1/register", json={"email": "kelvin@example.com", "password": PW})
    print("ADMIN_EMAIL=\\u212aelvin -> kelvin@example.com role:", r.json().get("role"))


@pytest.mark.parametrize("val", [None, "", "   ", "\t"])
def test_admin_email_unset_or_empty_nobody_admin(client, monkeypatch, val):
    if val is None:
        monkeypatch.delenv("ADMIN_EMAIL", raising=False)
    else:
        monkeypatch.setenv("ADMIN_EMAIL", val)
    for e in ["boss@example.com", "a@b.co", "x@example.com"]:
        r = client.post("/v1/register", json={"email": e, "password": PW})
        assert r.status_code == 201 and r.json()["role"] == "user"


def test_admin_email_env_case_and_space(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "  Chief@Example.COM ")
    assert client.post("/v1/register", json={"email": "chief@example.com", "password": PW}).json()["role"] == "admin"


def test_role_fixed_at_registration(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "later@example.com")
    client.post("/v1/register", json={"email": "plain@example.com", "password": PW})
    monkeypatch.setenv("ADMIN_EMAIL", "plain@example.com")
    t = client.post("/v1/login", json={"email": "plain@example.com", "password": PW}).json()["access_token"]
    other = client.post("/v1/register", json={"email": "o@example.com", "password": PW}).json()
    to = client.post("/v1/login", json={"email": "o@example.com", "password": PW}).json()["access_token"]
    tid = client.post("/v1/tasks", json={"title": "x"}, headers={"Authorization": f"Bearer {to}"}).json()["id"]
    assert client.get(f"/v1/tasks/{tid}", headers={"Authorization": f"Bearer {t}"}).status_code == 404


def test_concurrent_admin_registration_live(live, tmp_path):
    import concurrent.futures as cf
    import httpx
    s = live(DATABASE_URL=f"sqlite:///{tmp_path}/race.db", ADMIN_EMAIL="boss@example.com")
    variants = ["boss@example.com", "BOSS@example.com", "Boss@Example.com", " boss@example.com"] * 8
    def go(e):
        return httpx.post(s.base + "/v1/register", json={"email": e, "password": PW}, timeout=60)
    with cf.ThreadPoolExecutor(32) as ex:
        rs = list(ex.map(go, variants))
    codes = sorted(r.status_code for r in rs)
    print("admin race codes:", {c: codes.count(c) for c in set(codes)})
    assert codes.count(201) == 1 and codes.count(409) == len(variants) - 1
    assert [r.json()["role"] for r in rs if r.status_code == 201] == ["admin"]
