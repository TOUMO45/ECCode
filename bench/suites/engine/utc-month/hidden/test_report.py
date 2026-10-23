import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from billing.reports import monthly_totals  # noqa: E402


def test_late_evening_order_counts_in_the_utc_month():
    orders = [
        {"placed_at": "2026-12-31T23:30:00-05:00", "cents": 100},
        {"placed_at": "2026-12-31T10:00:00-05:00", "cents": 40},
    ]
    assert monthly_totals(orders) == {"2026-12": 40, "2027-01": 100}


def test_positive_offsets_move_back():
    orders = [{"placed_at": "2027-02-01T01:00:00+09:00", "cents": 5}]
    assert monthly_totals(orders) == {"2027-01": 5}


def test_utc_and_z_timestamps_unchanged():
    orders = [
        {"placed_at": "2026-11-03T10:00:00+00:00", "cents": 500},
        {"placed_at": "2026-11-30T23:59:59Z", "cents": 1},
    ]
    assert monthly_totals(orders) == {"2026-11": 501}
