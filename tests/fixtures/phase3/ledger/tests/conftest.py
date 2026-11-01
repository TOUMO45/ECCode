import os
import shutil
import tempfile

import pytest

# One sqlite file per test session, chosen before the application is imported.
_TMP = tempfile.mkdtemp(prefix="eccode-ledger-test-")
os.environ["LEDGER_DB"] = os.path.join(_TMP, "ledger.sqlite")

from fastapi.testclient import TestClient  # noqa: E402

from ledger import db  # noqa: E402
from ledger.app import app  # noqa: E402

ADMIN = {"Authorization": "Bearer tok-admin"}
MEMBER = {"Authorization": "Bearer tok-member"}
MEMBER2 = {"Authorization": "Bearer tok-member2"}
VIEWER = {"Authorization": "Bearer tok-viewer"}


@pytest.fixture(scope="session")
def database():
    db.seed()
    yield
    db.engine.dispose()
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(autouse=True)
def fresh_data(database):
    # Every test starts from the seed data (schema untouched, rows reset).
    db.reset_data()


@pytest.fixture(scope="session")
def client(database):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin():
    return ADMIN


@pytest.fixture()
def member():
    return MEMBER


@pytest.fixture()
def member2():
    return MEMBER2


@pytest.fixture()
def viewer():
    return VIEWER
