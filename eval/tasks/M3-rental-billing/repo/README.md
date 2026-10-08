# rentals-service

Rental counter API for Acme's equipment hire shops. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/items`: the hire catalogue with day and week rates and the deposit
- `GET /api/customers/:id`: a customer account
- `GET /api/rentals/:id`: one rental (`startDate`, `dueDate`, `returnedOn`, `status` = `out`, `returned` or `cancelled`)

## Notes
- Dates are plain calendar days (`YYYY-MM-DD`). A rental starts on `startDate` and is due back on `dueDate`.
- Rates and deposits are DECIMAL columns. Sales tax is set per item category (`categories.tax_bp`, basis points); some customers (schools, charities) are tax exempt.
- Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
