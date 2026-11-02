import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from hub.main import app
    with TestClient(app) as c:
        yield c
