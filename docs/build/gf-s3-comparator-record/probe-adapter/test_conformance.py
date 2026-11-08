"""PRD / contract conformance, migration drift."""
import re

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from conftest import CLONE, user

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def test_task_shape_and_roundtrip(client):
    a, h = user(client, "a@example.com")
    t = client.post("/v1/tasks", json={"title": " Write ", "description": "  d  "}, headers=h)
    assert t.status_code == 201
    j = t.json()
    assert set(j) == {"id", "title", "description", "status", "owner_id", "created_at"}
    assert j["title"] == "Write" and j["description"] == "  d  " and j["status"] == "todo"
    assert j["owner_id"] == a["id"] and ISO_Z.match(j["created_at"])
    assert client.get(f"/v1/tasks/{j['id']}", headers=h).json() == j
    t2 = client.post("/v1/tasks", json={"title": "second"}, headers=h).json()
    assert t2["description"] == ""
    lst = client.get("/v1/tasks", headers=h).json()
    assert [x["id"] for x in lst] == sorted([j["id"], t2["id"]])
    for st in ("in_progress", "done", "todo"):
        r = client.patch(f"/v1/tasks/{j['id']}", json={"status": st}, headers=h)
        assert r.status_code == 200 and r.json()["status"] == st
        assert r.json()["title"] == "Write" and r.json()["created_at"] == j["created_at"]
    r = client.patch(f"/v1/tasks/{j['id']}", json={"title": "  new  "}, headers=h)
    assert r.json()["title"] == "new"


def test_register_shape(client):
    r = client.post("/v1/register", json={"email": "Alice@Example.com", "password": "pw-12345"})
    assert r.status_code == 201 and set(r.json()) == {"id", "email", "role"}
    assert r.json()["email"] == "alice@example.com"


def test_logout_204_empty(client):
    _, h = user(client, "a@example.com")
    r = client.post("/v1/logout", headers=h)
    print("logout headers", dict(r.headers))
    assert r.status_code == 204 and r.content == b""


def test_anonymous_docs_endpoints(client):
    """S-AUTHN: every endpoint except register and login requires a token (401)."""
    res = {p: client.get(p).status_code for p in ("/docs", "/redoc", "/openapi.json")}
    print("anonymous docs statuses", res)
    assert all(s in (401, 404) for s in res.values()), res


def test_anonymous_malformed_json_gets_401(client):
    """AC-8: POST /v1/tasks and PATCH /v1/tasks/{id} without Authorization answer 401."""
    hdrs = {"content-type": "application/json"}
    r1 = client.post("/v1/tasks", content=b"{bad", headers=hdrs)
    r2 = client.patch("/v1/tasks/1", content=b"{bad", headers=hdrs)
    r3 = client.post("/v1/tasks", json={"title": ""})
    print("anon malformed:", r1.status_code, r2.status_code, "anon invalid schema:", r3.status_code)
    assert r3.status_code == 401
    assert r1.status_code == 401 and r2.status_code == 401


def _schema(engine):
    insp = sa.inspect(engine)
    out = {}
    for t in sorted(set(insp.get_table_names()) - {"alembic_version"}):
        cols = [(c["name"], str(c["type"]), c["nullable"], c.get("default"))
                for c in insp.get_columns(t)]
        idx = sorted((i["name"], tuple(i["column_names"]), bool(i["unique"]))
                     for i in insp.get_indexes(t))
        uq = sorted(tuple(u["column_names"]) for u in insp.get_unique_constraints(t))
        fk = sorted((tuple(f["constrained_columns"]), f["referred_table"],
                     tuple(f["referred_columns"])) for f in insp.get_foreign_keys(t))
        pk = insp.get_pk_constraint(t)["constrained_columns"]
        out[t] = (cols, idx, uq, fk, pk)
    return out


def test_migration_matches_create_all(tmp_path):
    from app.db import init_db, make_engine
    e1 = make_engine(f"sqlite:///{tmp_path/'ca.db'}")
    init_db(e1)
    url = f"sqlite:///{tmp_path/'mig.db'}"
    cfg = Config()
    cfg.set_main_option("script_location", str(CLONE / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")
    e2 = sa.create_engine(url)
    s1, s2 = _schema(e1), _schema(e2)
    assert s1 == s2
    command.downgrade(cfg, "base")
    assert set(sa.inspect(sa.create_engine(url)).get_table_names()) <= {"alembic_version"}
