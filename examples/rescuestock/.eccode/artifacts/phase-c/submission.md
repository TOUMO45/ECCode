# Phase c-core-flow — submission

Author: delivery-lead. Gate: `phase:c-core-flow`. Date: 2026-10-10.
- Plan: `.eccode/artifacts/plan/plan.json`, revision 2, approved.
- Follow-ups: `.eccode/artifacts/plan/followups.md`, extended in this submission with FU-13..FU-19.
- Toolkit: 0.3.3. The engine unions every completion's files into the phase artifacts.
- Reviewers: technical, and security for auth and input handling (plan.md).

## What the phase delivers

| Task | Owner | Handoff | Verification runs | Delivered |
|---|---|---|---|---|
| c1-auth-rbac | backend-engineer | ho-mv2pgzqg-0145c52b | ev:ev-mv2pf62t-01198c9f (119 tests); failing first ev:ev-mv2p31zi-01021921; npm test 509/509 ev:ev-mv2pg2ag-0141772a | Auth routes csrf, register, signin, signout and session; server sessions (sha256 at rest, idle 60 min, absolute 12 h, rotation); pre-login HMAC and session CSRF tokens with an Origin check; SQLite throttles (SEC-1 pair/IP hard limits, cross-IP delay only, SEC-9 key normalisation); register limit (F-TR-17); RBAC access hook (default deny, role policies, `signature` policy for the webhook route only); admin bootstrap from `RS_ADMIN_PASSWORD`; client IP with `X-Forwarded-For` validation (FU-11); audit service |
| c2-requests-plans-view | backend-engineer | ho-mv2q84ku-01502a13, then the one-case fix ho-mv2xpk15-0134ba5a | ev:ev-mv2pustl-014a4bbe, ev:ev-mv2q6b1z-01e41e81, ev:ev-mv2q6xdm-016e9e6b; fix: failing ev:ev-mv2xmykn-01ac3e86 → ev:ev-mv2xncuw-0139e91f, npm test 750/750 ev:ev-mv2xo82d-01ee2754 | Requests (daily cap in one `BEGIN IMMEDIATE`), confirm (values only, server-derived provenance, supersession on change), planning runs with an offers_hash re-check, approval with hash and total and server re-validation, request list and RequestView with the rescue status derived on every read; FU-1 (typed 422 for `PLANNER_LIMIT`), FU-7 (derive input shape), FU-8 (per-customer planning limit) |
| c3-reservations-supplier-admin | backend-engineer | ho-mv2r6nzy-016f73cb | ev:ev-mv2qi8hy-012e358c, ev:ev-mv2r2we8-013b9455, ev:ev-mv2r4oe7-01ecfed1 (81 tests); suite red by one stale c2 case at completion: ev:ev-mv2r5ewg-01518bd8 (fixed by c2's one-case rework) | Reserve in one `BEGIN IMMEDIATE` (user/key idempotency, F-TR-1, live-reservation cap SEC-2, conditional stock update, orders and created operations, OUT_OF_STOCK path); ledger service; void rule with a provider port (no-op recorder by default); supersession for offer changes; supplier orders and inventory PATCH; expiry pass; admin reset, faults, timeline and metrics |
| c5-frontend-dashboards | frontend-engineer | ho-mv2pwq96-01a15bb3 | ev:ev-mv2pvbny-01b62540, ev:ev-mv2pvgnq-018e6e2c (95 frontend tests); baseline failing ev:ev-mv2p4dxf-01e156ae | Vanilla-ESM SPA: eight hash routes, the request page sections in RS-35 order, supplier orders and inventory, admin, labels and banners, states; one API module; DOM via textContent only (scan test); 43 contract fixtures |
| c6-reserve-concurrency-browser | test-engineer | ho-mv2y12xq-012f7ce7 | ev:ev-mv2xzdun-013ba433 (plan command incl. browser 3/3), ev:ev-mv2y09m2-015bab7d (npm test 804); failing first ev:ev-mv2xpu7l-01950f2b | RS-14 two-process and DB_BUSY integration tests; contract test over 44 scenarios; browser harness (fresh database and customer per file and journey, raised limits under test mode); RS-33 journey at 360/1280 px in Chromium 141 with screenshots and a zero-rows database check |

**Phase runs by the delivery-lead on the final tree:**
- `npm test`: **804 tests, 788 pass, 0 fail, 10 skipped, 6 todo**; NFR5 p95 61.4 ms over 1,612 API calls; suite 35.8 s (**ev:ev-mv2y39to-01c6520f**).
- `npm run test:browser`: **3/3** (**ev:ev-mv2y3flp-0125d730**).
- The 10 skipped and the 6 todo are explained below; neither hides a failure.

## Criteria → task → evidence

Counts are passing tests in ev:ev-mv2y39to-01c6520f whose names start with the id.

| Criterion | Task(s) | Proving tests | Evidence |
|---|---|---|---|
| RS-12 | c2 (plus b2's planner half) | 10 `RS-12:` tests in `test/api/approve-guards.test.js`: tampered `planHash` or `expectedTotalCents` → 409 `PLAN_CHANGED` with current values; a stored plan failing re-validation → 409 `PLAN_INVALID`; a short plan never feasible | ev:ev-mv2y39to-01c6520f, ev:ev-mv2q6b1z-01e41e81 |
| RS-14 | c6 (two processes), c3 (single process) | 14 `RS-14:` tests:<br>- `test/integration/rs14-two-process-reserve.test.js`: two server processes, busy_timeout 5000, three rounds; one 201 and one 409 `OUT_OF_STOCK`; one active row; reserved ≤ on_hand; no lock error in either log;<br>- `rs14-db-busy.test.js`: server started first (FU-10), then a held write lock with busy_timeout 0 → 503 `DB_BUSY`, `Retry-After: 1`, no rows; the same key gives 201 after release | ev:ev-mv2y39to-01c6520f, ev:ev-mv2xzdun-013ba433 |
| RS-16 | c3 | 10 `RS-16` tests in `test/api/reserve-idempotency.test.js`:<br>- same key and body → same reservation, no second row;<br>- another body → 422;<br>- `RS-16 (F-TR-1)`: same key on a second plan → 422 with no rows, before and after the key purge;<br>- a concurrent same-key race resolves to one reservation | ev:ev-mv2y39to-01c6520f |
| RS-28 | c3 | 6 `RS-28:` tests in `test/api/isolation.test.js`: supplier A patching B's product → 403, whole PATCH refused, nothing changed | same |
| RS-30 | c1, c3 | 49 `RS-30:` tests: customer and supplier sessions on admin fault and reset routes → 403; anonymous → 401 | same |
| RS-33 | c5, c6 | Browser: 3 `RS-33:` tests at 360×800 and 1280×800 (infeasible notice, blocking `OVER_BUDGET`, candidate codes, the relaxation button, no buy controls, zero rows in reservations, orders, operations, provider calls, plan versions and approvals; screenshots `test/browser/out/journey-infeasible-{360,1280}.png`). Unit: 2 `RS-33:` view-model tests | ev:ev-mv2y3flp-0125d730, ev:ev-mv2y39to-01c6520f |
| RS-36 | c2 (view), b2 (derive) | 76 `RS-36` tests: `test/api/rescue-status.test.js` (rescueStatus derived on every read, RS-36 (i)–(iv) through the API), `schema-no-rescue-status.test.js` (no stored status column), plus b2's derive tables and totality. **[I]** The reviewer inspects `src/services/view.js` (`deriveInput` hands derive.js the persisted rows, FU-7) against the revision-2 table (F-TR-9) | ev:ev-mv2y39to-01c6520f |

**Prerequisites proved here for criteria claimed later.** Named tests pass, but the criterion is not claimed by this phase:

| Item | What is proved now | Proved in full by |
|---|---|---|
| RS-04 (8 tests) | approve half: `MISSING_BUDGET` before `MISSING_DEADLINE` | e-payments (paypal/create half) |
| RS-15 (10 tests) | expiry pass exactly once, expire ledger rows, created operations voided locally | f-compensation |
| RS-27 (11 tests) | foreign request and plan ids → 404 | e-payments (PayPal return/cancel tokens) |
| RS-37 (7 tests) | reset guard and archive-not-delete | f-compensation (forced reset with provider voids) |
| RS-38 (8 tests) | reserve, release and expire ledger rows | f-compensation (consume, restock) |

Design items asserted by named tests:
- auth: SEC-1 (19), SEC-9 (5), SEC-13 (5), SEC-20 (9), ARCH-25 (33);
- limits: SEC-2 (13), F-TR-17 (9);
- SEC-B-9 / FU-11 (7);
- follow-ups: FU-6 (5), FU-7 (4), FU-1 and FU-8 (tests named `PB-3: FU-1 …` and `RISK-19: FU-8 …`);
- F-TR-15 (1).

**FU-5 watch:** no "database is locked" in the multi-process logs.

## Skipped and todo results in `npm test` (not hidden failures)

- **10 skipped:** contract scenarios for routes that do not exist yet. They are extract, request delete and the degraded view (phase D), and execute, execute replay, abandon, paypal create, receipt, supplier ready and supplier handover (phase E). The test "every registered route has a scenario" fails as soon as a route lands without its scenario. FU-18 assigns them to d5 and e6.
- **6 todo:** contract fixtures that disagree with the live API. The server follows the spec in each case. These are fixture defects in c5's files, and c6's contract test marks them as known defects.

| # | Fixture | Defect | Proposed fix owner |
|---|---|---|---|
| 1 | plan-create-feasible.json | top-level `labels` missing | d4 corrects, d5 drops the todo entry (FU-13) |
| 2 | plan-create-infeasible.json | top-level `labels` missing | same |
| 3 | plan-approve.json | top-level `labels` missing | same |
| 4 | plan-reserve.json | top-level `labels` missing | same |
| 5 | supplier-order-confirm.json | `order.canMarkReady` true; the server answers false until the plan is executed (brief state table) | same |
| 6 | admin-timeline.json | `cursor` an integer; the server returns an opaque string `<atMs>.<sourceIndex>.<rowId>` | same |

d4 owns `test/fixtures/contracts/**` and d5 owns `contracts.test.js` in phase D, and d5 depends on d4, so this needs no plan change. The value-only drifts (sandbox `reservationTtlMin` 15 vs 30, `supplierName`) go to d4 too.

## Cross-task notes the reviewers must see

1. **FU-8's environment names are not delivered.** The planning limit (10 per customer per 10 min, 429 `RATE_LIMITED` with `details.limit: "plan"` per `dec-mv1jopyn-01ba1096`) works and is tested. It is configurable only through `createApp({planRate})`.
   - `RS_PLAN_RATE_LIMIT` and `RS_PLAN_RATE_WINDOW_MIN` need `src/config.js`, owned by b1 and later by d3/e1, and `.env.example`, owned by b4 and later by g2.
   - The env-example scan fails if config reads a name that `.env.example` lacks, so the two files must change together.
   - No later task owns both, and the plan cannot change without a plan rework. FU-14 proposes a narrow orchestrator rework (`src/config.js`, `.env.example`, `limits.test.js`) before phase D.
2. **The planning count is stored under kind `general`.** `rate_events.kind` has no `plan` value, and migrations are append-only. So planning is counted under kind `general`, key `plan:u:<id>`. The general limit must not count those keys.
3. **The general per-user limit (300/min, `details.limit: "general"`) is unassigned.** c1 left it open, and c2 did not take it.
   - FU-15 proposes an orchestrator rework on `src/auth/rbac.js` plus its tests (only c1 owned `src/auth/**`), before phase E. It could be merged with FU-14.
   - Until then, the spec's general limit is not enforced. The specific limits are: sign-in, register, requests per day, planning, live reservations.
4. **Idempotent replay status, for the reviewer to decide.** The spec's Conventions say the stored status and body are replayed. The route table says "201 (new) or 200 (replay)".
   - c3 replays the stored status (201 for a replay of the first answer, with `Idempotent-Replayed: true`) and answers 200 on the purged-key path.
   - Changing this is one line in `resolveExisting`/`replayStored` if the reviewer wants 200 everywhere.
5. **The browser journey tolerates the extract route's 404.** `journey-infeasible.test.js` tolerates exactly the 404 of `POST /api/requests/:id/extract`, which phase D builds; the page ignores that failure. The journey uses the manual-form path.
   - The tolerance (`withoutUnregisteredExtract()`) must be removed once d3 lands.
   - No later task owns that file. FU-16 proposes a one-file test-engineer rework after d3, or accepting it until g3 reports it.
6. **A clipped column at 360 px.** The "Original wording" column of the "What you need" table is clipped inside its scroll region (the header reads "Or"). The page-level no-horizontal-scroll check passes; the column is reachable only by scrolling the table. FU-17 sends it to d4, verified by g1.
7. **Ports and conventions from c1 and c3 that later tasks must use** (FU-19):
   - the void-rule provider port (no-op recorder until e2 passes a real `voidProvider`);
   - `fault_flags` naming;
   - the `refund_order` intents e4 must send;
   - the `meta` keys metrics reads;
   - the re-plan drain hooks for f1;
   - c1's routing contract: policy `public` plus `identify` for the PayPal return and cancel; policy `signature` for the webhook.
8. **The RESERVATION_LIMIT link goes to the list.** `RESERVATION_LIMIT` details carry only `reservationIds`, per the spec, so the UI links to `#/requests`, not to the other request.
9. **Browser checks still to build in later journeys** (c5's list; journeys that need them come later): keyboard-only path, a measured 3 px focus ring, polling pause when hidden, the PayPal round trip, Retry and timeout states. Built now inside RS-33: no horizontal scroll, no CSP violations or console errors, focus on the h1 after a route change.

## Deviations from the design, with reasons

| Deviation | Where | Reason |
|---|---|---|
| Planning rate counted as kind `general`, key `plan:u:<id>` | src/services/plans.js | Migration 002's CHECK has no `plan` kind, and migrations are append-only |
| `labels` added at top level of the plan, approve and reserve responses | c2, c3 routes | The spec's Labels convention: every response with seeded prices carries labels. The fixtures lag behind (FU-13) |
| The two public POST routes (signin, register) check Origin and CSRF in their handlers | src/routes/auth.js | b1's contract runs the access hook for non-public routes only. `rbac.test.js` asserts these are the only public non-GET routes |
| Validation runs before the throttle | src/routes/auth.js | A 422 consumes no register budget and records no sign-in failure |
| `X-Forwarded-For` is ignored unless `RS_TRUST_PROXY=1`, then the last hop only, validated with `net.isIP` | src/auth/client-ip.js | Spec default (no proxy), and FU-11 |
| Throttle key is the full IPv6 address, so a /64 can rotate | src/auth/client-ip.js | The spec says per IP. A /64 key is a small change if the security reviewer asks |
| Only bundle offers (a bundle with a cup item and a lid item) are planned | src/services/plans.js | The seeded catalog and the spec's planner input; single-item offers are out of scope for version one |
| Timeline cursor is an opaque string | src/services/admin.js | A stable merge key across four tables. The spec does not type it |
| Reset audit row written directly, not through `recordAudit` | src/services/admin.js | `recordAudit` drops free text; the spec wants the operator's reason, which is admin-typed and 10–500 characters |
| Forced reset and `refund_order` are minimal | src/services/admin.js | Provider voids, the read-resolve pass and refund sending need the e-phase providers. RS-37 is claimed in phase F |
| Void rule uses a provider port with a no-op default | src/services/void-rule.js, src/app.js | The approval and cancellation path is wired now; e2 supplies the real provider (FU-19) |
| SPEC_MISMATCH offers appear in "Why this plan", not under "What was rejected" (the FU-3 default) | public/js | The Rejection code enum has no such code. g1 verifies it on the six-answer page |
| Multi-process and browser tests use the real clock with `upcomingDemoDate()` | test/helpers/server-proc.js | The server has no clock override. Results do not depend on timing |
| Chromium runs with `--no-sandbox` when the tests run as root | test/browser/helpers/harness.js | Container environment; the flag is added only when uid is 0 |

## Process notes (refusals and stops during the phase)

1. **c2's first claim was refused with `DIRTY_OWNERSHIP`, correctly.** The claim raced the orchestrator's snapshot commit of c1's files, so c2 owned files that were already changed in the working tree. The orchestrator now commits between dependent dispatches.
2. **The first completion of c2's one-case fix was refused.** An untracked `package-lock.json`, created by c6's parallel `npm install`, was a file no task owned. The engineer did not delete another task's file and reported it; the orchestrator removed the generated file. Per `dec-mv1joq3i-01180c65`, g2 will commit the lockfile, and until then a local lockfile must not be left in the tree (followups.md).
3. **c3 completed with the full suite red.** One c2 test still asserted the old fail-closed behaviour (ev:ev-mv2r5ewg-01518bd8, 749/750). c2 was reset for a one-case rework, now 750/750.
4. **The engine stopped dispatching at 482.7/480 minutes with `BUDGET_EXCEEDED`.** That followed `dec-mv2oy2zj-0109743e`. The user then raised the limit to 1200 minutes themselves (commit 4300fb9, `dec-mv2xlzls-01709639`); the full scope stands. `eccode status` now reports 498 of 1200 minutes used.

## What stays unverified or open after this phase

- The general per-user limit (FU-15) and FU-8's environment variables (FU-14), until their reworks land.
- The 10 skipped contract scenarios (FU-18) and the 6 fixture defects (FU-13).
- The extract-route tolerance in the RS-33 journey (FU-16).
- The 360 px column (FU-17).
- The browser checks listed in note 9.
- FU-4 (optional seed-equals-fixture test) was not taken by c6.
- RISK-19, the planner node-cap residual, is still open. FU-1 (typed 422) and FU-8 (planning limit) now mitigate it.
- The live checks (LIVE-M1, LIVE-P1, LIVE-P2) and USER-Q9 are untouched, and RISK-1 and RISK-2 stay open.

## Lessons

Each task recorded `mem-sd-mv1audrd-013b7102` as not-applicable, with a note. The plan's assessment ev:ev-mv1eo87o-01c933d5 is the basis. The reviewers judge these decisions under a `lessons` criterion.

## Artifact coverage

After submitting, I checked the submission with `.eccode/drafts/phase-artifacts-check.mjs`. It compares three sets against the latest submission: every phase-C handoff's declared files (all completions), every file changed in git since c1's claim base `c1614468` that falls under a phase-C ownership glob, and the plan's ownership. The result is in the handoff to the reviewer.
