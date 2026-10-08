# Feature: weekly timetables that match what really happens, and a feed for the corridor signage

**Requested by:** School office (ticket TT-88)

The recurring grid in the database is not what happens in a given week: we run an A/B fortnight, we close for holidays and staff days, and the office changes teachers and rooms or cancels lessons day by day. Teachers and students want to see the real week, and the corridor screens need a feed.

**Class timetable: `GET /api/classes/:id/timetable?week=2026-03-09`**
**Teacher timetable: `GET /api/teachers/:id/timetable?week=2026-03-09`**
`week` is the Monday of the week. If it is left out, it means the current week at the school (the school's own calendar day, see `src/config.js`). A date that is not a Monday, or is not a date, is a validation error on `week`. The answer is
`{ "week", "term", "weekType", "days": [ { "date", "weekday", "closed", "lessons": [ ... ] } ] }`
with the five days Monday to Friday always present (`weekday` is `Mon`..`Fri`), and each lesson as
`{ "period", "start", "end", "subject", "class", "teacher", "room", "substituted", "cancelled" }` (class code, teacher name and room code as text), ordered by period and then class code.
- Terms run Monday to Friday. The first week of each term is an A week, then B, A, B and so on, counting calendar weeks from the term's first Monday (a week with a closure day in it still counts). A lesson marked `A` or `B` only runs in that kind of week; `both` runs every week. A week that is in no term (the break between terms) has `term` and `weekType` set to null and no lessons.
- On a closure day nothing runs: `closed` holds the reason and `lessons` is empty. Otherwise `closed` is null.
- A substitution changes one lesson on one date. A new teacher or room replaces the usual one and the lesson is marked `substituted`. A cancelled lesson stays on the timetable, marked `cancelled`.
- The teacher timetable shows the lessons a teacher actually has that week: lessons they cover for a colleague are in, lessons that were handed over to someone else are not.

**Room feed: `GET /api/rooms/:id/schedule.csv?week=2026-03-09`**
This is loaded every night by the corridor signage controllers (Lumiboard). Their loader is very simple: it splits the file on line feeds and each line on commas, has no idea what a quote is, and treats a carriage return as part of the last field. So:
- plain text, every line (the last one too) ends with a single line feed, no quoting of any kind;
- first line `date,start,end,class,subject,teacher`, then one line per lesson held in that room that week (a lesson moved into the room counts, a lesson moved out does not, cancelled lessons are left out), ordered by date and then start time;
- `date` as `YYYY-MM-DD`, `start` and `end` as local 24-hour `HH:MM`;
- a comma inside a subject or a teacher name would break their loader, so it is written as a semicolon;
- a week without lessons is just the header line.
`week` works as above. Unknown rooms are a 404.

**Acceptance**
- The timetables and the feed behave as described, with the same error format as the rest of the service.
- Existing behaviour that is not part of this request stays as it is (`npm test` passes).
