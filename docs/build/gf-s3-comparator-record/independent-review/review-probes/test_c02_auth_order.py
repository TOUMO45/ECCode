"""Class 2: authentication must be decided before body/path validation (AC-8)."""
import pytest

AUTHS = {"none": {}, "bad_token": {"Authorization": "Bearer not-a-real-token"}, "basic": {"Authorization": "Basic dXNlcjpwYXNz"}}
ENDPOINTS = [("post", "/v1/tasks"), ("patch", "/v1/tasks/1"), ("patch", "/v1/tasks/abc"),
             ("get", "/v1/tasks/abc"), ("post", "/v1/logout"), ("get", "/v1/tasks")]
JSON_CT = {"content-type": "application/json"}

SCHEMA_BAD = [b'{"title": ""}', b'{"owner_id": 5}', b'{}', b'[]', b'"x"', b'null', b'{"title": 123}']
SYNTAX_BAD = [b'{bad', b'{"title": "x",}', b'', b"\xff\xfe", b'[' * 50000 + b']' * 50000]


@pytest.mark.parametrize("auth", list(AUTHS))
@pytest.mark.parametrize("method,path", ENDPOINTS)
@pytest.mark.parametrize("body", SCHEMA_BAD, ids=lambda b: b[:12].decode(errors="replace"))
def test_schema_invalid_body_gets_401(client, auth, method, path, body):
    r = client.request(method, path, content=body, headers={**JSON_CT, **AUTHS[auth]})
    assert r.status_code == 401, (r.status_code, r.text[:200])
    assert "detail" in r.json()


@pytest.mark.parametrize("auth", list(AUTHS))
@pytest.mark.parametrize("method,path", ENDPOINTS)
@pytest.mark.parametrize("body", SYNTAX_BAD, ids=["brace", "trailing_comma", "empty", "nonutf8", "deep"])
def test_syntax_invalid_body_gets_401(client, auth, method, path, body):
    r = client.request(method, path, content=body, headers={**JSON_CT, **AUTHS[auth]})
    assert r.status_code == 401, (r.status_code, r.text[:200])


def test_logged_out_token_with_bad_json_gets_401(client, alice):
    client.post("/v1/logout", headers=alice["h"])
    r = client.post("/v1/tasks", content=b"{bad", headers={**JSON_CT, **alice["h"]})
    assert r.status_code == 401, (r.status_code, r.text)
