# notes-service

Team notes for the Acme workspace app. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/notes/:id`: one note, `{ "id", "title", "body", "tags": [...], "createdAt" }`
- `GET /api/tags`: tag cloud, `[{ "tag": "billing", "count": 3 }, ...]` sorted by tag. The mobile app parses this format directly, so it stays as it is.

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. `notes.tags` holds the note's tags as a JSON array of strings. Some notes were imported from the old wiki and keep their original creation date.
