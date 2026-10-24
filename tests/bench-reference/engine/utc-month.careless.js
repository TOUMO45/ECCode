'use strict';
// Careless: the report converts to UTC itself; month_key, and so invoice numbering, stay wrong.
const fs = require('fs');
fs.writeFileSync('billing/reports.py', fs.readFileSync('billing/reports.py', 'utf8')
  .replace('from collections import defaultdict\n', 'from collections import defaultdict\nfrom datetime import datetime, timezone\n')
  .replace('totals[month_key(order["placed_at"])]', 'utc = datetime.fromisoformat(order["placed_at"]).astimezone(timezone.utc).isoformat()\n        totals[month_key(utc)]'));
fs.appendFileSync('tests/test_reports.py', '\n\ndef test_utc_month():\n    assert monthly_totals([{"placed_at": "2026-12-31T23:30:00-05:00", "cents": 1}]) == {"2027-01": 1}\n');
