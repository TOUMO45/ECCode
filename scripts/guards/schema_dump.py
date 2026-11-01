#!/usr/bin/env python3
"""Print a normalized JSON description of a database schema (ECCode migration guard).

  python schema_dump.py <sqlalchemy url | sqlite file path>

Tables, columns (name, type, nullable, default, primary key), indexes (name,
columns, unique), unique constraints and foreign keys, sorted, so two dumps of
the same schema are byte-identical. Needs sqlalchemy (the project's own).
"""
import json
import sys


def main(argv):
    if len(argv) != 1:
        sys.stderr.write(__doc__)
        return 2
    target = argv[0]
    url = target if "://" in target else "sqlite:///" + target
    from sqlalchemy import create_engine, inspect

    engine = create_engine(url)
    insp = inspect(engine)
    out = {}
    for table in sorted(insp.get_table_names()):
        if table == "alembic_version":
            continue
        cols = []
        for c in insp.get_columns(table):
            cols.append({
                "name": c["name"], "type": str(c["type"]), "nullable": bool(c.get("nullable", True)),
                "default": None if c.get("default") is None else str(c.get("default")), "primary_key": bool(c.get("primary_key")),
            })
        cols.sort(key=lambda x: x["name"])
        idx = sorted(({"name": i.get("name"), "columns": list(i.get("column_names") or []), "unique": bool(i.get("unique"))} for i in insp.get_indexes(table)), key=lambda x: (x["name"] or "", x["columns"]))
        uniques = sorted(({"name": u.get("name"), "columns": list(u.get("column_names") or [])} for u in insp.get_unique_constraints(table)), key=lambda x: (x["name"] or "", x["columns"]))
        fks = sorted(({"name": f.get("name"), "columns": list(f.get("constrained_columns") or []), "referred_table": f.get("referred_table"), "referred_columns": list(f.get("referred_columns") or [])} for f in insp.get_foreign_keys(table)), key=lambda x: (x["name"] or "", x["columns"]))
        out[table] = {"columns": cols, "indexes": idx, "unique": uniques, "foreign_keys": fks}
    json.dump(out, sys.stdout, sort_keys=True, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
