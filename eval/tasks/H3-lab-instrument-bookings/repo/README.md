# lab-service

Instruments and instrument bookings of the Acme research core facility. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/instruments`: all instruments, `[{ "id", "name", "room", "status" }, ...]`. The lobby kiosk parses this format directly, so it stays as it is.
- `GET /api/instruments/:id`: one instrument. `status` is `active` or `retired`.
- `GET /api/bookings/:id`: one booking, `{ "id", "instrumentId", "bookedBy", "purpose", "startsAt", "endsAt" }`

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. Bookings so far were imported from the facility's booking spreadsheet.
