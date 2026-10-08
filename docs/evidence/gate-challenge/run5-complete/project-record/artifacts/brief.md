# Brief: Notes Vault (rev 2)

## Users
- Primary: individual users of a small internal tool who keep private working notes. Jobs: capture a note, find/read it later, delete it. Each user sees only their own notes.
- Secondary: developers of other internal tools who call the notes API; the platform team that runs the gateway and the service.
- An administrator role is out of scope.

## Problem
Teams share one wiki, but people also need a private place for working notes. Today they use local files, which cannot be reached through an API and are lost between machines.
- Evidence: the stated request from the product owner. No frequency or cost data was collected (assumption A3).
- Assumption: the pain occurs daily for each user and costs minutes per lost or unfindable note.
- Consequence for design (ARCH-1): because the problem is "lost notes", notes must survive a service restart. This release therefore includes durable file persistence; it is not a prototype.

## Requirements
Functional
- R1: A user can create a note with a title and a body.
- R2: A user can list their own notes and read one of their own notes.
- R3: A user can delete their own notes.
- R4: Notes are private: no user can read, list or delete another user's notes.
- R5: Invalid input is rejected with a clear, structured error; no input causes a stack trace or internal detail in a response.
- R6: Notes persist across service restarts (file-backed store, see Architecture).
- R7: Identity comes from the `X-User` header and is strictly validated.
- R8: Resource limits: request-size cap, per-user note cap.

Non-functional
- NFR1 Security: only the validated `X-User` identifies callers; the service binds to loopback by default; storage uses `Map`, never plain objects keyed by user input.
- NFR2 Privacy: logs never contain note titles, bodies or request bodies.
- NFR3 Performance: p95 latency under 50 ms for any endpoint with 500 notes per user and 100 users on one instance (local measurement).
- NFR4 Reliability: a crash during a write never corrupts the data file (write to temp file, then atomic rename).
- NFR5 Accessibility: not applicable, API only; error messages are plain text in a structured body.
- NFR6 Cost: zero runtime dependencies, single process, no paid services.

## Main Workflows
1. Create: the gateway authenticates and forwards `POST /notes` with `X-User`. The service validates the header, then the content type and size, then the body, enforces the note cap, stores the note, persists it and returns 201 with the note.
2. List and read: `GET /notes` returns the caller's notes, newest first. `GET /notes/:id` returns one note if the caller owns it, otherwise 404.
3. Delete: `DELETE /notes/:id` removes an owned note and returns 204; otherwise 404.
4. Restart: the service loads the data file on start and serves the same notes.

## Note schema
`{ "id": <UUID v4 from crypto.randomUUID>, "owner": <X-User>, "title": string, "body": string, "createdAt": <ISO-8601 UTC string> }`. `title` is stored trimmed. `body` defaults to `""` when absent. Ids are random, so they are not guessable; access control still never relies on id secrecy. List ordering: `createdAt` descending, ties broken by insertion order (newest first). `GET /notes` returns `{"notes":[...]}`. `POST` returns the note object.

## Acceptance Criteria
Checks run in this order: route and method, `X-User` (401), content type, size (413), JSON parse (400), validation (422), then business rules.

- AC1 (R1): `POST /notes` with `{title, body}` returns 201 and the full note per the schema. `title` is 1–100 characters after trimming; `body` is a string of at most 2000 characters.
- AC2 (R2, R4): `GET /notes` returns only the caller's notes, newest first.
- AC3 (R2, R4): `GET /notes/:id` returns the note only to its owner. For anyone else and for unknown ids it returns 404 (not 403).
- AC4 (R3, R4): `DELETE /notes/:id` returns 204 only for its owner and removes the note. Otherwise 404 and nothing is deleted.
- AC5 (R5) error contract. All errors have the shape `{"error":{"code":"…","message":"…"}}` and never contain stack traces or paths:
  - malformed JSON: 400 `bad_json`
  - non-object JSON (array, string, null), missing or non-string `title`, non-string `body`, title empty after trim, title >100 or body >2000 characters: 422 `validation_failed`
  - `Content-Type` not `application/json` on POST: 415 `unsupported_media_type`
  - unknown route: 404 `not_found`
  - known route with the wrong method: 405 `method_not_allowed` with an `Allow` header
  - `:id` that is not a UUID: 404 `not_found` (same as unknown id)
  - unexpected internal error: 500 with the fixed body `{"error":{"code":"internal","message":"Internal error"}}`; a test forces a repository failure and asserts no stack, path or exception text appears.
