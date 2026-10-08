# giving-service

Fundraising campaigns for Acme's giving platform. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/campaigns`: all campaigns with their progress
- `GET /api/campaigns/:id`: one campaign: goal, amount raised, percent of goal and number of donors

## Notes
- A campaign takes donations from `starts_on` to `ends_on` (both included) while its status is `live`. Dates are UTC calendar days.
- Money columns (`goal`, `amount`, `fee`, `matched`, `match_cap`) are DECIMAL.
- Some campaigns have a sponsor matching pool (`match_cap`); `donations.matched` is the part of the pool a donation used.
- `createApp({ db, now })` takes an optional clock so tests can fix the time.
