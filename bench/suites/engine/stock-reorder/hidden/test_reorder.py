import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from inventory.models import Product  # noqa: E402
from inventory.repo import load_products, save_products  # noqa: E402
from inventory.reports import export_csv, low_stock  # noqa: E402


def make(sku, qty, level=None):
    d = {"sku": sku, "name": sku.lower(), "qty": qty, "updated": "2026-10-20"}
    if level is not None:
        d["reorder_level"] = level
    return Product.from_dict(d)


def test_saved_products_default_to_ten():
    products = load_products(os.path.join(ROOT, "data", "products.json"))
    assert [p.reorder_level for p in products] == [10, 10, 10]
    assert low_stock(products) == ["NUT-M6"]


def test_own_reorder_level_is_used():
    products = [make("A", 15, 20), make("B", 5, 3), make("C", 9)]
    assert low_stock(products) == ["A", "C"]


def test_round_trip_keeps_the_level(tmp_path):
    path = tmp_path / "p.json"
    save_products(path, [make("A", 1, 4)])
    assert load_products(path)[0].reorder_level == 4
    assert json.loads(path.read_text())[0]["reorder_level"] == 4


def test_csv_includes_the_reorder_level():
    text = export_csv([make("A", 1, 4)])
    header = text.splitlines()[0].split(",")
    row = text.splitlines()[1].split(",")
    assert "reorder_level" in header
    assert row[header.index("reorder_level")] == "4"
