# reports-service

Sales reports for Acme's back office. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/reports/sales?month=YYYY-MM`: the month's sales, `{ "month", "orders": [{ "number", "customer", "placedAt", "total" }], "total" }`. Orders are listed oldest first.

## What counts as a sale
Only `completed` orders count (`pending`, `cancelled` and `refunded` orders don't). An order belongs to the month in which it was placed, in UTC.

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
