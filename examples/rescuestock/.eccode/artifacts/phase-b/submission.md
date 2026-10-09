# Phase b-foundation — submission

Author: delivery-lead. Gate: `phase:b-foundation`. Date: 2026-10-09. Plan: `.eccode/artifacts/plan/plan.json`, revision 2, approved.

## Response to rev-mv1ijr52-01b2f4b6 (third and last review iteration)

Two reworks were done: b2-domain (handoff ho-mv1jewhq-01c5bca8) and b1-foundation-core (handoff ho-mv1ipb3r-01ca015d). b3 and b4 are unchanged.

**Delivery-lead re-runs on the final tree:**
- `npm test`: **390/390**, p95 15.4 ms, suite 17.1 s (**ev:ev-mv1jgr43-019019a1**).
- The reviewers' own scripts:
  - SEC-B-1 planner sweep: exit 0 (**ev:ev-mv1jgz8k-01e18aeb**).
  - Technical checks (migrations, CSP, scripts, planner vs independent brute force on 3000 catalogs): 0 failures (**ev:ev-mv1jgzrl-019a88f4**).
  - Config/db probe: 0 REPRO lines (**ev:ev-mv1jh03r-01f39ba5**).
  - SEC-B-3 verify: 422 and a healthy server (**ev:ev-mv1jh6uo-0163ad1b**).
  - HTTP probe: one expected FAIL, explained in the SEC-B-3 row (**ev:ev-mv1jha0c-0193ed2e**).
  - Slowloris probes: every slow connection closed (**ev:ev-mv1jjd22-014ee08d**, **ev:ev-mv1jlmwd-01538718**).

