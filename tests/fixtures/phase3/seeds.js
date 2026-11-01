'use strict';
// Seeded flaws (and their safe counterparts) for the Phase 3 fixture app
// (ledger/). Each entry is a list of changes on the clean app: a find/replace
// whose `find` occurs exactly once, a new file, or a deleted file. `part` is
// the guard the entry exercises (B1 migrations, B2 API compatibility, B3
// performance, B4 concurrency, C security); `expect` is `caught` for a flaw
// and `clean` for a safe change. Every entry keeps the app's own pytest suite
// green (the guards must catch what the tests do not), except the entries
// marked `suiteBreaks`, where that is impossible by construction; the Node
// test (tests/phase3-fixture-app.test.js) tolerates exactly those ids.

const MIGRATION_HEADER = (slug, title) => `"""${title}

Revision ID: 0002_${slug}
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_${slug}"
down_revision = "0001"
branch_labels = None
depends_on = None
`;

function migration(id, title, upgrade, downgrade) {
  const slug = id.replace(/^b\d-/, '').replace(/-/g, '_');
  return { addFile: `alembic/versions/0002_${id}.py`, content: `${MIGRATION_HEADER(slug, title)}\n\ndef upgrade():\n${upgrade}\n\n\ndef downgrade():\n${downgrade}\n` };
}

const ROUTES = 'ledger/routes.py';
const MODELS = 'ledger/models.py';

// The clean transfer body (ledger/routes.py), used by the B4 entries.
const TRANSFER_BODY = `    with session.begin():
        source = session.get(Account, body.from_account)
        if source is None or source.owner_id != user.id:
            raise HTTPException(status_code=404, detail="source account not found")
        target = session.get(Account, body.to_account)
        if target is None:
            raise HTTPException(status_code=404, detail="target account not found")
        if source.balance < body.amount:
            raise HTTPException(status_code=400, detail="insufficient funds")
        source.balance -= body.amount
        target.balance += body.amount
        transfer = Transfer(from_account=source.id, to_account=target.id, amount=body.amount)
        session.add(transfer)
        session.flush()
    return transfer_view(transfer)
`;

// The clean GET /orders/{id} body.
const GET_ORDER_BODY = `    stmt = select(Order).where(Order.id == order_id).options(selectinload(Order.items).joinedload(OrderItem.product))
    order = session.execute(stmt).scalar_one_or_none()
    if order is None or (order.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="order not found")
    return order_view(order)
`;

// The clean GET /products body.
const LIST_PRODUCTS_BODY = `    stmt = select(Product)
    if q:
        # Parameterized LIKE: the search term is a bound parameter.
        stmt = stmt.where(Product.name.like("%" + q + "%"))
    products = session.execute(stmt).scalars().all()
    products = sorted(products, key=lambda p: (p.name.lower(), p.id))
    return [product_view(p) for p in products]
`;

