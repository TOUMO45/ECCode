"""Fixtures for the eccode_runtime guard tests: a minimal default FastAPI app whose handlers record whether they ran.

Driven by tests/gf-runtime.test.js (ECCODE_PYTHON). The guard under test is the engine's own copy,
lib/greenfield/runtime/eccode_runtime, configured from a config.json written per test.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "lib", "greenfield", "runtime"))

from fastapi import Body, FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DEFAULT_CONFIG = {
    "version": 1,
    "secured": [{"method": "POST", "pathTemplate": "/secure"}, {"method": "PATCH", "pathTemplate": "/secure/{item_id}"}],
    "public": [{"method": "POST", "pathTemplate": "/items"}, {"method": "POST", "pathTemplate": "/raw"}],
    "limits": {"max_body_bytes": 1048576, "max_depth": 64, "max_string_length": 100000},
    "docs_enabled": False,
}


class Calls:
    def __init__(self) -> None:
        self.items: list = []
        self.raw: list = []
        self.secure: list = []


def build_app(calls: Calls, config_path: str | None, *, mount: bool = True) -> FastAPI:
    from eccode_runtime import EccodeGuard

    app = FastAPI()
    if mount:
        app.add_middleware(EccodeGuard, config_path=config_path)

    @app.post("/items")
    async def items(payload: dict = Body(...)):
        calls.items.append(payload)
        return {"ok": True}

    @app.post("/raw")
    async def raw(request: Request):
        body = await request.body()
        calls.raw.append(body)
        return {"len": len(body)}

    @app.post("/secure")
    async def secure(payload: dict = Body(...)):
        calls.secure.append(payload)
        return {"ok": True}

    @app.patch("/secure/{item_id}")
    async def secure_patch(item_id: int, payload: dict = Body(...)):
        calls.secure.append(payload)
        return {"ok": True}

    @app.get("/items")
    async def list_items():
        return []

    return app


@pytest.fixture
def make_client(tmp_path):
    def make(overrides: dict | None = None, *, mount: bool = True):
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))
        for k, v in (overrides or {}).items():
            cfg[k] = v
        path = tmp_path / "config.json"
        path.write_text(json.dumps(cfg))
        calls = Calls()
        app = build_app(calls, str(path), mount=mount)
        return TestClient(app, raise_server_exceptions=False), calls, app

    return make


def drive(app, method: str, path: str, chunks: list[bytes], headers: list[tuple[bytes, bytes]]):
    """Run one HTTP request through the ASGI app with the body sent as `chunks` (streamed, no Content-Length)."""
    sent: list = []
    queue = [{"type": "http.request", "body": c, "more_body": i < len(chunks) - 1} for i, c in enumerate(chunks)]

    async def receive():
        if queue:
            return queue.pop(0)
        await asyncio.sleep(0)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "", "headers": headers,
             "client": ("127.0.0.1", 1), "server": ("testserver", 80)}
    asyncio.run(app(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], dict((k.decode().lower(), v.decode()) for k, v in start["headers"]), body