| Finding | What changed | Evidence |
|---|---|---|
| **SEC-B-1** (major): the planner gives up (PLANNER_LIMIT) on ordinary fillable requests and holds the event loop for up to about 0.3 s | **Planner rework (b2):** a new `src/domain/search.js`, used by `planner.js`, does an exact subset search. It enumerates offer subsets within the pickup cap, smallest first, and solves each subset's cover by bounded DFS. Pruning:<br>- irredundant plans only;<br>- a multiplicity window per offer;<br>- fractional-knapsack lower bounds against the budget and the K-th best;<br>- canonical order removes equal-cost plateaus;<br>- a dominance table when no supplier has two offers.<br>**Same objective, rejections, candidate codes and relaxations as before.** On the reproduction (stock 100, 10,000 cups, maxPickups 5), plan() returns A at 301,000 cents in 0.1–0.2 ms; it threw PLANNER_LIMIT after about 170 ms before. Across the 5,400-input sweep there is no PLANNER_LIMIT, and the worst call is 21.5 ms in b2's run and 24.6 ms in mine.<br>**Tests added:**<br>- `SEC-B-1:` cases in planner-fixture (huge stock and quantity solved exactly; the node-cap guard through `search(…, {maxNodes})`);<br>- `test/timing/planner-sec-b1.test.js`: the named case, a 1,008-call grid over stock 1..100,000 and quantity 100..100,000 (each < 100 ms, p95 < 20 ms), and 150 random 12-offer catalogs (each < 250 ms);<br>- the oracle property test extended to availability up to 7, tie-heavy catalogs and tied offers of one supplier;<br>- 250 medium catalogs compared, whole output, with a frozen slow exact reference (`test/unit/domain/helpers/reference-planner.js`). A deliberate mutation was caught by this comparison and reverted. | Reproduction failing before the fix: ev:ev-mv1imwtc-01fe7d7e. After: b2's sweep ev:ev-mv1jdtnn-01074374, reviewer checks ev:ev-mv1jdu69-01dd1d33, declared command ev:ev-mv1je9tn-01616b83 (119 tests); my re-runs ev:ev-mv1jgz8k-01e18aeb and ev:ev-mv1jgzrl-019a88f4 |
| **SEC-B-1 residual, stated plainly: RISK-19 (medium, low likelihood, open)** | The node cap (2,000,000 nodes per search, about 150 ms) is still reachable. Neither the seeded catalog shape nor random-priced catalogs reach it. **Deliberately tie-laden catalogs do:**<br>- several suppliers whose bundles of different sizes cost the same per bundle;<br>- quantities of about 50,000 or more;<br>- especially with a non-zero tax rate.<br>A supplier can set equal prices through PATCH, so this is reachable in principle.<br>**b2's adversarial stress script measured:**<br>- the cap hit in about 0.1–0.3 % of such inputs;<br>- calls of 150–400 ms, up to about 800 ms when several searches hit the cap;<br>- its recorded run (ev:ev-mv1jdvnv-01ed0f76) exits 1 by its own 50 ms criterion, on one 58 ms tie-plateau call. That is information, not a regression.<br>**This does not fully meet the reviewer's preferred resolution** ("exact optimum quickly on the API-reachable envelope … any budget"). An integer DP over coverage would remove the residual, and it is not built in version one.<br>**Mitigation recorded by the orchestrator as RISK-19:**<br>- c2 maps `PlannerLimitError` to a typed 422 (followups FU-1);<br>- a per-customer planning rate limit (FU-8, new).<br>So a request that reaches the cap gets a typed refusal, never a 500 and never a wrong plan, and one customer cannot repeat it hot. The reviewer must decide whether this residual blocks approval; I do not claim it is closed. | ev:ev-mv1jdvnv-01ed0f76 (adversarial stress, fails by design on 58 ms); RISK-19 in the record |
| **SEC-B-2** (minor): REPLACE bypassed the append-only triggers | `openDb` sets `PRAGMA recursive_triggers = ON`, inside the retry-protected pragmas, with no migration change. Three `SEC-B-2:` tests in `test/unit/db/triggers.test.js` cover REPLACE refused per table with rows unchanged, plus plain and `INSERT OR IGNORE` inserts still working. | Repro ev:ev-mv1ilouz-013ab82a → clean ev:ev-mv1iobfp-016ca5a4; my run of the reviewer's probe: recursive_triggers=1, every REPLACE refused, 0 REPRO (ev:ev-mv1jh03r-01f39ba5) |
| **SEC-B-3** (minor): a deeply nested body made canonicalJson overflow | `readJsonBody` scans nesting without recursion and refuses depth > 32 with 422 `VALIDATION_FAILED` (`details.fields [{field: body, rule: depth:32}]`). `canonicalJson` also refuses depth > 32 with a TypeError. `SEC-B-3:` tests are in `test/unit/http/hardening.test.js`.<br>**One remaining FAIL is expected:** the security reviewer's `sec-phb-http.mjs` now reports exactly one FAIL. Its section H expectation (`expect(body.includes('throws RangeError'), 'reproduction: …')`, line 257) asserts the bug itself. With the fix, the 20,000-deep body is refused with 422 before fingerprinting, and the server still answers 200. Every other section passes. | Repro ev:ev-mv1ilp8t-017fc2a5 → b1 verify ev:ev-mv1iobpi-01402abf; my runs: verify ev:ev-mv1jh6uo-0163ad1b, HTTP probe ev:ev-mv1jha0c-0193ed2e (1 FAIL = the reproduction expectation) |
| **PB-4** (info): the rs14 busy test must start the server before taking the lock | Routed to c6 as followups **FU-10**. | followups.md |
| **SEC-B-4** (info): slow-connection timeouts | **Taken (b1):**<br>- `connectionsCheckingInterval` 1000;<br>- `maxConnections` 512, a value the engineer chose because the spec names none; a deployment behind a proxy with more concurrent connections would need it raised;<br>- 408 instead of 400 for `ERR_HTTP_REQUEST_TIMEOUT`;<br>- `SEC-B-4:` tests.<br>**The residual b1 left open (slowloris probes not re-run) is now closed by my runs:** both of the security reviewer's slowloris probes close every slow connection.<br>- Header timeouts fire at 10.0–11.0 s and body timeouts at 30.0 s, all answered 408, including after 422, 413, 400 and 431 responses.<br>- The probes' banner line "connectionsCheckingInterval 30000" is a hard-coded string in the probe scripts. The real server value is 1000, as the HTTP probe reads from the live server in its section K. | ev:ev-mv1jjd22-014ee08d, ev:ev-mv1jlmwd-01538718, ev:ev-mv1jha0c-0193ed2e (section K) |
| **SEC-B-5** (info): an existing `data/` is not tightened | **Taken (b1):** `ensureRuntimeDirs` tightens an existing `data/` or `uploads/` owned by the current user to 0700, with a test in `startup.test.js`. The README line (and backup under `umask 077`) is routed to g2 as **FU-9**. b4 is closed, and the README belongs to g2 in phase G. | b1 declared command ev:ev-mv1iol67-014cd738 (188 tests) |
| **SEC-B-6** (info): no lockfile | Recorded as a decision for the orchestrator (**FU-12**). The default proposed is to commit a lockfile in g2 and have the clean checkout use `npm ci`. | followups.md |
| **SEC-B-7** (info): scrypt N and length-only checks | Accepted: both follow the approved design. A change, if wanted, is one constant in `scripts/seed.js` plus c1's verifier. | followups.md |
| **SEC-B-8** (info): stale `explain.js` header comment | **Not fixed;** b2's rework did not touch `explain.js`. It is a comment, not behaviour. It will be corrected when `src/domain/` is next reopened, or in a rework if the reviewer asks. | followups.md |
| **SEC-B-9** (info): c1 X-Forwarded-For validation | Routed to c1 as **FU-11** (`net.isIP`, test `SEC-B-9: …`). | followups.md |

