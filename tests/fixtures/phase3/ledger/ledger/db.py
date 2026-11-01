"""Engine, sessions, schema creation (through Alembic) and seed data.

The database is the sqlite file LEDGER_DB names (a path or a sqlite URL), so
every test session and every behavior-diff side gets its own. Every
transaction starts with BEGIN IMMEDIATE (the documented pysqlite recipe): a
transaction that reads a balance and then updates it holds the write lock
from the read on, which is sqlite's equivalent of SELECT ... FOR UPDATE.
"""
import contextlib
import hashlib
from datetime import datetime
import os
import re
import tempfile
import threading

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, delete, event, insert
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Account, Order, OrderItem, Product, Transfer, User

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASSWORD_SALT = b"ledger-fixture-salt"


def database_url():
    value = os.environ.get("LEDGER_DB") or os.path.join(tempfile.gettempdir(), "eccode-ledger-fixture.sqlite")
    if value.startswith("sqlite:"):
        return value
    return "sqlite:///" + os.path.abspath(value)


def make_engine(url=None):
    eng = create_engine(url or database_url(), connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(eng, "connect")
    def _connect(dbapi_connection, record):
        # Let SQLAlchemy control transactions: pysqlite must not emit its own BEGIN.
        dbapi_connection.isolation_level = None

    @event.listens_for(eng, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    return eng


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def hash_password(password):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), PASSWORD_SALT, 1000).hex()


def alembic_config():
    cfg = Config(os.path.join(ROOT, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(ROOT, "alembic"))
    return cfg


def migrate():
    """Create or update the schema: alembic upgrade head, programmatically."""
    command.upgrade(alembic_config(), "head")


# Deterministic seed data: fixed ids, roles and bearer tokens.
SEED_USERS = [
    {"id": 1, "username": "ann", "email": "ann@example.test", "role": "admin", "token": "tok-admin", "password": "ann-pass"},
    {"id": 2, "username": "bob", "email": "bob@example.test", "role": "member", "token": "tok-member", "password": "bob-pass", "reset_token": "reset-bob-1"},
    {"id": 3, "username": "vic", "email": "vic@example.test", "role": "viewer", "token": "tok-viewer", "password": "vic-pass"},
    {"id": 4, "username": "cam", "email": "cam@example.test", "role": "member", "token": "tok-member2", "password": "cam-pass"},
]
SEED_ACCOUNTS = [
    {"id": 1, "owner_id": 2, "name": "checking", "balance": 10000},
    {"id": 2, "owner_id": 2, "name": "savings", "balance": 5000},
    {"id": 3, "owner_id": 4, "name": "checking", "balance": 3000},
    {"id": 4, "owner_id": 4, "name": "savings", "balance": 1500},
]
SEED_TRANSFERS = [
    {"id": 1, "from_account": 1, "to_account": 2, "amount": 500, "created_at": datetime(2026, 1, 15, 9, 30, 0)},
]
SEED_PRODUCTS = [
    {"id": 1, "name": "lamp", "sku": "LAMP-01", "price": 2500},
    {"id": 2, "name": "desk", "sku": "DESK-01", "price": 12000},
    {"id": 3, "name": "chair", "sku": "CHAIR-01", "price": 8000},
    {"id": 4, "name": "pen", "sku": "PEN-01", "price": 150},
    {"id": 5, "name": "notebook", "sku": "NOTE-01", "price": 450},
    {"id": 6, "name": "lamp shade", "sku": "LAMP-02", "price": 900},
]
SEED_ORDERS = [
    {"id": 1, "user_id": 2, "total": 5450},
    {"id": 2, "user_id": 4, "total": 12000},
]
SEED_ORDER_ITEMS = [
    {"id": 1, "order_id": 1, "product_id": 1, "qty": 2},
    {"id": 2, "order_id": 1, "product_id": 4, "qty": 3},
    {"id": 3, "order_id": 2, "product_id": 2, "qty": 1},
]


def _user_rows():
    rows = []
    for u in SEED_USERS:
        rows.append({
            "id": u["id"], "username": u["username"], "email": u["email"], "role": u["role"], "token": u["token"],
            "password_hash": hash_password(u["password"]), "tokens_valid": True,
            "reset_token": u.get("reset_token"), "reset_used": False,
        })
    return rows


def reset_data(session=None):
    """Delete every row and insert the seed data again (schema untouched).
    The seeded balances already reflect the one seeded transfer."""
    with (session or SessionLocal()) as s, s.begin():
        for table in (OrderItem, Order, Transfer, Account, Product, User):
            s.execute(delete(table))
        s.execute(insert(User), _user_rows())
        s.execute(insert(Account), SEED_ACCOUNTS)
        s.execute(insert(Transfer), SEED_TRANSFERS)
        s.execute(insert(Product), SEED_PRODUCTS)
        s.execute(insert(Order), SEED_ORDERS)
        s.execute(insert(OrderItem), SEED_ORDER_ITEMS)


def seed():
    """Create the schema (alembic upgrade head) and insert the seed data."""
    migrate()
    reset_data()


_TRANSACTION_CONTROL = re.compile(r"^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b", re.IGNORECASE)


class QueryCounter:
    def __init__(self):
        self.statements = []
        self._lock = threading.Lock()

    @property
    def count(self):
        return len(self.statements)

    def record(self, statement):
        with self._lock:
            self.statements.append(statement)


@contextlib.contextmanager
def count_queries(session_or_engine=None):
    """Count the SQL statements the engine executes inside the block, through
    SQLAlchemy's before_cursor_execute event. Transaction control (BEGIN,
    COMMIT, SAVEPOINT, PRAGMA) is not counted; every SELECT, INSERT, UPDATE
    and DELETE is. Takes a Session or an Engine (default: the app engine)."""
    target = session_or_engine if session_or_engine is not None else engine
    bind = target.get_bind() if isinstance(target, Session) else target
    assert isinstance(bind, Engine)
    counter = QueryCounter()

    def listener(conn, cursor, statement, parameters, context, executemany):
        if not _TRANSACTION_CONTROL.match(statement):
            counter.record(statement)

    event.listen(bind, "before_cursor_execute", listener)
    try:
        yield counter
    finally:
        event.remove(bind, "before_cursor_execute", listener)
