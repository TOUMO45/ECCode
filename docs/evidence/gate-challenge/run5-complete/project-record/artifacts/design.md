# Design: Notes Vault (rev 2)

Contract: `.eccode/artifacts/brief.md` (rev 2). No requirement is changed here. Node.js LTS, zero runtime dependencies, tests with `node:test`.

## Components
| Component | File | Responsibility | Covers |
|---|---|---|---|
| Entry point | `src/server.js` | Read `HOST` (default `127.0.0.1`), `PORT`, `DATA_FILE`. Load the repository (exit 1 with a stderr message on failure). Warn if the host is non-loopback. Start `http.createServer`. | AC8, AC9 |
| Config | `src/config.js` | Constants: `MAX_BODY=16384`, `MAX_NOTES=500`, `TITLE_MAX=100`, `BODY_MAX=2000`, `USER_RE=/^[A-Za-z0-9._@-]{1,64}$/`. | R8 |
| HTTP app | `src/app.js` | `createApp({repo, logger})` returns a request handler. Runs the pipeline below. Top-level try/catch maps any exception to the fixed 500. | R1–R5 |
| Identity | `src/identity.js` | `getUser(req)` returns the user id or `null`. | R7, AC6 |
| Body reader | `src/body.js` | Counts bytes on the stream, JSON-parses, enforces the 16 KB cap. | AC7 |
| Validation | `src/validate.js` | `validateNewNote(obj)` returns `{title, body}` or throws `ValidationError`. | AC1, AC5 |
| Note service | `src/service.js` | `create/list/get/remove(user, …)`. Enforces the 500-note cap and the owner check. | R1–R4, AC7 |
| Repository interface | `src/repository.js` (JSDoc) | `load()`, `list(user)`, `get(user,id)`, `insert(note)`, `delete(user,id)`, `count(user)`. All async except where noted. | R6 |
| `FileNoteRepository` | `src/file-repository.js` | `Map<userId, Map<noteId, note>>` in memory. Every write is flushed to the data file. | R6, NFR4 |
| Logger | `src/logger.js` | One line per request: `method route-template status durationMs`. Takes only those four fields, so content cannot be passed in. | AC10 |
| Errors | `src/errors.js` | `AppError(status, code, message)` and the `sendError` helper. | AC5 |

Request pipeline (the order is fixed by the brief):
1. Route and method match. Unknown path gives 404 `not_found`. Known path with the wrong method gives 405 with `Allow`.
2. `X-User` validation gives 401, **before any body is read or parsed**.
3. For POST: Content-Type check (415), then size (413), then JSON parse (400), then validation (422).
4. Business rules (note cap 409, ownership 404), then persistence.
5. Log the line after the response finishes (`res.on('finish')`, using the route template, e.g. `GET /notes/:id`, never the raw URL).

## Interface Contracts
All responses are `application/json; charset=utf-8`, except 204 which has no body. Every request needs `X-User`. Timestamps are ISO-8601 UTC. This section is the shared contract for implementers and tests.

Note object: `{"id":"<uuid v4>","owner":"<X-User>","title":"<string>","body":"<string>","createdAt":"<ISO UTC>"}`

Error object (all errors): `{"error":{"code":"<code>","message":"<plain text>"}}`. Messages are fixed strings or field-level hints. They never contain stacks, paths, exception text, or echoed user content.

### POST /notes
- Request: `Content-Type: application/json`. Body `{"title": string (trim length 1–100), "body"?: string (0–2000 chars, default "")}`. Unknown extra fields are ignored and not stored.
- 201: the note object. `title` stored trimmed. `id` comes from `crypto.randomUUID()`. `owner` is the validated `X-User`, never taken from the body. `Location` header is not required.
- Errors: 401 `unauthorized`, 415 `unsupported_media_type`, 413 `payload_too_large`, 400 `bad_json`, 422 `validation_failed`, 409 `note_limit_reached`, 500 `internal`.
- Not idempotent. A retry creates a second note (documented).

### GET /notes
- 200 `{"notes":[note,…]}` containing only the caller's notes, `createdAt` descending, ties broken newest-inserted first. Empty list gives `{"notes":[]}`. There is no pagination, because the cap is 500 notes.
- Errors: 401, 500. Idempotent and safe.

### GET /notes/:id
- 200 note object only if `repo.get(user, id)` finds it in the **caller's own** map.
- 404 `not_found` for: unknown id, an id owned by another user, and an `:id` that is not a UUID (regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, case-insensitive). The three cases give identical bodies. Never 403.
- Errors: 401, 404, 500.

