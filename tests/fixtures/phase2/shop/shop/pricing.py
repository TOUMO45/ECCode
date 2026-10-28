"""Pure pricing rules: discounts, tax and rounding. Amounts are in cents."""


def bulk_discount(quantity: int) -> float:
    """Discount rate for a line: 10% from 10 units, 20% from 100."""
    if quantity >= 100:
        return 0.2
    if quantity >= 10:
        return 0.1
    return 0.0


def line_total(unit_cents: int, quantity: int) -> int:
    gross = unit_cents * quantity
    return round_cents(gross * (1 - bulk_discount(quantity)))


def tax(amount_cents: int, rate: float) -> int:
    return round_cents(amount_cents * rate)


def round_cents(value: float) -> int:
    """Round half up to the nearest cent."""
    if value < 0:
        return -round_cents(-value)
    return int(value + 0.5)


def page_bounds(page: int, size: int) -> tuple:
    """Zero-based page -> (start, end) slice bounds."""
    if page < 0 or size <= 0:
        raise ValueError("page must be >= 0 and size > 0")
    start = page * size
    return start, start + size


def normalize_name(name: str) -> str:
    return " ".join(name.strip().lower().split())
