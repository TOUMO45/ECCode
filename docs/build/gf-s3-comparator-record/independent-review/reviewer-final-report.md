Independent review of /tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-tree, judged against prd.json and idea.txt. Nothing was fixed, committed or pushed. The builder's own suite passes (139 passed).

My probes are in /tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-work/review-probes/: conftest.py plus test_c01..test_c10, one file per class. They use TestClient, and a live `uvicorn app.main:app` for the races, contention, TTL and clean-checkout checks. I also reproduced the main findings with curl against a live uvicorn.

Every reproduction below is run from the review-probes directory with this prefix:
PFX = `cd /tmp/claude-0/-home-user-ECCode/2ff1157d-1617-5023-a18b-1b209c0748a3/scratchpad/review-work/review-probes && /root/.cache/eccode/phase3-venv/bin/python -m pytest -q -p no:cacheprovider --rootdir=.`

## 1. Findings

```json
[
 {"id":"B-1","severity":"major","class":"2. Ordering of authentication vs validation",
  "summary":"AC-8 (P0) is broken for bodies that are not valid JSON. On POST /v1/tasks and PATCH /v1/tasks/{id}, a caller with no token, a bad token, a Basic header or a logged-out token gets 422 json_invalid, or 400 for very deep nesting or non-UTF-8 bytes, instead of 401. FastAPI parses the JSON before it runs the current_principal dependency. Bodies that are valid JSON but fail the schema do get 401.",
  "reproduction":"PFX test_c02_auth_order.py ; live: curl -s -w ' %{http_code}' -X POST $B/v1/tasks -H 'content-type: application/json' -d '{bad'",
  "observed":"37 failed, 180 passed. curl: {\"detail\":[{\"type\":\"json_invalid\",\"loc\":[\"body\",1],\"msg\":\"JSON decode error\",...}]} 422. With 'Authorization: Bearer bogus', PATCH /v1/tasks/1 with -d '{\"title\":\"x\",}' gives 422. Deeply nested array body, anonymous: 400 {\"detail\":\"There was an error parsing the body\"}."},
 {"id":"B-2","severity":"major","class":"7. Malformed bodies",
  "summary":"Lone UTF-16 surrogates in JSON strings cause 500. Two causes: (a) a 422 that echoes the input cannot be encoded as UTF-8 when the response is built; (b) SQLite cannot bind the value. Register and login are reachable without a token. Affected: register password, register email, login email, task title and description on create and PATCH.",
  "reproduction":"PFX test_c07_malformed.py -k lone_surrogates ; live: curl -X POST $B/v1/register -H 'content-type: application/json' -d '{\"email\":\"v@example.com\",\"password\":\"abcdefgh\\ud800\"}'",
  "observed":"7 failed (all except the login-password case, which returns 401). curl: 'Internal Server Error 500'. Server log: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 164 (starlette/responses.py render); for the login email: same error raised from sqlalchemy do_execute."},
 {"id":"B-3","severity":"major","class":"7. Malformed bodies",
  "summary":"A JSON object nested about 5000 levels deep causes 500 on /v1/register and /v1/login (anonymous) and on authenticated /v1/tasks and PATCH. jsonable_encoder hits RecursionError while serializing the 422 'input' field.",
  "reproduction":"PFX test_c07_malformed.py -k bad_json_never_500 ; live: python3 -c \"print('{\\\"a\\\":'*5000+'1'+'}'*5000)\" > deep.json; curl -X POST $B/v1/login -H 'content-type: application/json' --data-binary @deep.json",
  "observed":"4 failed: AssertionError: (500, 'Internal Server Error'). Server log: RecursionError: maximum recursion depth exceeded (fastapi/encoders.py 307 jsonable_encoder)."},
 {"id":"B-4","severity":"major","class":"7. Malformed bodies",
  "summary":"422 responses echo the plaintext password, because the default validation handler includes 'input'. This happens for register with a password that is too short or too long, register with a missing field, and login with a missing field.",
  "reproduction":"PFX test_c07_malformed.py -k echo_password ; live: curl -X POST $B/v1/register -H 'content-type: application/json' -d '{\"password\":\"MySecretPw-99\"}'",
  "observed":"4 failed. curl: {\"detail\":[{\"type\":\"missing\",\"loc\":[\"body\",\"email\"],\"msg\":\"Field required\",\"input\":{\"password\":\"MySecretPw-99\"}}]} 422. Too short: ...\"input\":\"Sup3rSe\"...; too long: \"input\":\"Sup3rSecretPwSup3r...\""},
 {"id":"B-5","severity":"major","class":"9. Docs exposure",
  "summary":"/docs, /redoc, /openapi.json and /docs/oauth2-redirect are served to anonymous callers with 200. S-AUTHN says every endpoint except register and login requires a bearer token and answers 401. No task or user data leaks; the full API schema does.",
  "reproduction":"PFX test_c09_docs.py ; live: for p in /docs /redoc /openapi.json; do curl -s -o /dev/null -w \"$p %{http_code}\\n\" $B$p; done",
  "observed":"4 failed. /docs 200, /redoc 200, /openapi.json 200, /docs/oauth2-redirect 200."},
 {"id":"B-6","severity":"minor","class":"8. Config bounds",
  "summary":"TOKEN_TTL_SECONDS is accepted as any positive int with no upper bound. Values of about 2.5e11 or more make every successful login fail with 500 (datetime OverflowError), so login is completely unusable.",
  "reproduction":"PFX test_c08_config.py -k huge ; live: TOKEN_TTL_SECONDS=300000000000 uvicorn app.main:app, then register and login t@example.com",
  "observed":"4 failed: ('300000000000', 500, 'Internal Server Error'); also 99999999999999, 10**20 and 2**63. Live: register 201, login 'Internal Server Error 500'; log: OverflowError: date value out of range."},
 {"id":"B-7","severity":"minor","class":"3. Odd ids",
  "summary":"Id spellings that are not canonical integers resolve to real tasks instead of 422: '+1', '01', ' 1', '1 ', '1.0' all return task 1 (200), and '1_0' is parsed as id 10. AC-16 says a non-integer id returns 422, and '1.0' is not an integer. Ownership is still enforced: none of these crosses owners.",
  "reproduction":"PFX test_c03_odd_ids.py -k non_canonical",
  "observed":"6 failed, e.g. AssertionError: ('1.0', 200, '{\"id\":1,\"title\":\"t\",...}'), ('+1', 200, ...), ('01', 200, ...), ('%201', 200, ...), ('1%20', 200, ...), ('1_0', 404, ...). Cross-owner alias probes: 6 passed (404)."},
 {"id":"B-8","severity":"minor","class":"3. Odd ids",
  "summary":"An integer id longer than 4300 digits returns 422 int_parsing_size, while 20 to 4300 digits return 404. AC-16 says a nonexistent integer id returns 404. The 422 also echoes the full input back.",
  "reproduction":"PFX test_c03_odd_ids.py -k very_long",
  "observed":"3 failed: (4301, 422, '{\"detail\":[{\"type\":\"int_parsing_size\",...\"Unable to parse input string as an integer, exceed...'); 4300 digits -> 404."},
 {"id":"B-9","severity":"minor","class":"8. Config bounds",
  "summary":"The default database is a fixed, predictable path, <tempdir>/task_tracker.db (/tmp/task_tracker.db here). It is created with mode 0644 under the usual umask 022, so other local users can read the password verifiers. A file already present at that path is trusted as-is: an admin user and token planted in it work after restart. AC-21's temp-dir requirement itself is met.",
  "reproduction":"PFX -s test_c08_config.py -k preseed",
  "observed":"default db: task_tracker.db mode: 0o644; planted admin token on restart: 200; AssertionError: default DB is world-readable: 0o644"},
 {"id":"B-10","severity":"minor","class":"7. Malformed bodies",
  "summary":"422 responses reflect input of any size: a 5 MB title produces a response of about 5 MB.",
  "reproduction":"PFX -s test_c07_malformed.py -k oversize",
  "observed":"5MB title -> 422 response bytes: 5000158 (the probe passes; it asserts only the status)."}
]
```