### DELETE /notes/:id
- 204 with no body when the note exists in the caller's map. It is removed and persisted before the response is sent.
- 404 `not_found` otherwise, with the same rules as GET. Nothing is deleted. Repeating a delete gives 404 the second time.
- Errors: 401, 404, 500.

### Error table
| Status | code | message |
|---|---|---|
| 400 | `bad_json` | Request body is not valid JSON |
| 401 | `unauthorized` | Missing or invalid X-User |
| 404 | `not_found` | Not found |
| 405 | `method_not_allowed` | Method not allowed (and `Allow: <methods>`) |
| 409 | `note_limit_reached` | Note limit reached |
| 413 | `payload_too_large` | Request body too large |
| 415 | `unsupported_media_type` | Content-Type must be application/json |
| 422 | `validation_failed` | Fixed per-field hint, e.g. "title must be 1-100 characters" |
| 500 | `internal` | Internal error (body exactly `{"error":{"code":"internal","message":"Internal error"}}`) |

### Identity (AC6, R7, trust boundary)
`getUser(req)`:
- Reject (401) if `req.rawHeaders` contains `x-user` (case-insensitive) more than once, or if the value contains a comma.
- The value must match `^[A-Za-z0-9._@-]{1,64}$` exactly. Do not trim first, so `" a"` and whitespace-only values are rejected. Missing, empty, overlong or bad-charset values give 401.
- Runs before body handling. No body is read on a 401. The response is sent with `Connection: close`, and the request stream is destroyed or left unread so the connection does not buffer it.
- `__proto__` and `constructor` are valid ids and are used only as `Map` keys.

### Size cap (AC7)
- If `Content-Length` > 16384, respond 413 immediately without reading.
- Otherwise count bytes while streaming. If the count exceeds 16384 (chunked or lying `Content-Length`), stop reading, send 413 with `Connection: close`, and destroy the socket after the response is flushed.
- Only POST bodies are read. A body on GET or DELETE is ignored and never parsed.

## Data Design
**Entities.** Note, per the schema above. Fields are `id` (string UUID v4), `owner` (string matching `USER_RE`), `title` (string, trimmed, 1–100), `body` (string, 0–2000, default `""`), `createdAt` (ISO UTC string from `new Date().toISOString()`). A hidden monotonically increasing `seq` is kept in memory only, for the tie-break (the file keeps array order, so `seq` is rebuilt at load).

**In-memory shape.** `Map<userId, Map<noteId, note>>`. Plain objects are never keyed by user input (NFR1). Ownership is structural: `get(user,id)` looks up the caller's inner map only, so another user's note cannot be reached even with a valid id (R4, AC3, AC4, RISK-5). `list` sorts by `createdAt` descending, then by `seq` descending.

**File format.** `DATA_FILE` (default `./data/notes.json`) holds `{"version":1,"notes":[note,…]}` in insertion order. File mode is `0600`, and the data directory is created if missing.

**Write path (NFR4).** Every `insert` and `delete` mutates a copy-on-write snapshot and then flushes:
1. Serialize all notes to JSON.
2. Write to `DATA_FILE + ".tmp"` with flag `wx` and mode `0600`. Then `fsync` the file handle and close it.
3. `rename(tmp, DATA_FILE)` (atomic on the same filesystem). Then fsync the directory where supported.
4. Writes are serialized through a promise queue (`this.queue = this.queue.then(...)`). The memory state is only committed if the flush succeeds. If it fails, the change is rolled back and the error propagates, so the API returns the fixed 500. The `.tmp` file is removed on failure.

**Startup (AC8).** `load()`:
- If `DATA_FILE + ".tmp"` exists, refuse to start. stderr says: `Refusing to start: leftover temp file <name> found; inspect and remove it`. Exit code 1. Nothing is overwritten or deleted.
- If `DATA_FILE` is missing, start empty. The file is created on the first write.
- If it exists but is not valid JSON, has the wrong `version`, or fails per-note validation (id UUID, owner matches `USER_RE`, title/body/createdAt types and lengths, duplicate ids, more than 500 notes for one user), refuse to start with `Refusing to start: data file is corrupt (<reason, no note content>)`. Exit code 1. The file is never rewritten.
- The data file is read once. Single instance only (A4, RISK-6), and this is documented in the README.

**Limits (R8).** 500 notes per user, checked in `service.create` before `insert`: `count(user) >= 500` gives 409 `note_limit_reached`. Deleting one allows a new create. The 16 KB request cap bounds memory per request. Total memory is bounded by 100 users × 500 notes × about 2.2 KB, roughly 110 MB worst case.

