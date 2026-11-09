"""I8 / GF-ERR-1 (A-1, B-10 classes): error bodies never echo request secrets and are capped.

For every 4xx/5xx response from the app the guard (1) removes the ``input`` and ``ctx`` keys of JSON error detail items,
(2) redacts every request secret value (JSON body fields whose key matches pass(word)?|secret|token, found in a
malformed body too, and the Authorization header value; length >= 4) wherever it appears in the body, and (3) caps the
body at 4096 bytes: a larger one is replaced by {"detail":"request rejected"} with ``x-eccode-rule: GF-ERR-1``.
Content-Length stays correct. Success bodies are untouched. The app is a default FastAPI app (its 422 echoes input).
"""

from __future__ import annotations

import json
import os
import sys

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "lib", "greenfield", "runtime"))

CONFIG = {
    "version": 1,
    "secured": [],
    "public": [],
    "int_params": [],
    # large GF-VAL-1 limits here, so a 5 MB body reaches the app and the cap on the APP's error body is what is tested
    "limits": {"max_body_bytes": 16 * 1024 * 1024, "max_depth": 64, "max_string_length": 10 * 1024 * 1024},
    "docs_enabled": False,
}
PW = "pw12"  # short: the default 422 for min_length echoes it
LONG_PW = "correct-horse-battery-staple"
TOKEN = "tok-abcdef-123456"


class RegisterIn(BaseModel):
    email: str
    password: str = Field(min_length=8)


class TaskIn(BaseModel):
    title: str = Field(max_length=200)


def build(tmp_path, mount=True):
    from eccode_runtime import EccodeGuard

    app = FastAPI()
    if mount:
        p = tmp_path / "config.json"
        p.write_text(json.dumps(CONFIG))
        app.add_middleware(EccodeGuard, config_path=str(p))

    @app.post("/register")
    def register(body: RegisterIn):
        return {"email": body.email}

    @app.post("/tasks")
    def tasks(body: TaskIn):
        return {"title": body.title}

    @app.post("/echo-error")
    async def echo_error(request: Request):
        raw = (await request.body()).decode("utf-8", "replace")
        raise HTTPException(status_code=400, detail=f"cannot use {raw} with {request.headers.get('authorization')}")

    @app.post("/echo-ok")
    async def echo_ok(request: Request):
        return {"raw": (await request.body()).decode(), "auth": request.headers.get("authorization")}

    @app.get("/boom")
    def boom():
        raise HTTPException(status_code=500, detail="x" * 10000)

    return TestClient(app, raise_server_exceptions=False)


def _len_ok(r):
    assert int(r.headers["content-length"]) == len(r.content)


def test_control_default_fastapi_echoes_the_password(tmp_path):
    """The control (what A-1 is): the default 422 echoes the short password in `input`."""
    r = build(tmp_path, mount=False).post("/register", json={"email": "a@b.c", "password": PW})
    assert r.status_code == 422 and PW in r.text


def test_default_422_for_short_password_does_not_contain_it(tmp_path):
    r = build(tmp_path).post("/register", json={"email": "a@b.c", "password": PW})
    assert r.status_code == 422
    assert PW not in r.text
    d = r.json()["detail"][0]
    assert "input" not in d and "ctx" not in d
    assert d["loc"] == ["body", "password"] and d["type"] == "string_too_short"
    _len_ok(r)


def test_5mb_title_error_body_is_capped(tmp_path):
    big = "t" * (5 * 1024 * 1024)
    control = build(tmp_path, mount=False).post("/tasks", json={"title": big})
    assert control.status_code == 422 and len(control.content) > 5 * 1024 * 1024  # the control echoes 5 MB
    r = build(tmp_path).post("/tasks", json={"title": big})
    assert r.status_code == 422
    assert len(r.content) <= 4096, len(r.content)
    _len_ok(r)


def test_a_body_over_the_cap_after_scrubbing_is_replaced(tmp_path):
    r = build(tmp_path).get("/boom")
    assert r.status_code == 500
    assert r.json() == {"detail": "request rejected"}
    assert r.headers["x-eccode-rule"] == "GF-ERR-1"
    _len_ok(r)


def test_malformed_json_echo_and_authorization_are_redacted(tmp_path):
    c = build(tmp_path)
    malformed = '{"email": "a@b.c", "password": "%s", "api_token": "%s",' % (LONG_PW, TOKEN)
    r = c.post("/echo-error", content=malformed.encode(), headers={"content-type": "text/plain", "authorization": "Bearer sekrit-bearer-value"})
    assert r.status_code == 400
    for v in (LONG_PW, TOKEN, "sekrit-bearer-value", "Bearer sekrit-bearer-value"):
        assert v not in r.text, v
    assert "a@b.c" in r.text  # not a secret: left as the app wrote it
    _len_ok(r)
    ok = c.post("/echo-error", json={"user": {"password": LONG_PW}, "client_secret": TOKEN})
    assert ok.status_code == 400 and LONG_PW not in ok.text and TOKEN not in ok.text


def test_success_bodies_untouched(tmp_path):
    c = build(tmp_path)
    r = c.post("/echo-ok", json={"password": LONG_PW}, headers={"authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200
    assert json.loads(r.json()["raw"]) == {"password": LONG_PW} and r.json()["auth"] == f"Bearer {TOKEN}"
    assert "x-eccode-rule" not in r.headers
    _len_ok(r)
    assert c.post("/register", json={"email": "a@b.c", "password": LONG_PW}).json() == {"email": "a@b.c"}
