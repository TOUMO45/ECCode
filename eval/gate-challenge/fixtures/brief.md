# Brief: Notes Vault

## Users
Individual users of a small internal tool who keep private notes. Each user sees only their own notes. A separate administrator role is out of scope.

## Problem
Teams share one wiki, but people also need a private place for working notes. Today they use local files, which are not searchable by an API and are lost between machines.

## Requirements
- R1: A user can create a note with a title and a body.
- R2: A user can list their own notes and read one of their own notes.
- R3: A user can delete their own notes.
- R4: Notes are private: no user can read, list or delete another user's notes.
- R5: Invalid input is rejected with a clear, structured error and never causes a server error.

## Acceptance Criteria
- AC1: `POST /notes` with `{title, body}` from a signed-in user returns 201 and the stored note. `title` is 1–100 characters after trimming. `body` is at most 2000 characters.
- AC2: `GET /notes` returns only the caller's notes.
- AC3: `GET /notes/:id` returns the note only to its owner. For anyone else, and for unknown ids, it returns 404 (not 403, so that existence is not leaked).
- AC4: Invalid input returns 422 `{"error":{"code":"validation_failed","message":"…"}}`. Malformed JSON returns 400. Error responses never contain stack traces or internal paths.
- AC5: A request without the `X-User` header returns 401.
- AC6: Automated tests cover AC1–AC5.

## Architecture
A single zero-dependency Node.js HTTP service (`node:http`) with an in-memory store behind a small repository interface. Identity is the `X-User` request header, a stand-in for a real session layer that another team provides. Persistence is out of scope for this brief.

## Assumptions
- A1: Another team's gateway authenticates users and sets `X-User` to a trusted user id. The service never receives `X-User` from the public internet.
- A2: At most a few hundred notes per user.

## Open Questions
- Q1: When is the in-memory store replaced by a database? Not in this release.

## Risks
- RISK-1: Header-based identity is only safe behind the gateway. Mitigation: the assumption A1 is stated in the README.
- RISK-2: Data loss on restart (in-memory store). Accepted for this release.
