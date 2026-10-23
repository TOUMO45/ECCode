'use strict';
// Good: the cause is month_key; it converts to UTC, so the report and invoice numbers both follow.
const fs = require('fs');
fs.writeFileSync('billing/periods.py', `from datetime import datetime, timezone


def month_key(placed_at):
    """The UTC month of an ISO-8601 timestamp with an offset, as YYYY-MM."""
    return datetime.fromisoformat(placed_at).astimezone(timezone.utc).strftime("%Y-%m")


def year_key(placed_at):
    return month_key(placed_at)[:4]
`);
fs.appendFileSync('tests/test_reports.py', '\n\ndef test_utc_month():\n    assert monthly_totals([{"placed_at": "2026-12-31T23:30:00-05:00", "cents": 1}]) == {"2027-01": 1}\n');
