# Instant cash-out for couriers

**Requested by:** courier operations (ticket CRR-77)

Couriers are paid once a week. Many of them asked to get their money sooner, so we are adding an instant cash-out to their bank card, for a fee.

`POST /api/couriers/:id/payouts` with `{"amount": "40.00"}`

- `amount` is what leaves the courier's balance. It must be positive, have at most two decimals and must not exceed the courier's current balance.
- The instant payout fee is 1.5% of `amount`, rounded to the nearest cent (half a cent rounds up). The fee is withheld from the transfer, so the courier receives `amount` minus `fee`.
- On success, respond `201` with `{ "id", "courierId", "amount", "fee", "net" }` (amounts as decimal strings, like the other endpoints). The courier's `balance` drops by `amount`, and the payout shows up on `GET /api/payouts/:id` with kind `instant`.
- Invalid amounts, including amounts above the balance, are refused with the usual validation error on `amount`. Unknown couriers are a 404.

**Acceptance**
- Payouts, fees and balances are exact to the cent.
- Existing endpoints keep working (`npm test` passes).
