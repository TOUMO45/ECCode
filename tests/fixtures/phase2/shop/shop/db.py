"""SQLite storage for the shop (standard library only). The database path comes
from SHOP_DB, so every behavior-diff side and every test gets its own file."""
import os
import sqlite3
import tempfile

SEED_ITEMS = [
    (1, "apple", 100, "fruit"),
    (2, "banana", 50, "fruit"),
    (3, "carrot", 30, "vegetable"),
    (4, "date", 300, "fruit"),
    (5, "eggplant", 220, "vegetable"),
    (6, "fig", 450, "fruit"),
    (7, "grape", 180, "fruit"),
]
SEED_USERS = [
    (1, "ann", "ann@example.test", "admin"),
    (2, "bob", "bob@example.test", "user"),
]
SEED_ORDERS = [
    (1, 2, "1:3,2:10"),  # user bob: 3 apples, 10 bananas
    (2, 1, "4:1"),
]


def db_path():
    return os.environ.get("SHOP_DB") or os.path.join(tempfile.gettempdir(), "eccode-shop-fixture.sqlite")


def connect():
    path = db_path()
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    if fresh:
        conn.executescript(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price_cents INTEGER, category TEXT);"
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT);"
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, lines TEXT);"
        )
        conn.executemany("INSERT INTO items VALUES (?, ?, ?, ?)", SEED_ITEMS)
        conn.executemany("INSERT INTO users VALUES (?, ?, ?, ?)", SEED_USERS)
        conn.executemany("INSERT INTO orders VALUES (?, ?, ?)", SEED_ORDERS)
        conn.commit()
    return conn
