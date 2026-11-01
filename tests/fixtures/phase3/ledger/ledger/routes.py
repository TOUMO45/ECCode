"""All routes of the ledger API (mounted under /api)."""
import ipaddress
import os
import re
import secrets
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from . import db
from .auth import current_user, require_admin, require_writer
from .models import Account, Order, OrderItem, Product, Transfer, User

router = APIRouter()
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Report templates are a fixed dictionary: the request names one by key.
REPORT_TEMPLATES = {
    "summary": "Ledger: {{ users }} users, {{ accounts }} accounts, {{ products }} products.",
    "balances": "Total balance across all accounts: {{ total }}.",
}
_PLACEHOLDER = re.compile(r"{{\s*(\w+)\s*}}")
BLOCKED_HOSTS = {"localhost", "localhost.localdomain", "metadata.google.internal"}


def get_session():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


# ----- schemas -----------------------------------------------------------

class LoginIn(BaseModel):
    username: str
    password: str


class ResetRequestIn(BaseModel):
    username: str


class ResetConfirmIn(BaseModel):
    token: str
    password: str


class AccountPatch(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class TransferIn(BaseModel):
    from_account: int
    to_account: int
    amount: int = Field(gt=0)


class OrderItemIn(BaseModel):
    product_id: int
    qty: int = Field(gt=0)


class OrderIn(BaseModel):
    items: list[OrderItemIn] = Field(min_length=1)


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    sku: str = Field(min_length=1, max_length=32)
    price: int = Field(ge=0)


class UserPatch(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    role: str | None = None  # accepted in the body, never applied


class FetchIn(BaseModel):
    url: str


# ----- views -------------------------------------------------------------

def account_view(account):
    return {"id": account.id, "owner_id": account.owner_id, "name": account.name, "balance": account.balance}


def user_view(user, *, with_email):
    out = {"id": user.id, "username": user.username, "role": user.role}
    if with_email:
        out["email"] = user.email
    return out


def product_view(product):
    return {"id": product.id, "name": product.name, "sku": product.sku, "price": product.price}


def order_view(order):
    items = [{"product_id": i.product_id, "product_name": i.product.name, "qty": i.qty, "price": i.product.price} for i in order.items]
    return {"id": order.id, "user_id": order.user_id, "total": order.total, "items": items}


def transfer_view(transfer):
    return {"id": transfer.id, "from_account": transfer.from_account, "to_account": transfer.to_account, "amount": transfer.amount, "created_at": transfer.created_at.isoformat()}


# ----- auth --------------------------------------------------------------

@router.post("/auth/login")
def login(body: LoginIn, session: Session = Depends(get_session)):
    user = session.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if user is None or user.password_hash != db.hash_password(body.password):
        raise HTTPException(status_code=401, detail="bad credentials")
    user.tokens_valid = True
    session.commit()
    return {"token": user.token}


@router.post("/auth/logout", status_code=204)
def logout(user: User = Depends(current_user), session: Session = Depends(get_session)):
    row = session.get(User, user.id)
    row.tokens_valid = False
    session.commit()


@router.post("/auth/reset/request")
def reset_request(body: ResetRequestIn, session: Session = Depends(get_session)):
    user = session.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="unknown user")
    user.reset_token = "reset-" + secrets.token_hex(8)
    user.reset_used = False
    session.commit()
    # Test-only exposure: a real service would mail the token.
    return {"reset_token": user.reset_token}


@router.post("/auth/reset/confirm")
def reset_confirm(body: ResetConfirmIn, session: Session = Depends(get_session)):
    user = session.execute(select(User).where(User.reset_token == body.token)).scalar_one_or_none()
    if user is None or user.reset_used:
        raise HTTPException(status_code=400, detail="invalid or used reset token")
    user.password_hash = db.hash_password(body.password)
    user.reset_used = True
    session.commit()
    return {"ok": True}


# ----- accounts ----------------------------------------------------------

@router.get("/accounts")
def list_accounts(user: User = Depends(current_user), session: Session = Depends(get_session)):
    stmt = select(Account).order_by(Account.id)
    if user.role != "admin":
        stmt = stmt.where(Account.owner_id == user.id)
    accounts = session.execute(stmt).scalars().all()
    return [account_view(a) for a in accounts]


@router.get("/accounts/{account_id}")
def get_account(account_id: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    account = session.get(Account, account_id)
    if account is None or (account.owner_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="account not found")
    return account_view(account)


@router.patch("/accounts/{account_id}")
def rename_account(account_id: int, body: AccountPatch, user: User = Depends(require_writer), session: Session = Depends(get_session)):
    account = session.get(Account, account_id)
    if account is None or account.owner_id != user.id:
        raise HTTPException(status_code=404, detail="account not found")
    account.name = body.name
    session.commit()
    return account_view(account)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: int, user: User = Depends(require_writer), session: Session = Depends(get_session)):
    account = session.get(Account, account_id)
    if account is None or (account.owner_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="account not found")
    session.delete(account)
    session.commit()


# ----- transfers ---------------------------------------------------------

@router.post("/transfers", status_code=201)
def create_transfer(body: TransferIn, user: User = Depends(require_writer), session: Session = Depends(get_session)):
    if body.from_account == body.to_account:
        raise HTTPException(status_code=400, detail="cannot transfer to the same account")
    # One transaction: the balance is read and updated under the same write
    # lock (BEGIN IMMEDIATE, see db.py), so concurrent transfers cannot overdraw.
    with session.begin():
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


# ----- orders ------------------------------------------------------------

@router.get("/orders/{order_id}")
def get_order(order_id: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    # Two queries: the order, then its items joined with their products.
    stmt = select(Order).where(Order.id == order_id).options(selectinload(Order.items).joinedload(OrderItem.product))
    order = session.execute(stmt).scalar_one_or_none()
    if order is None or (order.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="order not found")
    return order_view(order)


@router.post("/orders", status_code=201)
def create_order(body: OrderIn, user: User = Depends(require_writer), session: Session = Depends(get_session)):
    wanted = {item.product_id: item.qty for item in body.items}
    # All products in one query.
    products = {p.id: p for p in session.execute(select(Product).where(Product.id.in_(wanted))).scalars()}
    missing = sorted(set(wanted) - set(products))
    if missing:
        raise HTTPException(status_code=400, detail=f"unknown products: {missing}")
    total = sum(products[pid].price * qty for pid, qty in wanted.items())
    order = Order(user_id=user.id, total=total)
    order.items = [OrderItem(product_id=pid, qty=qty) for pid, qty in wanted.items()]
    session.add(order)
    session.commit()
    items = [{"product_id": pid, "product_name": products[pid].name, "qty": qty, "price": products[pid].price} for pid, qty in wanted.items()]
    return {"id": order.id, "user_id": order.user_id, "total": order.total, "items": items}


# ----- products ----------------------------------------------------------

@router.get("/products")
def list_products(q: str = "", user: User = Depends(current_user), session: Session = Depends(get_session)):
    stmt = select(Product)
    if q:
        # Parameterized LIKE: the search term is a bound parameter.
        stmt = stmt.where(Product.name.like("%" + q + "%"))
    products = session.execute(stmt).scalars().all()
    products = sorted(products, key=lambda p: (p.name.lower(), p.id))
    return [product_view(p) for p in products]


@router.post("/products", status_code=201)
def create_product(body: ProductIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    product = Product(name=body.name, sku=body.sku, price=body.price)
    session.add(product)
    try:
        session.commit()
    except IntegrityError:
        # The unique constraint on sku is enforced by the database.
        session.rollback()
        raise HTTPException(status_code=409, detail="sku already exists")
    return product_view(product)


# ----- users -------------------------------------------------------------

@router.get("/users/{user_id}")
def get_user(user_id: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    row = session.get(User, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    # The email is private: only the user and admins see it. The hash never leaves.
    return user_view(row, with_email=(row.id == user.id or user.role == "admin"))


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, user: User = Depends(current_user), session: Session = Depends(get_session)):
    if user_id != user.id:
        raise HTTPException(status_code=403, detail="you can only edit yourself")
    row = session.get(User, user_id)
    # Only the username is writable; a role in the body is ignored.
    row.username = body.username
    session.commit()
    return user_view(row, with_email=True)


@router.get("/admin/users")
def admin_list_users(user: User = Depends(require_admin), session: Session = Depends(get_session)):
    rows = session.execute(select(User).order_by(User.id)).scalars().all()
    return [user_view(u, with_email=True) for u in rows]


# ----- reports, files, fetch ---------------------------------------------

def render_template(template, context):
    return _PLACEHOLDER.sub(lambda m: str(context.get(m.group(1), "")), template)


@router.get("/reports/{name}")
def get_report(name: str, user: User = Depends(current_user), session: Session = Depends(get_session)):
    template = REPORT_TEMPLATES.get(name)
    if template is None:
        raise HTTPException(status_code=404, detail="unknown report")
    context = {
        "users": session.scalar(select(func.count(User.id))),
        "accounts": session.scalar(select(func.count(Account.id))),
        "products": session.scalar(select(func.count(Product.id))),
        "total": session.scalar(select(func.coalesce(func.sum(Account.balance), 0))),
    }
    return {"name": name, "text": render_template(template, context)}


@router.get("/files/{name:path}")
def get_file(name: str, user: User = Depends(current_user)):
    base = os.path.realpath(STATIC_DIR)
    target = os.path.realpath(os.path.join(base, name))
    # The resolved path must stay inside the static directory.
    if os.path.commonpath([base, target]) != base or not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(target, media_type="text/plain")


def host_allowed(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    host = parts.hostname.lower().rstrip(".")
    if host in BLOCKED_HOSTS or host.endswith(".localhost") or host.endswith(".internal") or host.endswith(".local"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast or address.is_unspecified)


@router.post("/fetch")
def fetch(body: FetchIn, user: User = Depends(current_user)):
    # Only the decision is returned; the request is never performed.
    return {"allowed": host_allowed(body.url)}
