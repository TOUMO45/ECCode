# courier-service

Earnings and payouts of Acme's delivery couriers. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/couriers/:id`: a courier with their current `balance` (earnings not paid out yet)
- `GET /api/payouts/:id`: one payout, `{ "id", "courierId", "kind", "amount", "fee", "net", "createdAt" }`

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. Every completed delivery adds a row to `earnings`. The weekly payout run (a separate batch job) inserts `weekly` rows into `payouts`. A courier's balance is the sum of their earnings minus the sum of their payout amounts.
