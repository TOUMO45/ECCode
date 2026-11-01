"""initial schema: users, accounts, transfers, products, orders, order_items

Revision ID: 0001
Revises:
Create Date: 2026-10-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=128), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("tokens_valid", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reset_token", sa.String(length=64), nullable=True),
        sa.Column("reset_used", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("username", name="uq_users_username"),
        sa.UniqueConstraint("token", name="uq_users_token"),
    )
    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("balance", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_accounts_owner_id", "accounts", ["owner_id"])
    op.create_table(
        "transfers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("from_account", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("to_account", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("sku", sa.String(length=32), nullable=False),
        sa.Column("price", sa.Integer(), nullable=False),
        sa.UniqueConstraint("sku", name="uq_products_sku"),
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
    )
    op.create_index("ix_orders_user_id", "orders", ["user_id"])
    op.create_table(
        "order_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
    )
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"])


def downgrade():
    op.drop_index("ix_order_items_order_id", table_name="order_items")
    op.drop_table("order_items")
    op.drop_index("ix_orders_user_id", table_name="orders")
    op.drop_table("orders")
    op.drop_table("products")
    op.drop_table("transfers")
    op.drop_index("ix_accounts_owner_id", table_name="accounts")
    op.drop_table("accounts")
    op.drop_table("users")
