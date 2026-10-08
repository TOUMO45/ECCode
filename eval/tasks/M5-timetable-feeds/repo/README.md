# timetable-service

School timetable data for Acme's school management suite. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/classes`: the classes
- `GET /api/classes/:id`: one class
- `GET /api/teachers/:id`: one teacher
- `GET /api/rooms/:id`: one room
- `GET /api/periods`: the bell schedule

## Data model
- `periods`: the daily bell schedule (`number`, local `start` and `end` as `HH:MM`).
- `lessons`: the recurring weekly grid. `weekday` is 1 (Monday) to 5 (Friday). `week_type` is `A`, `B` or `both`.
- `terms`: `starts_on` is always a Monday and `ends_on` a Friday.
- `closures`: days the school is closed.
- `substitutions`: one-off changes to a lesson on one date: another teacher, another room, or a cancellation.

## Notes
- Dates are calendar days in the school's time zone (`src/config.js`). Times of day are local to the school.
- `createApp({ db, now })` takes an optional clock so tests can fix the time.
- Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
