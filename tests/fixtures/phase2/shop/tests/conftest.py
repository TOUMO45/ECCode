import os
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SHOP_DB", str(tmp_path / "shop.sqlite"))
    from shop.app import app
    with TestClient(app) as c:
        yield c
