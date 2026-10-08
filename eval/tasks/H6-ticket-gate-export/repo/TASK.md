# Guest list export for the venue gate system

**Requested by:** live events operations (ticket EVT-318)

From next season our venues scan tickets with Gatekeeper. Before doors open, Gatekeeper downloads a guest list per event as a CSV file. Please add:

`GET /api/events/:id/gate-list.csv`

Gatekeeper's import spec (from their integration guide):
- UTF-8 with Unix line endings (`\n`). Every line ends with `\n`, including the last one.
- The first line is exactly `ticket_code,holder_name,tier,checked_in`.
- Fields are separated by commas. A value is enclosed in double quotes only when it contains a comma, a double quote or a line break, and a double quote inside a value is written twice. No other value may be quoted: Gatekeeper's parser is strict and would take the quotes as part of the ticket code or name.
- `checked_in` is `1` or `0`.

Only valid tickets go on the list (no cancelled or refunded ones), sorted by ticket code.

**Acceptance**
- The file follows Gatekeeper's spec above, for every event.
- Unknown events give the usual 404.
- Existing endpoints keep working (`npm test` passes).
