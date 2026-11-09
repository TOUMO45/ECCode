from datetime import timedelta

import pytest
from sqlalchemy import create_engine, text

from app import security
from tests.conftest import auth, login, register

PROTECTED = [
    ("post", "/v1/logout", None),
    ("get", "/v1/tasks", None),
    ("post", "/v1/tasks", {"title": "x"}),
    ("get", "/v1/tasks/1", None),
    ("patch", "/v1/tasks/1", {"title": "y"}),
]


def call(client, method, path, body, headers):
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    return getattr(client, method)(path, **kwargs)


def test_login_returns_working_token(client):
    register(client, "alice@example.com")
    r = client.post("/v1/login", json={"email": "ALICE@example.com", "password": "correct-horse-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert isinstance(body["access_token"], str) and body["access_token"]
    assert client.get("/v1/tasks", headers=auth(body["access_token"])).status_code == 200


def test_two_logins_two_valid_tokens(client):
    register(client, "alice@example.com")
    t1, t2 = login(client, "alice@example.com"), login(client, "alice@example.com")
    assert t1 != t2
    for t in (t1, t2):
        assert client.get("/v1/tasks", headers=auth(t)).status_code == 200


def test_login_failures_identical(client):
    register(client, "alice@example.com")
    wrong = client.post("/v1/login", json={"email": "alice@example.com", "password": "wrong-password"})
    unknown = client.post("/v1/login", json={"email": "nobody@example.com", "password": "whatever-123"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert "detail" in wrong.json()


@pytest.mark.parametrize(
    "body",
    [{"email": "a@b.com"}, {"password": "x" * 10}, {}, {"email": "a@b.com", "password": "x" * 10, "extra": 1}],
)
def test_login_invalid_body(client, body):
    assert client.post("/v1/login", json=body).status_code == 422


def test_logout_invalidates_only_that_token(client):
    register(client, "alice@example.com")
    t1, t2 = login(client, "alice@example.com"), login(client, "alice@example.com")
    r = client.post("/v1/logout", headers=auth(t1))
    assert r.status_code == 204
    assert r.content == b""
    for method, path, body in PROTECTED:
        r = call(client, method, path, body, auth(t1))
        assert r.status_code == 401, (method, path)
    assert client.get("/v1/tasks", headers=auth(t2)).status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer "},
        {"Authorization": "Basic YWxpY2U6cGFzcw=="},
        {"Authorization": "Token abc"},
        {"Authorization": "Bearer not-a-real-token"},
    ],
)
@pytest.mark.parametrize("method,path,body", PROTECTED)
def test_protected_endpoints_require_token(client, headers, method, path, body):
    r = call(client, method, path, body, headers)
    assert r.status_code == 401
    data = r.json()
    assert isinstance(data, dict) and "detail" in data


def test_wrong_scheme_with_valid_token_rejected(client):
    register(client, "alice@example.com")
    t = login(client, "alice@example.com")
    assert client.get("/v1/tasks", headers={"Authorization": f"Basic {t}"}).status_code == 401
    assert client.get("/v1/tasks", headers={"Authorization": t}).status_code == 401


def test_token_storage_is_sha256_only(client, db_url):
    register(client, "alice@example.com")
    token = login(client, "alice@example.com")
    with create_engine(db_url).connect() as c:
        rows = c.execute(text("select * from auth_tokens")).mappings().all()
    assert len(rows) == 1
    stored = rows[0]["token_hash"]
    assert stored == security.hash_token(token)
    assert len(stored) == 64
    for value in rows[0].values():
        assert token not in str(value)
    # A stored digest presented as a token is not usable.
    assert client.get("/v1/tasks", headers=auth(stored)).status_code == 401


def test_token_entropy():
    tokens = {security.new_token() for _ in range(200)}
    assert len(tokens) == 200
    # token_urlsafe(32) -> 32 random bytes -> 43 base64url characters
    assert all(len(t) >= 43 for t in tokens)
    assert security.TOKEN_BYTES >= 32


def test_token_expires_after_ttl(db_url, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setenv("TOKEN_TTL_SECONDS", "60")
    with TestClient(main.create_app(db_url)) as c:
        register(c, "alice@example.com")
        t = login(c, "alice@example.com")
        assert c.get("/v1/tasks", headers=auth(t)).status_code == 200
        real = main.utcnow
        monkeypatch.setattr(main, "utcnow", lambda: real() + timedelta(seconds=59))
        assert c.get("/v1/tasks", headers=auth(t)).status_code == 200
        monkeypatch.setattr(main, "utcnow", lambda: real() + timedelta(seconds=61))
        r = c.get("/v1/tasks", headers=auth(t))
        assert r.status_code == 401
        assert "detail" in r.json()


def test_default_ttl(client, db_url, monkeypatch):
    from app import config

    assert config.token_ttl_seconds() == 86400
    register(client, "alice@example.com")
    login(client, "alice@example.com")
    with create_engine(db_url).connect() as c:
        created, expires = c.execute(text("select created_at, expires_at from auth_tokens")).one()
    from datetime import datetime

    delta = datetime.fromisoformat(expires) - datetime.fromisoformat(created)
    assert delta == timedelta(seconds=86400)
    monkeypatch.setenv("TOKEN_TTL_SECONDS", "120")
    assert config.token_ttl_seconds() == 120
