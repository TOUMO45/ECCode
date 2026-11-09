"""I2 / GF-VAL-1: the guard's body filters on a minimal default FastAPI app (positive, negative and bypass rows)."""

from __future__ import annotations

import json

import pytest

from conftest import drive

JSON = {"content-type": "application/json"}
REJECT = {"detail": [{"type": "gf_val", "rule": "GF-VAL-1"}]}


def assert_rejected(r, calls_list):
    assert r.status_code == 422, (r.status_code, r.text[:200])
    body = r.json()
    assert list(body) == ["detail"] and len(body["detail"]) == 1
    d = body["detail"][0]
    assert set(d) == {"type", "rule", "msg"}
    assert d["type"] == "gf_val" and d["rule"] == "GF-VAL-1" and isinstance(d["msg"], str) and 0 < len(d["msg"]) <= 80
    assert r.headers["x-eccode-rule"] == "GF-VAL-1"
    assert calls_list == [], "the app handler must not run"


# ---- positive: valid bodies reach the app unchanged --------------------------------------------------------------

def test_valid_json_reaches_the_app_unchanged(make_client):
    c, calls, _ = make_client()
    raw = '{"title": "café \\ud83d\\ude00", "n": [1, {"a": null}]}'.encode()
    r = c.post("/raw", content=raw, headers=JSON)
    assert r.status_code == 200 and calls.raw == [raw]
    assert "x-eccode-rule" not in r.headers
    r = c.post("/items", json={"a": "b"})
    assert r.status_code == 200 and calls.items == [{"a": "b"}]


def test_depth_64_and_string_100000_are_accepted(make_client):
    c, calls, _ = make_client()
    r = c.post("/raw", content=(b"[" * 64 + b"]" * 64), headers=JSON)
    assert r.status_code == 200 and len(calls.raw) == 1
    r = c.post("/raw", content=json.dumps({"s": "x" * 100000}).encode(), headers=JSON)
    assert r.status_code == 200 and len(calls.raw) == 2


def test_get_without_body_passes(make_client):
    c, _, _ = make_client()
    r = c.get("/items")
    assert r.status_code == 200 and "x-eccode-rule" not in r.headers


# ---- negative: each filter ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("raw", [
    b'{"a": "\\ud800"}',            # lone high, end of string
    b'{"a": "\\ud800x"}',           # high followed by a plain char
    b'{"a": "\\uD800\\u0041"}',     # high followed by a non-low escape
    b'{"a": "\\udc00"}',            # lone low
    b'{"a": "x\\uDFFF"}',           # lone low, upper case
    b'{"a": "\\ud800\\ud800\\udc00"}',  # high, then a valid pair: the first high is lone
    b'{"\\ud800": 1}',              # in a key
    b'["\\ud800"]',
])
def test_lone_escaped_surrogate_is_rejected(make_client, raw):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=raw, headers=JSON), calls.raw)


def test_valid_escaped_pair_is_accepted(make_client):
    c, calls, _ = make_client()
    r = c.post("/raw", content=b'{"a": "\\ud83d\\ude00"}', headers=JSON)
    assert r.status_code == 200 and len(calls.raw) == 1


@pytest.mark.parametrize("raw", [b'{"a": "\xed\xa0\x80"}', b'{"a": "\xed\xbf\xbf"}'])
def test_raw_encoded_surrogate_is_rejected(make_client, raw):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=raw, headers=JSON), calls.raw)


@pytest.mark.parametrize("raw", [b'{"a": "\xff"}', b'{"a": "\xc3"}', b'{"a": "\xc0\xaf"}', b'\xfe\xff\x00{'])
def test_invalid_utf8_is_rejected(make_client, raw):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=raw, headers=JSON), calls.raw)


def test_utf16_json_is_rejected_not_utf8(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content='{"a": "\\ud800"}'.encode("utf-16-le"), headers=JSON), calls.raw)


def test_body_over_the_size_cap_is_rejected_by_content_length(make_client):
    c, calls, _ = make_client()
    raw = b'{"a": "' + b"x" * 1048576 + b'"}'
    assert_rejected(c.post("/raw", content=raw, headers=JSON), calls.raw)
    # also for a non-JSON content type
    assert_rejected(c.post("/raw", content=b"x" * 1048577, headers={"content-type": "text/plain"}), calls.raw)


def test_body_at_the_size_cap_is_accepted(make_client):
    c, calls, _ = make_client({"limits": {"max_body_bytes": 1048576, "max_depth": 64, "max_string_length": 2000000}})
    raw = b'{"a": "' + b"x" * (1048576 - 9) + b'"}'
    assert len(raw) == 1048576
    r = c.post("/raw", content=raw, headers=JSON)
    assert r.status_code == 200 and calls.raw == [raw]


def test_streamed_body_over_the_cap_is_rejected_without_content_length(make_client):
    _, calls, app = make_client()
    chunks = [b'{"a": "'] + [b"x" * 65536] * 17 + [b'"}']
    status, headers, body = drive(app, "POST", "/raw", chunks, [(b"content-type", b"application/json")])
    assert status == 422 and headers["x-eccode-rule"] == "GF-VAL-1" and calls.raw == []
    assert json.loads(body)["detail"][0]["rule"] == "GF-VAL-1"


