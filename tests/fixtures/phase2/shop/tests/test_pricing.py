from shop.pricing import bulk_discount, line_total, normalize_name, page_bounds, round_cents, tax


def test_no_discount_below_ten():
    assert bulk_discount(9) == 0.0


def test_discount_at_hundred():
    assert bulk_discount(100) == 0.2


def test_line_total_single():
    assert line_total(100, 1) == 100


def test_tax_rounding():
    assert tax(1000, 0.08) == 80


def test_round_cents_half_up():
    assert round_cents(2.5) == 3


def test_page_bounds_first_page():
    assert page_bounds(0, 3) == (0, 3)


def test_page_bounds_rejects_negative():
    import pytest
    with pytest.raises(ValueError):
        page_bounds(-1, 3)


def test_normalize_name_collapses_spaces():
    assert normalize_name("  Red   Apple ") == "red apple"
