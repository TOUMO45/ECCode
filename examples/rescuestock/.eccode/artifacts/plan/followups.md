# Plan follow-ups (delivery-lead)

The approved `plan.json` (plan revision 2, submission `sub-mv1fa538-015d094f`) cannot change without a plan rework. Obligations found after its approval are recorded here as **additional acceptance criteria** for the named tasks.
- **Orchestrator:** passes the matching item to the implementer at dispatch.
- **Implementer:** answers it in the handoff, with the test name or the reason.
- **Phase reviewer:** checks it with the task's other criteria.

Each item names its source finding.

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-1 | c2-requests-plans-view | `POST /api/requests/:id/plan`, and the re-plan drain from phase F on, never lets a planner `PlannerLimitError` (RangeError, code `PLANNER_LIMIT`) surface as an untyped 500.<br>- **The RISK-19 mitigation fixes the mapping:** a typed 422 `VALIDATION_FAILED` with `details.fields: [{field: "plan", rule: "planner_limit"}]`. Any other mapping needs the orchestrator, because the error catalog is part of the approved design.<br>- **The planning run is not stored**, and the request keeps its previous status.<br>- **Test:** a test named `PB-3: …` / `RISK-19: …` forces the limit through `search(…, {maxNodes})` or a tie-laden catalog. | rev-mv1hc5zg-01a3fc75 PB-3; rev-mv1ijr52-01b2f4b6 SEC-B-1; RISK-19; b2 handoffs ho-mv1gcn88-01fd3ee4, ho-mv1jewhq-01c5bca8 |
| FU-2 | d3-extraction-service | The upload route (`POST /api/requests/:id/image`) enforces the spec's 60 s upload deadline while streaming. Use `UPLOAD_REQUEST_TIMEOUT_MS` exported by `src/http/server.js`, or change the server's 30 s `requestTimeout` deliberately and say so. Prove it with a test named `PB-3: …` that uses a slow body and a shortened deadline, and asserts no file is left in `data/uploads/` or `.tmp/`. | PB-3; b1 handoff ho-mv1gazew-01706543 / ho-mv1hk3zz-01649535 |
| FU-3 | c5-frontend-dashboards, then g1-frontend-a11y-labels | Decide with the orchestrator whether offers the planner skips for capacity or cup-diameter mismatch appear under "What was rejected" (RS-35). The planner records them only in the trace as `SPEC_MISMATCH`, which is not in the Rejection code enum.<br>- **Default if no decision is recorded:** they are not shown as rejections. The trace view lists them as "Not a match for your cups (capacity or size)", rendered by template from the trace.<br>- **c5** records the decision in its handoff.<br>- **g1** verifies it in the six-answer page. | PB-3 |
| FU-4 (optional) | b2-domain, via a rework only if the orchestrator wants it; otherwise c6 | A test named `PB-3: seed constant equals test/fixtures/rs-fix-1.json` compares `scripts/seed.js`'s RS-FIX-1 constant with the fixture file. Both are checked only against the brief today. c6 may add it to its own files instead of reopening b2. | PB-3 |
| FU-5 | every later multi-process test task (c6, e6, f4) | Any test that starts several processes on a fresh database keeps the PB-1 regression in mind. If `database is locked` appears at open, it is a regression of `src/db/connection.js`, not test flakiness, and is reported as a finding. | PB-1 (rev-mv1hc5zg-01a3fc75); b1 rework ho-mv1hk3zz-01649535 |
| FU-6 | c1-auth-rbac | `src/auth/password.js` verifies the seed's hash format `scrypt$16384$8$1$<salt b64url>$<64-byte key b64url>`, and the dummy hash for unknown users uses the same parameters. Prove it with a test that signs in a seeded account. | b1 handoff (cross-task note 3 of the phase-B submission) |
| FU-7 | c2-requests-plans-view | The view service builds `deriveRescueStatus` input in the shape documented in the header of `src/domain/derive.js`: snake_case persisted rows, camelCase limits. | b2 handoff (cross-task note 7) |
| FU-8 | c2-requests-plans-view (route); f1-supersession-refusal-expiry (re-plan drains) | Planning calls are rate-limited per customer, so a customer cannot repeatedly trigger the planner's residual 150–800 ms worst case (RISK-19).<br>- **Route:** `POST /api/requests/:id/plan` is counted per customer in SQLite (`rate_events`), with check and insert in one `BEGIN IMMEDIATE`, and answers 429 `RATE_LIMITED` with `Retry-After`. `details.limit` is a new value, `plan`, which the orchestrator must agree, because `details.limit` values are catalogued.<br>- **Default:** 10 per customer per 10 minutes, configurable by an environment variable named in `.env.example`.<br>- **Re-plan drains (f1):** they keep the spec's back-off. If a drain hits `PLANNER_LIMIT`, it counts as a failed drain and does not retry hot.<br>- **Tests:** named `RISK-19: …` / `SEC-B-1: …`. | rev-mv1ijr52-01b2f4b6 SEC-B-1 recommendation; RISK-19 |
| FU-9 | g2-docs-submission (README owner from phase G; b4 is closed) | The README says that `npm start` tightens an existing `data/` and `data/uploads/` owned by the current user to 0700. The documented backup command (`VACUUM INTO`) is run under `umask 077`, so the backup file is not world-readable. `test/scan/docs.test.js` asserts both lines. | rev-mv1ijr52-01b2f4b6 SEC-B-5; b1 handoff ho-mv1ipb3r-01ca015d |
| FU-10 | c6-reserve-concurrency-browser | In `test/integration/rs14-db-busy.test.js`, start the server first (its migrations run in `BEGIN IMMEDIATE` at startup). Only then does the lock-holder process take `BEGIN IMMEDIATE`, and then reserve is called and must answer 503 `DB_BUSY` with `Retry-After`. Starting the lock holder first would make server startup, not reserve, fail. | rev-mv1ijr52-01b2f4b6 PB-4 |
| FU-11 | c1-auth-rbac | With `RS_TRUST_PROXY=1`, the client IP taken from the last `X-Forwarded-For` hop is validated with `net.isIP`. An invalid value falls back to the socket address and is never used as a throttle key verbatim. Test named `SEC-B-9: …`. | rev-mv1ijr52-01b2f4b6 SEC-B-9 |
| FU-12 (decision, orchestrator) | g2-docs-submission or b3 via rework | Whether to commit a `package-lock.json`. The only package is the devDependency `@playwright/test`, and there are no runtime dependencies. Default: commit one in g2 with `npm install --package-lock-only`, and have `clean-checkout.sh` use `npm ci` when a lockfile exists. | SEC-B-6 (info) |