**Retention and migrations.** Notes are kept until deleted. `version:1` allows future migration. Operations should back up the file (RISK-2).

## Security
**Trust boundary.** The gateway authenticates users, sets `X-User`, strips any client-supplied `X-User`, rate-limits and terminates TLS. The service trusts `X-User` only because it listens on loopback by default (RISK-1, A1, Q2). All other client input is untrusted.

Controls and the findings they answer:
| Control | Spec | AC |
|---|---|---|
| Owner check on **every** read and delete | `get`/`delete` operate only on the caller's inner `Map`. Non-owners get 404, identical to unknown ids. There is no endpoint that fetches by id across users. | R4, AC2–AC4 |
| X-User validation | Regex, no trim, duplicate header and comma rejection via `rawHeaders`, 401 before any body read. | AC6 |
| Loopback bind | `server.listen(PORT, HOST)` with `HOST` default `127.0.0.1`. If `HOST` is not `127.0.0.1`, `::1` or `localhost`, log a warning at startup: `WARNING: listening on <host>; X-User must only be reachable via the trusted gateway`. | AC9 |
| No content in logs | The logger accepts only method, route template, status and duration. The raw URL, headers and bodies are never logged. The 500 handler logs only the error class name and a request counter, not `err.message` (it may contain content or paths). | AC10, NFR2 |
| Input validation | Content-Type must be exactly `application/json` (parameters like `charset=utf-8` allowed). Type and length checks. Extra fields dropped. | AC1, AC5 |
| Output safety | Responses are JSON built with `JSON.stringify`. Header `X-Content-Type-Options: nosniff`. The 500 body is a fixed string. | R5 |
| Prototype safety | `Map` only. Note objects are built field by field, and the parsed body is never spread into storage. | NFR1, RISK-4 |
| Resource limits | 16 KB cap (stream-counted), 500-note cap, `server.headersTimeout`/`requestTimeout` set (10 s) against slow clients. | RISK-3 |
| File permissions | Data file and temp file created with `0600`. | Constraints |
| Secrets | None. There are no keys or tokens in the service. | |

Threats: identity spoofing (RISK-1), id guessing (RISK-5, UUID v4 plus owner check, so secrecy is never the control), prototype pollution through `__proto__` as a user (RISK-4), memory exhaustion (RISK-3), log leakage (RISK-7), data corruption (RISK-2), a second instance on the same file (RISK-6, documented). Residual risks that belong to others: gateway misconfiguration (Q2), rate limiting and TLS (gateway).

## Testing Strategy
Runner: `node --test` (built-in `node:test`, `node:assert`, global `fetch`/`http`). Each test starts the app on port 0 with a temp `DATA_FILE` from `fs.mkdtemp`. Raw-socket tests (duplicate header, oversize) use `node:net`/`http.request`.

Commands:
- All tests: `node --test test/`
- Single area: `node --test test/security.test.js`
- Performance (NFR3): `node test/perf.js` exits non-zero if p95 ≥ 50 ms.
- CI runs `node --test test/ && node test/perf.js`.

Layers:
- Unit: `validate.test.js`, `identity.test.js`, `file-repository.test.js`.
- Integration (HTTP): `api.test.js`, `security.test.js`, `limits.test.js`, `persistence.test.js`, `logging.test.js`.
- Contract: `api.test.js` asserts the exact error shape and statuses from the table above on every error path.