**Artifact coverage.** The toolkit (0.3.2) now unions every completion's files into the phase artifact list. After submitting, I compared the submission with the plan's ownership using the technical reviewer's own check (`tr-phb-artifacts.mjs`); the count and result are in the handoff to the reviewer and in the delivery-lead report. Files added by the reworks:
- `src/domain/search.js`;
- `test/timing/planner-sec-b1.test.js`;
- `test/unit/domain/helpers/reference-planner.js`;
- `test/unit/http/hardening.test.js`.

## Response to rev-mv1hc5zg-01a3fc75 (resubmission)

b1-foundation-core was reset and reworked by backend-engineer (handoff ho-mv1hk3zz-01649535). The other three tasks are unchanged.

| Finding | What changed | Evidence |
|---|---|---|
| **PB-1** (blocking): concurrent start on a fresh database throws SQLITE_BUSY from `PRAGMA journal_mode = WAL` | **Root cause (b1):** on a fresh file the WAL switch needs an exclusive lock. When another process holds or awaits a write lock while this connection holds a shared one, SQLite returns SQLITE_BUSY at once without calling the busy handler, so `busy_timeout` cannot help.<br>**Fix in `src/db/connection.js`:** `openDb` reads the journal mode first and switches only if the file is not already WAL. The switch and the opening pragmas run under `retryWhileBusy`, a bounded, jittered back-off (2 ms doubling to 50 ms) up to max(busy timeout, 1000 ms). After that the busy error is rethrown and the handle closed.<br>**Regression tests:** `test/unit/db/open-race.test.js`, all named `PB-1: …`: retry units, bounded give-up against a real lock-holder process, success after release, and a stress of 25 rounds × 4 processes on a fresh file.<br>**Behaviour change, disclosed:** opening the database may wait up to 1 s even with `RS_DB_BUSY_TIMEOUT_MS=0`. Ordinary statements still honour the configured timeout, so the RS-14 DB_BUSY behaviour is unchanged (its tests pass). | **Before the fix:**<br>- reviewer's failing run ev:ev-mv1h5bbh-010aae6e and reproduction ev:ev-mv1h6fnx-0154466d;<br>- b1's reproduction ev:ev-mv1hf138-016b38f3 (3 of 40 runs locked).<br>**After the fix:**<br>- b1: ev:ev-mv1hidob-01eb30b6 (0 failures in 160 runs), declared verification ev:ev-mv1hj5be-01ed33dd (177 tests), npm test ev:ev-mv1hjizn-013960db (370 tests).<br>- **Delivery-lead re-runs:** `npm test` 370/370, **ev:ev-mv1hlfx5-0167277b**. The reviewer's resolution check `node .eccode/drafts/tr-phb-migrate-race.mjs 20` gave 20 sequential and 60 parallel runs, 0 failed, 0 locked (**ev:ev-mv1hn1vt-01413327**). That script always exits 0, so my evidence command wraps it in an `awk` pass condition on the two printed `failed: 0` lines.<br>- ev:ev-mv1hm4wr-016be9a3 is an earlier passing run of the same check whose counts were lost to a `tee` error; it is superseded by ev:ev-mv1hn1vt-01413327. |
| **PB-2** (minor): six design-item tests lacked their ids | Renamed to:<br>- `ARCH-26: RS_SAGA_LEASE_MS …`<br>- `SEC-10: RS_MODEL_CUSTOMER_DAILY_SHARE …`<br>- `SEC-12: RS_FAKE_APPROVAL_HOST …`<br>- `SEC-3: RS_TEST_HOOKS …` (the Deployment-table row has no finding id of its own; SEC-3 governs test-mode-only switches)<br>- `RS-14: SQLITE_BUSY …`<br>- `ARCH-25: default deny …` | Name scan, 6 of 6 matched: **ev:ev-mv1hn5qe-011931ad** |
| **PB-3** (minor): follow-ups for later tasks | The approved `plan.json` cannot change without a plan rework. So the obligations are recorded as additional acceptance criteria in **`.eccode/artifacts/plan/followups.md`** (delivery-lead owned), for the orchestrator to pass at dispatch and the implementers to answer in their handoffs:<br>- FU-1: c2 maps `PLANNER_LIMIT` to a catalogued error, with a test.<br>- FU-2: d3 enforces the 60 s upload deadline, with a test.<br>- FU-3: c5/g1 decide with the orchestrator whether `SPEC_MISMATCH` offers appear under "What was rejected"; the default is trace only, with a templated line.<br>- FU-4: optional seed-equals-fixture test, by c6 unless b2 is reopened.<br>- FU-5 to FU-7: PB-1 regression watch in multi-process tests, c1's scrypt format, c2's derive input shape. | `followups.md` is included in this submission |

