"""Alembic environment: the target database is the one LEDGER_DB names, the
schema is the application's metadata."""
import os
import sys

from alembic import context
from sqlalchemy import create_engine, pool

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from ledger.db import database_url  # noqa: E402
from ledger.models import Base  # noqa: E402

target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(url=database_url(), target_metadata=target_metadata, literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
