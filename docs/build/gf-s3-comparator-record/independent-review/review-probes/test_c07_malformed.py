"""Class 7: malformed bodies, no 500, no secret echo."""
import json

import pytest

from conftest import PW, uniq

CT = {"content-type": "application/json"}


@pytest.mark.parametrize("raw", [b"{bad", b"[]", b'"str"', b"1", b"null", b"true", b"", b"\xff\xfe\x00",
                                 b'{"title": "x"', b"[" * 100000 + b"]" * 100000,
                                 b'{"a":' * 5000 + b"1" + b"}" * 5000])
@pytest.mark.parametrize("path", ["/v1/register", "/v1/login", "/v1/tasks", "PATCH /v1/tasks/1"])
def test_bad_json_never_500_and_detail(client, alice, raw, path):
    client.post("/v1/tasks", json={"title": "t"}, headers=alice["h"])
    method, p = ("patch", path.split()[1]) if path.startswith("PATCH") else ("post", path)
    h = {**CT, **(alice["h"] if "tasks" in p else {})}
    r = client.request(method, p, content=raw, headers=h)
    assert r.status_code in (400, 422), (r.status_code, r.text[:200])
    assert "detail" in r.json()


SURR = '"\\ud800"'
SURR_CASES = [
    ("post", "/v1/register", '{"email": "s1@example.com", "password": "abcdefgh\\ud800"}', False),
    ("post", "/v1/register", '{"email": "s\\udc00@example.com", "password": "abcdefghij"}', False),
    ("post", "/v1/login", '{"email": "\\ud800@example.com", "password": "abcdefghij"}', False),
    ("post", "/v1/login", '{"email": "a@example.com", "password": "\\ud800\\ud800abcdefgh"}', False),
    ("post", "/v1/tasks", '{"title": "\\ud800"}', True),
    ("post", "/v1/tasks", '{"title": "ok", "description": "\\udfff"}', True),
    ("patch", "/v1/tasks/1", '{"title": "\\ud800"}', True),
    ("patch", "/v1/tasks/1", '{"description": "x\\ud83d"}', True),
]


@pytest.mark.parametrize("method,path,raw,authed", SURR_CASES, ids=[f"{m}-{p}-{i}" for i, (m, p, _, _) in enumerate(SURR_CASES)])
def test_lone_surrogates_no_500(client, alice, method, path, raw, authed):
    client.post("/v1/tasks", json={"title": "t"}, headers=alice["h"])
    h = {**CT, **(alice["h"] if authed else {})}
    r = client.request(method, path, content=raw.encode(), headers=h)
    assert r.status_code < 500, (method, path, r.status_code, r.text[:100])


@pytest.mark.parametrize("body", [
    {"email": "x@example.com", "password": "Sup3rSecretPw"[:7]},  # too short
    {"email": "x@example.com", "password": "Sup3rSecretPw" * 10},  # too long (130)
    {"password": "Sup3rSecretPw"},  # missing email
    {"email": "not-an-email", "password": "Sup3rSecretPw"},  # malformed email
    {"email": "x@example.com", "password": "Sup3rSecretPw", "role": "admin"},  # unknown field
])
def test_register_422_does_not_echo_password(client, body):
    r = client.post("/v1/register", json=body)
    assert r.status_code == 422
    assert body["password"] not in r.text, r.text


@pytest.mark.parametrize("body", [{"password": "Sup3rSecretPw"}, {"email": "a@example.com", "password": "Sup3rSecretPw", "x": 1},
                                  {"email": 5, "password": "Sup3rSecretPw"}])
def test_login_422_does_not_echo_password(client, body):
    r = client.post("/v1/login", json=body)
    assert r.status_code == 422
    assert "Sup3rSecretPw" not in r.text, r.text


@pytest.mark.parametrize("title", ["   ", "\t\n\r ", "　", "  ", "\x0b\x0c", ""])
def test_whitespace_titles_rejected(client, alice, title):
    assert client.post("/v1/tasks", json={"title": title}, headers=alice["h"]).status_code == 422


@pytest.mark.parametrize("title", ["\x00", "a\x00b", "\x07bell", "\x1b[31mred", "​", "﻿", "‮evil", "\U0001F600" * 200])
def test_control_char_titles_no_500_and_roundtrip(client, alice, title):
    r = client.post("/v1/tasks", json={"title": title}, headers=alice["h"])
    assert r.status_code in (201, 422), r.status_code
    if r.status_code == 201:
        got = client.get(f"/v1/tasks/{r.json()['id']}", headers=alice["h"]).json()
        assert got["title"] == title.strip()
        print("accepted title", title.encode("unicode_escape")[:30])


def test_oversize_fields(client, alice):
    assert client.post("/v1/tasks", json={"title": "x" * 200}, headers=alice["h"]).status_code == 201
    assert client.post("/v1/tasks", json={"title": " " + "x" * 200 + " "}, headers=alice["h"]).status_code == 201
    assert client.post("/v1/tasks", json={"title": "x" * 201}, headers=alice["h"]).status_code == 422
    assert client.post("/v1/tasks", json={"title": "x", "description": "d" * 2000}, headers=alice["h"]).status_code == 201
    assert client.post("/v1/tasks", json={"title": "x", "description": "d" * 2001}, headers=alice["h"]).status_code == 422
    r = client.post("/v1/tasks", json={"title": "x" * 5_000_000}, headers=alice["h"])
    assert r.status_code == 422
    print("5MB title -> 422 response bytes:", len(r.content))
    assert client.post("/v1/register", json={"email": "a" * 300 + "@example.com", "password": PW}).status_code == 422
    assert client.post("/v1/register", json={"email": uniq(), "password": "p" * 129}).status_code == 422
    assert client.post("/v1/register", json={"email": uniq(), "password": "p" * 128}).status_code == 201


def test_no_500_on_misc(client, alice):
    cases = [
        ("post", "/v1/tasks", {"content-type": "text/plain"}, b"title=x"),
        ("post", "/v1/tasks", {"content-type": "application/x-www-form-urlencoded"}, b"title=x"),
        ("post", "/v1/register", {"content-type": "application/json; charset=utf-16"}, json.dumps({"email": uniq(), "password": PW}).encode("utf-16")),
        ("post", "/v1/tasks", {"content-type": "application/json"}, json.dumps({"title": "x", "title2": 1}).encode()),
    ]
    for m, p, h, raw in cases:
        r = client.request(m, p, content=raw, headers={**h, **alice["h"]})
        assert r.status_code < 500, (p, h, r.status_code)
