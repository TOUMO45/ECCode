"""Order pricing, in integer cents."""
TAX_RATE = 0.2


def order_total(lines):
    """Quantity times unit price for every line, plus tax, rounded half up."""
    subtotal = sum(quantity * unit for quantity, unit in lines)
    return int(subtotal * (1 + TAX_RATE) + 0.5)
