# Feature: monthly sales report as CSV for accounting

**Requested by:** Tomasz Wiśniewski (Accounting), ticket RPT-204

For the monthly close we copy the sales report out of the JSON endpoint by hand. Please add a CSV download of the same report that we can import directly:

```
GET /api/reports/sales.csv?month=2026-09
```

- A header row, then one row per order in the report (the same orders as `GET /api/reports/sales`, oldest first), then a totals row.
- Columns: `order_number`, `customer`, `placed_on` (the date, `YYYY-MM-DD`), `total` (e.g. `1249.90`).
- Totals row: `TOTAL` in the first column, the month's total in the `total` column, the other columns empty. It must match the JSON report to the cent.
- Customer names can contain commas and quotes, for example `Smith, Jones & Co` or `Joe's "Best" Bikes`. They must not break the columns.
- A month without sales gives the header and a totals row of `0.00`.
- An invalid month gets the same error as the JSON report.
- `Content-Type: text/csv`, and the browser should save it as `sales-2026-09.csv` (for the requested month).

**Acceptance**
- The CSV has exactly the report's orders and its total, to the cent, for any month.
- Names with commas or quotes stay in their column.
- Empty months and invalid months behave as described above.
- Existing behaviour stays as it is (`npm test` passes).
