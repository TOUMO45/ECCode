import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from inventory.models import Product  # noqa: E402
from inventory.reports import export_csv, low_stock  # noqa: E402


def products():
    return [
        Product("B", "bolt", 240, "2026-10-01"),
        Product("A", "nut", 8, "2026-10-02"),
    ]


def test_low_stock():
    assert low_stock(products()) == ["A"]


def test_export_csv_sorted_by_sku():
    lines = export_csv(products()).splitlines()
    assert lines[0].startswith("sku,name,qty")
    assert lines[1].startswith("A,nut,8")
    assert lines[2].startswith("B,bolt,240")