Cross-task notes 3 and 7 below are now also follow-ups FU-6 and FU-7. The rest of this document is the first submission's text, updated where the rework changed it.

The engine adds every file the four tasks changed (from their handoffs) to this submission. This note covers four things:
- what the phase delivers;
- which tests and runs prove each criterion;
- the cross-task notes the reviewers must see;
- the deviations from the design and the items this phase leaves untouched.

## What the phase delivers

| Task | Owner | Handoff | Verification run | Delivered |
|---|---|---|---|---|
| b1-foundation-core | backend-engineer | ho-mv1hk3zz-01649535 (rework; first: ho-mv1gazew-01706543) | ev:ev-mv1hj5be-01ed33dd (177 tests, after the rework; first: ev:ev-mv1g9bkw-01abf3c8, 171); pre-work failure ev:ev-mv1fm7gt-0123f65c | package.json (no dependencies, devDependency @playwright/test 1.56.1, engines >=22.13, scripts per the spec); .gitignore; scripts/check-node.cjs (ES5, flag-free); scripts/seed.js (RS-FIX-1); src/index.js, main.js, app.js, config.js, log.js, clock.js; src/db (connection, migrate, errors, meta, migrations 001–005 byte-identical to the spec, ev:ev-mv1g5zww-0182816a); src/http (body, cookies, envelope, headers incl. approvalPageCsp, host, request-id, router, server, static, validate); routes health and config, the other route modules as stubs |
| b2-domain | backend-engineer | ho-mv1gcn88-01fd3ee4 | ev:ev-mv1gckx7-015c929a (110 tests) | src/domain money, time, canonical, compat, planner, oracle, states, derive, explain, errors; test/fixtures/rs-fix-1.json; planner-fixture, oracle property (500 catalogs), derive (row tables, S09–S20, totality 20,000 + 5,000 walks), states, NFR5 timing |
| b4-env-readme | devops-engineer | ho-mv1gg814-01ae09b4 | ev:ev-mv1gfrxe-01aa3e25 | .env.example (all 66 names config reads), README.md, LICENSE (MIT), test/scan/env-example.test.js (9 NFR4 tests) |
| b3-test-harness | test-engineer | ho-mv1gxflu-01a9c110 | ev:ev-mv1gwcdw-01e502bd (npm test 364/364 under the net guard, p95 15 ms, clean checkout passed); pre-work failure ev:ev-mv1gppzk-014ca419 | test/helpers net-guard, node-proc, server-proc, app-harness, fixtures, playwright; scripts report-p95.js, reset-test-out.js, clean-checkout.sh; start-health, start-old-node (real Node 20.20.0 and 21.7.3), package scan, health-config contract test, helper self-tests |

