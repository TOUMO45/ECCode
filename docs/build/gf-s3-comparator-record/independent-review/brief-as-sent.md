# Independent review (one reviewer, fresh context)

You are a zero-context reviewer. You did not build this service and must not ask its builder anything. You review the service in the directory `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree` (your own clone of the delivered tree). Report what you find; do not fix anything, do not commit, do not push, do not create a pull request.

## What you are given
- The code in `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree` (start it with `uvicorn app.main:app` from that directory; env vars DATABASE_URL, ADMIN_EMAIL, TOKEN_TTL_SECONDS).
- The requirements: `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree/prd.json` (24 acceptance criteria AC-1..AC-24) and `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree/idea.txt`.
- Contracts: any contract or schema files present in `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree` (there may be none).
- Python: use only `/root/.cache/eccode/phase3-venv/bin/python` (fastapi, starlette, pydantic, sqlalchemy, alembic, httpx, uvicorn, pytest, hypothesis). Install nothing.

## What you must not read
Anything outside `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree` and your own workspace `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-work`: in particular no other repository, no `docs/build/` directory, no acceptance or hidden test suite, no earlier review. Judge the code against the PRD only.

## What to attack (probe every class; record a result for each, including "clean")
1. BOLA/IDOR: cross-user GET and PATCH of `/v1/tasks/{id}` in both directions: status, body and headers compared with an unknown id; the owner's task unchanged afterwards; no foreign field or value in any response; list endpoint leaks; admin sees and edits all; timing of foreign vs unknown id.
2. Ordering of authentication vs validation: anonymous or invalid-token requests with invalid or malformed bodies on every protected endpoint must answer 401 (AC-8), not 422.
3. Odd ids: 0, -1, 999999, 2^63-1, 2^63, -(2^63)-1, very long digit strings (thousands of digits), non-integers, alternate spellings (+1, 01, " 1", 1.0, 1e0, full-width digits, 0x1).
4. Mass assignment: PATCH, create and register bodies carrying owner_id, id, created_at, role, is_admin, status, nested objects, nulls, wrong types; nothing may change.
5. Admin lookalikes: ADMIN_EMAIL case and whitespace variants, Unicode homoglyphs, full-width letters, zero-width characters, trailing dots, the Kelvin sign case fold; ADMIN_EMAIL unset or empty; concurrent registrations of the admin email.
6. Anonymous requests: every endpoint without a token, with other schemes, malformed Authorization headers, logged-out and expired tokens; logout semantics (exactly the presented token).
7. Malformed bodies: invalid JSON, non-object JSON, oversize fields, deep nesting, lone surrogates, whitespace-only and control-character titles; 422 responses must not echo passwords or input secrets; no 500 anywhere.
8. Config bounds: TOKEN_TTL_SECONDS at extremes (1, very large, non-numeric), DATABASE_URL default (temp directory, never ./app.db), clean-checkout startup with no env vars.
9. Docs exposure: `/docs`, `/redoc`, `/openapi.json` for anonymous callers, against the PRD's S-AUTHN statement.
10. Storage and sessions: password verifier (salted scrypt, per-user salt), tokens stored only as SHA-256, nothing usable in the database file; duplicate-email race; write contention; Alembic migration vs the models.

## How
Write your probes as pytest files under `/tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-work/review-probes/` and run them against the service (TestClient or a live uvicorn). Every finding must be reproduced by a probe or a command that you actually ran; quote its output. Never claim a defect without evidence.

## Output (your final message)
1. A JSON list of findings: `{"id": "B-n", "severity": "blocking|major|minor", "class": "<one of the 10 classes>", "summary": "...", "reproduction": "<exact command>", "observed": "<output>"}`.
2. A per-class line for all 10 classes: clean / finding ids.
3. A one-line BOLA/IDOR verdict: clean or not, with the probe counts.
4. The probe totals: files, tests, passed, failed.
