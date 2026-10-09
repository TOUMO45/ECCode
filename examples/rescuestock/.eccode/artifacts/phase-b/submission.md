# Phase b-foundation — submission

Author: delivery-lead. Gate: `phase:b-foundation`. Date: 2026-10-09. Plan: `.eccode/artifacts/plan/plan.json`, revision 2, approved.

The engine adds every file the four tasks changed (from their handoffs) to this submission. This note covers four things:
- what the phase delivers;
- which tests and runs prove each criterion;
- the cross-task notes the reviewers must see;
- the deviations from the design and the items this phase leaves untouched.

## What the phase delivers

| Task | Owner | Handoff | Verification run | Delivered |
|---|---|---|---|---|
| b1-foundation-core | backend-engineer | ho-mv1gazew-01706543 | ev:ev-mv1g9bkw-01abf3c8 (171 tests); pre-work failure ev:ev-mv1fm7gt-0123f65c | package.json (no dependencies, devDependency @playwright/test 1.56.1, engines >=22.13, scripts per the spec); .gitignore; scripts/check-node.cjs (ES5, flag-free); scripts/seed.js (RS-FIX-1); src/index.js, main.js, app.js, config.js, log.js, clock.js; src/db (connection, migrate, errors, meta, migrations 001–005 byte-identical to the spec, ev:ev-mv1g5zww-0182816a); src/http (body, cookies, envelope, headers incl. approvalPageCsp, host, request-id, router, server, static, validate); routes health and config, the other route modules as stubs |
| b2-domain | backend-engineer | ho-mv1gcn88-01fd3ee4 | ev:ev-mv1gckx7-015c929a (110 tests) | src/domain money, time, canonical, compat, planner, oracle, states, derive, explain, errors; test/fixtures/rs-fix-1.json; planner-fixture, oracle property (500 catalogs), derive (row tables, S09–S20, totality 20,000 + 5,000 walks), states, NFR5 timing |
| b4-env-readme | devops-engineer | ho-mv1gg814-01ae09b4 | ev:ev-mv1gfrxe-01aa3e25 | .env.example (all 66 names config reads), README.md, LICENSE (MIT), test/scan/env-example.test.js (9 NFR4 tests) |
| b3-test-harness | test-engineer | ho-mv1gxflu-01a9c110 | ev:ev-mv1gwcdw-01e502bd (npm test 364/364 under the net guard, p95 15 ms, clean checkout passed); pre-work failure ev:ev-mv1gppzk-014ca419 | test/helpers net-guard, node-proc, server-proc, app-harness, fixtures, playwright; scripts report-p95.js, reset-test-out.js, clean-checkout.sh; start-health, start-old-node (real Node 20.20.0 and 21.7.3), package scan, health-config contract test, helper self-tests |

**Phase run by the delivery-lead:** `npm test` passed with 364 tests, 0 failed and 0 skipped, offline under the net guard (**ev:ev-mv1gzlml-01a895d5**). The same run reported:
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
