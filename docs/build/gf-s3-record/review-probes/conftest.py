import pathlib
import sys

CLONE = pathlib.Path(__file__).resolve().parents[1] / "review-clone"
sys.path.insert(0, str(CLONE))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

PW = "password-123"


def make_client(tmp_path, admin="admin@example.com", ttl=86400, name="db.sqlite"):
    path = tmp_path / name
    app = create_app(Settings(database_url=f"sqlite:///{path}", admin_email=admin,
                              token_ttl_seconds=ttl))
    return TestClient(app, raise_server_exceptions=False), path


@pytest.fixture
def client(tmp_path):
    c, _ = make_client(tmp_path)
    return c


def reg(c, email, pw=PW):
    return c.post("/v1/register", json={"email": email, "password": pw})


def login(c, email, pw=PW):
    return c.post("/v1/login", json={"email": email, "password": pw})


def hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


def user(c, email, pw=PW):
    r = reg(c, email, pw)
    assert r.status_code == 201, r.text
    lr = login(c, email, pw)
    assert lr.status_code == 200, lr.text
    return r.json(), hdr(lr.json()["access_token"])
