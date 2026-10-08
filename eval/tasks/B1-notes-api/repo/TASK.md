# Feature: list and create notes over the API

**Requested by:** Priya Natarajan (product, workspace app), ticket NOTES-142

The new notes sidebar needs to list notes and the editor needs to save new ones. Today the API can only fetch a single note and the tag cloud.

1. `GET /api/notes`: the notes, newest first. `GET /api/notes?tag=billing` shows only notes that have that tag. Each note looks exactly like `GET /api/notes/:id`.
2. `POST /api/notes` with a body like

   ```json
   { "title": "Weekly sync", "body": "Agenda: roadmap, hiring", "tags": ["meetings", "team"] }
   ```

   - `title`: required, 1 to 120 characters. Leading and trailing spaces are trimmed.
   - `body`: optional, up to 5,000 characters.
   - `tags`: optional, a list of up to 10 tags, each 1 to 30 characters.

   It answers `201` with the created note, in the same shape as `GET /api/notes/:id`.

If the editor sends something invalid, reject it with a clear error so the editor can tell the user what is wrong, and don't save anything.

**Acceptance**
- A created note can be fetched by its id and shows up first in the list.
- The tag filter returns only notes with exactly that tag, newest first.
- Invalid input is rejected with a clear error and nothing is saved.
- Existing endpoints keep working (`npm test` passes).
