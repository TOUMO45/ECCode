from collections import defaultdict

from billing.periods import month_key


def monthly_totals(orders):
    """{YYYY-MM: total cents} over orders [{placed_at, cents}], months sorted."""
    totals = defaultdict(int)
    for order in orders:
        totals[month_key(order["placed_at"])] += order["cents"]
    return dict(sorted(totals.items()))