const FLAWS = [
  // ----- B1: migrations ---------------------------------------------------
  {
    id: 'b1-notnull-no-default', part: 'B1', kind: 'NOT NULL column added without a server default (no batch)', expect: 'caught',
    description: 'A new NOT NULL column on transfers with no server_default: every existing row violates it, and the ALTER locks the table on a large one.',
    // Exception by construction: sqlite refuses "ADD COLUMN ... NOT NULL" without a
    // default on a populated table ("Cannot add a NOT NULL column with default value
    // NULL"); on the suite's fresh database the ALTER goes through on the empty table
    // and every later INSERT into transfers (the seeded one included) violates it.
    suiteBreaks: 'the app cannot insert transfers without the new column; the migration itself fails on a populated table',
    changes: [migration('b1-notnull-no-default', 'add transfers.memo (NOT NULL, no default)',
      '    op.add_column("transfers", sa.Column("memo", sa.String(length=255), nullable=False))',
      '    op.drop_column("transfers", "memo")')],
  },
  {
    id: 'b1-drop-column', part: 'B1', kind: 'drop column (irreversible)', expect: 'caught',
    description: 'Drops accounts.name. The downgrade re-adds an empty column: the data cannot be restored.',
    // Exception by construction: the application still reads and writes
    // accounts.name (GET/PATCH /accounts), so the suite fails once the column is gone.
    suiteBreaks: 'the app still reads accounts.name after the column is dropped',
    changes: [migration('b1-drop-column', 'drop accounts.name',
      '    op.drop_column("accounts", "name")',
      '    # The column comes back, its contents do not.\n    op.add_column("accounts", sa.Column("name", sa.String(length=64), nullable=False, server_default=""))')],
  },
  {
    id: 'b1-missing-downgrade', part: 'B1', kind: 'migration without a downgrade', expect: 'caught',
    description: 'Adds a nullable column; downgrade() is `pass`, so the migration cannot be rolled back.',
    changes: [migration('b1-missing-downgrade', 'add transfers.memo (nullable), no downgrade',
      '    op.add_column("transfers", sa.Column("memo", sa.String(length=255), nullable=True))',
      '    pass')],
  },
  {
    id: 'b1-rename-in-place', part: 'B1', kind: 'column renamed in place', expect: 'caught',
    description: 'Renames products.sku to code in one migration (and maps the model onto the new name): any instance running the old code breaks during the deploy.',
    changes: [
      migration('b1-rename-in-place', 'rename products.sku to products.code',
        '    op.alter_column("products", "sku", new_column_name="code")',
        '    op.alter_column("products", "code", new_column_name="sku")'),
      { file: MODELS, find: '    __table_args__ = (UniqueConstraint("sku", name="uq_products_sku"),)\n', replace: '    __table_args__ = (UniqueConstraint("code", name="uq_products_sku"),)\n' },
      { file: MODELS, find: '    sku: Mapped[str] = mapped_column(String(32), nullable=False)\n', replace: '    sku: Mapped[str] = mapped_column("code", String(32), nullable=False)\n' },
    ],
  },
  {
    id: 'b1-add-nullable', part: 'B1', kind: 'nullable column added (safe)', expect: 'clean',
    description: 'Adds a nullable transfers.memo column with a correct downgrade.',
    changes: [migration('b1-add-nullable', 'add transfers.memo (nullable)',
      '    op.add_column("transfers", sa.Column("memo", sa.String(length=255), nullable=True))',
      '    op.drop_column("transfers", "memo")')],
  },
  {
    id: 'b1-add-index', part: 'B1', kind: 'index created concurrently (safe)', expect: 'clean',
    description: 'Creates an index on transfers.created_at with postgresql_concurrently=True in an autocommit block, with a correct downgrade.',
    changes: [migration('b1-add-index', 'index transfers.created_at',
      '    with op.get_context().autocommit_block():\n        op.create_index("ix_transfers_created_at", "transfers", ["created_at"], postgresql_concurrently=True)',
      '    with op.get_context().autocommit_block():\n        op.drop_index("ix_transfers_created_at", table_name="transfers", postgresql_concurrently=True)')],
  },
  {
    id: 'b1-expand-step', part: 'B1', kind: 'expand step of a rename (safe)', expect: 'clean',
    description: 'Adds products.code nullable, backfills it from sku and keeps sku: the expand step of an expand/contract rename.',
    changes: [migration('b1-expand-step', 'add products.code and backfill it from sku (expand step)',
      '    op.add_column("products", sa.Column("code", sa.String(length=32), nullable=True))\n    op.execute("UPDATE products SET code = sku")',
      '    op.drop_column("products", "code")')],
  },
  {
    id: 'b1-add-default', part: 'B1', kind: 'NOT NULL column added with a server default (safe)', expect: 'clean',
    description: 'Adds a NOT NULL transfers.memo column with server_default, so existing rows are valid.',
    changes: [migration('b1-add-default', 'add transfers.memo (NOT NULL, server default)',
      '    op.add_column("transfers", sa.Column("memo", sa.String(length=255), nullable=False, server_default=""))',
      '    op.drop_column("transfers", "memo")')],
  },

  // ----- B2: API compatibility -------------------------------------------
  {
    id: 'b2-remove-endpoint', part: 'B2', kind: 'endpoint removed (breaking)', expect: 'caught',
    description: 'Removes GET /admin/users (and its test, as the same pull request would).',
    changes: [
      { file: ROUTES, find: `@router.get("/admin/users")
def admin_list_users(user: User = Depends(require_admin), session: Session = Depends(get_session)):
    rows = session.execute(select(User).order_by(User.id)).scalars().all()
    return [user_view(u, with_email=True) for u in rows]


`, replace: '' },
      { file: 'tests/test_users.py', find: `

def test_admin_lists_users(client, admin):
    r = client.get("/api/admin/users", headers=admin)
    assert r.status_code == 200
    assert [u["username"] for u in r.json()] == ["ann", "bob", "vic", "cam"]
    assert all("email" in u for u in r.json())
`, replace: '' },
    ],
  },
  {
    id: 'b2-field-type', part: 'B2', kind: 'response field changes type (breaking)', expect: 'caught',
    description: 'Account balances are returned as strings instead of numbers (the tests are adjusted to match, as the same pull request would).',
    changes: [
      { file: ROUTES, find: '    return {"id": account.id, "owner_id": account.owner_id, "name": account.name, "balance": account.balance}\n', replace: '    return {"id": account.id, "owner_id": account.owner_id, "name": account.name, "balance": str(account.balance)}\n' },
      { file: 'tests/test_accounts.py', find: '== (1, 2, "checking", 10000)\n', replace: '== (1, 2, "checking", "10000")\n' },
      { file: 'tests/test_accounts.py', find: '    assert r.json()["balance"] == 5000\n', replace: '    assert r.json()["balance"] == "5000"\n' },
      { file: 'tests/test_transfers.py', find: '    return {a["id"]: a["balance"] for a in client.get("/api/accounts", headers=headers).json()}\n', replace: '    return {a["id"]: int(a["balance"]) for a in client.get("/api/accounts", headers=headers).json()}\n' },
    ],
  },
  {
    id: 'b2-new-required-param', part: 'B2', kind: 'new required query parameter (breaking)', expect: 'caught',
    description: 'GET /products requires a new `limit` query parameter; existing clients get 422 (the tests pass it, as the same pull request would).',
    changes: [
      { file: ROUTES, find: 'from fastapi import APIRouter, Depends, HTTPException\n', replace: 'from fastapi import APIRouter, Depends, HTTPException, Query\n' },
      { file: ROUTES, find: 'def list_products(q: str = "", user: User = Depends(current_user), session: Session = Depends(get_session)):\n', replace: 'def list_products(q: str = "", limit: int = Query(..., ge=1), user: User = Depends(current_user), session: Session = Depends(get_session)):\n' },
      { file: ROUTES, find: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n    return [product_view(p) for p in products]\n', replace: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))[:limit]\n    return [product_view(p) for p in products]\n' },
      { file: 'tests/test_products.py', find: '    r = client.get("/api/products", headers=viewer)\n', replace: '    r = client.get("/api/products", params={"limit": 50}, headers=viewer)\n' },
      { file: 'tests/test_products.py', find: 'params={"q": "lamp"}, headers=member)', replace: 'params={"q": "lamp", "limit": 50}, headers=member)' },
      { file: 'tests/test_products.py', find: 'params={"q": "zzz"}, headers=member)', replace: 'params={"q": "zzz", "limit": 50}, headers=member)' },
      { file: 'tests/test_products.py', find: '    assert "MUG-01" in [p["sku"] for p in client.get("/api/products", headers=admin).json()]\n', replace: '    assert "MUG-01" in [p["sku"] for p in client.get("/api/products", params={"limit": 50}, headers=admin).json()]\n' },
      { file: 'tests/test_products.py', find: '    assert len(client.get("/api/products", headers=admin).json()) == 6\n', replace: '    assert len(client.get("/api/products", params={"limit": 50}, headers=admin).json()) == 6\n' },
    ],
  },
  {
    id: 'b2-optional-param', part: 'B2', kind: 'new optional query parameter (additive)', expect: 'clean',
    description: 'GET /products accepts an optional `limit` query parameter.',
    changes: [
      { file: ROUTES, find: 'from fastapi import APIRouter, Depends, HTTPException\n', replace: 'from fastapi import APIRouter, Depends, HTTPException, Query\n' },
      { file: ROUTES, find: 'def list_products(q: str = "", user: User = Depends(current_user), session: Session = Depends(get_session)):\n', replace: 'def list_products(q: str = "", limit: int | None = Query(None, ge=1), user: User = Depends(current_user), session: Session = Depends(get_session)):\n' },
      { file: ROUTES, find: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n    return [product_view(p) for p in products]\n', replace: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n    if limit is not None:\n        products = products[:limit]\n    return [product_view(p) for p in products]\n' },
    ],
  },
  {
    id: 'b2-new-endpoint', part: 'B2', kind: 'new endpoint (additive)', expect: 'clean',
    description: 'Adds GET /ping.',
    changes: [{ file: ROUTES, find: '# ----- auth --------------------------------------------------------------\n', replace: '@router.get("/ping")\ndef ping():\n    return {"ok": True}\n\n\n# ----- auth --------------------------------------------------------------\n' }],
  },
  {
    id: 'b2-new-field', part: 'B2', kind: 'new response field (additive)', expect: 'clean',
    description: 'Account responses carry a new `currency` field.',
    changes: [{ file: ROUTES, find: '    return {"id": account.id, "owner_id": account.owner_id, "name": account.name, "balance": account.balance}\n', replace: '    return {"id": account.id, "owner_id": account.owner_id, "name": account.name, "balance": account.balance, "currency": "EUR"}\n' }],
  },

  // ----- B3: performance --------------------------------------------------
  {
    id: 'b3-nplus1-orders', part: 'B3', kind: 'N+1 on GET /orders/{id}', expect: 'caught',
    description: 'GET /orders/{id} loads each item\'s product with its own query (the fixed query count in the test is bumped, as the same pull request would).',
    changes: [
      { file: ROUTES, find: GET_ORDER_BODY, replace: `    stmt = select(Order).where(Order.id == order_id).options(selectinload(Order.items))
    order = session.execute(stmt).scalar_one_or_none()
    if order is None or (order.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="order not found")
    items = []
    for item in order.items:
        product = session.execute(select(Product).where(Product.id == item.product_id)).scalar_one()
        items.append({"product_id": item.product_id, "product_name": product.name, "qty": item.qty, "price": product.price})
    return {"id": order.id, "user_id": order.user_id, "total": order.total, "items": items}
` },
      { file: 'tests/test_orders.py', find: 'ORDER_QUERIES = 3\n', replace: 'ORDER_QUERIES = 5\n' },
    ],
  },
  {
    id: 'b3-nplus1-accounts', part: 'B3', kind: 'N+1 on GET /accounts', expect: 'caught',
    description: 'GET /accounts looks the owner up with one query per account.',
    changes: [{ file: ROUTES, find: '    accounts = session.execute(stmt).scalars().all()\n    return [account_view(a) for a in accounts]\n', replace: '    accounts = session.execute(stmt).scalars().all()\n    # Skip accounts whose owner no longer exists.\n    accounts = [a for a in accounts if session.execute(select(User).where(User.id == a.owner_id)).scalar_one_or_none() is not None]\n    return [account_view(a) for a in accounts]\n' }],
  },
  {
    id: 'b3-latency', part: 'B3', kind: 'latency regression on GET /products', expect: 'caught',
    description: 'GET /products recomputes a catalogue checksum thousands of times per request (at least 5x slower on the seeded data).',
    changes: [
      { file: ROUTES, find: 'import ipaddress\n', replace: 'import hashlib\nimport ipaddress\n' },
      { file: ROUTES, find: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n    return [product_view(p) for p in products]\n', replace: '    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n    # Catalogue integrity check on every request.\n    for product in products:\n        for _ in range(5000):\n            hashlib.sha256(repr(product_view(product)).encode()).hexdigest()\n    return [product_view(p) for p in products]\n' },
    ],
  },
  {
    id: 'b3-same-queries', part: 'B3', kind: 'refactor with the same query count (safe)', expect: 'clean',
    description: 'GET /orders/{id} is rewritten as a get() plus one items-with-products query: still two queries.',
    changes: [{ file: ROUTES, find: GET_ORDER_BODY, replace: `    order = session.get(Order, order_id)
    if order is None or (order.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="order not found")
    items = session.execute(select(OrderItem).where(OrderItem.order_id == order.id).options(joinedload(OrderItem.product)).order_by(OrderItem.id)).scalars().all()
    return {"id": order.id, "user_id": order.user_id, "total": order.total, "items": [{"product_id": i.product_id, "product_name": i.product.name, "qty": i.qty, "price": i.product.price} for i in items]}
` }],
  },
  {
    id: 'b3-faster', part: 'B3', kind: 'speed-up (safe)', expect: 'clean',
    description: 'GET /products sorts in SQL instead of in Python.',
    changes: [
      { file: ROUTES, find: '    stmt = select(Product)\n    if q:\n', replace: '    stmt = select(Product).order_by(func.lower(Product.name), Product.id)\n    if q:\n' },
      { file: ROUTES, find: '    products = session.execute(stmt).scalars().all()\n    products = sorted(products, key=lambda p: (p.name.lower(), p.id))\n', replace: '    products = session.execute(stmt).scalars().all()\n' },
    ],
  },

  // ----- B4: concurrency --------------------------------------------------
  {
    id: 'b4-double-spend', part: 'B4', kind: 'double spend (check outside the transaction)', expect: 'caught',
    description: 'POST /transfers checks the balance in one transaction and debits in another: two concurrent transfers can both pass the check and overdraw the account.',
    changes: [
      { file: ROUTES, find: 'from sqlalchemy import func, select\n', replace: 'from sqlalchemy import func, select, update\n' },
      { file: ROUTES, find: `    # One transaction: the balance is read and updated under the same write
    # lock (BEGIN IMMEDIATE, see db.py), so concurrent transfers cannot overdraw.
${TRANSFER_BODY}`, replace: `    # Check the balance, then apply the debit and the credit.
    source = session.get(Account, body.from_account)
    if source is None or source.owner_id != user.id:
        raise HTTPException(status_code=404, detail="source account not found")
    target = session.get(Account, body.to_account)
    if target is None:
        raise HTTPException(status_code=404, detail="target account not found")
    if source.balance < body.amount:
        raise HTTPException(status_code=400, detail="insufficient funds")
    session.commit()
    with session.begin():
        session.execute(update(Account).where(Account.id == source.id).values(balance=Account.balance - body.amount))
        session.execute(update(Account).where(Account.id == target.id).values(balance=Account.balance + body.amount))
        transfer = Transfer(from_account=source.id, to_account=target.id, amount=body.amount)
        session.add(transfer)
        session.flush()
    return transfer_view(transfer)
` },
    ],
  },
  {
    id: 'b4-duplicate-insert', part: 'B4', kind: 'duplicate insert (check-then-insert without the unique constraint)', expect: 'caught',
    description: 'Drops the unique constraint on products.sku and checks for an existing sku in Python before inserting: two concurrent creates can both insert.',
    changes: [
      {
        addFile: 'alembic/versions/0002_b4-duplicate-insert.py',
        content: `${MIGRATION_HEADER('duplicate_insert', 'drop the unique constraint on products.sku')}

def upgrade():
    with op.batch_alter_table("products") as batch_op:
        batch_op.drop_constraint("uq_products_sku", type_="unique")


def downgrade():
    with op.batch_alter_table("products") as batch_op:
        batch_op.create_unique_constraint("uq_products_sku", ["sku"])
`,
      },
      { file: MODELS, find: '    __table_args__ = (UniqueConstraint("sku", name="uq_products_sku"),)\n\n', replace: '' },
      { file: ROUTES, find: `    product = Product(name=body.name, sku=body.sku, price=body.price)
    session.add(product)
    try:
        session.commit()
    except IntegrityError:
        # The unique constraint on sku is enforced by the database.
        session.rollback()
        raise HTTPException(status_code=409, detail="sku already exists")
    return product_view(product)
`, replace: `    if session.execute(select(Product).where(Product.sku == body.sku)).scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="sku already exists")
    product = Product(name=body.name, sku=body.sku, price=body.price)
    session.add(product)
    session.commit()
    return product_view(product)
` },
    ],
  },
  {
    id: 'b4-transfer-ok', part: 'B4', kind: 'refactor keeping the single transaction (safe)', expect: 'clean',
    description: 'The balance check and the two updates move into a helper called inside the same transaction.',
    changes: [
      { file: ROUTES, find: '@router.post("/transfers", status_code=201)\n', replace: `def apply_transfer(source, target, amount):
    if source.balance < amount:
        raise HTTPException(status_code=400, detail="insufficient funds")
    source.balance -= amount
    target.balance += amount


@router.post("/transfers", status_code=201)
` },
      { file: ROUTES, find: `        if source.balance < body.amount:
            raise HTTPException(status_code=400, detail="insufficient funds")
        source.balance -= body.amount
        target.balance += body.amount
`, replace: '        apply_transfer(source, target, body.amount)\n' },
    ],
  },

  // ----- C: security ------------------------------------------------------
  {
    id: 'c-idor-read', part: 'C', kind: 'IDOR on read', expect: 'caught',
    description: 'GET /accounts/{id} no longer checks the owner: any user reads any account.',
    changes: [{ file: ROUTES, find: `    if account is None or (account.owner_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="account not found")
    return account_view(account)
`, replace: `    if account is None:
        raise HTTPException(status_code=404, detail="account not found")
    return account_view(account)
` }],
  },
  {
    id: 'c-idor-update', part: 'C', kind: 'IDOR on update', expect: 'caught',
    description: 'PATCH /accounts/{id} no longer checks the owner: any member renames any account.',
    changes: [{ file: ROUTES, find: '    if account is None or account.owner_id != user.id:\n        raise HTTPException(status_code=404, detail="account not found")\n    account.name = body.name\n', replace: '    if account is None:\n        raise HTTPException(status_code=404, detail="account not found")\n    account.name = body.name\n' }],
  },
  {
    id: 'c-idor-delete', part: 'C', kind: 'IDOR on delete', expect: 'caught',
    description: 'DELETE /accounts/{id} no longer checks the owner: any member deletes any account.',
    changes: [{ file: ROUTES, find: `    if account is None or (account.owner_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="account not found")
    session.delete(account)
`, replace: `    if account is None:
        raise HTTPException(status_code=404, detail="account not found")
    session.delete(account)
` }],
  },
  {
    id: 'c-mass-assignment', part: 'C', kind: 'mass assignment (role from the body)', expect: 'caught',
    description: 'PATCH /users/{id} applies a `role` sent in the body: a member promotes themselves to admin.',
    changes: [{ file: ROUTES, find: '    # Only the username is writable; a role in the body is ignored.\n    row.username = body.username\n', replace: '    row.username = body.username\n    if body.role is not None:\n        row.role = body.role\n' }],
  },
  {
    id: 'c-field-leak', part: 'C', kind: 'field leakage', expect: 'caught',
    description: 'GET /users/{id} returns the email and the password hash to any authenticated user.',
    changes: [{ file: ROUTES, find: '    # The email is private: only the user and admins see it. The hash never leaves.\n    return user_view(row, with_email=(row.id == user.id or user.role == "admin"))\n', replace: '    out = user_view(row, with_email=True)\n    out["password_hash"] = row.password_hash\n    return out\n' }],
  },
  {
    id: 'c-missing-auth', part: 'C', kind: 'missing authorization on one route', expect: 'caught',
    description: 'GET /admin/users loses its admin dependency: any authenticated user lists every user with their email.',
    changes: [{ file: ROUTES, find: 'def admin_list_users(user: User = Depends(require_admin), ', replace: 'def admin_list_users(user: User = Depends(current_user), ' }],
  },
  {
    id: 'c-reset-reuse', part: 'C', kind: 'password-reset token reusable', expect: 'caught',
    description: 'POST /auth/reset/confirm no longer marks the token used: a leaked token resets the password again and again.',
    changes: [{ file: ROUTES, find: '    user.password_hash = db.hash_password(body.password)\n    user.reset_used = True\n', replace: '    user.password_hash = db.hash_password(body.password)\n' }],
  },
  {
    id: 'c-sql-concat', part: 'C', kind: 'SQL built by string formatting', expect: 'caught',
    description: 'GET /products builds the LIKE clause by concatenating the search term into the SQL text.',
    changes: [
      { file: ROUTES, find: 'from sqlalchemy import func, select\n', replace: 'from sqlalchemy import func, select, text\n' },
      { file: ROUTES, find: LIST_PRODUCTS_BODY, replace: `    sql = "SELECT id, name, sku, price FROM products"
    if q:
        sql += " WHERE name LIKE '%" + q + "%'"
    rows = session.execute(text(sql)).mappings().all()
    rows = sorted(rows, key=lambda r: (r["name"].lower(), r["id"]))
    return [{"id": r["id"], "name": r["name"], "sku": r["sku"], "price": r["price"]} for r in rows]
` },
    ],
  },
  {
    id: 'c-safe-rename', part: 'C', kind: 'local variable renamed (safe)', expect: 'clean',
    description: 'A local variable in GET /reports/{name} is renamed; no behaviour changes.',
    changes: [
      { file: ROUTES, find: '    template = REPORT_TEMPLATES.get(name)\n    if template is None:\n', replace: '    report_template = REPORT_TEMPLATES.get(name)\n    if report_template is None:\n' },
      { file: ROUTES, find: '    return {"name": name, "text": render_template(template, context)}\n', replace: '    return {"name": name, "text": render_template(report_template, context)}\n' },
    ],
  },
];

module.exports = { FLAWS };
