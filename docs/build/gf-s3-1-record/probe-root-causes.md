# S3.1 step 1.2: root causes of the 26 bare-tree probe failures (n=1)

Source: `docs/build/gf-s3-comparator-record/bare-probes/pytest.log` on origin/claude/modest-wozniak-mwpzbm (bd49f07),
read-only. 26 failed / 90 passed / 3 N/A. Duplicates (parametrized cases) are grouped by root cause.

| # | Root cause | Probes | Probe cases | Defect id | S3.1 item that would remove it |
|---|---|---|---|---|---|
| RC-1 | Unbounded `TOKEN_TTL_SECONDS`: `now + timedelta(seconds=ttl)` overflows, login 500 | 2 | `test_auth.py::test_huge_ttl_env_login[1e12]`, `[99999999999999999999]` | R-1 | none (config bounds are not an S3.1 item) |
| RC-2 | An int path param over 4,300 digits hits pydantic's `int_parsing_size` and answers 422, not 404 | 1 | `test_bola.py::test_out_of_range_ids_404[9×5000]` | R-2 | none (I7 canonicalises non-canonical ids; a 5,000-digit id is canonical) |
| RC-3 | Framework default `/docs`, `/redoc` and `/openapi.json` are mounted for anonymous callers | 1 | `test_conformance.py::test_anonymous_docs_endpoints` | R-3 | I3 |
| RC-4 | The JSON body is parsed before the auth dependency runs, so an anonymous malformed body gets 422, not 401 | 1 | `test_conformance.py::test_anonymous_malformed_json_gets_401` | R-4 | none (stage order is GF-PIPE-1, moved to S4a by I1) |
| RC-5 | The framework's default 422 handler echoes `input`/`ctx`, including the plaintext password | 14 | `test_register_422_no_echo[body0..9]` (10), `test_login_422_no_echo[body0,2,3]` (3), `test_malformed_json_no_echo` (1) | A-1 (and B-10, same root cause) | I8 |
| RC-6 | A lone UTF-16 surrogate in a JSON string reaches str encoding (UnicodeEncodeError), giving 500 | 5 | `test_register_lone_surrogate_no_500[email,password]` (2), `test_task_lone_surrogate_no_500[title,description]` (2), `test_login_lone_surrogate_no_500` (1) | A-2 | I2 |
| RC-7 | Login with a 280-character password answers 401 where the probe expects 422; the PRD permits 401 | 1 | `test_login_422_no_echo[body1]` | A-3 (not counted) | none (not a defect under the PRD) |
| RC-8 | `a@b.c` is rejected; the PRD does not define TLD length | 1 | `test_email_format[a@b.c-True]` | A-4 (not counted) | none (not a defect under the PRD) |
| | **Total** | **26** | | | I2: 5, I3: 1, I8: 14, none: 6 |

Not visible in the probe pack: B-3 (5,000-deep nesting → 500) and B-9 (predictable DB path) were found by the
comparator's reviewer probes, not by this pack. B-3 targets I2. B-9 has no S3.1 item.