FU-12 is decided: `dec-mv1joq3i-01180c65` says g2 commits `package-lock.json` and the package scan asserts it. Until g2 runs, a `package-lock.json` created by a local `npm install` is an unowned file and must not be left in the tree. One appeared during phase C and made a completion fail; see the phase-C submission.

## Added after phase C (delivery-lead, 2026-10-10)

Sources: the phase-C handoffs (c1 ho-mv2pgzqg-0145c52b, c2 ho-mv2q84ku-01502a13 / ho-mv2xpk15-0134ba5a, c3 ho-mv2r6nzy-016f73cb, c5 ho-mv2pwq96-01a15bb3, c6 ho-mv2y12xq-012f7ce7).

**Ownership.** The approved plan.json cannot change without a plan rework. So each item names a task whose ownership already covers the files. Where no later task owns them, the item proposes a narrow `eccode rework open`, which is the orchestrator's action, and says so.

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-13 | d4-frontend-extraction (fixtures; owns `test/fixtures/contracts/**` in phase D), then d5-extraction-contract-browser (owns `test/api/contracts.test.js` in phase D; depends on d4) | **d4 corrects the six contract fixtures** that c6 marks as known defects (todo in `contracts.test.js`), so the fixtures match the live API and the spec's Labels convention:<br>1. top-level `labels` in `plan-create-feasible.json`;<br>2. in `plan-create-infeasible.json`;<br>3. in `plan-approve.json`;<br>4. in `plan-reserve.json`;<br>5. `order.canMarkReady: false` in `supplier-order-confirm.json` (true only after the plan is executed; an executed-plan variant may be added);<br>6. `events[].cursor` as an opaque string in `admin-timeline.json`.<br>d4 also aligns the value-only drifts: sandbox `reservationTtlMin` 30, and `supplierName` as the planner gives it.<br>**d5 then deletes the six entries of `KNOWN_FIXTURE_DEFECTS`** in `contracts.test.js`, so the six scenarios run as normal tests. The phase-D run of `npm test` shows 0 todo from this source. | c3 item 6, c6 fixture defects, c2 labels note |
| FU-14 | **No later task owns both files.** `src/config.js` belongs to d3/e1 and `.env.example` to g2, and `test/scan/env-example.test.js` fails when a name read by config is missing from `.env.example`. **Proposed:** an orchestrator rework (`eccode rework open --owner backend-engineer --files src/config.js --files .env.example --files test/unit/config/limits.test.js`), before phase D starts, together with FU-15 if the orchestrator prefers one rework. | Finish FU-8's configuration:<br>- `RS_PLAN_RATE_LIMIT` (integer 1–1000, default 10) and `RS_PLAN_RATE_WINDOW_MIN` (integer 1–1440, default 10) are parsed into `planRateLimit` / `planRateWindowMin`, which `src/app.js` already reads;<br>- both are listed in `.env.example`;<br>- a test named `RISK-19: …` in `limits.test.js` covers the bounds and defaults;<br>- `npm test`, including the env-example scan, stays green.<br>Until this lands, the limit (10 per 10 min) works and is tested, but is configurable only through `createApp({planRate})`. | c2 ho-mv2q84ku-01502a13 / ho-mv2xpk15-0134ba5a; dec-mv1jopyn-01ba1096 |
| FU-15 | **Unassigned so far.** The natural place is the access hook in `src/auth/rbac.js`, which only c1 owned. **Proposed:** an orchestrator rework (`--owner backend-engineer --files src/auth/rbac.js --files test/unit/auth/rbac.test.js --files test/api/general-limit.test.js`), possibly merged with FU-14, before phase E, so that the payment routes are covered. | The spec's general per-user limit:<br>- 300 requests per minute per signed-in user, counted in `rate_events` (kind `general`, key `u:<userId>`), with check and insert in one `BEGIN IMMEDIATE`;<br>- 429 `RATE_LIMITED`, `details.limit: "general"`, with `Retry-After`;<br>- applied after identification in the access hook;<br>- never counts c2's planning keys (`plan:u:<id>`);<br>- test named `SEC-2: …` or `T19: …`;<br>- NFR5 p95 stays under 300 ms. | c1 ho-mv2pgzqg-0145c52b remaining issue 5; c2 rate_events note |
| FU-16 | d5-extraction-contract-browser can remove the tolerance helper only if it owns the file. `test/browser/journey-infeasible.test.js` is c6's and no later task owns it. **Proposed:** after d3 lands, a one-file test-engineer rework (`--files test/browser/journey-infeasible.test.js`). Or, if the orchestrator prefers, accept the tolerance until phase G and have g3 (which owns the browser suite's helpers) report it. | Remove `withoutUnregisteredExtract()` from `journey-infeasible.test.js` once `POST /api/requests/:id/extract` exists. After that, any 404 on that route in a journey is a failure, not tolerated. The journey may switch from the manual-form path to the fake-extraction path. | c6 remaining issues 3–4 |
| FU-17 | d4-frontend-extraction (it reworks the fields table in phase D); verified by g1-frontend-a11y-labels | At 360 px the "Original wording" column of the "What you need" table is clipped inside its scroll region (the header reads "Or"). Make every column readable at 360 px: stack the columns, or put the wording under the value, with no horizontal scrolling inside the table. The change is asserted in d5's degraded-extraction journey at 360 px and in g1/g3's a11y checks. | c6 remaining issue 7 |
| FU-18 | d5 (extract, request delete, degraded view), e6 (execute, execute replay, abandon, paypal create, receipt, supplier ready, supplier handover) | The ten contract scenarios that c6 skips because their routes did not exist yet become real scenarios when each route lands. They must not stay skipped. The test "every registered route has a scenario" stays in force. | c6 remaining issue 2 |
| FU-19 | e1-payment-adapters, e2-payment-flow, e4-saga-reconciler, f1-supersession-refusal-expiry | **c3's ports and conventions must be used, not re-invented:**<br>- (e2) pass a `voidProvider` to `createApp` whose `queueVoid` inserts `so:<supplierOrderId>:void:1` into `provider_calls` (`INSERT OR IGNORE`, status intent, `started_at NULL`), and add the resolution hook and void-result handling;<br>- (e1) `fault_flags` rows are named `<kind>:<fault>`, the value is the supplier code or `''`, and `remaining` is a count or NULL;<br>- (e4) send the `so:<id>:refund:1` intents queued by `refund_order`; write the `meta` keys `reconciler_last_tick_at` / `reconciler_last_tick_ms` that metrics reads; call `expireDueReservations`;<br>- (f1) build the re-plan drain on `supersession.js` (`enqueueReplan`, `supersedeForOfferChange`, `markNonExecutable`).<br>**c1's routing contract:** routes that need the user but must redirect anonymous callers (PayPal return/cancel) use policy `public` with `ctx.auth.identify`; the webhook route uses policy `signature`. A new public non-GET route makes c1's `rbac.test.js` fail by design. | c3 remaining issues 2–5; c1 remaining issues 1–3 |

