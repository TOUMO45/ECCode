# Book instruments through the API

**Requested by:** core facility team (ticket LAB-57)

Instrument bookings still live in a shared spreadsheet, and double bookings happen every few weeks. The new lab portal needs two endpoints:

- `GET /api/instruments/:id/bookings`: the instrument's bookings, earliest first.
- `POST /api/instruments/:id/bookings` with
  `{"bookedBy": "r.mendes", "purpose": "Live-cell imaging", "startsAt": "2026-10-12T09:00:00Z", "endsAt": "2026-10-12T11:00:00Z"}`
  creates a booking and responds `201` with it. `purpose` is optional.

Bookings in responses look like `GET /api/bookings/:id`: `id`, `instrumentId`, `bookedBy`, `purpose`, `startsAt`, `endsAt`.

Rules for new bookings:
- `bookedBy` is required. `startsAt` and `endsAt` are ISO-8601 date-times with a time zone (`Z` or an offset such as `+02:00`; the portal sends the user's local offset), and `endsAt` must be after `startsAt`.
- A booking must not overlap another booking of the same instrument. Back-to-back bookings (one ends exactly when the next starts) are fine.
- Retired instruments cannot be booked.

**Acceptance**
- Bookings can be listed and created as described above. Refused requests get the standard Acme error responses.
- Existing endpoints keep working (`npm test` passes).
