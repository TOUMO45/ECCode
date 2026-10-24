def month_key(placed_at):
    """The month of an ISO-8601 timestamp, as YYYY-MM."""
    return placed_at[:7]


def year_key(placed_at):
    return month_key(placed_at)[:4]
