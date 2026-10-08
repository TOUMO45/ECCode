# Bug: invoice totals are garbled when a shipping fee is present

**Reported by:** accounting (ticket BILL-311)

`GET /api/invoices/2` returns `"total": "12015.00"` (the expected total is `"135.00"`). The CSV export for the same invoice is wrong in the same way. Invoices without a shipping fee look fine.

Accounting also says some discounted invoices are "off by a cent" compared with their spreadsheet. Please check that the totals are right in general, not only for this one invoice.

**Acceptance**
- Invoice totals (subtotal, discount, shipping, total) are exact to the cent on every endpoint that shows them.
- Totals in the CSV export match the JSON API.
- Existing behaviour that is not broken stays as it is (`npm test` passes).