def test_streamed_body_under_the_cap_is_replayed_unchanged(make_client):
    _, calls, app = make_client()
    chunks = [b'{"a"', b': "', b"y" * 1000, b'"}']
    status, _, _ = drive(app, "POST", "/raw", chunks, [(b"content-type", b"application/json")])
    assert status == 200 and calls.raw == [b"".join(chunks)]


@pytest.mark.parametrize("depth", [65, 1000, 100000])
def test_nesting_over_64_is_rejected_iteratively(make_client, depth):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=b"[" * depth + b"]" * depth, headers=JSON), calls.raw)
    assert_rejected(c.post("/raw", content=b'{"a":' * depth + b"1" + b"}" * depth, headers=JSON), calls.raw)
    # unterminated deep input is rejected too, before the parser could recurse
    assert_rejected(c.post("/raw", content=b"[" * depth, headers=JSON), calls.raw)


def test_brackets_inside_strings_do_not_count_as_depth(make_client):
    c, calls, _ = make_client()
    r = c.post("/raw", content=json.dumps({"s": "[" * 500 + "\\\"{" * 100}).encode(), headers=JSON)
    assert r.status_code == 200 and len(calls.raw) == 1


def test_string_over_the_length_cap_is_rejected(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=json.dumps({"s": "x" * 100001}).encode(), headers=JSON), calls.raw)
    assert_rejected(c.post("/raw", content=json.dumps({"x" * 100001: 1}).encode(), headers=JSON), calls.raw)


@pytest.mark.parametrize("raw", [b'"text"', b"1", b"null", b"true", b" 3.5 "])
def test_parsed_scalar_top_level_is_rejected(make_client, raw):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=raw, headers=JSON), calls.raw)


@pytest.mark.parametrize("raw", [b"{bad", b'{"a": 1,}', b"", b"[1, 2", b'"unterminated', b"tru"])
def test_malformed_json_reaches_the_app_unchanged(make_client, raw):
    c, calls, _ = make_client()
    r = c.post("/raw", content=raw, headers=JSON)
    assert r.status_code == 200 and calls.raw == [raw]
    assert "x-eccode-rule" not in r.headers


def test_rejection_never_contains_request_content(make_client):
    c, calls, _ = make_client()
    secret = "hunter2-SECRET-value"
    for raw in [json.dumps({"password": secret, "x": "\ud800"}, ensure_ascii=True).encode(),
                json.dumps({"password": secret, "s": "y" * 100001}).encode(),
                json.dumps(secret).encode()]:
        r = c.post("/raw", content=raw, headers=JSON)
        assert r.status_code == 422 and secret not in r.text and "hunter2" not in r.text


def test_json_suffix_content_type_is_checked(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=b'{"a": "\\ud800"}', headers={"content-type": "application/merge-patch+json; charset=utf-8"}), calls.raw)


def test_missing_content_type_is_checked_as_json(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/raw", content=b'{"a": "\\ud800"}', headers={"content-type": ""}), calls.raw)


def test_non_json_content_type_skips_the_json_filters(make_client):
    c, calls, _ = make_client()
    r = c.post("/raw", content=b'{"a": "\\ud800"}', headers={"content-type": "text/plain"})
    assert r.status_code == 200 and len(calls.raw) == 1


def test_items_endpoint_rejects_before_validation_and_handler(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/items", content=b'{"a": "\\ud800"}', headers=JSON), calls.items)


# ---- stage order: no credentials -> 401 first ------------------------------------------------------------------

def test_secured_operation_without_authorization_gets_401_first(make_client):
    c, calls, _ = make_client()
    for path, method in [("/secure", "post"), ("/secure/7", "patch")]:
        r = getattr(c, method)(path, content=b'{"a": "\\ud800"}', headers=JSON)
        assert r.status_code == 401 and r.json() == {"detail": "Not authenticated"}
        assert r.headers["www-authenticate"] == "Bearer" and r.headers["x-eccode-rule"] == "GF-VAL-1"
    assert calls.secure == []


def test_secured_operation_with_authorization_gets_422(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/secure", content=b'{"a": "\\ud800"}', headers={**JSON, "authorization": "Bearer junk"}), calls.secure)


def test_public_operation_without_authorization_gets_422(make_client):
    c, calls, _ = make_client()
    assert_rejected(c.post("/items", content=b'[' * 100, headers=JSON), calls.items)


def test_secured_operation_valid_body_passes_through_without_401(make_client):
    c, calls, _ = make_client()
    r = c.post("/secure", json={"a": 1})
    assert r.status_code == 200 and calls.secure == [{"a": 1}] and "x-eccode-rule" not in r.headers


# ---- bypass rows ---------------------------------------------------------------------------------------------------

def test_unmounted_guard_lets_the_bad_body_through(make_client):
    """The control: without the mount the same body reaches the handler (the gate's canary relies on this difference)."""
    c, calls, _ = make_client(mount=False)
    r = c.post("/raw", content=b'{"a": "\\ud800"}', headers=JSON)
    assert r.status_code == 200 and len(calls.raw) == 1


def test_missing_config_fails_closed(tmp_path):
    from eccode_runtime import EccodeGuard
    from fastapi import FastAPI
    with pytest.raises(Exception):
        EccodeGuard(FastAPI(), config_path=str(tmp_path / "nope.json"))