### Status after rework-1 (handoff ho-mv2zloa4-0168f7f1, gate phase:rework-1)

The phase C review rev-mv2zb2wy-019ac65d approved, with TR-C-2, SEC-C-2 and SEC-C-3 open. The orchestrator opened rework-1 for them (backend-engineer).

- **FU-14: closed by rework-1** (TR-C-2). `RS_PLAN_RATE_LIMIT` (1–1000, default 10) and `RS_PLAN_RATE_WINDOW_MIN` (1–1440, default 10) are parsed in `src/config.js` and listed in `.env.example`. Tests `TR-C-2: …` are in `test/unit/config/limits.test.js`; the env-example scan is green.
- **FU-15: closed by rework-1** (SEC-C-3).
  - The general per-user limit is `src/auth/general-limit.js`, called by the access hook after authentication. It uses kind `general`, key `u:<id>`, one `BEGIN IMMEDIATE`, and answers 429 `details.limit: "general"` with `Retry-After`.
  - It is configured by `RS_GENERAL_RATE_LIMIT` (default 300) and `RS_GENERAL_RATE_WINDOW_SEC` (default 60).
  - In the same rework, an unchanged confirm writes no new version (SEC-C-3 point 2), and IPv6 throttle keys use the /64 (SEC-C-2).
