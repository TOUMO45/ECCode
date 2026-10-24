import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from billing.invoices import invoice_number  # noqa: E402
from billing.periods import month_key, year_key  # noqa: E402


def test_month_key_is_the_utc_month():
    assert month_key("2026-12-31T23:30:00-05:00") == "2027-01"
    assert month_key("2027-02-01T01:00:00+09:00") == "2027-01"
    assert month_key("2026-11-30T23:59:59Z") == "2026-11"


def test_invoices_are_numbered_in_the_utc_month_too():
    assert invoice_number({"placed_at": "2026-12-31T23:30:00-05:00"}, 1) == "INV-2027-01-0001"


def test_year_key_follows():
    assert year_key("2026-12-31T23:30:00-05:00") == "2027"
