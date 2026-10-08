# billing-service

Invoices API for Acme billing. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/invoices`: list with totals
- `GET /api/invoices/:id`: one invoice with lines and totals
- `GET /api/invoices/:id/export.csv`: CSV export for accounting

Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