**Phase run by the delivery-lead, after the rework:** `npm test` passed with 370 tests, 0 failed (**ev:ev-mv1hlfx5-0167277b**).

**First submission's run:** 364 tests, 0 failed and 0 skipped, offline under the net guard (**ev:ev-mv1gzlml-01a895d5**). The same run reported:
- NFR5 API latency over 18 requests: p50 2.1 ms, p95 13.8 ms;
- suite time: 14.8 s.

## Criteria → task → evidence

The phase run (ev:ev-mv1gzlml-01a895d5) contains every test named below. Counts are passing tests whose name starts with the id.

| Criterion | Task | Tests (name prefix, file) | Evidence |
|---|---|---|---|
| RS-06 | b2 | 6 `RS-06:` tests in test/unit/domain/planner-fixture.test.js and planner-oracle.property.test.js: A+B 8400, multiplicity guard A×2 7000, oracle equality on 500 seeded catalogs (≤ 6 offers, on_hand 0–3), oracle pinned outcomes, oracle independence | ev:ev-mv1gckx7-015c929a, ev:ev-mv1gzlml-01a895d5 |
| RS-07 | b2 | 3 `RS-07:` tests (planner-fixture, compat, explain) | same |
| RS-08 | b2 | `RS-08:` in planner-fixture | same |
| RS-09 | b2 | `RS-09:` in planner-fixture (B at on_hand 0 and B withdrawn) | same |
| RS-10 | b2 | 2 `RS-10:` tests (planner-fixture: exactly two relaxations, no maxPickups one; explain) | same |
| RS-11 | b2 | `RS-11:` in planner-fixture | same |
| NFR1 | b1, b3, b4 | 56 `NFR1:` tests:<br>- package scan (no dependencies, engines, check-node prefix on every flagged script);<br>- start-old-node on real Node 20.20.0 and 21.7.3, "needs Node >= 22.13 (found …)";<br>- start-health 200;<br>- node-version and gate tests;<br>- health-config.<br>`npm test` passes offline with no browser. The clean checkout (npm install from the registry, npm test, npm start, health 200) passed in b3's verification run | ev:ev-mv1gwcdw-01e502bd, ev:ev-mv1g9bkw-01abf3c8, ev:ev-mv1gzlml-01a895d5 |
| NFR4 | b1, b4, b3 | 21 `NFR4:` tests: env-example scan (every name config reads is listed, placeholders only, secrets commented out, placeholder refused by variable name), Secret redaction in config tests, /api/config secret scans | ev:ev-mv1gfrxe-01aa3e25, ev:ev-mv1gzlml-01a895d5 |
| Prerequisites reviewed here (claimed later) | b1, b2 | Migrations and triggers (test/unit/db, 6 `RS-38:`-named trigger tests); derive table and totality: 59 `RS-36` tests, incl. "RS-36 totality: 20,000 seeded walks x 120 events … never reach row 14"; states tables; F-TR-17 limit (2 `F-TR-17:` tests in limits.test.js, F-PL-4) | ev:ev-mv1gzlml-01a895d5 |

## Notes the reviewers must see (from the handoffs' remaining issues)

