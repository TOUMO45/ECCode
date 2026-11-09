"""Class 10: storage, hashing, races, contention, migration."""
import concurrent.futures as cf
import hashlib
import json
import re
import sqlite3

import httpx
import pytest
from sqlalchemy import create_engine, inspect

from conftest import PW, TREE, H, uniq


def test_password_verifier_salted_scrypt(client, db_path):
    e1, e2 = uniq(), uniq()
    client.post("/v1/register", json={"email": e1, "password": PW})
    client.post("/v1/register", json={"email": e2, "password": PW})
    con = sqlite3.connect(db_path)
    rows = con.execute("select email, password_hash from users").fetchall()
    con.close()
    hashes = [h for _, h in rows]
    print(hashes[0])
    assert len(set(hashes)) == 2
    salts = set()
    for h in hashes:
        m = re.fullmatch(r"scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)", h)
        assert m and int(m.group(1)) >= 2**14
        salts.add(m.group(4))
        assert PW not in h
    assert len(salts) == 2


def test_no_plaintext_password_or_token_in_db_file(client, db_path):
    pw = "Unique-Plaintext-Marker-123"
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": pw})
    t = client.post("/v1/login", json={"email": e, "password": pw}).json()["access_token"]
    client.post("/v1/tasks", json={"title": "x"}, headers=H(t))
    raw = b""
    for p in db_path.parent.glob(db_path.name + "*"):
        raw += p.read_bytes()
    assert pw.encode() not in raw and t.encode() not in raw
    con = sqlite3.connect(db_path)
    stored = [r[0] for r in con.execute("select token_hash from auth_tokens")]
    con.close()
    assert stored == [hashlib.sha256(t.encode()).hexdigest()]
    # a DB read does not give a usable token
    assert client.get("/v1/tasks", headers=H(stored[0])).status_code == 401


def test_token_entropy(client):
    e = uniq()
    client.post("/v1/register", json={"email": e, "password": PW})
    toks = {client.post("/v1/login", json={"email": e, "password": PW}).json()["access_token"] for _ in range(20)}
    assert len(toks) == 20
    assert all(len(t) >= 43 for t in toks)  # 32 bytes urlsafe b64


def test_register_response_shape(client):
    r = client.post("/v1/register", json={"email": "Shape@Example.COM", "password": PW})
    assert r.status_code == 201 and set(r.json()) == {"id", "email", "role"}
    assert r.json()["email"] == "shape@example.com"
    assert client.post("/v1/register", json={"email": "shape@example.com", "password": PW}).status_code == 409
    assert client.post("/v1/register", json={"email": "SHAPE@example.com", "password": "other-pass-1"}).status_code == 409


def test_duplicate_email_race_live(live, tmp_path):
    s = live(DATABASE_URL=f"sqlite:///{tmp_path}/dup.db")
    variants = ["race@example.com", "RACE@example.com", "Race@Example.Com"] * 10
    with cf.ThreadPoolExecutor(30) as ex:
        rs = list(ex.map(lambda e: httpx.post(s.base + "/v1/register", json={"email": e, "password": PW}, timeout=60), variants))
    codes = [r.status_code for r in rs]
    print("dup race:", {c: codes.count(c) for c in set(codes)})
    assert codes.count(201) == 1 and codes.count(409) == 29
    con = sqlite3.connect(tmp_path / "dup.db")
    assert con.execute("select count(*) from users").fetchone()[0] == 1
    con.close()


def test_write_contention_live(live, tmp_path):
    s = live(DATABASE_URL=f"sqlite:///{tmp_path}/wc.db")
    users = []
    for i in range(6):
        e = uniq()
        httpx.post(s.base + "/v1/register", json={"email": e, "password": PW})
        users.append(httpx.post(s.base + "/v1/login", json={"email": e, "password": PW}).json()["access_token"])

    def work(i):
        t = users[i % len(users)]
        r = httpx.post(s.base + "/v1/tasks", json={"title": f"t{i}"}, headers=H(t), timeout=60)
        r2 = httpx.patch(s.base + f"/v1/tasks/{r.json()['id']}", json={"status": "done"}, headers=H(t), timeout=60) if r.status_code == 201 else r
        r3 = httpx.post(s.base + "/v1/login", json={"email": "nobody@example.com", "password": PW}, timeout=60)
        return r.status_code, r2.status_code, r3.status_code
    with cf.ThreadPoolExecutor(40) as ex:
        res = list(ex.map(work, range(200)))
    print("contention:", {x: res.count(x) for x in set(res)})
    assert all(x == (201, 200, 401) for x in res)
    con = sqlite3.connect(tmp_path / "wc.db")
    assert con.execute("select count(*), count(distinct id) from tasks where status='done'").fetchone() == (200, 200)
    con.close()


def test_migration_matches_models_and_contract(tmp_path):
    from alembic import command
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from app.db import alembic_config, make_engine
    from app.models import Base
    eng = make_engine(f"sqlite:///{tmp_path}/mig.db")
    cfg = alembic_config()
    with eng.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    with eng.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    print("autogenerate diff:", diff)
    assert diff == []
    contract = json.loads((TREE / "contracts/db-schema.json").read_text())
    insp = inspect(eng)
    assert set(insp.get_table_names()) - {"alembic_version"} == set(contract["tables"])
    for name, spec in contract["tables"].items():
        cols = {c["name"]: c for c in insp.get_columns(name)}
        assert set(cols) == set(spec["columns"])
        for cn, cs in spec["columns"].items():
            assert str(cols[cn]["type"]) == cs["type"] and cols[cn]["nullable"] == cs["nullable"]
        assert sorted((u["name"], u["column_names"]) for u in insp.get_unique_constraints(name)) == \
            sorted((u["name"], u["columns"]) for u in spec["unique_constraints"])
        assert sorted((i["name"], i["column_names"], bool(i["unique"])) for i in insp.get_indexes(name)) == \
            sorted((i["name"], i["columns"], i["unique"]) for i in spec["indexes"])
        fks = [(f["constrained_columns"], f["referred_table"], f["referred_columns"], (f.get("options") or {}).get("ondelete")) for f in insp.get_foreign_keys(name)]
        assert sorted(fks) == sorted((f["columns"], f["referred_table"], f["referred_columns"], f["ondelete"]) for f in spec["foreign_keys"])
        assert sorted(c["name"] for c in insp.get_check_constraints(name)) == sorted(spec["check_constraints"])
    with eng.begin() as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, "base")
    assert set(inspect(eng).get_table_names()) <= {"alembic_version"}
    eng.dispose()


def test_restart_on_existing_db_keeps_data(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import create_app
    url = f"sqlite:///{tmp_path}/re.db"
    with TestClient(create_app(url)) as c:
        c.post("/v1/register", json={"email": "keep@example.com", "password": PW})
    with TestClient(create_app(url)) as c:
        assert c.post("/v1/login", json={"email": "keep@example.com", "password": PW}).status_code == 200