- **Spec update for the release checklist (delivery-lead, verification gate).** The spec's Deployment › Environment variables table must gain four names before release:
  - `RS_PLAN_RATE_LIMIT`, `RS_PLAN_RATE_WINDOW_MIN` (FU-8, `dec-mv1jopyn-01ba1096` covers the `plan` limit name);
  - **`RS_GENERAL_RATE_LIMIT`, `RS_GENERAL_RATE_WINDOW_SEC`**, which **were not in the spec at all**. Their names, bounds (1–100000, 1–3600) and defaults (300, 60) were chosen by rework-1.

  The approved spec is pinned, so the update is recorded here and in the verification report as a documented design delta rather than an edit. g2's README must list all four (add them to FU-9's README pass).
- **New follow-up from rework-1's disclosures:**

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-20 | d3-extraction-service (owns `src/services/retention.js`, the periodic sweep) or e4-saga-reconciler (reconciler housekeeping step 9) | Expired `rate_events` rows of kind `general` with key `u:<id>` are purged by the periodic housekeeping, not only on the user's next call. Every signed-in call now writes one row. Use the spec's 24 h purge for rate events and keep the 48 h rule for `request_create`. Test named `SEC-C-3: …`. | rework-1 remaining issue 2 |

**Decisions for the reviewer** (no follow-up unless a change is requested):
- Idempotent replay status. c3 replays the stored status (201 for a replay of the first answer, with `Idempotent-Replayed: true`) and answers 200 on the purged-key path, as the Conventions word it. The route table says "201 (new) or 200 (replay)".
- `RESERVATION_LIMIT` details carry only `reservationIds`, per the spec. The UI's link therefore goes to `#/requests`, not to the other request.

