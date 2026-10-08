# credits-service

Store credit for Acme customers. Checkout reads the balance from here when a customer pays with store credit. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/customers/:id`: `{ "id", "name", "creditBalance": "42.00" }`

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.

- `customers.credit_balance`: the customer's current store-credit balance, as read by checkout.
- `credits`: the history of issued credits (`customer_id`, `amount`, `reason`, `created_at`).
