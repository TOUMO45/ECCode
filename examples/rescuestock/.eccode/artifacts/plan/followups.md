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

## Added after phase F (delivery-lead, 2026-10-11)

Sources: the phase F handoffs (f1 ho-mv40suhb-012306c3; f2 ho-mv41a3s6-0138e24d; f3 ho-mv403lay-01fa3938, ho-mv42ei0w-019037ae; f4 ho-mv43p246-01228012), rework-5 (ho-mv43etq7-01598938, sub-mv43raev-013fd872; review rev-mv44amic-012cf420; iteration 2 ho-mv44fohe-01197e16), the decisions `dec-mv40tgfo-01d03e4f`, `dec-mv40tgp9-0139d534`, `dec-mv41b2g0-018dc143` and `dec-mv43s14b-01addb18`, and `.eccode/artifacts/phase-f/submission.md`.

### Status of earlier items touched by phase F

| # | Status |
|---|---|
| FU-19 | **Closed.** f1's part: the re-plan drain runs on `supersession.js` (`enqueueReplan`, `supersedeForOfferChange`, `markNonExecutable`) through the reconciler; `replan-queue.test.js` (F-TR-2) and `supplier-refusal.test.js` exercise it. f1 changed no source file. |
| FU-33 | **Still open, phase G** (`dec-mv3tqbn4-01d43152`). It failed again under load: in f4's first verification run (ev:ev-mv43j15k-01209f8b), and in the delivery-lead's run ev:ev-mv445oiq-01166891 during a uniform 2.1× slowdown. Both times the single re-run passed. The full-suite lock (`dec-mv43s14b-01addb18`) reduces contention between agents but does not remove the race. |
| FU-34 | **Tested** by f2: `F-TR-6: a webhook capture of a cancelled operation is refunded on the next tick, exactly once` (`void-capture-race.test.js`, through a signed webhook). The backstop in `reconciler.js` is kept. |
| FU-35 | **Decided again** for the handler side: `dec-mv40tgfo-01d03e4f`. The request handler does not drain; the customer sees "Finding a new plan with current stock…" for up to one reconciler interval (default 15 s). For the verification report. |
| FU-36 | **Met** (f2). `ledgers.test.js` › `FU-36: a consume row and a restock row carry the same fields as a reserve row; the balances are the running sums …`. The helpers stay in `saga.js`. |
| FU-38 | **Met** (f3). `payments/view-non-executable.json` is now the post-claim state (AUTHORIZATION_EXPIRED); the new `recovery/view-abandoned.json` shows a real abandon. Test: `recovery.test.js` › `FU-38: a real abandon cancels the orders; …`. |
| FU-39 | **Not done, decided:** `dec-mv40tgp9-0139d534`. `RESERVATION_LIMIT` keeps `reservationIds` only; the UI fallback stays. |
| FU-40 | **UX part partly met** (f3): `poll.js` keeps polling while the plan is executed and a live order is still `confirmed`, so the receipt appears without a reload. `journey-happy.test.js` still reloads (not f3's file); g3 may drop the reload. The **docs part** stays g2's. |
| FU-41 | **Met** (f2). (a) `readBeforeResend` in `saga.js` (three `FU-41(a)` tests); (b) two `FU-41(b)` tests. The reviewers' mutant M6 is killed (ev:ev-mv418etg-01b71dfe, 25 of 25 mutants killed). Side effect: two approved tests went stale and were updated by rework-5. |
| FU-42 | **Met by test, and the source changed** (f2): the refund sender now reads `supplier_orders.total_cents`, like the capture. Tests: `capture-compensation.test.js` and `admin-refund-order.test.js` › `FU-42: …` (the two columns disagree on purpose). Phase E delta 24 now reads "refunds send `supplier_orders.total_cents`". |
| FU-43 | **Met** (f3): `?paypal=not_approved|check_failed` shows "PayPal did not confirm the approval; try again." (two `FU-43` tests in `recovery.test.js`). |
| FU-45 | **Met** (f2, `calls.js`). Tests: two `FU-45` tests plus `FU-45 (limit)` in `void-capture-race.test.js`. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-46 | g3-final-scans-browser (or an orchestrator acceptance if no G task owns `test/timing/**`) | The SEC-B-1 test `the seeded catalog shape never reaches PLANNER_LIMIT and stays fast …` (`test/timing/planner-sec-b1.test.js:58`) asserts every one of its 1,008 planner calls under 100 ms by wall clock (line 70). Under CPU contention one call took 186.9 ms (ev:ev-mv43keu0-0102c57c, two full suites on 4 CPUs) and 327.9 ms (ev:ev-mv445oiq-01166891, uniform 2.1× slowdown). Each passed alone or on re-run. Bound the per-call limit by the p95 the test already computes (line 78, `< 20 ms`) plus a generous per-call ceiling, or keep 100 ms and document that the test needs an idle host. The PLANNER_LIMIT assertion stays exact. | `dec-mv43s14b-01addb18`; rework-5 submission |
| FU-47 | **Withdrawn: settled by the rework-5 review.** `rev-mv44amic-012cf420` raised TR-R5-1 (major, the `notEqual 'refund_requested'` bound let the reviewer's mutant MB, a rejected refund recorded as `refunded`, pass the whole suite) and TR-R5-2 (minor, the FU-42/SEC-11 citation). Rework-5 iteration 2 (ho-mv44fohe-01197e16, in commit `8542265`) pins `refund_failed` and `last_error_code INVALID_RESOURCE_ID` and rewrites the citation; it awaits re-review. | — | rework-5 submission, observations 1 and 2; TR-R5-1, TR-R5-2 |
| FU-48 | delivery-lead (verification report) or an orchestrator decision | **A plan that was `executing` when a forced reset archived its operations stays `executing`.** The plan machine allows `executing → non_executable` only for CAPTURE_FAILED / AUTHORIZATION_EXPIRED. The plan is fenced (never taken over, resumed or marked executed; `RS-38: an executing plan whose operations the reset archived …`), but `plansByStatus` in the admin metrics still counts it. Either the verification report lists it, or a state-machine decision adds an archive transition. | f2 remaining issue 3 |
| FU-49 | technical and security reviewers of phase F, then the verification report | **The FU-41(a) hold path with a read that keeps failing:** f2 reports that the lease is paused and the next tick takes the plan over again, epoch + 1 per tick, until the read recovers, with no send meanwhile. The reviewers should confirm that this is consistent with F-TR-7 (no epoch growth while an operation is `capture_pending` or `unknown`) and with the takeover rule (no takeover while an operation is `capture_pending`/`unknown`). The test `FU-41(a): a read that fails under the lease sends nothing; …` covers the no-send part only. | f2 remaining issue 6 |
| FU-50 | g1-frontend-a11y-labels or g3-final-scans-browser (UX), after a product decision by the orchestrator | Once the voids are done and the new plan exists, "If something fails" is empty: the server returns no orders of the closed plan. The buyer then sees the refusal reason only in the status message, and no longer sees that the old authorization was voided. f3's criterion (spec, Frontend section 7) asks for "voids and refunds outstanding with outcome"; whether a *completed* void of a closed plan must stay listed is not stated. Decide whether completed voids of a closed plan stay visible. If yes, it is a view change (`view.js`, no remaining owner) plus a browser check. If no, the verification report says so. | f4 remaining issue 6 |
| FU-51 | g3-final-scans-browser | Browser checks at 360 px for the recovery states that no journey reaches: compensation/refunding, failed_needs_attention ("Contact the organiser"), reservation expired with Re-plan, the admin forced-reset stranded list. f3 checked them ad hoc only (scratch Chromium, not recorded). The RS-17 and RS-32(a) journeys cover refusal and replacement at 360 and 1280 px. | f3 remaining issue 14 |

### Carried to the verification report (owner: delivery-lead), additions

16. **Phase F design deltas** (f2 remaining issue 7, f1 remaining issues 3–4):
    - refunds read `supplier_orders.total_cents` (delta 24, source changed);
    - the forced reset's audit event carries `authorized`, `resolved`, `polled`, `resolveTimedOut` and `closedReconciling`;
    - any reset closes `reconciling` reservations without restock rows;
    - `refund_order` waits for the provider call (up to `RS_PAYPAL_TIMEOUT_MS` + 1 s) before it answers;
    - a forced reset needs the real void port (`startApp` wires it; `createApp`'s default is a recorder), otherwise authorized operations of non-approved plans are listed as `stranded`;
    - the re-plan drain is the reconciler's only (`dec-mv40tgfo-01d03e4f`);
    - between a supersession or refusal and the drain the request reads `replanning` (4a), or `cancelling` while a void is outstanding.
17. **Residuals of phase F:**
    - the `send_token` fence of `recordCall` cannot be proved on its own (the `status = 'intent'` condition rejects the same late results; the epoch fence and the lease checks are each mutant-proved);
    - a DB error inside `resolveRejectedVoid`'s transaction is escalated only by derivation row 2 (b) after `RS_PENDING_ESCALATE_MIN`;
    - f4's surviving mutant M5: the reconciler backstop that cancels a queued authorize is redundant with the void rule;
    - f1's four surviving mutants are equivalent through layered guards;
    - f1's and f2's mutation runs are in scratch copies (f2's are recorded: ev:ev-mv40r2b6-0183d269 failing-first and ev:ev-mv418etg-01b71dfe 25/25; f1's 30 mutants have no ev id);
    - return-crash (b) and (c) write the rows the product would write (`reservations.expires_at`, a `fault_flags` row) from the test process;
    - the multi-process tests ran on Node 22.22 only; the spec's 22.5 pass condition is the user's run.
18. **LIVE-DEPENDENT facts phase F relies on** (unchanged by f2): `final_capture`, `AUTHORIZATION_ALREADY_CAPTURED`, PayPal-Request-Id retention, the `EXPIRED` answer to a void (FU-45), capture DECLINED and PENDING, and refund PENDING/FAILED/COMPLETED semantics. RS-32(b) is LIVE-P2. **RISK-18's title names live RS-22 evidence, but no live file covers RS-22** (`test/live/paypal/` has rs18, rs19, rs20, rs23, rs24 and the Sandbox journey); g2/g3 should correct either the risk wording or LIVE-P1's scope.
19. **Coverage note from TR-R5-1:** no f2 test reaches the `rejected` refund mapping (`calls.js` L296, `refund_pending → refund_failed`). `admin-refund-order.test.js` covers a 200 answer with status FAILED, not a `rejected` send. Since rework-5 iteration 2, `admin-basic.test.js` › `refund_order` pins it and kills the reviewer's mutant MB. The phase F reviewers may want an f2-side test as well.

## Added after the phase F review (delivery-lead, 2026-10-11)

Sources: `rev-mv45ljos-01f00a5d` (technical, TR-F-1..TR-F-7) with the FINAL security draft `.eccode/reviews/drafts/phase-f-security-1.md` (SEC-F-1, SEC-F-I1..I7), the f2 reset handoff `ho-mv46cije-013aeaff` (commit `66206c9`), and `.eccode/artifacts/phase-f/submission.md` › "Iteration 2".

**Ownership.** No phase G task owns `src/services/admin.js`, `src/services/orders.js`, `src/routes/supplier.js`, `test/api/uploads-retention.test.js` or `test/timing/**`. Every item below that needs a change there needs either a user-authorised rework (`limits.maxReworks` is now 12, commit `88c6c4d`) or an orchestrator acceptance recorded for the verification report.

### Changed items

| # | Change |
|---|---|
| FU-33 | **Raised by TR-F-7 to the first change of phase G, before any further full-suite evidence is gathered.** The race is in the test, not in load: `retention.js` deletes the row (L37) and then unlinks the file asynchronously (L47). The test polls for the row only, then checks `existsSync` at once. Four recorded occurrences: ev:ev-mv43j15k-01209f8b, ev:ev-mv445oiq-01166891, ev:ev-mv44rydx-01958248, ev:ev-mv451ngy-01bf3721. **Owner: orchestrator** (no G task owns the test file): a rework or a scope extension of g3. Resolved when the test waits for the file as well, and three consecutive locked `npm test` runs pass it. |
| FU-49 | **Resolved (TR-F-1, f2 reset `ho-mv46cije-013aeaff`).** `holdOperation` in `saga.js` puts a held operation back to `unknown` (prev_status `authorized`), keeping the original `unknown_since`. The F-TR-7 takeover exclusion and derivation row 2 now apply. The epoch stays bounded (2 over 8 failing ticks), and the request escalates to `failed_needs_attention` after `RS_UNKNOWN_ESCALATE_MIN`. |
| Item 16 (design deltas) | Add: **a held pre-resend read (failed, or CAPTURED/VOIDED/EXPIRED) makes the operation `unknown`** until the reconciler's next read resolves it; derivation row 2 escalates it only after `RS_UNKNOWN_ESCALATE_MIN` (f2 remaining issue 2). |
| Item 18 (RISK-18) | **RISK-18's title is corrected** with `risk add --id RISK-18 --title …` (delivery-lead, the risk's owner, 2026-10-11T18:48:29Z). It now reads "Single-credential Sandbox mode makes live RS-19/20/23/24 evidence weaker than claimed". Its status stays open. |
| Item 19 (rejected refund) | **Resolved (SEC-F-1).** f2's new test in `capture-compensation.test.js` drives a compensation whose refund is rejected (`http_422:refund`) and pins `refund_failed`, `reconciling` with REFUND_FAILED, no restock and `failed_needs_attention`. Mutant MB is red (ev:ev-mv45wwaa-0115c9c9). |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-52 | g3-final-scans-browser (`docs/evidence-table.md`) and delivery-lead (verification report) | The evidence table and the verification report list these as **LIVE-DEPENDENT and not covered by LIVE-P1** (no live file exercises them):<br>- authorization DENIED/PENDING (RS-21);<br>- void after capture (F-TR-6);<br>- PayPal-Request-Id retention across a takeover;<br>- capture PENDING/DECLINED;<br>- refund PENDING/FAILED;<br>- the EXPIRED read after a refused void (FU-45).<br>The table's rows match LIVE-P1's real scope, RS-18/19/20/23/24. | TR-F-3 |
| FU-53 | delivery-lead (verification report, item 16); optional code change needs an orchestrator decision (`admin.js`, no G owner) | The report states that the `stranded` statuses of a forced reset are **as of the archive**, and that a capture in flight for an executing plan can complete after it. Its refund is then never sent, because `startCall` refuses archived operations, and the stranded entry still says `authorized`. Optional: the archive transaction bumps `lease_epoch` of executing plans, to fence late result writes. | TR-F-6 (complements SEC-F-I1) |
| FU-54 | **Decision needed (orchestrator)**; then `src/services/admin.js` (no G owner) and g1 (`public/js/views/admin.js`) | (a) Each stranded entry carries `planStatus` and `cancelRequested` (or `owedRefund`), so captured money owed back is distinguishable from a completed sale.<br>(b) The intro is worded by provider: L130 says "Check each one in the PayPal Sandbox dashboard" even with the fake provider, whose records the reset has just archived.<br>Or the verification report records the decision not to. | SEC-F-I1 |
| FU-55 | orchestrator (follow-up; `admin.js`, no G owner) | A `denied` audit row is written for `refund_order` 404 and for every 422 on the fault routes. Otherwise the verification report states the narrower reading of "every faults and refund_order call writes an audit event". | SEC-F-I3 |
| FU-56 | orchestrator (`admin.js`, no G owner) | `applyFault`'s `supplier_refusal` reason uses `checkRefusalReason` (`src/services/orders.js` L133) instead of `str(1, 300)` (admin.js L428), with a test for ESC/BEL and a blank reason. | SEC-F-I4 |
| FU-57 | orchestrator (`admin.js` metrics, no G owner) | Admin metrics `reconciler.unresolved` also counts `refund_failed` operations and reservations with an `escalation`. Otherwise the verification report states the narrower meaning (`operationsByStatus` shows them). | SEC-F-I5 |
| FU-58 | orchestrator (`orders.js` `checkRefusalReason`, no G owner; or g1 if solved by isolation at display) | Bidi controls U+202A–U+202E and U+2066–U+2069 in a refusal reason are refused or stripped, or the reason is isolated (FSI…PDI) when the sentence "Supplier X refused the order: <reason>. No money was taken." is composed. | SEC-F-I6 |
| FU-59 | **Product decision needed (orchestrator, possibly the user)**; then `src/services/orders.js` (c3's, no G owner) | Decide whether a **`refunded`** order may still be marked ready and handed over. Today: `canMarkReady` true, `ready` and `handover` answer 200, the order ends `collected`. This matches the brief's literal guard and OQ-D2 (partial refunds). If not allowed: add `refunded` to `HANDOVER_BLOCKING_PAYMENT` (orders.js L27) for that order only, with a test. | SEC-F-I7 |

### Carried to the verification report (owner: delivery-lead), additions

20. **TR-F-5 survivors:**
    - **MF6** (the empty-plan guard of `releaseIfSettled` removed) is equivalent: any reset closes `reconciling` reservations in the archiving transaction.
    - **MF4** (the reset pass skips "stale started intents → unknown") is reachable only within one reconciler interval before the regular tick marks the intent.
    - Optional pin: a forced-reset test with a stale started void intent.
21. **SEC-F-I2 / FU-49 history:** before the TR-F-1 fix, the plan was taken over every tick while reads failed. After it, the epoch grows only with a successful reconciler read: at most one takeover per read that shows CREATED.
22. **TR-F-2:** the SEC-11 bound test and the RS-37 already-archived test now bound their own wait (5 s helper, `{ timeout: 20000 }`), so an unbounded pass is a red test (ev:ev-mv464v52-0153ea2c), not a stalled suite.

## Added after phase G (delivery-lead, 2026-10-11)

Sources:
- the phase G handoffs: g1 ho-mv48fejc-0156303e, g2 ho-mv48w355-01947d26, g3 ho-mv4e9r0t-01a6813c;
- rework-6 (ho-mv47ltf3-01c9351a) and rework-7 (ho-mv4aker9-014c05a3, ho-mv4b2qcu-01d596a2), both approved;
- the decisions `dec-mv46ovf2-017bf12d`, `dec-mv4740d4-015b3589`, `dec-mv46ovt6-01a662af`, `dec-mv47vma5-01d0d177`, `dec-mv48g2fj-018e0ca7` and `dec-mv4eaw35-013b929e`;
- `.eccode/artifacts/phase-g/submission.md`.

### Status of earlier items touched by phase G

| # | Status |
|---|---|
| FU-21 / FU-40 (docs) | **Closed** by g2 (README, runbooks, `.env.example`) and rework-7 round 2 (the live-only variables as commented `.env.example` entries, accepted by `env-example.test.js`). `RS_PAYPAL_WEBHOOK_ALGOS` stays an environment fallback (`dec-mv3abkv0-011839e9`). |
| FU-33 | **Closed** by rework-6: the RS-39 test waits for the unlink. It was green in g3's three consecutive locked runs (ev:ev-mv4dnlhv-0167b2b1, ev:ev-mv4dpxim-01093245, ev:ev-mv4ds3no-0151407a) and in every delivery-lead run of phase G. |
| FU-37 | **Closed** by g3: `test/scan/live-refusal.test.js`. |
| FU-44, FU-52 | **Closed as documentation:** the live PayPal runbook and `docs/evidence-table.md` list the same items that no live file covers, and the table test pins the parity. Verification report. |
| FU-46 | **Closed** by rework-6: SEC-B-1 is re-timed. Green in every phase G full run. |
| FU-50 | **Decided**, `dec-mv47vma5-01d0d177`: no view change. Verification report. |
| FU-51 | **Closed** by g3: `a11y-states.test.js` renders the recovery states at 360 px and the admin stranded list. |
| FU-53 | **Report only** (`dec-mv46ovt6-01a662af`): stranded statuses are as of the archive; no `lease_epoch` bump. |
| FU-54 | **Closed:** g1 words the intro by adapter, and rework-7 sends `planStatus`/`owedRefund`. |
| FU-55 | **Closed, narrower:** a denied audit row for `refund_order` 404 and 422 only. A 422 on the other fault kinds writes none. Verification report. |
| FU-56, FU-58 | **Closed:** rework-7 (the supplier and admin reasons refuse control and bidi characters) and g1 (`<bdi>` isolation, rendered by g3 in Chromium). |
| FU-57 | **Closed, narrower:** `unresolved` counts `refund_failed` operations; reservations with an escalation are not counted. Verification report. |
| FU-59 | **Closed** by rework-7: the per-order refunded rule (`orders.js` L50–57). README L243 states it. |
| Single-credential sentence | **Closed:** `dec-mv48g2fj-018e0ca7`; `src/config.js` L376 sends the spec's sentence. |
| Lockfile (FU-12, TR-R7-3, SEC-R7-I2) | **Decided**, `dec-mv4eaw35-013b929e`: the lock lacks the darwin-only `fsevents` entry. The regenerated lock is at `scratchpad/g3-lock/package-lock.json` (sha256 `d870b67d…dd62`) for the next maintenance change. |

### New follow-ups

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-60 | release checklist; the README is g2's (done) and rework-7's (approved), so this needs an orchestrator decision: a one-line change, or the verification report alone | `dec-mv4eaw35-013b929e` says "the verification report **and the README limits** state" the missing fsevents entry. The README does not mention it; only `docs/evidence-table.md` › Limits does. | phase G submission, Disclosures item 8 |
| FU-61 | the user (release checklist) | `docs/submission/project-description.md` L42: replace "[Edit this to say exactly which decisions I actually made myself.]" with the user's own statement; fill in the repository and video URLs; re-check every hackathon fact in `docs/submission/checklist.md` against the official page (the Devpost connector needs the user to sign in again). | g2 remaining issues 7–8 |
| FU-62 | a person (technical reviewer or the user), before release | RS-36 / F-TR-9: inspect the final `src/domain/derive.js` against the final derivation table (rows 4a, 5a, 12 and the row 2 clauses were added after the phase B inspection). Until then the evidence table's RS-36 `I` part rests on the phase B review plus tests. | g3 remaining issue 2 |

### Carried to the verification report (owner: delivery-lead), additions

23. **T20 deviation:** an allow-list of interpolations instead of a literal template-literal ban (reviewer's acceptance recorded in the phase G review).
24. **Design delta `dec-mv44nzj5-01fbc177`:** ARCH-26 (2) and saga step 6 say "intent (queued or started)"; the code reads first only for **started** intents. The approved spec is not edited.
25. **Phase G test limits:**
    - Chromium only, Linux only, Node 22.22 only;
    - the date-control focus is shown by screenshot comparison;
    - the secrets scan works by shapes and canaries (screenshots by name and text chunks, not pixels);
    - the clock-shift blind spots (the header of `test/helpers/shift-clock.mjs`);
    - a Sandbox adapter without test mode was never rendered.
26. **Unverified documents:** the hackathon facts (RISK-10), the PayPal dashboard steps and the webhook event names in `docs/runbooks/live-paypal.md`, the live-model dry run, macOS and Windows, and switching `RS_PAYMENT_PROVIDER` with unfinished payments.
