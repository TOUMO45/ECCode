Hidden-suite author report (kept OUT of the repo until the build ends; it describes the suite's coverage):
116 test functions / 221 collected cases; all 24 criteria mapped (>=2 tests each); oracle self-check 220 passed 1 skipped (optional expiry test);
21 deliberately broken oracle variants each failed the expected criteria.
PRD gaps: AC-21..24 are `command` criteria (HTTP proxies only; the harness must run the PRD's commands); AC-4 ADMIN_EMAIL unset/empty not
HTTP-probeable, case-insensitivity tested only on a fresh DB; AC-8/AC-23 expiry needs a short TOKEN_TTL_SECONDS (optional test);
AC-1/AC-3 "local@domain.tld" not precisely defined; AC-3/AC-10 non-string password/description unstated; AC-18 over-long PATCH
description unstated; AC-15 PATCH order (404 vs 422) for a foreign task with an invalid body unspecified; S-CONVENTIONS tz-aware ISO UTC.