Behaviours I checked and do not count as defects:
- Titles made of control characters, U+200B, U+FEFF or U+202E are accepted and round-trip intact. The PRD forbids only empty or whitespace-only titles.
- If ADMIN_EMAIL itself contains the Kelvin sign (K, U+212A), `.lower()` folds it, so plain-ASCII `kelvin@example.com` registers as admin. Kelvin-sign registrations are rejected with 422.
- TOKEN_TTL_SECONDS written in Arabic-Indic digits ('١٢') is parsed as 12.
- With a valid token, a deeply nested array body returns 400 with a detail key.

## 2. Per-class results
1. BOLA/IDOR: clean
2. Ordering of authentication vs validation: B-1
3. Odd ids: B-7, B-8. Clean on 0, -1, 999999, 2^63-1, 2^63, -(2^63)-1 and up to 4300 digits: all 404 for user and admin, never 500.
4. Mass assignment: clean. 54/54: every extra field, wrong type and null on register, create and PATCH gives 422, and nothing is created or changed.
5. Admin lookalikes: clean. 27/27: homoglyphs, full-width letters, zero-width characters, trailing dots and the Kelvin sign never get admin. Case and whitespace variants normalize to the real admin address. Unset, empty or blank ADMIN_EMAIL makes nobody admin. In the live concurrent admin race of 32 requests: one 201 (admin) and 31 409.
6. Anonymous requests: clean. All 17 malformed or foreign Authorization headers on all 5 endpoints give 401 with a detail key. Logout invalidates exactly the presented token. Expired tokens give 401. Login answers are identical for wrong password and unknown email, with timing 38.1 ms vs 37.9 ms.
7. Malformed bodies: B-2, B-3, B-4, B-10
8. Config bounds: B-6, B-9. A clean checkout with no env vars starts, and the database goes to TMPDIR/task_tracker.db, never ./app.db. Non-numeric or non-positive TTL falls back to 86400. TTL=1 expires live.
9. Docs exposure: B-5
10. Storage and sessions: clean. Passwords are stored as `scrypt$16384$8$1$salt$digest` with a different salt per user, and the plaintext appears nowhere in the DB file. Only the token's SHA-256 is stored, and that hash is not usable as a bearer token. Live duplicate-email race of 30 requests: one 201 and 29 409, one row. 200 concurrent create, PATCH and login triples all succeed. Alembic autogenerate shows no difference from the models, the schema matches contracts/db-schema.json exactly, and downgrade works.

## 3. BOLA/IDOR verdict
Clean: test_c01_bola.py has 23 of 23 passing. A foreign id behaves exactly like an unknown id in GET and PATCH, in both directions, with the same status, body and headers, including invalid bodies, and the owner's task is unchanged afterwards. Lists never leak another user's task. The admin sees and edits everything while owner_id stays the original owner. The admin gets 404 on unknown ids. Median timing was 4.18 ms for a foreign id vs 4.49 ms for an unknown one. A further 6 of 6 alias-id probes across owners pass.

## 4. Probe totals
10 test files plus conftest.py; 574 tests, 504 passed, 70 failed. Full run: `PFX .` gives "70 failed, 504 passed in 77.93s".