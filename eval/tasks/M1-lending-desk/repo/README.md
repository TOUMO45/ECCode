# lending-service

Lending desk API for the Acme library branches. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/books`: the catalogue, with copy counts and how many copies are on the shelf
- `GET /api/books/:id`: one title
- `GET /api/members/:id`: a member with their number of open loans
- `POST /api/loans` with `{"memberId": 1, "copyId": 9}`: check a copy out to a member

## Notes
- Dates (`checkedOutOn`, `dueOn`, `returnedOn`) are calendar days in the branch's time zone (`src/config.js`), not UTC days. `src/lib/dates.js` has the helpers.
- `createApp({ db, now })` takes an optional clock so tests can fix the time.
- Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
