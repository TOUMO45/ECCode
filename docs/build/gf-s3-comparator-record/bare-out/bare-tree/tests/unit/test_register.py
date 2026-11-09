import pytest
from sqlalchemy import create_engine, text

from tests.conftest import ADMIN, register


def count_users(db_url):
    with create_engine(db_url).connect() as c:
        return c.execute(text("select count(*) from users")).scalar()


def test_register_returns_user(client):
    r = client.post("/v1/register", json={"email": "Alice@Example.COM", "password": "correct-horse-1"})
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"id", "email", "role"}
    assert isinstance(body["id"], int)
    assert body["email"] == "alice@example.com"
    assert body["role"] == "user"


def test_duplicate_email_case_insensitive(client, db_url):
    register(client, "alice@example.com")
    r = client.post("/v1/register", json={"email": "Alice@Example.com", "password": "other-pass-2"})
    assert r.status_code == 409
    assert "detail" in r.json()
    assert count_users(db_url) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not-an-email", "password": "correct-horse-1"},
        {"email": "a@b", "password": "correct-horse-1"},
        {"email": "a@@b.com", "password": "correct-horse-1"},
        {"email": "@b.com", "password": "correct-horse-1"},
        {"email": "a b@c.com", "password": "correct-horse-1"},
        {"email": "a@b.com", "password": "short7!"},
        {"email": "a@b.com", "password": "x" * 129},
        {"email": "a@b.com"},
        {"password": "correct-horse-1"},
        {},
        {"email": "a@b.com", "password": "correct-horse-1", "role": "admin"},
        {"email": 5, "password": "correct-horse-1"},
        {"email": "a@b.com", "password": 123456789},
    ],
)
def test_register_invalid(client, db_url, body):
    r = client.post("/v1/register", json=body)
    assert r.status_code == 422
    assert "detail" in r.json()
    assert count_users(db_url) == 0


def test_register_non_json(client):
    r = client.post("/v1/register", content="nope", headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_password_bounds_accepted(client):
    register(client, "a@b.com", "x" * 8)
    register(client, "c@d.com", "x" * 128)


def test_admin_bootstrap(client):
    assert register(client, "someone@example.com")["role"] == "user"
    assert register(client, ADMIN.upper())["role"] == "admin"
    assert register(client, "other@example.com")["role"] == "user"


@pytest.mark.parametrize("value", [None, ""])
def test_no_admin_without_admin_email(db_url, monkeypatch, value):
    from fastapi.testclient import TestClient

    from app.main import create_app

    if value is None:
        monkeypatch.delenv("ADMIN_EMAIL", raising=False)
    else:
        monkeypatch.setenv("ADMIN_EMAIL", value)
    with TestClient(create_app(db_url)) as c:
        assert register(c, ADMIN)["role"] == "user"
        assert register(c, "x@example.com")["role"] == "user"
