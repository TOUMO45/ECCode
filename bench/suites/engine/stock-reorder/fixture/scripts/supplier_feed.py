"""Supplier feed: python scripts/supplier_feed.py data/products.json

The supplier's system reads the CSV by column position: sku, name, qty, updated.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from inventory.repo import load_products  # noqa: E402
from inventory.reports import export_csv  # noqa: E402


def feed_lines(csv_text):
    out = []
    for row in csv_text.strip().split("\n")[1:]:
        cells = row.split(",")
        sku, qty, updated = cells[0], int(cells[2]), cells[3]
        out.append(f"{sku}|{qty}|{updated}")
    return out


if __name__ == "__main__":
    print("\n".join(feed_lines(export_csv(load_products(sys.argv[1])))))
