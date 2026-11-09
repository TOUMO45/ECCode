"""Class 6: anonymous / malformed Authorization / logout / expiry."""
import time

import pytest

from conftest import PW, H, uniq

ENDPOINTS = [("post", "/v1/logout", None), ("get", "/v1/tasks", None), ("post", "/v1/tasks", {"title": "x"}),
             ("get", "/v1/tasks/1", None), ("patch", "/v1/tasks/1", {"title": "x"})]
BAD_HEADERS = [None, "", "Bearer", "Bearer ", "Bearer    ", "Basic dXNlcjpwYXNz", "Token abc", "Digest abc",
               "Bearer null", "Bearer undefined", "BearerX abc", "Bearer\tabc", "abc", "Bearer a b",
               "Bearer " + "A" * 10000, "Bearer ../../etc", "Bearer ' OR 1=1 --"]


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
@pytest.mark.parametrize("hdr", BAD_HEADERS, ids=lambda h: repr(h)[:20])
def test_bad_auth_401(client, alice, method, path, body, hdr):
    client.post("/v1/tasks", json={"title": "x"}, headers=alice["h"])
    headers = {} if hdr is None else {"Authorization": hdr}
    r = client.request(method, path, json=body, headers=headers)
    assert r.status_code == 401, (r.status_code, r.text)
    assert isinstance(r.json(), dict) and "detail" in r.json()


def test_other_scheme_with_valid_token(client, alice):
    t = alice["h"]["Authorization"].split(" ", 1)[1]
    for scheme in ("Basic", "Token", "JWT", "Bearer:"):
        assert client.get("/v1/tasks", headers={"Authorization": f"{scheme} {t}"}).status_code == 401
    assert client.get("/v1/tasks", headers={"Authorization": f"Bearer {t}x"}).status_code == 401
    assert client.get("/v1/tasks", headers={"Authorization": f"Bearer {t[:-1]}"}).status_code == 401


def test_token_in_query_or_cookie_not_accepted(client, alice):
    t = alice["h"]["Authorization"].split(" ", 1)[1]
    assert client.get(f"/v1/tasks?access_token={t}").status_code == 401
    assert client.get("/v1/tasks", cookies={"access_token": t}).status_code == 401


def test_logout_exactly_presented_token(client):
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    t1 = client.post("/v1/login", json={"email": e, "password": PW}).json()["access_token"]
    t2 = client.post("/v1/login", json={"email": e, "password": PW}).json()["access_token"]
    assert t1 != t2
    r = client.post("/v1/logout", headers=H(t1))
    assert r.status_code == 204 and r.content == b""
    for m, p, b in ENDPOINTS:
        assert client.request(m, p, json=b, headers=H(t1)).status_code == 401
    assert client.get("/v1/tasks", headers=H(t2)).status_code == 200
    assert client.post("/v1/logout", headers=H(t2)).status_code == 204
    assert client.get("/v1/tasks", headers=H(t2)).status_code == 401


def test_logout_does_not_affect_other_users(client, alice, bob):
    client.post("/v1/logout", headers=alice["h"])
    assert client.get("/v1/tasks", headers=bob["h"]).status_code == 200


def test_expired_token(client, monkeypatch):
    monkeypatch.setenv("TOKEN_TTL_SECONDS", "1")
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    t = client.post("/v1/login", json={"email": e, "password": PW}).json()["access_token"]
    assert client.get("/v1/tasks", headers=H(t)).status_code == 200
    time.sleep(1.3)
    for m, p, b in ENDPOINTS:
        r = client.request(m, p, json=b, headers=H(t))
        assert r.status_code == 401 and "detail" in r.json()


def test_401_has_www_authenticate(client):
    r = client.get("/v1/tasks")
    assert r.headers.get("www-authenticate", "").lower().startswith("bearer")


def test_login_no_enumeration(client):
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    a = client.post("/v1/login", json={"email": e, "password": "wrong-password"})
    b = client.post("/v1/login", json={"email": uniq(), "password": "wrong-password"})
    assert a.status_code == b.status_code == 401 and a.content == b.content
    assert {k: v for k, v in a.headers.items() if k != "date"} == {k: v for k, v in b.headers.items() if k != "date"}


def test_login_timing_no_enumeration(client):
    import statistics
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    def med(email, n=15):
        xs = []
        for _ in range(n):
            s = time.perf_counter()
            client.post("/v1/login", json={"email": email, "password": "wrong-password"})
            xs.append(time.perf_counter() - s)
        return statistics.median(xs)
    k, u = med(e), med("nobody-x@example.com")
    print(f"login timing known={k*1e3:.1f}ms unknown={u*1e3:.1f}ms")
    assert 0.6 < k / u < 1.6


def test_register_login_open_anonymous(client):
    assert client.post("/v1/register", json={"email": uniq(), "password": PW}).status_code == 201
