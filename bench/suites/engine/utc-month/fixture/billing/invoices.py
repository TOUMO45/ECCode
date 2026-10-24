from billing.periods import month_key


def invoice_number(order, seq):
    """INV-<YYYY-MM>-<seq, 4 digits>: numbered within the order's month."""
    return f"INV-{month_key(order['placed_at'])}-{seq:04d}"
