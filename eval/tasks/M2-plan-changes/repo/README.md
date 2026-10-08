# subscriptions-service

Plans and customer subscriptions for Acme's SaaS billing. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/plans`: the plans on sale
- `GET /api/subscriptions/:id`: a subscription with its plan, seats, billing cycle and balances

## Notes
- A billing cycle runs from `cycleStart` (inclusive) to `cycleEnd` (exclusive, the next renewal day). Cycles follow calendar months, so they are 28 to 31 days long.
- Cycle dates are calendar days in the **account's** time zone (`accounts.timezone`), not UTC days.
- `creditBalance` is account credit; `pendingCharge` is money that goes on the next invoice. Both are DECIMAL columns.
- `createApp({ db, now })` takes an optional clock so tests can fix the time.
