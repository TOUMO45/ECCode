# Phase submission: core-backend

Tasks done: backend-auth-http, backend-domain.

## Acceptance criteria -> evidence

| Criterion | Evidence | Notes |
|---|---|---|
| Consistent error envelope (D2, D5) | ev:ev-mv023wwy-01eb1500 (full npm test, 195 tests, 194 pass, 0 fail, 1 skipped; includes test/api/errors.test.js, contract.test.js, validation.test.js, limits.test.js, csrf.test.js); ev:ev-mv01vixs-01d593a7 (auth/http task run); ev:ev-mv022uu6-01fc1e00 (domain task run) | 404/405/413/415/500 envelope with X-Request-Id; fixed messages, 500s log error class only. |
| Access control and IDOR proven (D6) | ev:ev-mv023wwy-01eb1500 (includes test/api/idor.test.js, rbac.test.js, auth.test.js, audit.test.js); ev:ev-mv022uu6-01fc1e00 | Cross-team IDOR matrix returns 404 with data unchanged; only leads publish; default-deny RBAC. |
| API journey and persistence tests pass (D3, D7) | ev:ev-mv023wwy-01eb1500 (includes journey.test.js, publish.test.js, draft.test.js, persistence.test.js incl. spawned-process restart, perf.test.js); ev:ev-mv022zp5-013414f9 (unit regression) | Publish runs in BEGIN IMMEDIATE and re-verifies. |

Integration: full npm test 194 pass / 0 fail / 1 skipped (ev:ev-mv023wwy-01eb1500); plan validate OK, 5 phases / 13 tasks (ev:ev-mv023x06-01f7e1d3).

## Gaps and honest notes
- 1 skipped test: the real public/index.html inline-script check; public/ does not exist until the frontend (ui phase). Static server returns the 404 envelope until then.
- Spec 3.6 160 s per-request socket timeout (rc.extendTimeout) is verified by code path only, not by a test with a long-running provider.
- src/index.js passes providers={}; real providers are built by the registry in src/services/providers.js (anthropic, cli, fallback; fake only with GW_ENABLE_FAKE=1). Not explicitly wired in index.js; never exercised live.
- No live tests (no test/live): real claude -p / Anthropic behaviour is untested here; API tests use fake providers.
- Grounding verifier quality is still unmeasured: no eval corpus beyond unit tests (eval phase, not yet done).
- Audit-on-deny covers only publish, users and audit actions; other 403s are not audited.
- Non-ProviderError exceptions from a provider map to 502 PROVIDER_UNAVAILABLE (spec silent).
- Login limiter and sessions-per-process state are in memory; the limiter resets on restart (documented in spec).
- Browser/UI journey not in scope for this phase; not run.
- Carried over: the earlier failed reconcile isolation re-run (ev:ev-mv017dyv-041fd9cb) is still not re-verified; passing check is ev:ev-mv017dym-036a4bb4.
