# ticketing-service

Events and tickets for Acme Live. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/events/:id`: an event with the number of valid tickets sold
- `GET /api/tickets/:code`: one ticket, `{ "code", "eventId", "holderName", "tier", "status", "checkedIn", "price" }`

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. A ticket's `status` is `valid`, `cancelled` or `refunded`. `checked_in` is set when the ticket was scanned at a previous entry (multi-day passes, re-entry).
