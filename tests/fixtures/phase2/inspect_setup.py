#!/usr/bin/env python3
"""Test helper, not part of the measured pipeline: describe what bench/pilot/phase2-hb/mealie_setup.py produced.

Run with the Mealie checkout's interpreter, with the same environment as the setup (DATA_DIR and the
probe tokens), after the setup ran. Argument 1: JSON list of roles [{name, headers}] to authenticate
with; argument 2: JSON list of GET url templates in which {id} is replaced by each id in argument 3.
Prints one line `ECCODE_INSPECT <json>` with:
  tables:   for each table with a CHAR(32) id (a GUID table): its ids in creation (rowid) order, as uuid strings;
  intIds:   for the integer-id tables the tests look at: the ids in creation order
  columns:  for every table, a digest of each non-time column (the rows sorted), so two setups can be compared
  users:    username, id and permission flags of every user
  fk:       the rows PRAGMA foreign_key_check reports (must be none), and integrity_check
  self:     the status and username GET /api/users/self returns for each role
  routes:   for each template and id, the role-admin status
"""
import hashlib
import json
import os
import sqlite3
import sys
import uuid

TIME_TYPES = ("DATETIME", "TIMESTAMP")
INT_TABLES = ("group_meal_plans", "long_live_tokens", "invite_tokens")


def as_uuid(value):
    try:
        return str(uuid.UUID(value))
    except Exception:  # noqa: BLE001
        return value


def describe(db_path):
    c = sqlite3.connect(db_path)
    tables = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
    out = {"tables": {}, "intIds": {}, "columns": {}, "counts": {}}
    for t in tables:
        cols = c.execute("pragma table_info('%s')" % t).fetchall()
        idcol = [x for x in cols if x[1] == "id"]
        if idcol and "CHAR(32)" in (idcol[0][2] or "").upper():
            out["tables"][t] = [as_uuid(r[0]) for r in c.execute("select id from \"%s\" order by rowid" % t)]
        if t in INT_TABLES:
            out["intIds"][t] = [r[0] for r in c.execute("select id from \"%s\" order by rowid" % t)]
        out["counts"][t] = c.execute("select count(*) from \"%s\"" % t).fetchone()[0]
        per_col = {}
        for x in cols:
            name, typ = x[1], (x[2] or "").upper()
            if any(k in typ for k in TIME_TYPES) or name == "password":
                continue
            values = sorted(repr(r[0]) for r in c.execute("select \"%s\" from \"%s\"" % (name, t)))
            per_col[name] = hashlib.sha256("\n".join(values).encode()).hexdigest()[:16]
        out["columns"][t] = per_col
    out["users"] = [
        {"username": r[0], "id": as_uuid(r[1]), "admin": bool(r[2]), "canInvite": bool(r[3]), "canManage": bool(r[4]), "canManageHousehold": bool(r[5]), "canOrganize": bool(r[6])}
        for r in c.execute("select username, id, admin, can_invite, can_manage, can_manage_household, can_organize from users order by rowid")
    ]
    out["tokens"] = [{"id": r[0], "userId": as_uuid(r[1])} for r in c.execute("select id, user_id from long_live_tokens order by rowid")]
    c.execute("pragma foreign_keys=OFF")
    out["fk"] = {"violations": c.execute("pragma foreign_key_check").fetchall(), "integrity": c.execute("pragma integrity_check").fetchall()}
    c.close()
    return out


def probe(roles, templates, ids):
    from fastapi.testclient import TestClient
    from mealie.app import app

    result = {"self": {}, "routes": {}, "public": {}}
    with TestClient(app) as client:
        for role in roles:
            r = client.get("/api/users/self", headers=role.get("headers") or {})
            name = None
            try:
                name = r.json().get("username")
            except Exception:  # noqa: BLE001
                pass
            result["self"][role["name"]] = {"status": r.status_code, "username": name}
        admin = next((r for r in roles if r["name"] == "admin"), None)
        for tpl in templates:
            for i in ids:
                url = tpl.replace("{id}", i)
                r = client.get(url, headers=(admin or {}).get("headers") or {})
                result["routes"]["%s %s" % (tpl, i)] = r.status_code
        r = client.get("/api/households/mealplans/ical/alpha")
        result["public"]["calendar alpha"] = r.status_code
    return result


def main():
    roles = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    templates = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
    ids = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
    out = describe(os.path.join(os.environ["DATA_DIR"], "mealie.db"))
    out.update(probe(roles, templates, ids))
    sys.stdout.write("ECCODE_INSPECT " + json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