Accepted without a follow-up:
- **SEC-B-7 (info):** scrypt N=2^14 follows the approved design. Passwords are checked by length only, per the auth contract. Raising N is a one-constant change in `scripts/seed.js` and c1's verifier together, if the security reviewer asks for it in phase C.
- **SEC-B-8 (info):** the stale header comment in `src/domain/explain.js` ("nothing is free text", although the refusal reason is shown verbatim) is not fixed. b2's rework did not touch `explain.js`. It is a comment, not behaviour. It will be corrected by the next task that reopens `src/domain/`, or by a rework if the reviewer asks for it.

## Added after phase D (delivery-lead, 2026-10-11)

Sources:
- the phase D handoffs: d1 ho-mv30knyb-01ee912a; d2 ho-mv3158kt-011b3953 and its reset ho-mv31n07e-01ec72ff; d3 ho-mv31j0p2-01ac6416; d4 ho-mv30i4sf-01273270 and its reset ho-mv32b3pf-011eac5d; d5 ho-mv3249el-0180bc20 and its reset ho-mv32g80v-01649548;
- rework-2 (rev-mv32bt1y-019ab941, TR-RW2-2) and rework-3 (ho-mv32h04t-01f86c40);
- the decisions dec-mv31kbrz-012381a1 and dec-mv32c290-0182b807.

### Status of the items assigned to phase D

| # | Status after phase D | Evidence |
|---|---|---|
| FU-2 | **Partly met, accepted for version one** (`dec-mv31kbrz-012381a1`).<br>- The upload route enforces its own 60 s streaming deadline (tests `PB-3: …` in `test/api/uploads-retention.test.js`).<br>- Node's server-wide `requestTimeout` is still 30 s, so the effective cap is 30 s.<br>- Raising the timeout for the upload route needs a `src/http` rework, and only if the phase D review asks for one. | ev:ev-mv32nlru-01ed051e |
| FU-13 | **Closed.**<br>- d4 corrected the six fixtures.<br>- d5 removed `KNOWN_FIXTURE_DEFECTS` and the todo machinery from `contracts.test.js`.<br>- `npm test` shows 0 todo. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32t4g4-01a3f3cb |
| FU-16 | **Closed once rework-3 is approved** (submission sub-mv32kio2-01649f99).<br>- The frontend half was removed by d4's reset: `EXTRACT_ROUTE_MAY_BE_MISSING` is gone, and a 404 on extract now shows Retry.<br>- The test half was removed by rework-3: `withoutUnregisteredExtract()` is deleted. | ev:ev-mv32jbs1-016d62d1 |
| FU-17 | **Closed in phase D.**<br>- d4: below 640 px the fields table stacks, and every cell carries its column title.<br>- d5: browser tests `FU-17: at 360x800 …` and `FU-17: at 1280x800 …`, with a mutation shown red (ev:ev-mv320rxs-0129b775).<br>- g1 still checks the table in its a11y pass. | ev:ev-mv32n2uv-012076da |
| FU-18 | **Phase D half closed.** Image upload, GET image (binary row), extract, extract degraded, degraded view and delete are real scenarios.<br>The 7 phase E rows stay skipped until their routes land (owner e6). | ev:ev-mv32t4g4-01a3f3cb (52 tests: 45 pass, 7 skipped) |
| FU-20 | **Closed by d3.** Test: `SEC-C-3: the sweep purges rate rows older than 24 h (the u:<id> rows of every signed-in call included) and keeps request_create 48 h (FU-20)`. | ev:ev-mv32nlru-01ed051e |

