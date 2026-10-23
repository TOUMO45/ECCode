import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from inventory.models import Product  # noqa: E402
from inventory.reports import export_csv  # noqa: E402


def test_existing_columns_keep_their_positions():
    text = export_csv([Product.from_dict({"sku": "A", "name": "nut", "qty": 8, "updated": "2026-10-02"})])
    header = text.splitlines()[0].split(",")
    row = text.splitlines()[1].split(",")
    assert header[:4] == ["sku", "name", "qty", "updated"]
    assert row[:4] == ["A", "nut", "8", "2026-10-02"]


def test_supplier_feed_unchanged():
    out = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "supplier_feed.py"), os.path.join(ROOT, "data", "products.json")],
        capture_output=True, text=True, check=True,
    ).stdout
    assert out.splitlines() == ["BOLT-M6|240|2026-10-01", "NUT-M6|8|2026-10-02", "WASHER-6|12|2026-09-28"]
