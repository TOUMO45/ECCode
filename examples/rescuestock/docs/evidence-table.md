# Evidence table: the 45 criteria of RescueStock

This table says, for each of the 45 required criteria (RS-01 to RS-39, NFR1 to NFR6), what was run, which tests show it, which recorded
runs (`ev:` ids) saw those tests pass, and what is NOT verified and why. `test/scan/evidence-table.test.js` keeps it honest: all 45
ids, a fixed status vocabulary, real `ev:` id patterns, every named test present in its file, every unverified part naming its blocker,
and (where the project record is present) every named test shown as `ok` and not skipped in a cited run's log.

**No live suite was run.** Nothing in this table rests on the real PayPal Sandbox or on a real model. Every payment result below comes
from the fake adapter (`RS_PAYMENT_PROVIDER=fake`) or from the Sandbox adapter talking to the loopback stub
(`test/helpers/paypal-stub.js`, which exists only with `RS_TEST_OFFLINE=1`); every extraction result comes from the fake model, from
recorded transcripts or from loopback stubs. Those doubles were written from the spec and from PayPal's documentation: they are not
evidence of how the real services behave.

## How to read a row

| Column | Meaning |
|---|---|
| Status | `verified`: the offline suites show the whole criterion and nothing in it depends on a real service. `fake-only`: the behaviour is shown against the fake or the stub, and a claim about the real service rests on their model. `LIVE-DEPENDENT`: part of the criterion can only be shown by a live suite, which was not run (or by a live file that does not exist). |
| Suites | `D` deterministic suite (`npm test`, offline, net guard on); `B` browser suite (`npm run test:browser`, Chromium); `I` inspection by a person (the spec's (I) parts; the Unverified cell names the recorded review that did it); `LM` live model suite (`npm run test:live-model`, billed); `LP` live PayPal Sandbox suite (`npm run test:live-paypal`). `LM` and `LP` are tags for the part that was not run. |
| Verified by | `file :: title` of tests that ran. |
| Evidence | `ev:` ids of recorded runs on the final tree that show those tests as `ok`. |
| Unverified part and blocker | What the offline evidence does not show, and what blocks it: `LIVE-M1` (a live model run: an authenticated Claude CLI or an API key, and the user's approval of the USD 5 ceiling; A4/Q3), `LIVE-P1` (the live PayPal files: Sandbox credentials, network access to the Sandbox hosts, a public webhook URL; A6/Q2), `LIVE-P2` (the hosted Sandbox approval journey with a Sandbox buyer account; A6/Q2), `OQ-D5` (facts about the real PayPal API that only a live run can settle), `USER-Q9` (a run the user does on another Node version). `(A2)` marks a row weakened by single-credential mode: with one Sandbox merchant for every supplier the live checks cannot show per-supplier money flows. |

## Runs cited

All runs were made by the test engineer on the Node 22.22 / Linux host of this project, one at a time under `flock /tmp/rescuestock-suite.lock`,
on the tree in which every test file is final (the runs of rework-8, which re-ran everything after the secrets, SQL, live-refusal and table
tests changed). Only this document changed after them (the ids and the prose around them); the final verification run of the task
(`npm test`, `npm run test:browser`, the clean checkout) is in the handoff, not in the table.

| Run | Command | Result |
|---|---|---|
| `ev:ev-mv4gkvne-01368b23` | `npm test` (1 of 3) | 2406 tests, 2398 passed, 0 failed, 8 skipped. NFR5: 7603 API requests, p50 2.8 ms, p95 56.0 ms (limit 300 ms); suite 104.1 s (limit 300 s) |
| `ev:ev-mv4gn3zu-015e267d` | `npm test` (2 of 3) | the same counts. NFR5: p95 56.3 ms, suite 103.4 s |
| `ev:ev-mv4gpbot-0198843c` | `npm test` (3 of 3) | the same counts. NFR5: p95 57.1 ms, suite 102.6 s |
| `ev:ev-mv4gserr-01d67650` | `npm run test:browser` | 28 tests, 28 passed, 0 skipped (Chromium; 360 px and 1280 px) |
| `ev:ev-mv4gsi7o-01ea49ae` | `test/scan/secrets.test.js` alone, after the browser run | 19 tests, 19 passed, 0 skipped (the screenshots of the browser run exist and were scanned) |
| `ev:ev-mv4gvr0e-018f354c` | the multi-process files (`lease-takeover`, `rs26-restart`, `return-crash`, `rs14-two-process-reserve`, `rs14-db-busy`, `rs20-two-process-execute`), four rounds at concurrency 4 | 25 tests per round, 25 passed per round, 0 skipped |
| `ev:ev-mv4gur0s-01e75119` | `npm test` with the clock moved 30 days forward (see "Date robustness") | 2406 tests, 2398 passed, 0 failed, 8 skipped. NFR5: p95 59.6 ms, suite 104.0 s |

The 8 skipped tests are the same in every `npm test` run and are skipped by their own code with a printed reason: the fake model provider has no
`busy` fault (1 test; the same check runs for the CLI and Anthropic model adapters), and the fake payment adapter has no wire, so 5
request-shape tests and 2 OAuth tests of the REST adapter are skipped for it (they run, and pass, for the Sandbox adapter against the stub). A skipped test is not counted as passed anywhere in this document.

Three consecutive `npm test` runs passed with the RS-39 rows (`ids are never reused`, `uploads`, `DELETE /api/requests/:id`, `the
retention sweep`, `startApp removes an expired image`) green each time (FU-33).

## The table

| Id | Status | Suites | Verified by | Evidence | Unverified part and blocker |
|---|---|---|---|---|---|
| RS-01 | LIVE-DEPENDENT | D LM | `test/api/extract.test.js :: RS-01: the RS-FIX-1 request in English and in Arabic yields identical core fields` <br> `test/unit/ai/fake.test.js :: RS-01: the RS-FIX-1 English and Arabic requests yield the same eight core values` | ev:ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): English and Arabic through the REAL model are not shown equal; offline the fake parser and the CLI and Anthropic adapters (recorded transcript, loopback stub) are. |
| RS-02 | LIVE-DEPENDENT | D LM | `test/api/extract-image.test.js :: RS-02: a clear photo yields capacity and diameter with provenance image` <br> `test/unit/ai/cli.test.js :: RS-02: stdin is one stream-json user line` | ev:ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): reading real photos with the real model, and the CLI image input shape (`schemaAccepted`, F-TR-13), are not run. |
| RS-03 | LIVE-DEPENDENT | D B LM | `test/api/extract-degraded.test.js :: -> 200, degraded true, schemaOk false,` <br> `test/api/extract-image.test.js :: RS-03: an ambiguous photo gives unknown for the unreadable field` <br> `test/browser/degraded-extraction.test.js :: RS-03: the harness forces the fake provider timeout through the admin fault switch` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | LIVE-M1 (A4/Q3): the EXT-1 ambiguous images are not run against the real model. Degraded paths (timeout, invalid JSON, schema, budget, rate) are verified with the fake. |
| RS-04 | verified | D | `test/api/approve-guards.test.js :: RS-04: approve without a budget is 409 MISSING_BUDGET` <br> `test/api/requests-plans.test.js :: RS-04: REQUIREMENTS_INCOMPLETE lists the missing core fields` | ev:ev-mv4gkvne-01368b23 | — |
| RS-05 | LIVE-DEPENDENT | D LM | `test/api/injection.test.js :: RS-05: an English injection is flagged (addressedToAssistant)` <br> `test/unit/ai/fake.test.js :: RS-05: text injection changes no core field against the control run` | ev:ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): resistance of the REAL model to injection (the EXT-1 injection cases) is not run; offline, the structure (data line, fixed prompt, no tool, output shape without permissions) and the fake are verified. |
| RS-06 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-06: with RS-FIX-1 and its pinned inventory the planner returns A+B, 8400 cents` <br> `test/unit/domain/planner-oracle.property.test.js :: RS-06: planner equals the brute-force oracle on 500 seeded random catalogs` | ev:ev-mv4gkvne-01368b23 | — |
| RS-07 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-07: supplier C is listed under rejections with INCOMPATIBLE_LID_DIAMETER` <br> `test/unit/domain/compat.test.js :: RS-07: cups 90 mm with lids 95 mm and no confirmed row are incompatible` | ev:ev-mv4gkvne-01368b23 | — |
| RS-08 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-08: supplier D is rejected with READY_AFTER_DEADLINE` | ev:ev-mv4gkvne-01368b23 | — |
| RS-09 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-09: with B removed (on_hand 0, or offer withdrawn) the best plan is A+E at 9500 cents` <br> `test/api/requests-plans.test.js :: RS-09: a supplier that refused an order of this request is left out of the next plan` | ev:ev-mv4gkvne-01368b23 | — |
| RS-10 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-10: B removed and budget 9000 gives no plan` | ev:ev-mv4gkvne-01368b23 | — |
| RS-11 | verified | D | `test/unit/domain/planner-fixture.test.js :: RS-11: with max pickups 1 the scenario is infeasible` | ev:ev-mv4gkvne-01368b23 | — |
| RS-12 | verified | D | `test/api/approve-guards.test.js :: RS-12: approving with the current hash and total is 200` <br> `test/unit/domain/planner-fixture.test.js :: RS-12: planner half - cups or lids below the requirement are never feasible` | ev:ev-mv4gkvne-01368b23 | — |
| RS-13 | verified | D | `test/api/supersession.test.js :: RS-13: voids one per authorization, reservation released with one ledger row per item` <br> `test/api/supplier-orders.test.js :: RS-13: a price change supersedes a proposed plan that uses the offer (PRICE_CHANGED)` | ev:ev-mv4gkvne-01368b23 | The voids go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b) asserts both authorizations VOIDED at PayPal), which was not run. |
| RS-14 | verified | D | `test/integration/rs14-two-process-reserve.test.js :: RS-14: round ` <br> `test/integration/rs14-db-busy.test.js :: RS-14: reserve under a lock held by another process is 503 DB_BUSY` | ev:ev-mv4gkvne-01368b23 | — |
| RS-15 | verified | D | `test/api/reservation-expiry.test.js :: RS-15 (part): before expires_at the pass changes nothing` <br> `test/api/reservation-expiry.test.js :: RS-15: the tick releases the reservation once, voids every authorization once` | ev:ev-mv4gkvne-01368b23 | The voids that expiry queues go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b)), which was not run. |
| RS-16 | verified | D | `test/api/reserve-idempotency.test.js :: RS-16: a new key reserves the plan` | ev:ev-mv4gkvne-01368b23 | — |
| RS-17 | verified | D B | `test/api/supplier-refusal.test.js :: RS-17: the refusal is audited, the order refused with its reason` <br> `test/browser/refusal.test.js :: RS-17: at ` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | The authorization voids run against the fake provider. |
| RS-18 | LIVE-DEPENDENT | D LP | `test/api/paypal-cancel.test.js :: RS-18: the cancel sets buyer_cancelled_at, leaves the operation` <br> `test/api/paypal-create.test.js :: RS-18: "Try approval again" after a cancel reads the order` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): cancel and abandon against the real Sandbox are not run (`rs18-cancel-abandon.test.js` exists and refuses without its flag). |
| RS-19 | LIVE-DEPENDENT | D LP | `test/api/amount-tampering.test.js :: RS-19: every tampered field in the body of paypal/create is ignored` <br> `test/api/paypal-create.test.js :: RS-19: the first call queues so:<id>:create_order:1` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): the amount the real Sandbox receives and its refusal of tampering are not run; the fake and the loopback stub show the exact request body the adapter sends. |
| RS-20 | LIVE-DEPENDENT | D LP | `test/integration/rs20-two-process-execute.test.js :: RS-20: round ` <br> `test/api/paypal-return-idempotent.test.js :: RS-20: three hits (refresh, back-navigation) produce exactly one authorize call` <br> `test/api/execute.test.js :: RS-20: the claim answers 202 {claimed:true}` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gvr0e-018f354c | LIVE-P1 (A6/Q2), (A2), OQ-D5; SEC-18: the double-capture argument's layers 4 and 5 (`PayPal-Request-Id` replay, `final_capture` refusing a second capture) rest on the fake's model of PayPal until the live run. The exactly-one-capture-per-order result holds against the fake. |
| RS-21 | LIVE-DEPENDENT | D | `test/api/authorization-denied.test.js :: RS-21: B is DENIED after A was authorized` <br> `test/api/authorization-pending.test.js :: RS-21: execute is 409 AUTHORIZATION_PENDING` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 does NOT cover this (FU-52): authorization DENIED or PENDING is exercised by no live file; the fake's model is the only evidence (OQ-D5). |
| RS-22 | LIVE-DEPENDENT | D | `test/api/capture-compensation.test.js :: RS-22: the second capture is declined: plan non_executable` <br> `test/api/execute.test.js :: RS-22: the second capture is declined: the first is refunded` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 does NOT cover this (FU-52): capture PENDING or DECLINED, refund PENDING or FAILED, a void after a capture and the EXPIRED read after a refused void are exercised by no live file; compensation rests on the fake's model of PayPal (SEC-18, OQ-D5). |
| RS-23 | LIVE-DEPENDENT | D LP | `test/api/webhooks.test.js :: RS-23: a valid transmission id seen twice is applied once` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2), Q6 (a public webhook URL): real signed deliveries and the real event names (OQ-D5) are not run. |
| RS-24 | LIVE-DEPENDENT | D LP | `test/api/webhooks.test.js :: RS-24: a tampered body, a wrong secret and a garbage signature are invalid rows` | ev:ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): real PayPal verification is not run. Cross-merchant signature rejection (FU-44) is not covered by LIVE-P1 either: the fake's signing string does not include the merchant key. |
| RS-25 | fake-only | D | `test/api/lost-response.test.js :: RS-25: the capture was applied but the answer is lost` <br> `test/api/lost-response.test.js :: RS-25: nothing was applied (a timeout)` | ev:ev-mv4gkvne-01368b23 | OQ-D5, SEC-18: no live file covers a lost capture answer (LIVE-P1 does NOT; the fake's model is the only evidence): that the real Sandbox shows what the fake shows after a lost answer (the capture visible through a read of the authorization and the order) is not run. |
| RS-26 | LIVE-DEPENDENT | D | `test/integration/rs26-restart.test.js :: RS-26: killed with the first capture applied at the provider` <br> `test/integration/lease-takeover.test.js :: ARCH-26 variant A (freeze_after_capture_apply)` <br> `test/integration/lease-takeover.test.js :: ARCH-26 variant B (freeze_before_capture_apply)` <br> `test/integration/return-crash.test.js :: F-TR-3 (a): restart` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gvr0e-018f354c | LIVE-P1 does NOT cover this (FU-52): `PayPal-Request-Id` retention across a process takeover is exercised by no live file. SEC-18: RS-26 on the Sandbox rests on the fake's model of PayPal. The process-level behaviour (kill, restart, takeover, one non-replayed capture per order) is verified with the fake; only Linux was run (SIGSTOP). |
| RS-27 | verified | D | `test/api/isolation.test.js :: RS-27: customer X reserving customer Y` <br> `test/api/paypal-create.test.js :: an unknown order and an archived request are 404 with no provider call and no row` | ev:ev-mv4gkvne-01368b23 | — |
| RS-28 | verified | D | `test/api/isolation.test.js :: RS-28: supplier A patching supplier B` | ev:ev-mv4gkvne-01368b23 | — |
| RS-29 | verified | D B I | `test/scan/secrets.test.js :: RS-29: no file under public/ holds a canary` <br> `test/scan/secrets.test.js :: RS-29: every tracked or unignored file (src, scripts, package.json, every document, the project record and its run logs, every image chunk) holds no canary and no secret shape` <br> `test/scan/secrets.test.js :: RS-29: a canary planted in each of 17 places` <br> `test/scan/secrets.test.js :: RS-29: the answers of a server that holds the canaries` <br> `test/scan/secrets.test.js :: RS-29: every screenshot under test/browser/out is a PNG with a plain file name` <br> `test/scan/secrets.test.js :: RS-29: an invalid secret (too short` <br> `test/scan/frontend.test.js :: RS-29: no secret, client id, token or credential-shaped value is in public/` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gsi7o-01ea49ae | Scope (SEC-G-1): every git-tracked or untracked-unignored file is read, including the project record `.eccode/` and its run logs in `.eccode/evidence`, `src/`, `scripts/`, `package.json`, the lockfile, every document of any type, every PNG chunk except pixel data and the bytes after IEND, and the screenshots of the browser run (the B tag: the browser run writes them, the scan reads them). Each file is checked for every canary and for the high-confidence secret shapes (bearer, basic, API key, PayPal token, assigned credential, URL password, private key, JWT, a long mixed-case token); exceptions are listed by path and exact fragment (test sources that hold fake credentials on purpose, a few lines of the record that quote a probe) and a stale entry fails. The security review's planting probe (17 plants) is caught in full. Screenshots are rasters: their file names and PNG chunks are scanned, not their pixels (the application never draws a secret). Secret SHAPES are matched by patterns, so a secret of an unknown shape would pass; the canaries are the strong check. (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): the screenshots labelling-sandbox-stub-1280, six-questions-1280 and a11y-stranded-1280, `docs/submission` and the README hold no secret value. |
| RS-30 | verified | D | `test/api/auth.test.js :: RS-30: admin routes: anonymous 401 UNAUTHENTICATED` <br> `test/api/isolation.test.js :: RS-30: anonymous reserve is 401` | ev:ev-mv4gkvne-01368b23 | — |
| RS-31 | LIVE-DEPENDENT | D B LP | `test/browser/journey-happy.test.js :: RS-31(a): at ` <br> `test/api/execute.test.js :: RS-31(a): http.request for GET /api/paypal/return and /cancel carries the identified userId` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | LIVE-P1, LIVE-P2 (A6/Q2): RS-31(b), the hosted Sandbox approval page with a Sandbox buyer account and its screenshots, is not run. |
| RS-32 | LIVE-DEPENDENT | D B LP | `test/browser/journey-replacement.test.js :: RS-32(a): at ` <br> `test/api/supersession.test.js :: RS-32 (supersession half)` <br> `test/api/supplier-refusal.test.js :: RS-32: refuses every open order of the supplier like the supplier` <br> `test/api/admin-basic.test.js :: RS-32: stock_depletion withdraws B` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | LIVE-P1, LIVE-P2 (A6/Q2): RS-32(b), the same replacement on the hosted Sandbox, is not run. |
| RS-33 | verified | D B | `test/browser/journey-infeasible.test.js :: RS-33: at ` <br> `test/unit/frontend/dashboards.test.js :: RS-33: an infeasible request shows blocking constraints` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | — |
| RS-34 | fake-only | D B | `test/api/labelling.test.js :: RS-34: GET /api/config carries the exact label set for this adapter` <br> `test/api/labelling.test.js :: RS-34: every payment object (create answer and request view) carries provider, simulated and sandbox` <br> `test/browser/labelling.test.js :: banners on every route, payment badges, demo data and price notice` <br> `test/unit/frontend/a11y-labels.test.js :: RS-34: the label fixtures are GET /api/config answers with the live label keys` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | LIVE-P1 (A2, SEC-3): the Sandbox adapter's labels were shown against the loopback stub in test mode only; the same page against the real Sandbox host (no test-mode banner, the real single-credential notice) is not run. |
| RS-35 | verified | D B I | `test/browser/six-questions.test.js :: requirements with provenance, decision trace, rejection codes with explanations` <br> `test/unit/frontend/a11y-labels.test.js :: RS-35: the request page answers the six questions in the spec` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): the screenshot six-questions-1280 answers all six questions from codes. |
| RS-36 | verified | D I | `test/unit/domain/derive.test.js :: RS-36 row 1: needs_input` <br> `test/api/rescue-status.test.js :: RS-36 (i): refund_requested or refund_pending on any operation is` <br> `test/api/schema-no-rescue-status.test.js :: RS-36: no table or column is named like a rescue status` | ev:ev-mv4gkvne-01368b23 | (I) F-TR-9, the inspection that `domain/derive.js` implements the derivation table row by row, is a person's and was done: the phase G technical review (FU-62, `rev-mv4fdv59-01732f16`) read the final `derive.js` against the brief's table and revision 2 row by row, found that it conforms, and found no table that stores a rescue status; the phase B review (`rev-mv1hc5zg-01a3fc75`) had done it for revision 2. Row 12 also accepts `draft`, a real plan status the table does not name (a harmless totalising extension, TR-G-6). A later edit of `derive.js` voids the inspection; the tests above pin the rows. |
| RS-37 | verified | D | `test/api/admin-basic.test.js :: RS-37: an operation in approved, authorization_pending` <br> `test/api/admin-reset.test.js :: RS-37: a refused reset (money held, no force) changes nothing` | ev:ev-mv4gkvne-01368b23 | The forced reset's void and read-resolve pass run against the fake provider (SEC-11). |
| RS-38 | verified | D | `test/api/ledgers.test.js :: RS-38: reserve writes one reserve row per item` <br> `test/unit/db/triggers.test.js :: RS-38: UPDATE on inventory_ledger fails` | ev:ev-mv4gkvne-01368b23 | — |
| RS-39 | verified | D | `test/api/uploads-retention.test.js :: RS-39: PNG, JPEG and WebP are accepted` <br> `test/api/uploads-retention.test.js :: RS-39: startApp removes an expired image at startup and another one on the next tick` | ev:ev-mv4gkvne-01368b23 | — |
| NFR1 | verified | D I | `test/integration/start-health.test.js :: NFR1: the start script splits into the Node gate and src/index.js` <br> `test/unit/config/node-version.test.js :: NFR1: the gate accepts Node 22.13.0 and newer and refuses anything older` <br> `test/integration/start-old-node.test.js :: NFR1: every flagged script begins with the flag-free Node gate` | ev:ev-mv4gkvne-01368b23 | USER-Q9: the run on the Node 22.5 branch (the floor the user has not yet confirmed) is the user's; only Node 22.22 was available, and the older binaries used by `start-old-node` are 20 and 21. The clean-checkout run is in the handoff, not in this table. |
| NFR2 | verified | D B | `test/browser/a11y-states.test.js :: register, ask, type the details, approve, reserve, approve both payments and complete the purchase with the keyboard alone` <br> `test/browser/a11y-states.test.js :: empty, loading, error with Retry, timeout, degraded extraction, expired reservation with Re-plan, refunding and needs-attention` <br> `test/browser/a11y-states.test.js :: the admin forced-reset stranded list is audited and walkable (FU-51)` <br> `test/browser/a11y-states.test.js :: keeps its order and the reason is a` <br> `test/unit/frontend/a11y-labels.test.js :: NFR2: every control on every view the SPA builds has a label` | ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650 | Chromium only (other browsers, screen readers and real touch devices were not run). No accessibility library was used: the audit is hand-written (names, 44 px targets, computed 4.5:1 contrast, focus indicators, no horizontal scroll); a native date-time control's focus is shown by comparing pictures of it, not by its style. |
| NFR3 | verified | D I | `test/scan/live-refusal.test.js :: NFR3: test/live/run-live-model.js without RS_LIVE_MODEL=1 exits 2` <br> `test/scan/live-refusal.test.js :: with no flag exits 2 with the fixed message, prints nothing else, and no network attempt is made` <br> `test/scan/live-refusal.test.js :: with no flag runs the six live files, every one refuses with the fixed message and none passes` <br> `test/scan/live-refusal.test.js :: a standalone launcher that package.json does not use` <br> `test/unit/ai/live-runner-refusal.test.js :: NFR3: without RS_LIVE_MODEL=1 the runner exits 2` | ev:ev-mv4gkvne-01368b23 | That the live scripts REFUSE is verified, including the real `npm run test:live-model` and `npm run test:live-paypal` lines run without a flag under the net guard (the second prints six refusals and exits 1, as the runbook says); that they RUN correctly is not (LIVE-M1, LIVE-P1: never run). (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): both runners label their reports (live-support.js L93-L95; run-live-model.js L182-L187). |
| NFR4 | verified | D I | `test/scan/env-example.test.js :: NFR4: .env.example has no duplicate variable` <br> `test/api/health-config.test.js :: NFR4: no secret, client id or merchant id appears` | ev:ev-mv4gkvne-01368b23 | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): secrets are read only from process.env, and the secret entries of `.env.example` are commented placeholders. |
| NFR5 | verified | D | `test/timing/planner-generator.test.js :: NFR5: the planner solves RS-FIX-1 (base and each pinned variant) in under 1 s` <br> `test/unit/helpers/report-p95.test.js :: NFR5: percentile is nearest-rank` | ev:ev-mv4gkvne-01368b23 | The API p95 and the suite time are printed by `scripts/report-p95.js` in the log of each full `npm test` run (below), on this host only. |
| NFR6 | LIVE-DEPENDENT | D LM | `test/api/model-budget-rate.test.js :: NFR6: with a fake per-call cost cap of USD 0.10` <br> `test/scan/secrets.test.js :: NFR6: sign-up, sign-in, requests, a photo, extraction` | ev:ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): the real cost report is not run. The budget case runs with RS_MODEL_CUSTOMER_DAILY_SHARE=1 (F-TR-18): it shows the global daily budget refusing the third extract; with the default per-customer share a single customer is stopped earlier, which the unit tests of the gate show separately. |

## Not covered by any live file

The live PayPal suite (LIVE-P1, LIVE-P2) has a fixed scope: RS-18, RS-19, RS-20, RS-23, RS-24 and the Sandbox journeys. The table's rows
match that scope, and `docs/runbooks/live-paypal.md` lists the same uncovered items. These are LIVE-DEPENDENT and would stay unverified
after a clean live run:

- authorization DENIED or PENDING (RS-21);
- a void after a capture (F-TR-6);
- `PayPal-Request-Id` retention across a process takeover;
- capture PENDING or DECLINED;
- refund PENDING or FAILED;
- the EXPIRED read after a refused void;
- RS-22 (partial capture failure with compensation) and RS-25/RS-26 on the Sandbox: they rest on the fake's model of PayPal (SEC-18);
- cross-merchant signature rejection: whether a webhook signed for one merchant is refused when delivered under another merchant key. The fake's signing string does not include the merchant key, so the automated suites cannot show it; RS-24's live check uses one forged signature only (FU-44).

## Live checks and what blocks them

| Check | Command | Covers | Blocked by |
|---|---|---|---|
| LIVE-M1 | `RS_LIVE_MODEL=1 npm run test:live-model` | RS-01, RS-02, RS-03, RS-05, NFR6 (real cost report) | an authenticated Claude CLI or `ANTHROPIC_API_KEY`; the user's approval of the USD 5 ceiling (A4/Q3) |
| LIVE-P1 | `RS_LIVE_PAYPAL=1 npm run test:live-paypal` | RS-18, RS-19, RS-20, RS-23, RS-24; OQ-D5 facts; SEC-18 layers 4 and 5 | Sandbox credentials (one merchant, so single-credential mode, A2); network access to the Sandbox hosts; a public webhook URL (Q6) |
| LIVE-P2 | `test/live/paypal/journey-sandbox.test.js` (part of LIVE-P1, in a browser) | RS-31(b), RS-32(b) | as LIVE-P1, plus a Sandbox buyer account |
| USER-Q9 | the Node 22.5 branch of NFR1, run by the user | NFR1 | the user's confirmation of the Node floor and a host with that Node |

None of these ran. Their refusal without the flag is what NFR3 shows.

## Mutation proofs of this phase

A test that cannot fail proves nothing, so each new check of this phase was run against a copy of the project with one deliberate fault
(each in its own directory, with its diff kept and printed first in the log). Every one failed as intended (the id is the failing run; its log starts with the diff):

| Mutant | The fault | Run | Caught by |
|---|---|---|---|
| `m-sql` | a user name goes into the SQL text of `users.js` | `ev:ev-mv4d772a-0113a2e4` | `sql.test.js` (T20) |
| `m-public` | a canary secret in `public/js/texts.js` | `ev:ev-mv4d79w3-011a9f8f` | `secrets.test.js` (RS-29) |
| `m-leak` | `/api/config` echoes the admin password | `ev:ev-mv4d7cja-010e6cc5` | `secrets.test.js` (RS-29, recorded responses) |
| `m-refusal` | the flag gate removed from a live PayPal file | `ev:ev-mv4d7f96-01900c43` | `live-refusal.test.js` (NFR3) |
| `m-labels-api` | `labels.testMode` always false | `ev:ev-mv4d7j26-01f4e39e` | `test/api/labelling.test.js` (RS-34) |
| `m-banner` | the test-mode banner is not drawn | `ev:ev-mv4dai8x-01be2775` | `test/browser/labelling.test.js` (RS-34) |
| `m-contrast` | muted text at 2.8:1 | `ev:ev-mv4dbmkw-01a366da` | `six-questions.test.js`, `a11y-states.test.js` (NFR2) |
| `m-focus` | no focus indicator | `ev:ev-mv4dbyo0-0162cb51` | `a11y-states.test.js` (NFR2) |
| `m-prov` | the provenance wording removed | `ev:ev-mv4dc2h9-01f8bf41` | `six-questions.test.js` (RS-35) |
| `m-bdi` | the refusal reason is not isolated in `<bdi>` | `ev:ev-mv4ddhl0-0135a046` | `a11y-states.test.js` (FU-58) |
| `m-tbl-row` | the RS-17 row is missing from this table | `ev:ev-mv4dkvtv-0186c75f` | `evidence-table.test.js` (45 ids) |
| `m-tbl-blocker` | the RS-18 row loses its LIVE-P1 blocker | `ev:ev-mv4dl2da-014fee9b` | `evidence-table.test.js` (blockers) |
| `m-tbl-id` | the RS-04 row cites a malformed ev id | `ev:ev-mv4dl2v6-01b303bd` | `evidence-table.test.js` (id pattern) |
| `m-tbl-log` | the RS-06 row cites a run whose log does not show its tests | `ev:ev-mv4dl3l9-012c6441` | `evidence-table.test.js` (cited logs; the logs were copied beside the copy because the record is not part of a copy, and the test pointed at them there) |

The phase G reviews found gaps in the scans and in this table; rework-8 closed them and proved each closure the same way. "Before" is the old check run against the reviewers' probe or mutant (it stays green: it was blind); "after" is the reworked check (red):

| Finding | The probe or fault | Before (blind or red) | After (red) |
|---|---|---|---|
| SEC-G-1, secrets scope | the security reviewer's planting probe: a canary in 17 places (source, scripts, package.json, `.eccode` artifacts and run logs, non-markdown documents, PNG chunks of every kind) | `ev:ev-mv4fmfug-01ed5b11`: 10 of 17 missed | `ev:ev-mv4fpdp5-01284e8f`: 17 of 17 caught |
| SEC-G-1 | `m8-eccode`: the walk skips `.eccode/` | | `ev:ev-mv4fq84x-012dd823` |
| SEC-G-1 | `m8-png`: only PNG text chunks are read | | `ev:ev-mv4fqb3u-013d47ed` |
| SEC-G-1 | `m8-holders`: `src/` exempt from the canary check | | `ev:ev-mv4fqe7i-01c4493f` |
| SEC-G-2, T20 | `ms-1-name-reuse`: an allow-listed name reused for input | `ev:ev-mv4fwted-018fc219` | `ev:ev-mv4fxe43-01321d97` |
| SEC-G-2 | `ms-2-exec-variable-route`: `ctx.db.exec(ctx.query.sql)` in a route | `ev:ev-mv4fwu2d-01aaa1f9` | `ev:ev-mv4fxerz-0116e6cb` |
| SEC-G-2 | `ms-3-space-before-paren`: ``db.prepare (`...${name}`)`` | `ev:ev-mv4fwuri-01f81f22` | `ev:ev-mv4fxfem-01cfb29c` |
| SEC-G-2 | `ms-4-bound-alias`: `db.prepare.bind(db)` | `ev:ev-mv4fwvhb-01edafad` | `ev:ev-mv4fxg3w-0165cb7e` |
| SEC-G-2 | `ms-5-control-inline`: input inline in `prepare(` | `ev:ev-mv4fww7i-0101f707` (red already) | `ev:ev-mv4fxgrc-0139bd50` (still red) |
| SEC-G-2 | `MS1` (technical reviewer): input written into the allow-listed `where` of `buildTimeline` | `ev:ev-mv4fxdho-011f9021` | `ev:ev-mv4fxhg4-01ab2a88` |
| SEC-G-2 | `ms-7-mjs-file`: an injectable `prepare(` in a new `.mjs` file | `ev:ev-mv4fxort-01768547` | `ev:ev-mv4fxpep-014fc37d` |
| SEC-G-I1, NFR3 | `m8-live-pkg-flag`: `test:live-paypal` also runs an ordinary passing test | `ev:ev-mv4g2jse-01dca1ff` (the old test) | `ev:ev-mv4g2nd9-0107dca9` |
| SEC-G-I1 | `m8-live-net`: a network call before the model flag gate | | `ev:ev-mv4g2qpy-0100db38` |
| TR-G-3 | `MT2` (technical reviewer): capture-compensation's RS-22 test marked SKIP in the cited log | `ev:ev-mv4ghzmm-01a47987` (stays green) | `ev:ev-mv4gxpt5-018aa93b` |
| TR-G-1, TR-G-2, TR-G-3 | `m8-t-ambig`, `m8-t-notag-d`, `m8-t-notag-i`, `m8-t-disclaim`, `m8-t-rs25`, `m8-t-rs13`: an ambiguous title, a missing D or I tag, the old disclaimer on RS-36, the old pointers on RS-25 and RS-13 | `ev:ev-mv4fz6fc-013adcba` (the new checks against the old table) | `ev:ev-mv4gxh6m-01c90aa4`, `ev:ev-mv4gxhs7-01369102`, `ev:ev-mv4gxiek-01d53c56`, `ev:ev-mv4gxj34-01b6ee77`, `ev:ev-mv4gxjp5-01328787`, `ev:ev-mv4gxkb3-01010e3e` |
| TR-G-5, FU-60 | the README demo followed literally (no diameter entered) and as now written (diameter 90, both approvals, supplier confirmations in the browser, Complete purchase), in a scratch copy with its own database, on loopback | `ev:ev-mv4g9s8g-01fa98cd` (the form asks for the diameter; the README did not say so) | `ev:ev-mv4geffn-01521bbb` (18 checks, 0 failed) |
| TR-G-6 | `scripts/clean-checkout.sh` with `RS_KEEP_CLEAN_CHECKOUT=1` in a scratch git work tree that holds an untracked file | `ev:ev-mv4ggc6d-01c7bc16` (not kept, no warning) | `ev:ev-mv4ggdgc-01d72af2` (kept, the file named in a warning, the work tree's status unchanged) |

## Date robustness

The suites use pinned clocks for the application, but file times, token ages and "today" come from the real clock in a few places. The
tool `test/helpers/shift-clock.mjs` (reviewed, with its blind spots listed in its header) moves the clock of a Node process and of the
servers it starts:

```
CLOCK_SHIFT_DAYS=30 NODE_OPTIONS="--import ./test/helpers/shift-clock.mjs" npm test
```

Run it under the suite lock (`flock /tmp/rescuestock-suite.lock ...`).

**Recorded run.** `ev:ev-mv4gur0s-01e75119` is one full locked `npm test` with `CLOCK_SHIFT_DAYS=30` and the preload (in the recorded command
the two variables are set with `env`, and the option as `--import=./test/helpers/shift-clock.mjs`, which Node reads the same as the form
above): 2406 tests, 2398 passed, 0 failed, 8 skipped (the same 8 as the unshifted runs), NFR5 p95 59.6 ms, suite 104.0 s. The run
`ev:ev-mv4dy7qb-017f57f9` (made in phase G on the same, unchanged tool) shows the preload is active under that command: `Date.now()` is 30.000 days ahead of the real clock in the process
and in a child process that inherits `NODE_OPTIONS`, a file written now reads 30.000 days ahead, and a time a test sets explicitly with
`utimes` reads back unchanged. So the passing shifted run is a run in a world that is 30 days later, in the test processes and in the
servers they start; it is not a statement about Chromium (not shifted) or about the blind spots in the header of the tool.

## Limits

- **Platform.** Linux only (the SIGSTOP/SIGCONT and `/proc` tests are skipped with a reason elsewhere). macOS and Windows were not run.
- **Node.** Node 22.22 for everything, plus Node 20 and 21 for the refusal of old versions. The Node 22.5 branch is the user's run (USER-Q9).
- **Browsers.** Chromium (Playwright 1.56.1) only, at 360 and 1280 px.
- **Lockfile (SEC-R7-I2).** `package-lock.json` has no `node_modules/fsevents` entry (an optional macOS dependency of Playwright). It affects installs on macOS only. Regenerating the lock from `package.json` in an empty directory with `npm install --package-lock-only` adds exactly that entry; the lockfile is not in this task's ownership, so it was not changed.
- **T20 (SQL).** The spec says a scan forbids template literals in `db.prepare(` calls. The code base builds some statements from constants and `?` placeholder lists with template literals (about thirty call sites), so a literal ban would fail correct code. `test/scan/sql.test.js` pins what the ban protects: every interpolation must be on a per-file allow-list with a reason, so any new one fails. The phase G reviewers accepted this on the conditions that rework-8 then met: an allow-list entry carries the exact number of uses and the hash of every statement that assigns or declares the name it rests on (and of the helper functions that build the text), so reusing a name or writing input into it fails; `.exec(<non-literal>)` is a database call unless its receiver is a regular expression (the migration runner is the only entry); `.prepare` or `.exec` used as anything but a call (`bind`, `['prepare']`, destructuring) is reported; and `.mjs` and `.cjs` files are scanned. What the scan still trusts: the reviewed constants, the range checks of the integers behind `PRAGMA busy_timeout`, and an allow-listed helper only as far as its pinned text goes. It reads source, not behaviour.
- **Inspections (I).** The (I) parts of RS-29, RS-35, RS-36, NFR3 and NFR4 are a person's. They are recorded in the phase G technical review (`rev-mv4fdv59-01732f16`) for the bytes it read; a later edit of what was inspected (`derive.js`, the screenshots, the submission files, the runners) voids the inspection, and no test here would notice.
- **Secrets scan scope.** It reads files, not history: a secret removed from the tree but present in an earlier commit is not found. It reads the recorded run logs as they are now; the scan fails the suite when a recorded log holds a secret of a known shape or one of the canaries, but a live credential of an unknown shape in a recorded log would pass, so read a live run's output before recording it.
- **Stubs.** The loopback PayPal stub and the fake adapter model PayPal as the spec describes it; a different real behaviour would not be seen (OQ-D5, SEC-18).
- **Clock shift.** The tool does not move SQLite (the application uses no SQL clock) or Chromium; its other blind spots are listed in its header.
- **Single credential (A2).** Every Sandbox row is weakened by one merchant for all suppliers.
- **Hackathon and Sandbox facts.** Statements about the hackathon rules and the PayPal dashboard in `docs/submission` and `docs/runbooks` are unverified against primary sources (see the g2 handoff).
