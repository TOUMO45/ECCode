# payments-service

Payments and refunds for Acme checkout. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/payments/:id`: a payment with `amount`, `refunded` and `refundable`
- `POST /api/payments/:id/refunds` with `{"amount": "12.50"}`: create a refund. The total refunded may never exceed the payment amount.
