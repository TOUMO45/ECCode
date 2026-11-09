"""I7 / B-7: canonical integer path ids. config.int_params (derived by the engine from the openapi integer path params)
names the segments the guard checks. A segment that is not canonical (^(0|-?[1-9][0-9]*)$ after percent-decoding) is not
answered by the guard: it is rewritten to the fixed token "not-canonical" and passed on, so the app gives exactly its
own non-integer-id answer in its own auth order (anonymous 401, owner 422). Huge canonical ids are left alone.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "lib", "greenfield", "runtime"))

CONFIG = {
    "version": 1,
    "secured": [{"method": "GET", "pathTemplate": "/items/{item_id}"}],
    "public": [{"method": "GET", "pathTemplate": "/open/{n}/x/{name}"}],
    "int_params": [
        {"method": "GET", "pathTemplate": "/items/{item_id}", "params": ["item_id"]},
        {"method": "GET", "pathTemplate": "/open/{n}/x/{name}", "params": ["n"]},
    ],
    "limits": {"max_body_bytes": 1048576, "max_depth": 64, "max_string_length": 100000},
    "docs_enabled": False,
}
NON_CANONICAL = ["+1", "01", "1.0", "%201", "1%20", "%2B1", "00", "-0", "1_0", "%EF%BC%91"]


def user(authorization: str | None = Header(default=None)):
    if authorization != "Bearer owner":
        raise HTTPException(status_code=401, detail="Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return "owner"


def build(tmp_path, mount=True):
    from eccode_runtime import EccodeGuard

    seen = []
    app = FastAPI()
    if mount:
        path = tmp_path / "config.json"
        path.write_text(json.dumps(CONFIG))
        app.add_middleware(EccodeGuard, config_path=str(path))

    @app.get("/items/{item_id}")
    def get_item(item_id: int, who: str = Depends(user)):
        seen.append(item_id)
        if item_id != 1:
            raise HTTPException(status_code=404, detail="Not Found")
        return {"id": item_id}

    @app.get("/open/{n}/x/{name}")
    def open_(n: int, name: str):
        return {"n": n, "name": name}

    return TestClient(app, raise_server_exceptions=False), seen


OWNER = {"authorization": "Bearer owner"}


def test_control_unguarded_app_accepts_non_canonical_ids(tmp_path):
    """The control (what B-7 is): a default FastAPI app answers 200 for +1, 01, 1.0 and ' 1'."""
    c, _ = build(tmp_path, mount=False)
    for raw in ["+1", "01", "1.0", "%201"]:
        assert c.get(f"/items/{raw}", headers=OWNER).status_code == 200, raw


@pytest.mark.parametrize("raw", NON_CANONICAL)
def test_non_canonical_id_gets_the_apps_own_non_integer_answer(tmp_path, raw):
    c, seen = build(tmp_path)
    r = c.get(f"/items/{raw}", headers=OWNER)
    assert r.status_code == 422, (raw, r.status_code, r.text)
    assert "x-eccode-rule" not in r.headers  # the app answered, not the guard
    assert r.json()["detail"][0]["loc"] == ["path", "item_id"]
    assert "input" not in r.json()["detail"][0]  # I8 (GF-ERR-1) removes input; the rewrite itself: test_raw_path_is_rewritten_with_the_path
    anon = c.get(f"/items/{raw}")
    assert anon.status_code == 401, (raw, anon.status_code)  # the app's own auth order: credentials first
    assert seen == []


def test_canonical_ids_unchanged(tmp_path):
    c, seen = build(tmp_path)
    assert c.get("/items/1", headers=OWNER).json() == {"id": 1}
    assert c.get("/items/0", headers=OWNER).status_code == 404
    assert c.get("/items/2", headers=OWNER).status_code == 404
    assert c.get("/items/1").status_code == 401
    assert c.get("/items/-1", headers=OWNER).status_code == 404  # a negative id is canonical: the app's own answer
    huge = "9" * 60
    assert c.get(f"/items/{huge}", headers=OWNER).status_code == build(tmp_path, mount=False)[0].get(f"/items/{huge}", headers=OWNER).status_code
    assert seen[:4] == [1, 0, 2, -1]


def test_only_the_integer_segments_of_a_matching_template_are_rewritten(tmp_path):
    c, _ = build(tmp_path)
    assert c.get("/open/7/x/01").json() == {"n": 7, "name": "01"}  # name is a string param: untouched
    r = c.get("/open/07/x/01")
    assert r.status_code == 422 and r.json()["detail"][0]["loc"] == ["path", "n"]
    assert c.get("/other/01").status_code == 404  # no template: untouched


def test_raw_path_is_rewritten_with_the_path(tmp_path):
    from eccode_runtime import EccodeGuard

    got = {}

    async def app(scope, receive, send):
        got["path"], got["raw_path"] = scope["path"], scope["raw_path"]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    path = tmp_path / "config.json"
    path.write_text(json.dumps(CONFIG))
    guard = EccodeGuard(app, config_path=str(path))
    sent = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(m):
        sent.append(m)

    scope = {"type": "http", "method": "GET", "path": "/items/ 1", "raw_path": b"/items/%201", "query_string": b"q=1",
             "headers": [(b"authorization", b"Bearer owner")], "root_path": ""}
    asyncio.run(guard(scope, receive, send))
    assert got == {"path": "/items/not-canonical", "raw_path": b"/items/not-canonical"}
    assert scope["path"] == "/items/ 1"  # the caller's scope is not mutated
