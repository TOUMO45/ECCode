import json
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, inspect

from app.db import alembic_config, make_engine, run_migrations
from app.models import Base

CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "db-schema.json").read_text())


def describe(engine):
    insp = inspect(engine)
    out = {}
    for table in insp.get_table_names():
        if table == "alembic_version":
            continue
        pk = set(insp.get_pk_constraint(table)["constrained_columns"])
        out[table] = {
            "columns": {
                c["name"]: {"type": str(c["type"]), "nullable": c["nullable"], "primary_key": c["name"] in pk}
                for c in insp.get_columns(table)
            },
            "unique_constraints": sorted(
                ({"name": u["name"], "columns": u["column_names"]} for u in insp.get_unique_constraints(table)),
                key=lambda u: u["name"],
            ),
            "indexes": sorted(
                (
                    {"name": i["name"], "columns": i["column_names"], "unique": bool(i["unique"])}
                    for i in insp.get_indexes(table)
                ),
                key=lambda i: i["name"],
            ),
            "foreign_keys": [
                {
                    "columns": f["constrained_columns"],
                    "referred_table": f["referred_table"],
                    "referred_columns": f["referred_columns"],
                    "ondelete": (f.get("options") or {}).get("ondelete"),
                }
                for f in insp.get_foreign_keys(table)
            ],
            "check_constraints": sorted(c["name"] for c in insp.get_check_constraints(table)),
        }
    return out


def test_migration_matches_contract(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'm.db'}")
    run_migrations(engine)
    assert describe(engine) == CONTRACT["tables"]
    assert "alembic_version" in inspect(engine).get_table_names()


def test_models_match_contract(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'orm.db'}")
    Base.metadata.create_all(engine)
    assert describe(engine) == CONTRACT["tables"]


def test_migration_idempotent_and_downgrade(tmp_path):
    url = f"sqlite:///{tmp_path / 'd.db'}"
    engine = make_engine(url)
    run_migrations(engine)
    run_migrations(engine)  # second startup is a no-op
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]


def test_alembic_cli_style_upgrade_uses_database_url(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'cli.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    command.upgrade(alembic_config(), "head")
    assert describe(create_engine(url)) == CONTRACT["tables"]
