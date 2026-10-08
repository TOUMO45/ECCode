# parking-service

Lots, live occupancy and parking sessions for Acme's staff and visitor car parks. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/lots/:id`: a lot with its name and capacity
- `GET /api/lots/:id/occupancy`: `{ "lotId", "name", "capacity", "occupied", "free", "full" }`. The entrance signs poll this every 5 seconds per lot.
- `POST /api/lots/:id/entries` with `{"plate": "LS21 KPX"}`: the entry gate opens a parking session (`201`). A full lot answers `409 conflict`.
- `POST /api/sessions/:id/exit`: the exit gate closes a parking session. Closing it twice is a `409 conflict`.

Counting the open sessions of a lot is the most expensive query of the service at peak times, so occupancy is cached (`src/lots/occupancy.js`). Lot names and capacities change a few times a year and are cached too.

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. A parking session is open while `exited_at` is empty.
