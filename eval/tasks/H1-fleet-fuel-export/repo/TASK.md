# Monthly fuel export for accounting

**Requested by:** finance, accounts payable (ticket FLEET-204)

Accounting reconciles the fuel card statements every month. Today someone copies the numbers from the admin screens into a spreadsheet by hand. They need a CSV file per month that they can import into their accounting system instead.

`GET /api/exports/fuel-purchases.csv?month=2026-09`

- One row per fuel purchase made in that month, oldest first.
- Columns, in this order: `purchase_id`, `date` (YYYY-MM-DD), `plate`, `driver`, `station`, `net`, `vat`, `gross`.
- `vat` is the purchase's VAT rate applied to `net`, rounded to the nearest cent (half a cent rounds up). `gross` is `net` + `vat`.

**Acceptance**
- The export contains exactly the purchases of the requested month, with the columns above and amounts exact to the cent.
- Driver and station names come through unchanged, even when they contain commas or quotes.
- A month without purchases gives a file with only the header.
- A missing or malformed `month` is rejected the same way as on the other endpoints.
- Existing endpoints keep working (`npm test` passes).
