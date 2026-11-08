# Hidden acceptance suite (black-box, HTTP)

Drives a RUNNING task-tracker service; no imports from the app, no database access.

    BASE_URL=http://127.0.0.1:18080 ADMIN_EMAIL=admin@example.test \
      python -m pytest -q /root/.cache/eccode-gf-hidden/s3 -p no:cacheprovider

- Needs only Python 3.13, pytest and httpx (use /root/.cache/eccode/phase3-venv/bin/python).
- `BASE_URL` and `ADMIN_EMAIL` are required; the server must have been started with the same ADMIN_EMAIL.
- Every test registers uniquely named users, so it is safe against a persistent server and in any order.
- The admin account (ADMIN_EMAIL, fixed suite password) is registered once per session; if it already
  exists on the server the suite just logs in. A pre-existing admin with another password fails the admin tests.
- `criteria-map.json` maps AC-1..AC-24 to test function names (`test_ac<NN>_<slug>`); a criterion passes
  iff all tests with its prefix pass (parametrized cases included).
- AC-21..AC-24 are `command` criteria in the PRD (repo unit tests, migration contract); here only their
  HTTP-observable consequences are probed. Run the PRD's own commands for the rest.
- `test_x_optional_token_expiry_when_ttl_env_is_small` is unmapped and skipped unless the service was started
  with a small TOKEN_TTL_SECONDS (1..30) and the same variable is exported for the suite, e.g.
  `TOKEN_TTL_SECONDS=2` for both. It is the only check of the "expired token -> 401" part of AC-8/AC-23.
