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

## Added after the phase D review (delivery-lead, 2026-10-11)

Sources:
- the review rev-mv33xoyz-0143dd56 (`.eccode/reviews/drafts/phase-d-1.json`, TR-D-1..TR-D-10) and the security draft `.eccode/reviews/drafts/phase-d-security-1.md` (SEC-D-1..SEC-D-9);
- the resets d3 ho-mv3461bp-018c0431 and d2 ho-mv34d3dh-01f6abfa;
- the decisions dec-mv341ap0-010209d2 (FU-23 rework needs the user) and dec-mv34dqsr-0163a6d9 (the ceiling refuses a leading zero).

### Changed items

| # | Change |
|---|---|
| FU-21 | **Wording replaced** after d2's reset (TR-D-10). The runner now accepts `RS_LIVE_MODEL_CEILING_USD` only as an exact decimal from 0.01 to 5.00, with at most two decimals and no leading zero (`dec-mv34dqsr-0163a6d9`). It prints a `cli: claude <version>` line before its first call, and SIGINT/SIGTERM end a run without a report (exit 130/143). **g2 uses d2's text** for `.env.example` and the README: "RS_LIVE_MODEL_CEILING_USD: the most you are willing to spend on one live model run (npm run test:live-model); required together with RS_LIVE_MODEL=1; an exact decimal from 0.01 to 5.00 with at most two decimals (for example 0.50 or 5); anything else, including 5.0000001, 1e0 or 05, is refused with exit 2." The README line about the printed plan may also mention the CLI version line. The runbook command stays `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model`, with `-- --dry-run` first. |
| FU-23 | **Decided, scope widened, blocked on the user.** `dec-mv330std-0165d9be` chose the migration, and TR-D-3 widened it. The rework must rebuild `rescue_requests`, `plan_versions` and `images` with `AUTOINCREMENT`, and `planning_runs` too (security's recommendation). A test named `RS-39: …` must show that after a hard delete of the highest ids none of the request, plan-version or image ids is reused. The engine refused a fourth rework (`USER_AUTH_REQUIRED`, `limits.maxReworks=3`; `dec-mv341ap0-010209d2`), so it needs the user to open it or to delegate `rework.open`. **e4 is not dispatched until this rework is approved.** In the meantime phase E runs e0..e3. Whatever happens, the verification report states that `model_spend.request_id` has no foreign key, so the spend rows of a hard-deleted request keep the old id. |
| FU-26 | **Two items added.** (a) SEC-D-5: `anthropic.js` › `post` must read `response.body` with a running byte count and abort past 1 MiB, instead of `response.text()` first. No later task owns `src/ai/anthropic.js`, so it goes with the FU-26 adapter change, or into a rework if the verification review asks for one sooner. (b) TR-D-6: the LIVE-M1 report gives the metric values from `test/eval/lib/metrics.js` as the threshold result, not the assertion count. It also scores SEC-7 on the stored row after `normaliseExtraction`, not only on the raw provider output. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-27 | e1-payment-adapters (owns `src/config.js` in phase E); g2-docs-submission for the documentation | **Bound `RS_MODEL_TIMEOUT_MS` below the client's 45 s extract limit.** `src/config.js` accepts 1..600000 today. Above about 44 s the client gives up first, while the server still holds the connection and the customer's single model slot, stores the row and charges the call.<br>- **e1:** narrow the accepted range to 1..40000. Like every other range violation, a larger value is a startup configuration error that names the variable only. Add a test named `TR-D-7: RS_MODEL_TIMEOUT_MS above 40000 is refused …`. The default stays 30000.<br>- **g2:** the `.env.example` comment and the README state the bound and the reason, the client's 45 s.<br>- If e1 is not to touch it, the orchestrator records a decision and g2 documents the bound instead (TR-D-7 allows either). | TR-D-7; security SEC-D-8 (which suggests 60000; 40000 keeps the client consistent) |
| FU-28 | g2-docs-submission (runbook); delivery-lead (verification report); ai-engineer for (b), with the FU-26 adapter change | **The remaining orphan cases of TR-D-9.** *Text rewritten after the phase D iteration-3 resets (TR-D-16 / SEC-D-15).*<br>**What is handled:**<br>- **The server** (`src/main.js`, d3 ho-mv35zyof-011e9473) registers **SIGINT, SIGTERM and SIGHUP** with `process.on`, and `stop()` is idempotent. Ctrl-C, `kill <pid>` and a closed terminal therefore all run `stop()` → `close()` → the CLI adapter's `close()`, and **a second signal during the grace period** is swallowed instead of killing the server. Both are proved by real server process tests.<br>- `process.exit()` (the `exit` hook, which now also removes the temp cwd).<br>- The live runner's SIGINT and SIGTERM, including repeats.<br>**What is not handled:**<br>- **A process killed with SIGKILL** (`kill -9`, the OOM killer, `docker stop` after its grace period).<br>- **A parent with no handler at all**, for example a script that embeds the adapter without `close()`.<br>- (b) **SIGHUP to the live runner** (`test/live/run-live-model.js`). Its `INTERRUPT_SIGNALS` is still SIGINT and SIGTERM. d2 owns the file and no later task does, so the fix (SIGHUP, exit 129) goes with the FU-26 adapter change (ai-engineer).<br>In each unhandled case no hook runs and the CLI child is orphaned. Each such child is bounded by `--max-budget-usd 0.05`, and the reservation sweep settles its row at the cap after 2 × `RS_MODEL_TIMEOUT_MS`.<br>**g2's runbook:**<br>- stop the server with Ctrl-C, `kill <pid>` (SIGTERM) or by closing its terminal; never `kill -9`;<br>- keep the terminal of a live run (`npm run test:live-model`) open until it ends, and stop it with Ctrl-C;<br>- after an uncatchable kill, check for a leftover `claude -p` process (`pgrep -af "claude -p"`) and end its group.<br>**The verification report** lists SIGKILL, the handler-less parent and (b) as residuals of SEC-D-2. | d2 ho-mv34d3dh-01f6abfa, remaining issue 2; TR-D-9; TR-D-16 / SEC-D-15; d3 ho-mv35zyof-011e9473, remaining issue 6; d2 ho-mv35z5ux-01b0d55a, remaining issue 2 |
| FU-29 | g2-docs-submission (README) | **Two README statements from the security review.**<br>- SEC-D-4: five self-registered accounts from one IP can spend the default USD 1.00 daily model budget, which the gate bounds. For a public deployment, recommend `RS_ALLOW_SIGNUP=0` or a smaller `RS_MODEL_CUSTOMER_DAILY_SHARE`.<br>- SEC-D-7: in the privacy statement (T23), say that an uploaded photo is stored and sent to the model provider byte for byte, including any metadata such as an EXIF location. It is owner-only and deleted after 7 days. | TR-D-8; security SEC-D-4, SEC-D-7 |

### Carried to the verification report (owner: delivery-lead)

These come from the phase D review. None needs a code change in phase D.
1. **TR-D-4.** All eleven documented design deltas above, with the reviewer's judgements. Three caveats are written out:
   - with the server's default 30 s `requestTimeout`, the route's 60 s `UPLOAD_TIMEOUT` branch (delta 3) cannot fire in production, and only tests reach it, with an injected deadline;
   - `capabilities.deleteRequest` (delta 2) is constant `true`, and DELETE answers 409 `PAYMENT_IN_PROGRESS` where it does not apply, so it is a route-availability flag;
   - the EXT-1 images (delta 9) carry English capitals only, so LIVE-M1 will say nothing about reading Arabic packaging.
2. **TR-D-7 / SEC-D-8.**
   - The 408 that Node's `requestTimeout` sends for a slow upload is the server's bare `clientError` reply, with no JSON envelope and no `requestId`. It is an **NFR6 exception**.
   - The CLI refuses a third concurrent call at once (`PROVIDER_BUSY`) instead of waiting 5 s as spec T19 says. This affects availability only.
   - The bound on `RS_MODEL_TIMEOUT_MS` is FU-27.
3. **TR-D-3 / FU-23.** `model_spend` rows of a hard-deleted request keep the old request id. The state of the id-reuse rework at delivery is reported as it is.
4. **TR-D-5.** The CLI transcript and the Anthropic stub prove parsing, failure mapping and process hygiene, not the real event shapes or schema acceptance. LIVE-M1 stays Unverified until it runs.
5. **TR-D-6.** ECCODE_EVAL 200/200 counts harness assertions over the fake. The spec thresholds come from `metrics.js` and say nothing about model quality.
6. **The security info items, for the risk list:**
   - SEC-D-3: the injection backstops for a real model are the flag, the buyer and the approval;
   - SEC-D-5: chunked-body buffering (FU-26);
   - SEC-D-6: no per-request idempotency on extract;
   - SEC-D-7: photo metadata (FU-29);
   - SEC-D-9: the secrets-scan gaps, planned for g3's RS-29 extension;
   - SEC-D-13 (added in iteration 3): grounding is lexical, not semantic. A quote that belongs to another field can still ground its number, as can a buyer-written code or an idiom. The shown quote reveals each case, and the buyer confirms;
   - SEC-D-14 (added in iteration 3): SEC-D-3 stands for `capacityMl` and `diameterMm` from the photo, which have no OCR check. `dec-mv35aank-0169ec16` keeps these two fields on the photo.
7. **FU-28.** The orphan residuals: SIGKILL, a parent with no handler, and the live runner's SIGHUP (FU-28 (b)).

## Added after the phase D iteration-2 review (delivery-lead, 2026-10-11)

Sources:
- the review rev-mv35hyoj-01e0a18c (`.eccode/reviews/drafts/phase-d-2.json`, TR-D-11..TR-D-17) and the security draft `.eccode/reviews/drafts/phase-d-security-2.md` (SEC-D-10..SEC-D-17);
- the resets d1 ho-mv35op30-016a6560, d2 ho-mv35z5ux-01b0d55a and d3 ho-mv35zyof-011e9473;
- the decision dec-mv35aank-0169ec16 (image provenance only for productType, material, capacityMl and diameterMm).

### Changed items

| # | Change |
|---|---|
| FU-28 | **Text rewritten in place** (table "New follow-ups" above). The server now handles SIGHUP and a second signal during the grace period. SIGKILL and a parent with no handler are not handled. The live runner's SIGHUP is the new part (b), owner ai-engineer with the FU-26 change. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-30 | backend-engineer, through a user-authorised rework of `src/services/extraction.js` (no task after d3 owns it; it can ride the FU-23 rework-4 if the user opens it). Otherwise the orchestrator records it as an accepted residual. delivery-lead lists it in the verification report either way. | **The date part of a `user_text` deadline is not grounded.** `deadlineTimeInQuote` checks the time only, so `2026-10-21T11:30` quoted "tomorrow by 11:30" stays known on the time alone. A relative date ("tomorrow", "Friday") cannot be matched without a calendar. The buyer confirms the deadline before any plan. **If taken up:**<br>- an absolute date written in the quote (ISO, "21 Oct", "21/10", or the Arabic forms after `foldDigits`) must equal the value's date, or the deadline is `unknown` with its question;<br>- a relative date may be resolved against the request's creation day in the server's time zone;<br>- add a test named `SEC-7: a user_text deadline whose written date differs from its value is unknown (FU-30)`. | TR-D-13 / SEC-D-10 resolution wording ("its date part too when present"), not met; d3 ho-mv35zyof-011e9473, remaining issue 2 |
| FU-31 | the same owner and route as FU-30 | **Arabic am/pm markers are not read.** `deadlineTimeInQuote` reads "3 pm" and "12:15 a.m." but not ص/م, so "الساعة ٣ م" is `unknown` and asked. This is the safe direction, an extra question for Arabic buyers who write the hour that way. **If taken up:**<br>- ص and م after an hour (and صباحًا/مساءً) map like am/pm;<br>- add a test that "الساعة ٣ م"→15:00 is known and "الساعة ٣ ص"→15:00 is unknown. | d3 ho-mv35zyof-011e9473, remaining issue 2 |
| FU-32 | **The reviewers decide** (technical-reviewer, security-reviewer). If they disagree with the extension: ai-engineer reverts it in `fail()` of `src/ai/cli.js` with the FU-26 adapter change (no later task owns the file). If they accept it: the orchestrator records a decision. delivery-lead states the rule in the verification report. | **d2 extended TR-D-15's cap charge beyond `close()`.** The adapter now charges the per-call cap also when its own timeout, an abort during a run (the client gives up) or the 8 MiB output flood kills a child that had started. Before, such a call was refunded at 0 whenever the adapter's timer fired before the service watchdog. The billing state of a killed call is unknown, so this is conservative, and it is consistent with the watchdog's own cap charge. One side effect: a buyer who cancels an extract mid-call is charged the cap against their own daily share. A call that never started a process is still not charged. | d2 ho-mv35z5ux-01b0d55a, remaining issue 1; TR-D-15 / SEC-D-16 |

### Carried to the verification report (owner: delivery-lead), additions

8. **TR-D-15 / FU-32, the ledger.**
   - A CLI call whose started child is killed (by `close()`, timeout, abort or flood) is settled at the per-call cap, not at 0.
   - Only SIGKILL of the server leaves the row `reserved`, and the startup sweep settles it at the cap.
   - The charge is proved at the gate and SQLite level (`TR-D-15: the ledger charges the cap for a call ended by close(); …`). **There is no HTTP-level row test** (a hanging stub, the server closed, `model_spend.actual` = cap). Such a test would belong to d3's API files, and nobody wrote it.
9. **TR-D-13 / FU-30 / FU-31.** The deadline is grounded on its time only. Its date part is the buyer's to confirm.

## Added after phase E (delivery-lead, 2026-10-11)

Sources: the phase E handoffs (e0 ho-mv37ojw0-01fb7411; e1 ho-mv38f42c-010fb379, ho-mv38jhfn-01d2ca04, ho-mv39x6r0-013c5688; e2 ho-mv39qe6x-01666ddf; e3 ho-mv3aalih-011f4d67; e4 ho-mv3tpmcv-01dc0d69, ho-mv3v3asc-01ce3c19; e5 ho-mv37hs3x-01066518, ho-mv3v9goy-01de8496; e6 ho-mv3uq93d-0114f12e), the approved rework-4 review rev-mv3v7t3p-0170adbe, and `.eccode/artifacts/phase-e/submission.md`.

### Status of earlier items touched by phase E

| # | Status |
|---|---|
| FU-18 | **Closed.** The seven phase E contract rows are real scenarios, plus route rows for GET `/api/paypal/return`, GET `/api/paypal/cancel` and the webhook (signed 200, unsigned 400). 0 skipped rows; a row for an unregistered route now fails (e6). |
| FU-19 | **Met** for e1 (fault_flags conventions), e2 (real void port `createVoidPort`, resolution hook) and e4 (refund intents sent, `reconciler_last_tick_at` / `_ms` written). f1's part remains. |
| FU-22 | **Closed by e4** (reconciler housekeeping: sessions, login failures, idempotency keys, invalid/unverified webhook rows after 7 days, stale model reservations). Stale reservations are settled by both d3's sweep and e4's housekeeping through one CAS UPDATE, so a row settles once. |
| FU-25 | **Amended** by `dec-mv38g19z-01f0a99f`: `RS_EXPLAIN_REPHRASE` stays parsed and inert; g2 documents it as reserved. |
| FU-27 | **Closed by e1**: `RS_MODEL_TIMEOUT_MS` is bounded to 1..40000 (test `TR-D-7: RS_MODEL_TIMEOUT_MS above 40000 is refused …`). g2 documents the bound. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-33 | **No remaining task owns `test/api/uploads-retention.test.js`.** Routed to phase G by `dec-mv3tqbn4-01d43152`: a user-authorised rework (the maxReworks of 4 is used) or an orchestrator acceptance. delivery-lead lists it in the verification report either way. | The RS-39 test `startApp removes an expired image at startup and another one on the next tick` waits for the file as well as the row (the sweep deletes the row, then unlinks). Resolved when three consecutive `npm test` runs are green on that row (TR-R4-6). Until then a failure is re-run once and reported, never skipped. | e4 remaining issue 2; TR-R4-6; `dec-mv3tqbn4-01d43152` |
| FU-34 | **No F/G task owns `src/services/webhooks.js`.** A user-authorised rework or an orchestrator acceptance; f2 (owns `reconciler.js`) keeps the backstop either way. | A webhook that moves an operation with `cancel_requested_at` into `captured` calls `queueRefundWhenCancelled` (exported by `saga.js`) in the same transaction, as the void hook already does. Until then the reconciler's step-6 backstop queues the refund on its next tick; f2 must not remove that backstop and should add a test `F-TR-6: … a webhook capture of a cancelled operation is refunded on the next tick`. | e4 remaining issue 6 |
| FU-35 | orchestrator, **before f1 is dispatched** | Decide where the re-plan drain lives: `drainReplanQueue` is in `reconciler.js` (2 entries per tick, `next_attempt_at = now + min(5 min, 15 s × 2^old failed_drains)`), which F-PL-3 forbids f1 to edit. Either f1 accepts placement and exponent, or the change rides f2 (owner of `reconciler.js`). | e4 remaining issue 3 |
| FU-36 | f2-compensation-takeover-admin | The consume and restock ledger rows written by local helpers in `saga.js` keep the `inventory_ledger` row format and the SUM(delta) invariant; `test/api/ledgers.test.js` (RS-38) covers both paths (execute consume, compensation restock). Moving the helpers into `ledger.js` is optional. | e4 remaining issue 5 |
| FU-37 | g3-final-scans-browser | `test/scan/live-refusal.test.js` (named in the spec and in g3's NFR3 criterion) holds the live PayPal refusal proof now kept in `test/integration/rs20-two-process-execute.test.js` (it imports only `live-support.js` and `run-live-paypal.js`), or imports it; the rs20 copy may stay. | e6 remaining issue 3 |
| FU-38 | f3-frontend-recovery or g1-frontend-a11y-labels (own `test/fixtures/contracts/**`) | `test/fixtures/contracts/payments/view-non-executable.json` is titled or described as the post-claim state (CAPTURE_FAILED / AUTHORIZATION_EXPIRED, fulfilment still confirmed), not "abandoned": a real abandon gives `presentation: "cancelled"`. | e2 remaining issue 5 (a); e5 assumption 3 |
| FU-39 (optional) | f1-supersession-refusal-expiry (owns `src/services/reservations.js`) | `RESERVATION_LIMIT` details may carry `requestIds` (ids only); the UI uses them first with no change. Not required: the UI's fallback works. | e5 assumption 1; e2 remaining issue 5 (b) |
| FU-40 | g2-docs-submission (extends FU-21); f3/g1 for the UX note | **Docs:** `.env.example`, README and runbook list `RS_PAYPAL_WEBHOOK_ALGOS` (`dec-mv3abkv0-011839e9`), `RS_LIVE_PAYPAL_WEBHOOK_SAMPLE` and `RS_LIVE_PAYPAL_HEADED`; the runbook says to subscribe the PayPal webhook to the seven mapped event types only (`dec-mv3abkne-01161cf3`); both live entry points and their exit codes (`dec-mv3uqze6-0196f887`); `RS_EXPLAIN_REPHRASE` reserved (`dec-mv38g19z-01f0a99f`). The stale comments naming it in `src/ai/provider.js:11` and `src/ai/rephrase.js:1` ride the next touch of those files. **UX (f3/g1):** the request page stops polling once the plan is executed, so a receipt needs a reload (e6 journey note). | e1, e3, e6 remaining issues |

### Carried to the verification report (owner: delivery-lead), additions

10. **Phase E contract deltas** 1–21 of `.eccode/artifacts/phase-e/submission.md` › "Contract deltas" (the unmapped webhook type, the env-only algorithm list, the redirect outcomes, the execute refusal codes, the inline expiry pass, the fake's and the stub's interpretations).
11. **LIVE-P1, LIVE-P2, OQ-D5 Unverified** with the list of Sandbox facts the stub only guesses (issue names, link rels, approvable statuses, invoice-id rules, `final_capture`, event shapes, verify-webhook shape, 29-day expiry).
12. **Residuals without an owner:** SEC-R-2, SEC-R-3, SEC-RW4-I2, SEC-RW4-I4 (no F/G task owns `src/auth/**` or `src/services/extraction.js`), the untested two-process race on one webhook transmission id, FU-33, FU-34; each needs an orchestrator acceptance or a user-authorised rework.
13. **TK-6:** most engineer evidence carries no tree digest; the phase E submission's own runs do.

## Added after the phase E review (delivery-lead, 2026-10-11)

Sources: rev-mv3xhtuz-017cfbef (`.eccode/reviews/drafts/phase-e-1.json`, TR-E-1..TR-E-8) with the security draft `phase-e-security-1.md` (SEC-E-1, SEC-E-2, SEC-E-I1..I5), and the resets e2 ho-mv3xpr5x-01f0502b, e3 ho-mv3xwa94-016b9830 and e6 ho-mv3y24kt-01968292.

### Changed items

| # | Change |
|---|---|
| FU-34 | **Decided**, `dec-mv3vuigy-0109feb6` (accepted by both reviewers, SEC-E-I4). The backstop in `reconciler.js` stays; f2 must keep it. |
| FU-35 | **Decided**, `dec-mv3vui7s-014f6e7c`. The drain stays in `reconciler.js`, and f1 works behind the function it calls. |
| Item 12 (residuals) | SEC-R-2, SEC-R-3, SEC-RW4-I2 and SEC-RW4-I4 are accepted as residuals, `dec-mv3vuiqw-01d3c5c9`. The untested two-process race on one webhook transmission id, FU-33 and FU-34 (decided) remain on the list. |
| Item 13 (TK-6) | ECCode 0.3.4 merged the repair. Iteration 2 runs are tree-pinned. `eccode audit` lists every earlier approved gate without a commit as a release-baseline warning. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-41 | f2-compensation-takeover-admin (owns `saga.js`) | (a) Before `captureLoop` re-sends a capture call that is `unknown` (token-less), it reads the authorization under the lease, as the spec's saga step 6 says, rather than relying on the reconciler's step-2 read of the same tick.<br>(b) A test where an operation becomes `capture_pending` or `unknown` after the takeover and before the resumed run: the saga pauses and sends nothing. The reviewer's mutant M6 (the condition at `saga.js` L531 replaced by `false`) must then be killed. | TR-E-4; SEC-E-1 recommendation 5 |
| FU-42 (optional) | f2-compensation-takeover-admin | Either `capture-compensation.test.js` asserts the capture and refund request amounts against `supplier_orders.total_cents` with a disagreeing `payment_operations.amount_cents`, or the verification report states that the two columns are equal by construction (delta 24). | TR-E-5 |
| FU-43 (optional) | f3-frontend-recovery | A neutral notice for `paypal=not_approved` and `paypal=check_failed` ("PayPal did not confirm the approval; try again"). | TR-E-6 delta 25 |
| FU-44 | g3-final-scans-browser or g2-docs-submission | Either the fake's webhook signing string (`src/payments/fake.js`, no later owner; a decision is needed if code changes) and `test/helpers/webhook-signer.js` (g3) include `merchantKey`, or the verification report lists cross-merchant signature rejection under LIVE-P1 RS-24 as LIVE-DEPENDENT. | SEC-E-I1 |
| FU-45 | f2-compensation-takeover-admin (owns `calls.js`) | An authorization read back as `EXPIRED` after a rejected void is treated as settled (no money held), not escalated with `void_failed = 1`, with a test. | SEC-E-I3; phase E remaining issue 9 |

### Carried to the verification report (owner: delivery-lead), additions

14. **Phase E deltas 22-28** (submission › "Contract deltas added or changed in iteration 2"):
    - 22: CREATED applies from `approved`;
    - 23: `rate_events` are purged by `retention.js`, not the reconciler;
    - 24: refunds send `amount_cents`;
    - 25: no UI notice for `not_approved`/`check_failed`;
    - 26: explicit origin lists, so a late duplicate is `flagged`, not `ignored`;
    - 27: CREATED never resolves `unknown`;
    - 28: return/cancel limited to 30 per user per window.
15. **Accepted info items:** SEC-E-I2 (duplicate oracle), SEC-E-I4 (FU-34 window, no loss or doubling), SEC-E-I5 (authorize before the expiry pass, voided by the next pass).
