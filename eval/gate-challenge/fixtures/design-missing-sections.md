# Design: Notes Vault

## Components
- `server.js`: HTTP routing.
- `store.js`: in-memory repository.

## Interface Contracts
- `POST /notes`, `GET /notes`, `GET /notes/:id`, `DELETE /notes/:id`.

## Data Design
Notes are kept in a Map.

## Deployment
`node src/server.js`
