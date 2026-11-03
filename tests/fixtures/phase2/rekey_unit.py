#!/usr/bin/env python3
"""Test helper: the canonical-order step of mealie_setup.py on a synthetic database (no Mealie needed).
Builds association tables whose rows were inserted in a scrambled order, runs canonical_order, prints the rows in rowid order per
table as JSON, and the rows of a table with an id (which must not move)."""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile

spec = importlib.util.spec_from_file_location("mealie_setup", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

db = os.path.join(tempfile.mkdtemp(), "t.db")
c = sqlite3.connect(db)
c.execute("create table recipes (id CHAR(32) primary key, name text)")
c.execute("create table recipes_to_categories (recipe_id CHAR(32), category_id CHAR(32))")
c.execute("create table recipes_to_tags (recipe_id CHAR(32), tag_id CHAR(32))")
c.execute("create table alembic_version (version_num CHAR(32))")
c.execute("insert into alembic_version values ('abc')")
c.executemany("insert into recipes values (?, ?)", [("b", "second"), ("a", "first")])
c.executemany("insert into recipes_to_categories values (?, ?)", [("2", "9"), ("1", "5"), ("2", "3"), ("1", "4")])
c.executemany("insert into recipes_to_tags values (?, ?)", [("2", "1"), ("1", "2"), ("1", "1")])
c.commit()
mod.canonical_order(c)
c.commit()
out = {t: [list(r) for r in c.execute('select * from "%s" order by rowid' % t)] for t in ("recipes_to_categories", "recipes_to_tags", "recipes", "alembic_version")}
print(json.dumps(out))
