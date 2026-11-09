import itertools

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ADMIN = "boss@example.com"
_counter = itertools.count()


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite:///{tmp_path / 'test.db'}"


@pytest.fixture
def client(db_url, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", ADMIN)
    monkeypatch.delenv("TOKEN_TTL_SECONDS", raising=False)
    with TestClient(create_app(db_url)) as c:
        yield c


def register(client, email=None, password="correct-horse-1"):
    email = email or f"user{next(_counter)}@example.com"
    r = client.post("/v1/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def login(client, email, password="correct-horse-1"):
    r = client.post("/v1/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def make_user(client):
    def _make(email=None):
        user = register(client, email)
        user["token"] = login(client, user["email"])
        user["h"] = auth(user["token"])
        return user

    return _make


@pytest.fixture
def alice(make_user):
    return make_user()


@pytest.fixture
def bob(make_user):
    return make_user()


@pytest.fixture
def admin(make_user):
    u = make_user(ADMIN)
    assert u["role"] == "admin"
    return u
