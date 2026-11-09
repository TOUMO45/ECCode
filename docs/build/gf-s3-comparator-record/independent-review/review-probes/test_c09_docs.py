"""Class 9: docs exposure vs S-AUTHN ("every endpoint except register and login requires a valid bearer token")."""
import pytest


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
def test_docs_require_auth(client, path):
    r = client.get(path)
    print(path, r.status_code, r.headers.get("content-type"))
    assert r.status_code in (401, 404), (path, r.status_code)


def test_unknown_routes_json_detail(client):
    for m, p in [("get", "/v1/nope"), ("delete", "/v1/tasks/1"), ("put", "/v1/tasks/1"), ("get", "/v1/register")]:
        r = client.request(m, p)
        assert r.status_code in (401, 404, 405) and "detail" in r.json()
        print(m, p, r.status_code)
