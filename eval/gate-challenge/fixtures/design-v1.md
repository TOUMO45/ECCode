# Design: Notes Vault

## Components
- `server.js`: HTTP routing and request handling.
- `store.js`: in-memory repository for notes.

## Interface Contracts
- `POST /notes`: create a note.
- `GET /notes`: list notes.
- `GET /notes/:id`: fetch a note by id.
- `DELETE /notes/:id`: delete a note.
All endpoints return JSON.

## Data Design
Notes are kept in a Map keyed by id.

## Security
TBD. To be decided during implementation.

## Testing Strategy
Manual testing of the endpoints with curl.

## Deployment
`node src/server.js`. Any signed-in user can fetch a note by its id, which keeps the API simple.
