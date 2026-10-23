# people

A user directory with profile search.

- `src/directory.js` registers people by handle. Handles are case-sensitive: `Ada` and `ada` are two different people.
- `src/search.js` indexes profile names and answers word queries (every word must match).
- `src/app.js` wires the two together.
