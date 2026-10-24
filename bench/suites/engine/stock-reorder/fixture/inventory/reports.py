LOW_STOCK_THRESHOLD = 10


def low_stock(products):
    """SKUs whose quantity is below the threshold, sorted."""
    return sorted(p.sku for p in products if p.qty < LOW_STOCK_THRESHOLD)


def export_csv(products):
    """One header line, then one line per product: sku,name,qty,updated."""
    lines = ["sku,name,qty,updated"]
    for p in sorted(products, key=lambda p: p.sku):
        lines.append(f"{p.sku},{p.name},{p.qty},{p.updated}")
    return "\n".join(lines) + "\n"