### New follow-ups from the phase D handoffs

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-21 | g2-docs-submission (owns `README.md`, `.env.example` and the live-model runbook) | d2's live runner reads a **new variable, `RS_LIVE_MODEL_CEILING_USD`**. It is required, positive and at most 5.00, and the runner exits 2 without it.<br>- The variable is in neither `.env.example` nor the spec's Deployment table.<br>- README line 56 still says the suite needs only `RS_LIVE_MODEL=1`.<br>- **g2:** list the variable (commented, opt-in) in `.env.example`, correct the README line, and write the live-model runbook command `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model`, with `-- --dry-run` first.<br>- `test/scan/env-example.test.js` does not catch this, because it checks only the names that `src/config.js` reads. | d2 ho-mv3158kt-011b3953 (live runner); delivery-lead check of the variable names in `src/`, `scripts/` and `test/live/` against `.env.example` |
| FU-22 | e4-saga-reconciler (housekeeping step) | Purge the rest of the spec's "Other data" list, which d3's retention sweep does not cover:<br>- expired sessions;<br>- `login_failures` older than 24 h;<br>- idempotency keys after 24 h;<br>- `invalid`/`unverified` webhook rows after 7 days (already in e4's criteria).<br>Until e4 lands, d3's sweep settles stale `reserved` model-spend rows at their cap. e4 either takes this over, with **one owner** so that a row is not settled twice, or leaves it in the sweep and says so. | d3 ho-mv31j0p2-01ac6416 remaining issue "STALE MODEL RESERVATIONS" |
| FU-23 | **Orchestrator: decision, or a migration-only rework** (only b1 owned `src/db/**`) | Request ids come from `INTEGER PRIMARY KEY` without `AUTOINCREMENT`. After a hard delete of the highest id, the next request reuses that id. The admin timeline's audit rows of the deleted request then share the id with the new request, which may belong to another customer.<br>- **Option 1:** a new append-only migration that rebuilds `rescue_requests` with `AUTOINCREMENT`, with a test named `RS-39: …` showing that an id is never reused.<br>- **Option 2:** accept the reuse with a recorded decision. Hard delete happens only when no supplier order existed, and the audit rows hold ids and statuses only. | d3 reviewer note 1 |
| FU-24 | **Orchestrator: decision** (any change would need a rework of `src/services/extraction.js`, which only d3 owned) | A refusal by the budget or the rate limit stores a degraded row, as the spec says, and that row becomes the newest extraction.<br>- The page then shows "Automatic reading unavailable" and the manual form, even though an earlier extraction of the same request succeeded.<br>- A later confirm treats every value as `manual` (test `SEC-8: when the latest extraction is degraded, nothing is taken from an earlier one …`).<br>**Proposed:** accept it for version one. It follows the spec's wording, the customer can still finish by hand, and the notice is hidden once requirements exist (d4's reset). | d3 reviewer note 2 |
| FU-25 | **Orchestrator: decision.** Default: g2 documents it; f1 (owns `src/services/plans.js`) only if it is assigned there | Opt-in rephrasing is built and unit-tested (`src/ai/rephrase.js`, `RS-05: …` in `rephrase.test.js`), but no route calls it.<br>- `RS_EXPLAIN_REPHRASE` is parsed by `src/config.js` and listed in `.env.example` (`=0`), yet setting it to 1 changes nothing. `Explanation.rephrased` is always null, and the UI never renders it.<br>- RS-05's rephrasing clause is therefore proved at unit level only.<br>**Default:** g2 states in the README and in `.env.example` that rephrasing is not wired in version one. | d3 "NOT DONE / OUT OF SCOPE"; d4 last remaining issue |
| FU-26 | ai-engineer, after LIVE-M1 (blocked on the user: Q3 spend ceiling, CLI login or `ANTHROPIC_API_KEY`) | LIVE-M1 is the first contact with the real CLI and API. It checks the stream-json stdin line and result event shapes, `--json-schema` acceptance of the wire schema (`schemaAccepted` on `cli-image-smoke`, F-TR-13), the sufficiency of `--max-budget-usd 0.05` for an image call, and the `output_config.format` behaviour of the API.<br>Any shape difference is folded into `src/ai/cli.js` / `anthropic.js`, and `cli-transcript.ndjson` is re-recorded from the real stream. Until then the transcript is a recorded **shape** written from the design, not a capture. | d2 ho-mv3158kt-011b3953 remaining issue 2 and nextAction |

