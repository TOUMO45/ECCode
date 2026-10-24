import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from billing.invoices import invoice_number  # noqa: E402
from billing.reports import monthly_totals  # noqa: E402


def test_monthly_totals():
    orders = [
        {"placed_at": "2026-11-03T10:00:00+00:00", "cents": 500},
        {"placed_at": "2026-11-20T12:00:00+00:00", "cents": 250},
        {"placed_at": "2026-12-01T09:00:00+00:00", "cents": 100},
    ]
    assert monthly_totals(orders) == {"2026-11": 750, "2026-12": 100}


def test_invoice_number():
    assert invoice_number({"placed_at": "2026-11-03T10:00:00+00:00"}, 7) == "INV-2026-11-0007"
