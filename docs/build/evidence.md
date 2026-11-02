# Evidence

Status words: **verified** (a check ran on the final tree), **coded**, **blocked**, **pending**. Every figure is copied from a run on 2026-11-02; commands are given so each can be reproduced.

| Req | Status | Evidence |
|---|---|---|
| R1 nested prefixes, bound and wrapped endpoints, self-referencing body | verified | `tests/behavior-routers.test.js`, 5 tests: a service change reaches exactly `GET /api/orders` and `GET /api/orders/{order_id}` (nothing from the route file that does not import it); a route-file change, a bound-method endpoint, a `@wraps` endpoint from another module and a self-referencing body are probed on full paths. **Red first:** the three behaviour tests failed on the unmodified detector (`insufficient-coverage`); the recursion test fails with the depth bound disabled and passes with it. **Control:** the same changes on the frozen v1 tree (git blobs of `4fbb80e`) are not flagged. Run: `ECCODE_PYTHON=<python with fastapi httpx hypothesis coverage pytest> ECCODE_REQUIRE_PHASE2=1 node --test tests/behavior-routers.test.js` |
| R2 Mealie reach | verified | `bench/pilot/hb2/edit-check.js` on Mealie `7533256` (populated config): behaviour change in a route file, v1 0 probes / v2 12 probes, 3 differences all `tokenTime`; behaviour change in a module 283 operations depend on, v1 0 probes / v2 2,481 probes, 9 differences on 3 operations (`version`, `isUpToDate`); comment-only edit, v1 0 probes / v2 12 probes, 0 differences |
| noise floor | verified | six comment-only edits (a line prepended to each file), final configuration: 0 unexplained differences each, over 2,481 / 277 / 405 / 2,506 / 2,481 / 45 probes. Two earlier controls failed and were fixed (629 differences from worktree path and traceback lines; 3 intermittent from random storage sizes, found by a six-baseline-run census) |
| harness | verified | `tests/hb2.test.js` (6 tests; mutation-checked: a validator that accepts anything fails 2, a tool that prints the key fails 1), `tests/phase2-hb.test.js` (audit + archive + manifest), `tests/r1lite-freeze.test.js` (2) |
| R3 v1 reproducible | verified | `phase2-seeds.js check` in the worktree at `4fbb80e`: 33 files; independent recomputation 33/33; `tests/phase2-stats.test.js` pins the v1 detector bytes read from git |
| R7 no regression | verified | with Python: 541 tests, 533 pass, 0 fail, 8 skipped; without (`npm run check`): 510 tests, 482 pass, 0 fail, 28 skipped. The Phase 3 guard tests need `/root/.cache/eccode/phase3-venv` (rebuilt: fastapi, httpx, hypothesis, coverage, pytest, sqlalchemy, alembic, pytest-xdist); with it they pass on a clean HEAD and on this tree |
| R4 v2 freeze | pending | next: `node bench/pilot/hb2/freeze.js`, commit, record the hash |
| R5 new seed set | pending | brief committed: `bench/protocols/2026-11-02-hb2-seeding-brief.md` |
| R6 measurement | pending | order fixed in protocol amendment 4 |
| R8 senior proof | prepared | `r1lite-freeze.js` + 2 tests; the freeze file is not generated until the rubric is extended and the owner approves the budget (≤ $300, interim stop at $120) |
