"""I3 / GF-DOCS-1: the documentation endpoints are closed by default and opened only by an explicit switch."""

from __future__ import annotations

import pytest

DOCS = ["/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"]


@pytest.mark.parametrize("path", DOCS)
def test_docs_closed_by_default(make_client, monkeypatch, path):
    monkeypatch.delenv("ECCODE_DOCS_ENABLED", raising=False)
    c, _, _ = make_client()
    for method in ("get", "head"):
        r = getattr(c, method)(path)
        assert r.status_code == 404, (method, path, r.status_code)
        assert r.headers["x-eccode-rule"] == "GF-DOCS-1"
    assert c.get(path).json() == {"detail": "Not Found"}
    # with a query string or a trailing slash too
    assert c.get(path + "?x=1").status_code == 404


def test_docs_are_open_without_the_guard(make_client, monkeypatch):
    """The control: a default FastAPI app serves them (what R-3 was)."""
    monkeypatch.delenv("ECCODE_DOCS_ENABLED", raising=False)
    c, _, _ = make_client(mount=False)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 200, path


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_docs_enabled_by_config(make_client, monkeypatch, path):
    monkeypatch.delenv("ECCODE_DOCS_ENABLED", raising=False)
    c, _, _ = make_client({"docs_enabled": True})
    r = c.get(path)
    assert r.status_code == 200 and "x-eccode-rule" not in r.headers


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_docs_enabled_by_env_switch(make_client, monkeypatch, path):
    monkeypatch.setenv("ECCODE_DOCS_ENABLED", "1")
    c, _, _ = make_client()
    r = c.get(path)
    assert r.status_code == 200 and "x-eccode-rule" not in r.headers


@pytest.mark.parametrize("value", ["0", "", "true", "yes"])
def test_only_the_explicit_switch_opens_docs(make_client, monkeypatch, value):
    monkeypatch.setenv("ECCODE_DOCS_ENABLED", value)
    c, _, _ = make_client()
    assert c.get("/docs").status_code == 404


def test_other_paths_are_untouched(make_client, monkeypatch):
    monkeypatch.delenv("ECCODE_DOCS_ENABLED", raising=False)
    c, _, _ = make_client()
    assert c.get("/items").status_code == 200
    assert c.get("/docsx").status_code == 404 and "x-eccode-rule" not in c.get("/docsx").headers