1. **Criterion ids in test names (b3's finding; my judgement).** The plan's phase criterion requires an id at the start of the name of every test that proves a criterion or finding. My static scan of the b1/b2 test declarations (`.eccode/drafts/phase-b-test-ids.mjs`, ev:ev-mv1h28ne-01779a6b) finds 132 named and 119 unnamed declarations. All b3 and b4 test declarations are named. b3 counted about 113 unnamed results at run time.
   - **Brief criteria are fully named:** every brief criterion claimed by this phase (RS-06..RS-11, NFR1, NFR4) has named proving tests (table above).
   - **Most unnamed tests are supporting tests.** They are in test/unit/db (tx, migrate), test/unit/http (app, static, validate, log), money, time, canonical, purity and parts of seed and planner-fixture. Several carry other design ids: threat ids T19, T21, T22, T26; `RS-FIX-1:`; `OQ-D1:`.
   - **A few unnamed tests do prove a design item and lack its id. That is a real gap against the plan's criterion, not a defect in behaviour:**
     - `RS_SAGA_LEASE_MS must be at least 3 times RS_PAYPAL_TIMEOUT_MS` (ARCH-26 (1));
     - `RS_MODEL_CUSTOMER_DAILY_SHARE … (default 0.2)` (SEC-10 / OQ-D7);
     - `RS_FAKE_APPROVAL_HOST is 127.0.0.1 outside test mode` (SEC-12);
     - `RS_TEST_HOOKS is refused when the Sandbox adapter is selected` (Deployment env table, no finding id);
     - `SQLITE_BUSY after the busy timeout maps to 503 DB_BUSY` (RS-14 prerequisite);
     - `default deny: a route with a non-public policy answers 401` (ARCH-25 prerequisite).
   - **If the reviewers require it,** the fix is a rename in b1/b2-owned test files (`test/unit/config/limits.test.js`, `hosts.test.js`, `secrets.test.js`, `test/unit/db/connection.test.js`, `test/unit/http/app.test.js`), owned by backend-engineer.
   - **Resolved in the rework (PB-2):** all six are renamed (ev:ev-mv1hn5qe-011931ad). The remaining unnamed declarations are supporting tests.
2. **Two `AppError` classes.**
   - The classes: `src/domain/errors.js` (b2; the domain may not import http) and `src/http/envelope.js` (b1).
   - How they meet: the HTTP layer recognises the domain error by duck typing (name `AppError`, status 400–599, code in the catalog), answers with the catalog message and passes only plain-object details.
   - Edge case: a domain code outside the catalog becomes 500 INTERNAL by design. The envelope class also accepts the domain argument order.
   - Tested in test/unit/http/app.test.js.
3. **Password hash format for c1.** `scripts/seed.js` writes `scrypt$16384$8$1$<salt b64url>$<64-byte key b64url>`. c1's `src/auth/password.js` must verify exactly this format, and the dummy hash for unknown users must use the same parameters.
4. **`.env.example` secrets are commented out.** `src/config.js` refuses placeholder-shaped values for every secret it reads (SEC-5, literal reading). A verbatim copy with active `<placeholder>` lines would refuse startup. The file header and the README say so, and b4 seeded successfully from a verbatim copy.
5. **Upload timeout is left to d3.** Node has one server-wide `requestTimeout`. server.js sets 30 s and exports `UPLOAD_REQUEST_TIMEOUT_MS` (60 s). The upload route (d3) must enforce its own 60 s deadline while streaming, or change the server value deliberately.
6. **Planner `PLANNER_LIMIT` cap (b2 addition).**
   - What it is: `MAX_SEARCH_NODES` 2,000,000. Beyond it the planner throws `PlannerLimitError` (RangeError, code `PLANNER_LIMIT`) for absurd catalogs.
   - Not in the spec; it bounds T19 (resource exhaustion).
   - Follow-up: the plans service (c2) must map it to a typed error, not an untyped 500.
7. **`deriveRescueStatus` input shape (b2).** The spec named only the argument groups. b2 defined persisted rows with snake_case column names, documented in the header of `src/domain/derive.js`:
   - plan_versions, reservations, supplier_orders (with optional supplier_code), payment_operations, provider_calls, planning_runs, and `replan_queue` as `{failed_drains}`;
   - camelCase limits `{unknownEscalateMin, pendingEscalateMin, replanFailedDrainsBeforeManual}`, defaulting to 15, 1440 and 5.

   c2's view service builds against this shape. The per-row `nextStepCode` and `messageCode` values beyond the spec's exact sentences (e.g. `CAPTURES_IN_PROGRESS`) are b2's choices within the spec's code set.
8. **Other cross-task items:**
   - **RBAC:** the router denies non-public policies with 401 until c1 passes an authorize hook. CSRF, Origin checks, session cookies and rate limits are c1's.
   - **main.js** starts only the HTTP server. The listener, reconciler and retention sweep come in e1, e4 and d3. The model-provider fallback to fake is left to d1/d3.
   - **Public URL:** `config.publicUrl` is null when `RS_PUBLIC_URL` is unset. Callers must use `deps.publicUrl()`.
   - **Harness latency:** NFR5's p95 covers only requests made through `app-harness`. API tests from phase C on must use the harness client.
   - **fixtures.js** `signIn`/`register` follow the Authentication contract but have only been run against a stand-in. c1's first API test must confirm them against the real routes.
   - **Deliberate network blocks:** a test that blocks the network on purpose must call `takeBlocked()`.

## Deviations from the design, with reasons

| Deviation | Where | Reason |
|---|---|---|
| Upload timeout not enforced server-wide (30 s server, 60 s left to the route) | src/http/server.js | Node has one `requestTimeout` per server; d3 owns the upload route |
| Log allow-list has one extra key, `port` | src/log.js | The harness reads the bound port from the "listening" line (PORT=0) |
| Planner node cap `PLANNER_LIMIT` | src/domain/planner.js | Bounds absurd inputs (T19); unreachable for RS-FIX-1 and the NFR5 generator (about 1 ms each) |
| Offers whose capacity or cup diameter differ from the requirement are recorded as `SPEC_MISMATCH` in the trace only, not in rejections | src/domain/planner.js | The spec's Rejection code enum has no such code; adding one would change the contract |
| Relaxations are emitted in the order budget, deadline, maxPickups | src/domain/planner.js | The brief's constraint order; consumers look relaxations up by constraint, not by position |
| The NFR5 generator fixes the deadline at 11:30 and draws the budget from 6000–30000 cents (164 of 200 seeds feasible) | test/unit/domain/helpers/catalog-gen.js | The brief gives the generator no deadline or budget |
| `.env.example` secrets commented out | .env.example | Config refuses placeholder secrets (SEC-5) |
| clean-checkout.sh does not run `npm run seed` | scripts/clean-checkout.sh | The seed prints generated credentials; the criterion lists install, test and start |
| start-health spawns the start equivalent, not literally `npm start` | test/integration/start-health.test.js | `npm start` itself is exercised by clean-checkout.sh |
| Seed embeds RS-FIX-1 as a constant | scripts/seed.js | Runtime must not import from test/. Both the seed test and planner-fixture assert the brief's table (and the fixture file is sha256-pinned), so the two agree through the brief; no direct cross-check |

## Evidence quality notes

- **b4's pre-work run is not a valid failing-state run.** ev:ev-mv1gdiqu-010e761b was recorded as separate arguments, so it failed on a mangled `ls` line, not on the missing files. The passing run uses the declared command.
- **b3's failing-state run came late.** ev:ev-mv1gppzk-014ca419 was recorded after some helpers existed, so it fails on the six files still missing, not on an empty tree.
- **The Node 22.5–22.12 branch has not run on a real Node.** node-proc's NODE_OPTIONS merge for that range is verified by simulating the version; no real Node 22.5–22.12 exists here (USER-Q9).
- **The ES5 property of check-node.cjs** is checked by a regex scan plus real runs on Node 20 and 21, not by an ES5 parser.

## Live and Unverified items this phase does not touch

LIVE-M1 (real model), LIVE-P1 and LIVE-P2 (PayPal Sandbox) and USER-Q9 (Node 22.5) are untouched. RISK-1 and RISK-2 stay open.

## Budget

`eccode status` reports 263.73 of 480 minutes used.
- **Precondition:** plan.md made phase B wait for the budget decision.
- **What was recorded:** the orchestrator recorded `dec-mv1fgdkd-01182466`. Phase B proceeds within the current limit, and no phase C or later dispatch is made until the user raises the limit or accepts the descoping order.
- **Effect:** the precondition moved from "before B" to "before C" by that recorded decision.

## Lessons

Each task recorded `mem-sd-mv1audrd-013b7102` as not-applicable, with a note. The plan's assessment ev:ev-mv1eo87o-01c933d5 is the basis. The reviewers must judge these decisions under a `lessons` criterion.
