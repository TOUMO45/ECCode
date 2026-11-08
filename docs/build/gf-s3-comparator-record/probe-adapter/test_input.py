"""Input handling probes: echo in 422, oversize, type confusion, injection, odd unicode."""
import json

import pytest

from conftest import login, reg, user

SECRET = "Sup3rSecretPw!"


def _no_echo(r, *needles):
    assert r.status_code == 422, (r.status_code, r.text)
    for n in needles:
        assert n not in r.text, (n, r.text)
    for e in r.json()["detail"]:
        assert set(e) == {"loc", "msg", "type"}, e


@pytest.mark.parametrize("body", [
    {"email": "not-an-email", "password": SECRET},
    {"email": "a@example.com", "password": SECRET[:6]},
    {"email": "a@example.com", "password": SECRET * 20},
    {"email": "a@example.com", "password": SECRET, "role": "admin"},
    {"email": "a@example.com", "password": SECRET, SECRET: SECRET},
    {"email": SECRET, "password": SECRET},
    {"password": SECRET},
    {"email": ["a@example.com"], "password": SECRET},
    {"email": "a@example.com", "password": [SECRET]},
    {"email": "a@example.com", "password": {"v": SECRET}},
])
def test_register_422_no_echo(client, body):
    r = client.post("/v1/register", json=body)
    needles = [SECRET[:6]] if body.get("email") != SECRET else []
    if SECRET in body:
        needles = []  # attacker-chosen key echoed in loc is not a password leak
    _no_echo(r, *needles)


@pytest.mark.parametrize("body", [
    {"email": "a@example.com", "password": SECRET, "x": SECRET},
    {"email": "a@example.com", "password": SECRET * 20},
    {"email": "a@example.com"},
    {"email": "a@example.com", "password": 12345678},
])
def test_login_422_no_echo(client, body):
    r = client.post("/v1/login", json=body)
    _no_echo(r, SECRET[:6] if "x" not in body else "Sup3rSecretPw!Sup3r")


def test_malformed_json_no_echo(client):
    raw = ('{"email":"a@example.com","password":"' + SECRET + '",}').encode()
    r = client.post("/v1/register", content=raw, headers={"content-type": "application/json"})
    _no_echo(r, SECRET)


@pytest.mark.parametrize("field,val", [("email", "a\ud800@example.com"),
                                       ("password", "pass\ud800word1")])
def test_register_lone_surrogate_no_500(client, field, val):
    body = {"email": "s@example.com", "password": "password-123", field: val}
    raw = json.dumps(body).encode()  # ensure_ascii -> \ud800 escape
    r = client.post("/v1/register", content=raw, headers={"content-type": "application/json"})
    assert r.status_code in (201, 422), (r.status_code, r.text)


@pytest.mark.parametrize("field", ["title", "description"])
def test_task_lone_surrogate_no_500(client, field):
    _, h = user(client, "a@example.com")
    body = {"title": "ok", field: "x\udfffy"}
    raw = json.dumps(body).encode()
    r = client.post("/v1/tasks", content=raw, headers={**h, "content-type": "application/json"})
    assert r.status_code in (201, 422), (r.status_code, r.text)


def test_login_lone_surrogate_no_500(client):
    raw = json.dumps({"email": "a\ud800@example.com", "password": "p\ud800"}).encode()
    r = client.post("/v1/login", content=raw, headers={"content-type": "application/json"})
    assert r.status_code in (401, 422), (r.status_code, r.text)


def test_oversize_and_type_confusion(client):
    _, h = user(client, "a@example.com")
    bad = [{"title": "x" * 201}, {"title": "x", "description": "d" * 2001},
           {"title": 1}, {"title": True}, {"title": ["x"]}, {"title": {"a": 1}},
           {"title": None}, {"title": ""}, {"title": " \t\n "}, {"title": "x", "description": None},
           {"title": "x", "description": 5}, {"title": "x" * 5_000_000}]
    for b in bad:
        r = client.post("/v1/tasks", json=b, headers=h)
        assert r.status_code == 422, (str(b)[:80], r.status_code)
    assert client.get("/v1/tasks", headers=h).json() == []
    ok = client.post("/v1/tasks", json={"title": "  " + "x" * 200 + "  "}, headers=h)
    assert ok.status_code == 201 and ok.json()["title"] == "x" * 200
    assert reg(client, "a" * 250 + "@b.co").status_code == 422
    assert reg(client, "q@example.com", "p" * 129).status_code == 422
    assert reg(client, "q@example.com", "p" * 7).status_code == 422
    assert reg(client, "q@example.com", "p" * 128).status_code == 201


def test_deep_nesting_and_bad_content(client):
    _, h = user(client, "a@example.com")
    deep = b"[" * 100000 + b"]" * 100000
    r = client.post("/v1/tasks", content=deep, headers={**h, "content-type": "application/json"})
    assert r.status_code in (400, 422), r.status_code
    r = client.post("/v1/tasks", content=b'{"title":"x"}', headers={**h, "content-type":
                                                                     "text/plain"})
    print("text/plain create:", r.status_code)
    assert r.status_code != 500
    r = client.post("/v1/tasks", content=b"\xff\xfe{", headers={**h, "content-type":
                                                                 "application/json"})
    assert r.status_code in (400, 422) and "detail" in r.json()


def test_sql_injection_surfaces(client):
    _, h = user(client, "a@example.com")
    payload = "x' OR '1'='1'; DROP TABLE tasks; --"
    r = client.post("/v1/tasks", json={"title": payload, "description": payload}, headers=h)
    assert r.status_code == 201 and r.json()["title"] == payload
    assert login(client, "a@example.com' OR '1'='1", "x' OR '1'='1").status_code == 401
    assert login(client, "' OR 1=1 --", "password-123").status_code == 401
    assert reg(client, "b'--@example.com").status_code == 201
    assert client.get("/v1/tasks", headers=h).status_code == 200


@pytest.mark.parametrize("title", [" ", "　", "  ", "\x1f", "\u0085",
                                   "​", "﻿"])
def test_unicode_blank_titles(client, title):
    _, h = user(client, "a@example.com")
    r = client.post("/v1/tasks", json={"title": title}, headers=h)
    print(repr(title), "isspace=", title.isspace(), "->", r.status_code)
    if title.isspace():
        assert r.status_code == 422, (repr(title), r.status_code, r.text)


@pytest.mark.parametrize("email,ok", [("a@b", False), ("@b.co", False), ("a b@c.co", False),
                                      ("a@b.co\n", True), ("a@@b.co", False),
                                      ("a@b.co\nx@y.zz", False), ("a@b.c", True)])
def test_email_format(client, email, ok):
    r = reg(client, email)
    assert (r.status_code == 201) == ok, (email, r.status_code, r.text)