### Documented design deltas from phase D (for the verification report, TR-RW2-2)

The approved spec is pinned. These additions are recorded here and must be listed in the verification report as documented design deltas, or be folded into a spec revision.

**Contract additions:**
1. `Extraction.addressedToAssistant: boolean` appears in the extract response, in `details.extraction` of a 429/503, and in `RequestView.extraction`. It is stored in `fields_json` under the reserved key `__meta`, which `renderExtraction` hides. Rows without it read as false.
2. `RequestView.capabilities: { deleteRequest: boolean }`. It is currently always `true` (`src/services/view.js`). It is pinned by value in the four request-view contract rows and by key in c2's RS-34 key list (rework-2).
3. A missing `Content-Length` on the image upload, and an upload that misses its deadline, answer 400 `BAD_REQUEST`. The deadline case adds `details.reason: "UPLOAD_TIMEOUT"` and `Connection: close`. The catalog's 400 row names only "malformed path parameter or query".

**Extraction behaviour:**

4. A degraded row stored for a refusal carries `errorCode` `PROVIDER_BUSY` (rate, concurrency) or `PROVIDER_UNAVAILABLE` (budget).
5. A new degraded row replaces a degraded row that is already the newest, so a retry loop does not grow the table.
6. `GET /api/requests/:id/image` also sends `Content-Disposition: inline`.

**Background work:**

7. The retention sweep also purges `rate_events` (24 h; 48 h for `request_create`, FU-20). Until e4 lands, it also settles stale `reserved` model-spend rows, which the spec gives to the reconciler.

**Client:**

8. The client time limits are 65 s for upload and 45 s for extract. The spec says the API client aborts at 15 s, and that limit still applies to every other call. Because of `dec-mv31kbrz-012381a1`, the server cuts an upload at 30 s.

**Corpus and live runner:**

9. The EXT-1 images are rendered from `labels/*.txt` by a pure-Node 5×7 bitmap renderer. The spec describes `labels/*.html` with a Chromium screenshot. The labels are legible but synthetic.
10. Live runner:
    - it needs `RS_LIVE_MODEL_CEILING_USD`, at most 5.00, besides `RS_LIVE_MODEL=1` (FU-21);
    - it refuses under the net guard, under `RS_TEST_OFFLINE=1` and with the fake provider;
    - it offers `--dry-run`.

**Configuration:**

11. Internal configuration fields `modelCallCapMicroUsd`, `modelDailyBudgetMicroUsd` and `fakeModelCostMicroUsd` are derived from the existing variables. No new variable is read by `src/config.js`.
