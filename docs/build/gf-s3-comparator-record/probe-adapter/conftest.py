"""Comparator probe adapter: replaces the S3 review-probe conftest (which imported the engine app in-process from
review-clone/). Test files are byte-identical copies (probe-files-source.sha256). Helpers below are identical to the
S3 conftest; only the app factory is the HTTP shim in shim/app. Target tree: env PROBE_TARGET_TREE.
Pre-registered (before the bare run): NOT_APPLICABLE tests are skipped because they assert engine-internal names."""
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
CLONE = pathlib.Path(os.environ["PROBE_TARGET_TREE"]).resolve()
sys.path.insert(0, str(HERE / "shim"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app, kill_all  # noqa: E402

PW = "password-123"

NOT_APPLICABLE = {
    "test_auth.py::test_storage": "asserts the engine's table/column names (users.password_hash, auth_tokens.token_hash) and its scrypt string format",
    "test_conformance.py::test_migration_matches_create_all": "imports the engine's app.db.init_db/make_engine",
    "test_race.py::test_clean_checkout_startup": "asserts the engine's chosen temp-db file name tasktracker-*.db",
}


def pytest_collection_modifyitems(config, items):
    for it in items:
        key = it.nodeid.split("[")[0].split("/")[-1]
        if key in NOT_APPLICABLE:
            it.add_marker(pytest.mark.skip(reason="N/A on a non-engine tree: " + NOT_APPLICABLE[key]))


def pytest_sessionfinish(session, exitstatus):
    kill_all()


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
