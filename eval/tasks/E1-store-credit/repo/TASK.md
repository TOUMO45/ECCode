# Feature: issue store credit from the support console

**Requested by:** Hannah Cole (Support Operations), ticket CRED-57

Today support agents ask engineering to issue store credit by hand. The support console needs an endpoint it can call:

```
POST /api/customers/:id/credits
{ "amount": "12.50", "reason": "Late delivery, order SO-88213" }
```

- `amount`: a positive amount with at most two decimals, sent as a string like every amount in our API (`"12.50"`, `"5"`, `"0.99"`). At most `500.00` per credit; bigger amounts need a manager and go through another process.
- `reason`: required, up to 200 characters. Finance reads it in the monthly review.
- Unknown customer: `404`.
- Success: `201` with the credit, `{ "id", "customerId", "amount", "reason", "createdAt" }`, with `amount` formatted like our other amounts (`"12.50"`).

The customer's balance (`creditBalance` on `GET /api/customers/:id`) goes up by the credit, exact to the cent.

**Acceptance**
- A valid credit is stored, returned with `201` and added to the customer's balance exactly.
- Invalid amounts or reasons are rejected with a clear error that names the field, and nothing changes.
- Unknown customers get a `404`.
- Existing behaviour stays as it is (`npm test` passes).
