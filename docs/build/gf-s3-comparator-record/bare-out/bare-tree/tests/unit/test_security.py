from sqlalchemy import create_engine, text

from app import security
from tests.conftest import register


def test_hash_is_salted_scrypt():
    h1 = security.hash_password("same-password")
    h2 = security.hash_password("same-password")
    assert h1 != h2
    assert h1.startswith("scrypt$")
    assert "same-password" not in h1
    assert security.verify_password("same-password", h1)
    assert security.verify_password("same-password", h2)
    assert not security.verify_password("other-password", h1)


def test_verify_rejects_garbage():
    assert not security.verify_password("x", "")
    assert not security.verify_password("x", "bcrypt$1$2$3$4$5")
    assert not security.verify_password("x", "scrypt$a$b$c$d$e")


def test_constant_time_compare_used(monkeypatch):
    calls = []
    real = security.hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(security.hmac, "compare_digest", spy)
    h = security.hash_password("pw-12345678")
    assert security.verify_password("pw-12345678", h)
    assert calls


def test_db_stores_no_plaintext_and_distinct_hashes(client, db_url):
    pw = "shared-password-1"
    a = client.post("/v1/register", json={"email": "a@example.com", "password": pw})
    b = client.post("/v1/register", json={"email": "b@example.com", "password": pw})
    for r in (a, b):
        assert pw not in r.text
        assert "hash" not in r.text
    with create_engine(db_url).connect() as c:
        rows = c.execute(text("select * from users")).mappings().all()
    hashes = [r["password_hash"] for r in rows]
    assert len(set(hashes)) == 2
    for row in rows:
        for value in row.values():
            assert pw not in str(value)