- AC6 (R7): `X-User` must match `^[A-Za-z0-9._@-]{1,64}$`. A missing, empty, whitespace-only, overlong or invalid-charset value, or a repeated header (value containing a comma, or `rawHeaders` showing more than one), returns 401 `unauthorized`. This check happens before any body parsing. Test values include `__proto__`, `constructor`, `a b`, 65 characters, and a duplicate header. `__proto__` is syntactically valid and must work as an ordinary, isolated user id (storage is a `Map`), and must not affect other users.
- AC7 (R8): A request body over 16 KB returns 413 `payload_too_large`; the service stops reading and closes the connection. A user who already holds 500 notes receives 409 `note_limit_reached` on create; deleting a note allows creating again. Rate limiting is explicitly owned by the gateway (not implemented here).
- AC8 (R6, NFR4): After creating notes, restarting the service (new process or new store instance on the same file) returns the same notes; a deletion also persists. A leftover temp file or a corrupt data file at start makes the service refuse to start with a clear message on stderr, and it never overwrites the file.
- AC9 (NFR1): The default bind host is `127.0.0.1`; `HOST` and `PORT` env vars override it. Binding to a non-loopback host logs a startup warning that `X-User` must only be reachable via the trusted gateway.
- AC10 (NFR2): Each request logs one line: method, route template, status, duration. A test creates a note with a sentinel title/body and asserts the sentinel does not appear in the log output.
- AC11: Automated tests cover AC1–AC10.

## Scope
In scope: the four endpoints above (create, list, read, delete) with error handling, file persistence, limits, validation, minimal logging.
Out of scope, with reason:
- Authentication and sessions: provided by another team's gateway.
- Rate limiting and TLS: gateway-owned.
- Update/edit and search of notes: not requested for this release.
- Database, multi-instance deployment and backups: a single-instance file store suffices for a few hundred notes per user; the repository interface keeps replacement possible.
- Admin role and sharing: conflicts with privacy goals.

## Architecture
Components: HTTP layer (`node:http`) → router/middleware (identity, content-type, size cap, JSON parse, validation) → note service (rules, note cap) → repository interface → `FileNoteRepository` (in-memory `Map<userId, Map<noteId, note>>` loaded at start, flushed on each write to a JSON file via temp file + atomic rename; writes serialized through a promise queue).

```
client -> [gateway: authN, rate limit, TLS] -> X-User
   -> Notes service (127.0.0.1) -> router -> service -> repository -> data.json
```
Trust boundary: between the gateway and the service. The service trusts `X-User` only because the network path is restricted (loopback bind by default plus deployment config). Everything else from the client is untrusted.
Deployment: one Node process, one data file path from `DATA_FILE` env var.
Choices vs alternatives:
- File persistence vs SQLite/DB: a file needs no dependency and fits the scale (A2); a DB adds operations cost with no current benefit. Chosen: file, behind the repository interface so a DB can replace it.
- File vs in-memory only: rejected, it defeats the purpose of the product (ARCH-1).
- `Map` vs plain objects: avoids prototype keys like `__proto__`.
- Own size cap vs a framework: a counter on the request stream is a few lines and keeps zero dependencies.

## Constraints
- Platform: Node.js LTS, no runtime dependencies.
- Single instance only (file store has no cross-process locking).
- Compliance: notes may be personal data; no logging of content (NFR2); data file permissions `0600`.
- Time and budget: small internal project, one iteration.

## Success Criteria
- All of AC1–AC11 pass in CI.
- Restart test shows 100% of notes retained.
- NFR3 latency measured under 50 ms p95 in a local test.
- Zero cross-user access in the privacy tests.

## Assumptions
- A1: Another team's gateway authenticates users and sets `X-User` to a trusted id, and strips any client-supplied `X-User`. Documentation in the README plus the loopback default (AC9) enforce this. Blocks: deployment sign-off.
- A2: At most a few hundred notes per user; the cap of 500 enforces it. Blocks: choice of file store.
- A3: Frequency and cost of the problem are unmeasured. Blocks: nothing in this release.
- A4: One service instance. Blocks: the file store choice.

## Open Questions
- Q1: When and who moves from file to database? Owner: product owner. Decision date: before any multi-instance deployment or more than 100 users; not blocking this release. Resolved for now: file persistence is in scope.
- Q2: Do the gateway owners confirm they strip client-supplied `X-User`? Owner: platform team. Blocks: production rollout (not development).
- Q3: Are 16 KB, 500 notes and the `X-User` charset acceptable to the gateway's user ids? Blocks: AC6 and AC7 values; defaults used if no answer.

## Risks
| Id | Description | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RISK-1 | Identity spoofing: service reachable without the gateway or gateway forwards client `X-User` | Medium | High | Loopback default bind, startup warning, strict header validation, Q2 confirmation, README | platform-engineer |
| RISK-2 | Data loss or corruption in the file store (crash, disk full, manual edit) | Low | High | Atomic rename writes, refuse to start on corrupt file, 0600 file, backup of the file by operations | developer |
| RISK-3 | Memory exhaustion via large or many requests | Medium | Medium | 16 KB request cap, 500 notes per user cap, gateway rate limiting | developer |
| RISK-4 | Prototype-key or odd-character user ids break storage | Low | Medium | Charset/length validation, `Map` storage, tests with `__proto__` | developer |
| RISK-5 | Id guessing to read others' notes | Low | High | Random UUID v4 ids, owner check on every access, 404 for non-owners | developer |
| RISK-6 | Multiple instances share the data file and overwrite each other | Low | High | Documented single-instance constraint; Q1 plans DB | product-architect |
| RISK-7 | Sensitive content leaks through logs | Low | Medium | No bodies/titles in logs, AC10 test | developer |
