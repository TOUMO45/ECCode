"""The shop API. Roles come from the X-Role header: anonymous, user or admin."""
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

from . import db
from .pricing import line_total, normalize_name, page_bounds, tax

app = FastAPI(title="shop")
TAX_RATE = 0.08
DEFAULT_PAGE_SIZE = 3


class NewItem(BaseModel):
    name: str
    price_cents: int
    category: str = "misc"


def role_of(x_role):
    return x_role if x_role in ("user", "admin") else "anonymous"


def item_view(row):
    return {"id": row["id"], "name": row["name"], "price_cents": row["price_cents"], "category": row["category"]}


@app.get("/items")
def list_items(page: int = Query(0, ge=0), size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=50), category: str | None = None):
    conn = db.connect()
    rows = conn.execute("SELECT * FROM items ORDER BY name").fetchall()
    if category:
        rows = [r for r in rows if r["category"] == category]
    start, end = page_bounds(page, size)
    return {"items": [item_view(r) for r in rows[start:end]], "total": len(rows), "page": page, "size": size}


@app.get("/items/{item_id}")
def get_item(item_id: int):
    conn = db.connect()
    row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item_view(row)


@app.post("/items", status_code=201)
def create_item(item: NewItem, x_role: str | None = Header(default=None)):
    if role_of(x_role) != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    conn = db.connect()
    name = normalize_name(item.name)
    cur = conn.execute("INSERT INTO items (name, price_cents, category) VALUES (?, ?, ?)", (name, item.price_cents, item.category))
    conn.commit()
    return {"id": cur.lastrowid, "name": name, "price_cents": item.price_cents, "category": item.category}


@app.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, x_role: str | None = Header(default=None)):
    if role_of(x_role) != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    conn = db.connect()
    cur = conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="item not found")
    return None


@app.get("/users/{user_id}")
def get_user(user_id: int, x_role: str | None = Header(default=None)):
    conn = db.connect()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    out = {"id": row["id"], "name": row["name"]}
    if role_of(x_role) == "admin":
        out["email"] = row["email"]
        out["role"] = row["role"]
    return out


@app.get("/orders/{order_id}/total")
def order_total(order_id: int):
    conn = db.connect()
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        raise HTTPException(status_code=404, detail="order not found")
    subtotal = 0
    lines = []
    for part in order["lines"].split(","):
        item_id, qty = (int(x) for x in part.split(":"))
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        total = line_total(item["price_cents"], qty)
        lines.append({"item_id": item_id, "quantity": qty, "total_cents": total})
        subtotal += total
    tax_cents = tax(subtotal, TAX_RATE)
    return {"order_id": order_id, "lines": lines, "subtotal_cents": subtotal, "tax_cents": tax_cents, "total_cents": subtotal + tax_cents}