### AC-to-test traceability matrix
| AC | Test file / case |
|---|---|
| AC1 | `api.test.js`: create returns 201 with all schema fields. UUID v4 id, trimmed title, body defaults to `""`, ISO `createdAt`, owner equals header. Boundaries: title of 1 and 100 chars ok, body of 2000 ok, extra fields not stored, owner in body ignored. |
| AC2 | `api.test.js`: two users create notes, each lists only their own, newest first, including a tie on `createdAt` (stubbed clock). Empty user gets `{"notes":[]}`. |
| AC3 | `security.test.js`: user B GET of user A's id gives 404 with a body identical to the unknown-id body. Owner gets 200. Non-UUID id gives 404. Never 403. |
| AC4 | `security.test.js`: B DELETE of A's id gives 404 and A's note still exists (GET 200). Owner DELETE gives 204, then GET gives 404, then DELETE gives 404. |
| AC5 | `api.test.js`: malformed JSON 400 `bad_json`. Array, string, null, missing title, numeric title, non-string body, whitespace title, title of 101, body of 2001 give 422 `validation_failed`. Content-Type `text/plain` and missing give 415. Unknown route 404. `PUT /notes` and `POST /notes/:id` give 405 with `Allow`. **Forced 500**: a repository stub throws `Error("secret /etc/path stack")`. The test asserts status 500, the body deep-equals the fixed body, and the body and the log output contain neither `secret`, `/etc/path`, `at `, nor `stack`. |
| AC6 | `security.test.js`, table-driven: missing, empty, `"   "`, `"a b"`, 65 characters, `"a/b"`, `"a,b"`, and a duplicate `X-User` header (raw `http.request` with two headers) all give 401 `unauthorized`. A 401 on POST with a malformed body is 401, not 400 or 422, and the body-read counter is 0. Valid edge values (`a`, 64 chars, `a.b@c-d_e`) work. **`__proto__` and `constructor` users**: create, list and get work as ordinary users, the other user's list is unaffected, and `Object.prototype` is unpolluted (`({}).title === undefined`). |
| AC7 | `limits.test.js`: a 16385-byte body gives 413 `payload_too_large` and the connection closes. A chunked body without Content-Length that exceeds the cap gives 413. A body of exactly 16384 is not 413. Create 500 notes ok, the 501st gives 409 `note_limit_reached`, a different user is unaffected, and after a delete a create gives 201. |
| AC8 | `persistence.test.js`: create 3 notes and delete 1, then build a new `FileNoteRepository` and app on the same file, and the 2 notes are returned (also a spawned-process restart test using `child_process`). A leftover `.tmp` makes `load()` reject and the spawned process exit 1 with a message on stderr. A corrupt file (truncated JSON, wrong version, duplicate id, invalid owner) exits 1, and the file bytes are unchanged after the attempt. A failed flush (rename stubbed to throw) returns 500, memory is unchanged, no `.tmp` remains, and the original file is intact. File mode is `0600`. |
| AC9 | `security.test.js`: with no env, `server.address().address === '127.0.0.1'`. `HOST`/`PORT` env overrides are honored (spawned process). A non-loopback `HOST` (`0.0.0.0`) writes the warning to stderr. Loopback does not. |
| AC10 | `logging.test.js`: create, read, list and delete with a sentinel title and body (`SENTINEL_9f3a`), including a 422 and a forced 500. The captured log output contains none of the sentinel. Each request produces exactly one line with method, route template (`/notes/:id`, not the real id), status and duration. |
| AC11 | This matrix. CI fails if any file is missing from `node --test test/`. |
| NFR3 | `test/perf.js`: 100 users × 500 notes preloaded, 2000 mixed requests, p95 below 50 ms. |

## Deployment
- Run: `node src/server.js` with `HOST` (default `127.0.0.1`), `PORT` (default 3000), `DATA_FILE` (default `./data/notes.json`). Single process, single instance, zero dependencies, Node.js LTS.
- The service must run only behind the trusted gateway, which authenticates users and **strips and overwrites** any client `X-User`. Do not expose the service port directly (RISK-1, A1, Q2).
- **Access is owner-only.** Every read and delete is checked against the caller's own notes, and a non-owner gets 404. Knowing a note id gives no access. This is covered by AC3 and AC4 tests.
- The data file directory must be writable by the service user only. The data file is `0600`. Operations back up the file (RISK-2). Do not run two instances on one file (RISK-6).
- A refusal to start (leftover `.tmp`, corrupt file) needs manual inspection. Operators must not delete the data file without checking the backup.
- TLS and rate limiting belong to the gateway. A README documents all of the above.
- Recovery: if the disk is full or the rename fails, writes return 500 and memory is rolled back. Reads keep working.

## Requirements map
| Req | Component |
|---|---|
| R1 | `app.js`, `validate.js`, `service.create`, `FileNoteRepository.insert` |
| R2 | `service.list/get`, `FileNoteRepository.list/get` |
| R3 | `service.remove`, `FileNoteRepository.delete` |
| R4 | `Map<user,Map<id,note>>` structure, owner-scoped lookup, 404 mapping |
| R5 | `errors.js`, `validate.js`, top-level catch with fixed 500 |
| R6 | `FileNoteRepository` (load, temp file plus atomic rename) |
| R7 | `identity.js` |
| R8 | `body.js` (16 KB), `service.create` (500 notes) |

## Implementation Workflow
1. `config.js`, `errors.js`, `identity.js`, `validate.js` and their unit tests (parallel).
2. `FileNoteRepository` and persistence tests, in parallel with `body.js`, `logger.js`.
3. `service.js`, `app.js`, `server.js`, then the integration, security, limits and logging tests.
4. `perf.js` and the README.
Steps 1 and 2 can proceed in parallel because they depend only on the contracts above.

## Open questions
Q1–Q3 from the brief remain open and are not blocking. No requirement changes are requested.
