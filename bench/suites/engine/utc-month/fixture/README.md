# billing

Orders carry an ISO-8601 timestamp with its UTC offset (`placed_at`). Every period we report or number by, months included, is a UTC period.

- `billing/periods.py`: period keys for timestamps.
- `billing/reports.py`: monthly totals.
- `billing/invoices.py`: invoice numbers (`INV-<month>-<seq>`).
