# RescueStock — Architecture Brief (revision 2)

Author: product-architect. Gate: architecture. Requirements version: RS-REQ-1 (2026-10-09). Responds to review `rev-mv16o544-0127ccbf`. Placement: this revision was written in an earlier product-architect context and placed after the toolkit 0.3.1 guard repair. Three corrections were made on placement; they are the last three rows of the response table.
Sources: `docs/build/goal.md` (the user's master goal: ids RS-01..RS-33, RS-NF-1..4, fixture RS-FIX-1, assumptions A1–A5) and `docs/build/plan.md` (first architecture draft). **This brief is self-contained and authoritative.** The fixture, planner rules, state machines, rescue-status derivation and payment saga are written out in the Architecture section below. Where `docs/build/plan.md` §3, §5 or §6 differs from this brief, the brief wins. Every user requirement id is kept, with its meaning unweakened, except the Node floor in NFR1, which awaits the user's confirmation (Q9). Ids RS-34+ and NFR5+ are additions by this role. The gate's criterion grammar (`/^[A-Z][A-Z0-9]*-?\d+$/`, lib/gates.js:197, ev:ev-mv16ggcp-011ee455) rejects `RS-NF-1`, so the four non-functional ids appear as `NFR1 (RS-NF-1)` … `NFR4 (RS-NF-4)`, with the user's id preserved in parentheses.

## Revision 2: response to review rev-mv16o544-0127ccbf
| Finding | Where addressed |
|---|---|
| ARCH-1 (major) inventory not pinned | Architecture › Canonical fixture: on_hand = 1 bundle per supplier A–E, loaded by the seed. RS-06/09/10/11/14 cite it. The RS-06 multiplicity guard and the oracle property test use catalogs with on_hand up to 3. |
| ARCH-2 (major) no PENDING states, no aggregate derivation | Architecture › State machines adds `authorization_pending`, `capture_pending` and `refund_pending`, with reconciler polling. Architecture › Rescue status derivation is a precedence table that covers `cancelling`, `refunding` and `failed_needs_attention`. RS-21, RS-22, RS-25 and RS-36 assert these. |
| ARCH-3 (major) execute claim, expiry during execute, voids | Architecture › Payment saga: an exclusive `approved → executing` claim under `BEGIN IMMEDIATE`, with the reservation consumed in the same transaction. A void rule covers RS-13, RS-17, RS-18, RS-21 and expiry, and gives the buyer a next step. The saga also states when supersession stops applying. RS-13/15/17/18/20/21 assert these. |
| ARCH-4 (major) labelling narrowed | RS-34 now covers fake adapters, the Sandbox adapter, seeded demo data and the "Test prices, not market prices" notice, tested for both adapters. |
| ARCH-5 (major) Node floor, browser script | Node ≥ 22.13 per decision `dec-mv16pyxx-01bad0bf` (user confirmation requested in Q9). NFR1's AC also states what applies if the user keeps 22.5 (`--experimental-sqlite` in every script). Script layout per `dec-mv16pz32-013c4cd1`. NFR1 and NFR3 are reworded, and every [B] AC names `npm run test:browser`. |
| ARCH-6 (major) PayPal approvals replaced by fake page | RS-31 and RS-32 each have a fake-adapter variant and a user-run Sandbox approval-page variant, marked Unverified until run. Success Criteria require the demo video to use the Sandbox approval page. |
| ARCH-19 (major) content outside the submission | Fixture, planner, state machines, derivation, saga, data model and contracts are inlined under Architecture. |
| ARCH-7 RS-10 suggestions | Relaxations are now computed (Architecture › Planner rules). RS-10 asserts budget 9500 → A+E and deadline 11:20 → D at 8000, and asserts that no "more pickups" suggestion appears (ev:ev-mv1719y8-011f6742). |
| ARCH-9 NFR5/NFR6 clauses | NFR5 defines the generator and keeps p95 with an AC. NFR6 adds a log-content scan and the haiku default to its AC. |
| ARCH-10 PayPal return | Architecture › PayPal return and session: token-owner check, idempotent authorize, `SameSite=Lax`, and a fake approval page served cross-site. RS-20 and RS-27 assert these. |
| ARCH-11 runtime spend | Daily model budget and per-customer extract/upload rate limit (Architecture › AI feature statement). NFR6 asserts both. |
| ARCH-12 degraded path, corpus | Manual-entry fallback, clearly labelled (asserted in RS-03). Corpus at `test/fixtures/extraction/`, versioned `EXT-1`. |
| ARCH-13 explanation rephrasing | Explanations are rendered deterministically from planner codes. Model rephrasing is opt-in, off by default, labelled and checked. |
| ARCH-16 missing risks | RISK-13 (authorization expiry), RISK-14 (browser install), RISK-15 (experimental node:sqlite, mitigated by `dec-mv16pyxx-01bad0bf`), plus RISK-16..18. |
| ARCH-17 upload validation | RS-39 adds magic-byte detection and an owner check. |
| ARCH-18 credentials | A2: the number of approvals equals the number of supplier orders and is shown up front. The live rows weakened by single-credential mode are named. |
| ARCH-20 busy timeout | `PRAGMA busy_timeout = 5000`. SQLITE_BUSY after the timeout maps to 503 `DB_BUSY`. RS-14 asserts that the loser gets `OUT_OF_STOCK` (ev:ev-mv16fndw-01e46e13). |
| ARCH-21 retention | Automatic 7-day image sweep, `DELETE /api/requests/:id`, and README statement. RS-39 asserts them. |
| ARCH-8 (info) NFR alias | Mapping kept here. Adding it to `docs/build/evidence.md` and the acceptance-report template is outside this role's write scope and is handed to the orchestrator. |
| ARCH-14 (info) idempotency | Architecture › Idempotency: a key reused with a different body gets 422. `PayPal-Request-Id` = operation key, which encodes the call kind. Asserted in RS-16. |
| ARCH-15 (info) defaults | Recorded as `dec-mv16pz0g-01d5c4c2`. Open Questions cite it. |
| (placement) RS-32 vs the stock-depletion fault | The admin stock-depletion fault used to refuse unconfirmed orders, which would make RS-32's old plan `non_executable`, but its AC requires `superseded`. The fault now withdraws the offer, and the supersession rule cancels the unconfirmed orders and voids the authorizations. Workflow 6 no longer cites RS-32, and RS-32's AC names the trigger. |
| (placement) authorize in flight when the void rule fires | An operation in `approved` whose authorize call is still `intent` or `unknown` is no longer voided locally. It is treated like `authorization_pending` and voided at the provider once the reconciler resolves it, so no provider authorization is left orphaned. |
| (placement) NFR1 under either answer to Q9 | NFR1's AC now also states the pass condition if the user keeps the goal's Node ≥ 22.5 floor. |

## Users
- **Primary: café owner or manager (customer role).** Job: when a supplier cancels or stock runs out, get matching cups and lids within a budget, before a deadline, from at most N pickup points, and pay only once every condition holds. Writes requests in Arabic or English and may attach a package photo. Approves plans and one PayPal authorization per supplier order, then collects the goods. Can delete their request.
- **Secondary: demonstration supplier (supplier role).** Job: keep inventory and offers current, confirm or refuse incoming supplier orders with committed quantity and ready time, mark orders ready, and record handover. Sees only its own orders and inventory.
- **Secondary: demo administrator (admin role, protected).** Job: seed and reset demonstration data, inject faults (stock depletion, supplier refusal, adapter faults) and read the timeline. Ordinary users cannot reach these tools (RS-30).
- **Tertiary: hackathon judges and reviewers.** Job: understand in under three minutes the six on-screen questions: what the buyer needed, why the plan was chosen, what was rejected, the exact total, what each supplier committed to, and what happens on partial failure.

## Problem
- **Pain (evidence: the user's goal statement).** A café's order or whole day is at risk because supplies are missing or a supplier cancelled. Finding compatible cups and lids across several suppliers, within budget and deadline and with limited pickups, is a constrained combinatorial decision made under time pressure. Paying several suppliers safely by hand is error-prone: the risks are a double charge, or paying for a plan that cannot be fulfilled.
- **Frequency and cost (assumption, not measured).** Treated as an occasional but high-cost event for a café (a lost service day or a spoiled order). No market research was done in this environment. Submission materials must not claim impact figures without a source.
- **What a model adds that code cannot.** It turns free text in Arabic or English, plus a package photo, into structured, provenance-tagged requirements. Everything after extraction (planning, money, inventory, payments, explanations) is deterministic code, verifiable by tests and a brute-force oracle.

## Requirements
Functional ids are the user's (RS-01..RS-33, grouped as in the goal). Each is testable. The Acceptance Criteria section gives the pass/fail test for each id.

**Extraction:** RS-01 bilingual equivalence; RS-02 image provenance; RS-03 ambiguous image → clarification, never invented measurements; RS-04 missing budget/deadline blocks approval and order creation; RS-05 injection via image/catalog text ends as data only.

**Planning:** RS-06 canonical A+B $84; RS-07 C rejected `INCOMPATIBLE_LID_DIAMETER`; RS-08 D rejected `READY_AFTER_DEADLINE`; RS-09 without B → A+E $95; RS-10 without B and budget $90 → no plan with blocking constraints and suggestions; RS-11 max 1 pickup → infeasible; RS-12 insufficient quantities cannot be approved; RS-13 price change supersedes the approved plan version.

**Inventory:** RS-14 exactly one of two concurrent reservations wins (real database, separate processes); RS-15 expiry releases exactly once; RS-16 same operation key → same reservation; RS-17 supplier refusal reaches the customer and starts replanning.

**Payments:** RS-18 cancelled approval → no capture; RS-19 browser amount tampering has no effect; RS-20 no double capture under repeated clicks/requests; RS-21 one authorization failure prevents capture of the plan; RS-22 partial capture failure → void/refund compensation with accurate statuses; RS-23 duplicate webhooks idempotent; RS-24 invalid webhook signatures rejected; RS-25 lost response after capture → reconciliation before retry; RS-26 restart preserves orders, payment operations and recovery progress.

**Authorization:** RS-27 customers isolated from each other; RS-28 suppliers isolated from each other; RS-29 PayPal secrets never in frontend assets, responses, logs, screenshots or submission materials; RS-30 demo tools inaccessible to ordinary users.

**Complete journeys:** RS-31 happy path request → collection, including PayPal approvals; RS-32 replacement flow after B becomes unavailable ($95 plan); RS-33 infeasible request ends with explanation and no purchase.

**Added functional requirements (RS-34+, derived from the goal's scope text, the six questions and the honest-status section; mandatory for the demonstration):**
- RS-34 Everything that is not real is labelled in the UI and the API. This covers demonstration data, simulations, test providers and Sandbox transactions (goal scope text). Fake adapters carry `"simulated": true` and show a provider badge and a persistent banner. The real PayPal adapter carries `provider: "paypal-sandbox"` and shows a "PayPal Sandbox — no real money" badge. Seeded suppliers, offers and prices carry `"demo": true` and show a "Demo data" badge, and the notice "Test prices, not market prices" appears wherever seeded prices are shown.
- RS-35 The customer screen answers the six questions: extracted requirements with provenance; the planner decision trace; rejection codes per supplier/bundle; totals in integer cents per supplier and overall; catalog offer and supplier-confirmed commitment shown separately; compensation state and next step.
- RS-36 Plan, reservation, payment operation and fulfilment are separate persisted state machines (Architecture › State machines). The rescue status is derived from them by the precedence table (Architecture › Rescue status derivation) and is never stored.
- RS-37 Admin reset refuses while any payment operation holds or moves money (`approved|authorization_pending|authorized|capture_pending|captured|refund_requested|refund_pending|unknown`), unless forced with a recorded reason. It never deletes `payment_operations` or `provider_calls` rows; it archives them.
- RS-38 Every inventory transition (reserve, release, expire, consume, restock) and every security-relevant action is written to append-only ledgers (`inventory_ledger`, `audit_events`; triggers forbid UPDATE and DELETE).
- RS-39 Image uploads: PNG, JPEG or WebP, detected by magic bytes; at most 5 MB; random file names; only the request owner may upload. Images are deleted with the request (`DELETE /api/requests/:id`) or by an automatic retention sweep after 7 days.

**Non-functional (RS-NF-1..4 are the user's; NFR5+ are additions):**
- NFR1 (RS-NF-1) Clean-checkout setup from the README with no network beyond npm and zero runtime dependencies. The user's text says Node ≥ 22.5. This brief adopts Node ≥ 22.13 per orchestrator decision `dec-mv16pyxx-01bad0bf`, because `node:sqlite` sits behind `--experimental-sqlite` on 22.5–22.12. **That narrows the user's stated floor and needs the user's confirmation (Q9).** If the user keeps 22.5, every npm script and the README start command add `--experimental-sqlite`. ev:ev-mv16frja-017d17a4 shows the flag is accepted on 22.22.
- NFR2 (RS-NF-2) Desktop and mobile layouts, keyboard navigation, visible focus, accessible labels, text-based status indicators; loading, empty, error, retry, timeout, expired-reservation and degraded-extraction states.
- NFR3 (RS-NF-3) The real-model extraction suite and the real PayPal Sandbox suite are separate from the deterministic suite and labelled. Script layout per `dec-mv16pz32-013c4cd1`: `npm test` (offline `node --test`), `npm run test:browser` (Playwright), `npm run test:live-model`, `npm run test:live-paypal`.
- NFR4 (RS-NF-4) Secrets only via environment variables; `.env.example` holds names and placeholders only.
- NFR5 Performance. The planner solves RS-FIX-1 and every catalog from the defined generator (≤ 12 offers) in < 1 s. API p95 < 300 ms over the deterministic API tests. The deterministic suite completes offline in < 5 min.
- NFR6 Cost and observability. `haiku` is the default model. The runtime has a daily model budget and a per-customer extract/upload rate limit. The live model suite reports its cost and stays within the recorded ceiling. Every response and log line carries a `requestId`. Logs never contain secrets, tokens, payer personal data or raw provider payloads; they hold ids and statuses only.

## Main Workflows
1. **Rescue request (customer).** Sign in, write the problem in Arabic or English, optionally upload a package photo (magic-byte checked, owner only), then call `extract`. Before the call, the server checks the daily model budget and the rate limit, then runs the configured provider (`fake` in tests). Each field shows a value or `unknown`, its provenance and the original wording. The customer answers clarification questions or confirms fields, and a requirements version is created. A missing budget or deadline leaves the request in `needs_input` (RS-04).
   - **Degraded path:** if the provider times out, errors, returns schema-invalid output, or is refused by the budget or rate limit, every field is `unknown`. The page shows the labelled notice "Automatic reading unavailable — please enter the details" with a manual form for every field (provenance `manual`), and the journey continues (RS-03, NFR6).
2. **Planning.** `plan` runs the exact planner over current offers and availability (on_hand − reserved).
   - **Feasible:** a `proposed` plan version is stored with the best plan, up to 3 ranked alternatives, rejections with codes, surplus, total in cents, pickup count, plan-ready time and a `planHash`. Explanations are rendered from planner codes by templates.
   - **Infeasible:** a planning run with blocking constraints, per-candidate codes and computed relaxations is stored. No plan version, reservation, order or payment operation exists (RS-10, RS-11, RS-33).
3. **Approval.** The customer approves with `expectedTotalCents` and `planHash`. A mismatch returns 409 `PLAN_CHANGED`, and a missing budget or deadline returns 409 `MISSING_BUDGET` or `MISSING_DEADLINE` (RS-04, RS-12, RS-19). Before the first PayPal step, the page states how many PayPal approvals are needed: one per supplier order (A2).
4. **Reservation and supplier orders.** `reserve` runs with an `Idempotency-Key` inside one `BEGIN IMMEDIATE` transaction:
   - a conditional `UPDATE inventory SET reserved = reserved + q WHERE … AND reserved + q <= on_hand` for each item;
   - the reservation becomes `active` with `expires_at = now + RS_RESERVATION_TTL_MIN` (default 30);
   - one supplier order is created per supplier (`awaiting_supplier`), with one payment operation per order (`created`).

   The expiry pass releases an expired reservation exactly once and then applies the void rule (RS-14..16).
5. **Payment authorization (per supplier order).**
   - Persist the provider call intent, then create the PayPal order (intent AUTHORIZE, server-derived amount, `PayPal-Request-Id` = operation key).
   - The customer approves on PayPal's hosted page (Sandbox) or the fake approval page (served from a different site).
   - The return URL hands the token to the server. The server checks the token's owner and authorizes idempotently: CREATED gives `authorized`, PENDING gives `authorization_pending` (polled), DENIED gives `authorization_failed` (RS-21).
   - The cancel URL leaves the operation `created` with `buyer_cancelled_at`. The buyer chooses "Try approval again" or "Abandon purchase" (RS-18).
6. **Supplier confirmation.** The supplier confirms the committed quantity (≥ planned) and ready time (≤ deadline), or refuses with a reason. A refusal before execute triggers the void rule, makes the plan `non_executable`, notifies the customer, and produces a new plan version that excludes that supplier (RS-17). An offer withdrawn before its supplier confirms (for example by the admin stock-depletion fault) supersedes the plan instead, under the same void rule (RS-13, RS-32).
7. **Execution saga.** `execute` takes the exclusive claim (Architecture › Payment saga). It revalidates, consumes the reservation, and captures sequentially in supplier-code order:
   - It stops at the first failure and compensates: void the uncaptured authorizations, refund the captured ones, set the reservation to `reconciling`, block handover.
   - A capture that answers PENDING pauses the saga until the reconciler resolves it.
   - A lost response sets `unknown`, and the reconciler reads provider state before any retry (RS-20..22, RS-25, RS-26).
8. **Readiness and collection.** Only after the plan is `executed` (every capture COMPLETED) can a supplier mark its order ready. The customer then sees pickup addresses and committed times. The supplier records handover, which makes the order `collected`, and the customer records receipt. When every order is `collected`, the rescue status is `collected`.
9. **Reconciliation (in-process loop, every 15 s and at startup).** The reconciler:
   - resolves `unknown` calls, and `intent` calls left over at a restart, by reading provider state;
   - polls `*_pending` states;
   - resumes `executing` plans whose saga lease has expired;
   - expires reservations;
   - continues outstanding voids and refunds;
   - raises escalation flags by age.

   Polling is the primary path. Webhooks are secondary and are verified when a public URL exists (`dec-mv16pz0g-01d5c4c2`, Q6).
10. **Webhooks.** `POST /api/webhooks/paypal/:merchantKey` verifies the signature through the provider using the raw body, dedupes on transmission id, and applies only transitions the state machine allows. Anything else is recorded and flagged (RS-23/24).
11. **Request deletion and retention.** The owner calls `DELETE /api/requests/:id`. The request, its image, raw text and extraction text are deleted. While money is held the call is refused (409 `PAYMENT_IN_PROGRESS`). When payments have settled, the request is tombstoned and the financial rows are kept with ids only. An hourly retention sweep deletes images older than 7 days (RS-39).
12. **Admin demo.** Reset (guarded), inject faults, read the timeline (RS-30, RS-37).

## Acceptance Criteria
Each item is pass/fail by a test or an inspection. The id is the user's requirement id (traceability is 1:1). The suite that proves each item is named in brackets:
- [D] = `npm test`: offline `node --test`, with a guard that fails any test opening a non-loopback connection.
- [B] = `npm run test:browser`: Playwright, Chromium, 360 px and 1280 px.
- [LM] = `npm run test:live-model` (`RS_LIVE_MODEL=1`).
- [LP] = `npm run test:live-paypal` (`RS_LIVE_PAYPAL=1`). Run by the user, and recorded as Unverified with blocker A6/Q2 until then.
- [I] = inspection.

"Pinned inventory" means the RS-FIX-1 table in Architecture › Canonical fixture: on_hand = 1 bundle for each of A–E, reserved = 0, loaded by the seed.

- RS-01: Equivalent Arabic and English requests (RS-FIX-1 wording) yield identical core fields: product type, quantities, capacity, diameter, deadline, budget, max pickups. [D with fake provider; LM with real model over corpus `test/fixtures/extraction/` version EXT-1, equality on normalised fields]
- RS-02: A clear package image yields capacity/diameter specifications carrying `provenance: "image"`. [D fake; LM real]
- RS-03: An ambiguous image yields `unknown` for unreadable fields plus at least one clarification question, and no numeric value absent from the image. Degraded path: when the provider times out, errors, returns schema-invalid output, or is refused by the daily budget or rate limit, the extraction row has `schema_ok = false` and an error code, every field is `unknown`, the response carries `degraded: true`, and the request page shows the labelled notice "Automatic reading unavailable — please enter the details" with a manual field for every core field (provenance `manual`); confirming those fields creates a requirements version and planning proceeds. [D fake incl. faults timeout, invalid_json, schema_invalid; B: test:browser for the notice; LM real]
- RS-04: With budget or deadline missing, `POST /api/plans/:id/approve` and `POST /api/orders/:id/paypal/create` return 409 with a named reason (`MISSING_BUDGET` / `MISSING_DEADLINE`) and no reservation or payment operation is created. [D]
- RS-05: Injection strings in image text and catalog text appear only as data in `fields_json`/catalog; after extraction no permission, amount, supplier, plan version or role differs from the control run; explanations stay template-rendered from planner codes, and when opt-in rephrasing is enabled the same control-run comparison holds and any output containing a number or supplier code absent from the trace is discarded in favour of the template text. [D fake with injection fixtures; LM real]
- RS-06: With RS-FIX-1 and its pinned inventory, the planner returns plan A+B with total 8400 cents (A 4000 + B 4400), 2 pickups, ready 10:30; multiplicity guard: with A's on_hand set to 2 the same planner returns A×2 at 7000 cents with 1 pickup (ev:ev-mv1719y8-011f6742); the oracle property test runs on random catalogs of ≤ 6 offers with on_hand 0–3, so multiplicities above 1 are exercised. [D]
- RS-07: Supplier C's bundle is listed under rejections with code `INCOMPATIBLE_LID_DIAMETER` (cups 90 mm, lids 95 mm, no confirmed compatibility row). [D]
- RS-08: Supplier D's bundle is rejected with code `READY_AFTER_DEADLINE` (ready 11:20 > deadline 11:00). [D]
- RS-09: With the pinned inventory and B removed (on_hand 0 or offer withdrawn; B listed `OUT_OF_STOCK` or withdrawn) the best plan is A+E at 9500 cents (A 4000 + E 5500), 2 pickups, ready 10:40. [D]
- RS-10: With the pinned inventory, B removed and budget 9000 cents the planner returns no feasible plan, lists blocking constraints including `OVER_BUDGET`, gives A and E the per-candidate codes `INSUFFICIENT_QTY` and `OVER_BUDGET`, and returns exactly two computed relaxations: budget → 9500 cents yields A+E at 9500 cents, and deadline → 11:20 yields D alone at 8000 cents with 1 pickup; no max-pickups relaxation is emitted because raising max pickups yields no plan (ev:ev-mv1719y8-011f6742, ev:ev-mv171l87-01672a57). [D]
- RS-11: With the pinned inventory and max pickups = 1 the canonical scenario is infeasible; each compatible, in-time candidate (A, B, E) carries exactly the per-candidate codes `INSUFFICIENT_QTY` (alone it supplies 100 of 200) and `TOO_MANY_PICKUPS` (its cheapest covering combination needs 2 suppliers), while C and D keep their RS-07/RS-08 codes (ev:ev-mv171l87-01672a57). [D]
- RS-12: A plan whose cups or lids total < required quantity cannot be produced as feasible, and approval of a tampered plan body is refused with 409. [D]
- RS-13: After the price of an offer used by an approved plan changes, while that supplier's order is not yet `confirmed` and the plan is not `executing`, the approved version becomes `superseded`, totals are recalculated in a new `proposed` version, and reserve/execute on the old version return 409 `PLAN_SUPERSEDED` until the new version is approved; every authorization on the old version ends `voided` (one void provider call each), its reservation is `released` (one ledger row per item), its supplier orders are `cancelled`, and the request shows "Prices changed: review plan vN"; a price change after that supplier confirmed, or after the claim to `executing`, does not supersede the plan (asserted). [D]
- RS-14: Two separate OS processes, each connection with `PRAGMA busy_timeout = 5000`, reserve supplier A's last bundle (pinned inventory, on_hand = 1) concurrently against the same SQLite file; exactly one reservation is `active`, the other receives `OUT_OF_STOCK` (not a lock error and not a 500); `reserved <= on_hand` holds; a separate test with `busy_timeout = 0` and a held write lock shows SQLITE_BUSY mapped to 503 `DB_BUSY` with `Retry-After`. [D, multi-process]
- RS-15: An expired reservation is released exactly once: inventory returns to its prior value, the ledger holds one release row, and a second expiry pass is a no-op; an expiry pass run after the execute claim and before the first capture (reservation `consumed`) changes nothing; on expiry before execute every authorization of that plan ends `voided`, the plan is `non_executable` (`RESERVATION_EXPIRED`), and the request shows "Reservation expired — no money was taken; re-plan with current stock". [D]
- RS-16: Two `reserve` calls with the same `Idempotency-Key` and body return the same reservation id and create no second reservation or ledger row; the same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED` and changes nothing. [D]
- RS-17: Supplier refusal before the execute claim sets the order to `refused`; every outstanding authorization of that plan version ends `voided`, its reservation is `released`, the plan is `non_executable` (`SUPPLIER_REFUSED`), the rescue status reads `cancelling` while a void is outstanding, the customer request shows the refusal reason with the next step "Review the new plan", and a new plan version is computed excluding that supplier. [D; B: test:browser]
- RS-18: Cancelling on PayPal (cancel URL) leaves that supplier's operation `created` with `buyer_cancelled_at` (no provider authorization exists) or `voided`, no capture call or capture row exists, and `execute` returns 409; the buyer is offered "Try approval again" and "Abandon purchase"; on "Abandon purchase" or reservation expiry every other supplier's outstanding authorization ends `voided`, the reservation is `released`, and the plan is `non_executable` (`PAYMENT_CANCELLED` or `RESERVATION_EXPIRED`). [D fake; LP]
- RS-19: A client-supplied amount/currency/supplier on any payment route is ignored; the PayPal order amount equals the server-approved supplier-order total. [D; LP]
- RS-20: Two server processes on the same SQLite file each receive N = 5 concurrent `execute` requests for the same plan: exactly one `approved → executing` claim commits (conditional UPDATE inside `BEGIN IMMEDIATE`), the other nine return the current state without any provider call, and the fake adapter (state persisted in the same database) records exactly one capture call per supplier order with `PayPal-Request-Id` equal to its deterministic operation key `so:<supplierOrderId>:capture:1`; three repeated hits on the PayPal return URL for one supplier order (refresh/back) produce exactly one authorize call. [D fake, multi-process; LP]
- RS-21: If one supplier's authorization is DENIED, no capture call occurs on any supplier order, the plan is `non_executable` (`AUTHORIZATION_FAILED`, naming the supplier), every other authorization ends `voided`, the reservation is `released`, and the buyer sees "PayPal declined the payment for <supplier>. No money was taken; other authorizations were voided. Re-plan or try another PayPal account"; an authorization answering PENDING leaves the operation `authorization_pending`, and `execute` returns 409 `AUTHORIZATION_PENDING` with no capture until the reconciler observes CREATED. [D]
- RS-22: With capture failing on the second supplier, the first capture is refunded and every uncaptured authorization voided; statuses read `refund_requested → refund_pending → refunded|refund_failed`; the plan becomes `non_executable` (`CAPTURE_FAILED`); the reservation is `reconciling` until every refund is `refunded` and every void done, then `released` with restock ledger rows (with `refund_failed` it stays `reconciling` and the rescue status reads `failed_needs_attention`); handover is refused with 409 `HANDOVER_BLOCKED`; a capture answering PENDING leaves the operation `capture_pending`, handover stays blocked, and the next capture does not start until the reconciler resolves it. [D fake faults]
- RS-23: Delivering the same webhook (same transmission id) twice applies its effect once. [D; LP]
- RS-24: A webhook with an invalid signature is rejected (4xx), recorded with `signature_status: invalid`, and applies no transition. [D; LP]
- RS-25: After a simulated lost response on capture, the operation is `unknown`; the reconciler fetches provider state and only then marks `captured` (COMPLETED), marks `capture_pending` (PENDING, polled until resolved), or re-sends with the same `PayPal-Request-Id` (no capture exists at the provider); no second capture occurs; a provider call left in `intent` at a restart is treated as `unknown`. [D fake]
- RS-26: Killing and restarting the server mid-saga preserves orders, payment operations, provider calls and recovery progress; after the saga lease expires, the reconciler takes it over and completes the saga. [D]
- RS-27: Customer X requesting customer Y's request or order id receives 404/403 and no data, including `GET /api/paypal/return?token=` and `/cancel?token=` with Y's PayPal order token (404, no authorize call, no state change). [D]
- RS-28: Supplier A patching supplier B's inventory receives 403 and B's inventory is unchanged. [D]
- RS-29: A scan of built frontend assets, API responses, logs, screenshots and submission files finds no client id/secret value; config redacts secrets in errors. [D scan; I]
- RS-30: Customer and supplier sessions calling admin fault/reset routes receive 403; unauthenticated 401. [D]
- RS-31: (a) Browser journey at 360 px and 1280 px: request → review → plan → reservation → PayPal approvals → supplier confirmations → capture → readiness → collection, with screenshots, using the fake adapter whose approval page is served from a different site (`127.0.0.1` while the app runs on `localhost`), so the `SameSite=Lax` session must survive the cross-site return [B: test:browser]; (b) the same journey through PayPal's hosted Sandbox approval page with a Sandbox buyer account, with screenshots [LP browser, user-run; Unverified with blocker A6/Q2 until the user runs it].
- RS-32: (a) Browser journey: B becomes unavailable after approval (the admin stock-depletion fault withdraws B's offer before B confirms); the buyer reviews and approves the $95 (9500 cents) A+E plan; the old plan is `superseded`, its authorizations end `voided` and B's order is `cancelled`; the replacement flow completes through collection [B: test:browser, fake adapter on a different site]; (b) the same replacement journey with PayPal's hosted Sandbox approval page, with screenshots [LP browser, user-run; Unverified with blocker A6/Q2 until the user runs it].
- RS-33: Browser journey: an infeasible request ends on an explanation screen with blocking constraints, per-candidate codes and computed relaxations; no reservation, order or payment operation exists. [B: test:browser]
- RS-34: Labelling, asserted for both payment adapters: (1) fake adapter payloads (payments and extraction) carry `"simulated": true`, and the UI shows a "Simulated" provider badge and a persistent banner while a fake adapter is active; (2) Sandbox adapter payloads carry `provider: "paypal-sandbox"` and `"sandbox": true`, and every payment element in the UI shows "PayPal Sandbox — no real money"; (3) seeded suppliers, offers and prices carry `"demo": true` rendered as a "Demo data" badge, and every screen that shows seeded prices shows "Test prices, not market prices"; config refuses any PayPal base URL other than the Sandbox host or a loopback stub. [D both adapters, with the Sandbox adapter pointed at a loopback stub base URL; B: test:browser both adapters]
- RS-35: The request page shows all six answers (requirements with provenance, decision trace, rejections, cents totals, offer vs commitment, compensation state and next step), with explanation text rendered from planner codes. [B: test:browser; I]
- RS-36: State tables persist plan, reservation, payment-operation and fulfilment statuses separately; the rescue status endpoint is computed by the derivation table and a schema query shows no column storing it; derivation assertions: (i) any operation of any plan version in `refund_requested` or `refund_pending` yields `refunding`, even when every other order is collected; (ii) a supplier refusal or `non_executable` plan with an operation still `authorized`, `authorization_pending` or `unknown` (within the escalation limit) yields `cancelling`, and with `refund_failed`, a failed void or an over-age `unknown` it yields `failed_needs_attention`; (iii) `collected` only when every supplier order of the current plan is `collected` and every capture is `captured`, so one order `ready` and one `collected` yields `ready_for_pickup`; (iv) after every void completes following a refusal and a new version is proposed, the status is `plan_found`. [D; I]
- RS-37: Admin reset returns 409 while any payment operation is `approved|authorization_pending|authorized|capture_pending|captured|refund_requested|refund_pending|unknown`; forced reset records a reason and archives rather than deletes payment operations and provider calls. [D]
- RS-38: Any UPDATE/DELETE on `audit_events` or `inventory_ledger` fails; every reserve, release, expire, consume and restock writes a ledger row. [D]
- RS-39: Upload accepts only bodies whose magic bytes identify PNG, JPEG or WebP (a body declared `image/png` but carrying other bytes is rejected with 415) and of at most 5 MB (413 above); the stored name is random (128-bit); customer Y uploading to customer X's request receives 404 and no file is written; `DELETE /api/requests/:id` by the owner removes the image file and row, raw text and extraction text (409 `PAYMENT_IN_PROGRESS` while money is held; with settled payments the request is tombstoned and financial rows keep ids only); with a pinned clock the retention sweep deletes an image at 7 days + 1 minute and keeps it at 6 days 23 hours, writing an audit event. [D]
- NFR1 (RS-NF-1): On Node ≥ 22.13 (floor per `dec-mv16pyxx-01bad0bf`; RS-NF-1 states ≥ 22.5, see Q9) a clean clone runs `npm install` (npm registry only) then `npm test`, which passes with the non-loopback network guard active and launches no browser; `npm start` from the README serves `GET /api/health` with 200; `package.json` has no `dependencies` (only `devDependencies`: `@playwright/test`) and declares `engines.node >= 22.13`; on an older Node `npm start` exits non-zero with a message naming the required version. If the user answers Q9 by keeping 22.5, `engines.node` is `>=22.5`, every npm script and the README start command pass `--experimental-sqlite`, and the same checks apply from Node 22.5 (only Node 22.22 is available on this host, so a run on 22.5 is the user's). [D; I]
- NFR2 (RS-NF-2): Playwright checks at 360 px and 1280 px: keyboard-only completion of the happy path, visible focus, labelled controls, text status indicators; loading/empty/error/retry/timeout/expired-reservation/degraded-extraction states rendered. [B: test:browser]
- NFR3 (RS-NF-3): Per `dec-mv16pz32-013c4cd1`, `npm test` (offline deterministic `node --test`), `npm run test:browser` (Playwright; the README documents the one-time `npx playwright install chromium`), `npm run test:live-model` (refuses to run unless `RS_LIVE_MODEL=1`) and `npm run test:live-paypal` (refuses unless `RS_LIVE_PAYPAL=1`) are separate scripts; live reports are labelled with suite, provider, model or merchant mode (per-supplier or single-credential) and corpus version. [I; D for the refusal without the flag]
- NFR4 (RS-NF-4): Config reads secrets only from `process.env`; `.env.example` contains names and placeholders only; a test asserts no real-looking value. [D; I]
- NFR5: The planner solves RS-FIX-1 and each of 200 seeded generator catalogs (seeds 1–200; 12 offers; bundle sizes {50, 100, 200}; required quantity 100–400 in steps of 100; on_hand 0–2; price 1000–10000 cents; prep fee 0–1500 cents; ready 09:30–12:00; 15 % incompatible; max pickups 1–3) in < 1 s each (a plain brute force needed at most 11.8 ms on this host, ev:ev-mv1719y8-011f6742); p95 latency over all HTTP calls made by the deterministic API tests with fake adapters (excluding the multi-process and restart tests) is < 300 ms as reported by the test harness; the deterministic suite completes offline in < 5 min. [D timing]
- NFR6: Every response and log line carries `requestId`; the RS-29 scan also asserts that no log line contains an `Authorization` header value, an access token, a client secret, a payer email or name, or a raw provider response body (ids and statuses only); config inspection shows `haiku` as the default model; runtime controls: with a fake per-call cost cap of USD 0.10 and `RS_MODEL_DAILY_BUDGET_USD=0.25`, the third extract is refused with 503 `MODEL_BUDGET_EXHAUSTED` without invoking the provider and enters the RS-03 degraded path, and an 11th extract or image upload by one customer within 10 minutes returns 429 `RATE_LIMITED` with `Retry-After`; the live model suite reports its cost and stays within the ceiling recorded in `dec-mv16pz0g-01d5c4c2` (USD 5 per run). [D; LM report; I]

## Scope
**In:** cafés; cups, matching lids, indivisible cup-and-lid bundles; one demo city (Amman, `Asia/Amman`); USD; pickup from participating demo suppliers; buyer-defined max pickups; English interface (`dir="auto"` on text inputs so Arabic renders right-to-left, `dec-mv16pz0g-01d5c4c2`); Arabic and English written requests; optional package images; customer, supplier and protected admin accounts; PayPal Sandbox only (authorize now, capture after all conditions); customer request deletion; automatic image retention sweep.

**Out, with reason:**
- Arbitrary internet shopping: there is no verifiable catalog or inventory.
- Real payments: the hackathon requires Sandbox, and real money brings liability. Config refuses non-Sandbox PayPal hosts.
- Currency conversion: adds rate risk without demo value.
- Delivery and driver tracking: the pickup model keeps the saga bounded.
- AI-to-AI negotiation: would be simulated theatre and contradicts the honesty labelling.
- Wallets and escrow: regulatory scope.
- Food substitutions and allergy decisions: safety.
- Marketplace or partner onboarding: not needed for demo suppliers.
- Arabic UI and RTL layout: requests are bilingual but the interface is English per the goal (Q8 default).
- Post-capture supplier failure handled by the buyer: once a plan is `executed`, a supplier cannot refuse (409 `ORDER_EXECUTED`). A post-capture failure is resolved by the admin "refund order" fault tool, which runs the refund path. Buyer self-service would add a second compensation journey without demo value.
- Model rephrasing of explanations by default: it adds cost and an injection surface, and no requirement needs it. It is kept only as an opt-in.

## Architecture
**Shape.** One Node process with zero runtime dependencies. It serves a JSON API under `/api` and a static ES-module SPA. Data lives in a SQLite file accessed through `node:sqlite`: WAL, `BEGIN IMMEDIATE` write transactions, `PRAGMA busy_timeout = 5000` on every connection (the constructor `timeout` option needs Node 22.16, so the PRAGMA is used), CHECK constraints and append-only triggers. The only outbound calls go to the AI provider (Claude Code CLI subprocess or Anthropic API) and PayPal Sandbox REST. PayPal webhooks are the only inbound calls besides the browser. An in-process reconciler loop and an hourly retention sweep run alongside. Several processes may share one database file; every cross-process race is settled by conditional updates inside `BEGIN IMMEDIATE`.

```
 Browser (customer | supplier | admin SPA, hash routing, no secrets)
   │ session cookie (HttpOnly, SameSite=Lax) + CSRF header, JSON, Idempotency-Key
   ▼
 ┌──────────────────────────── Node ≥ 22.13 process ─────────────────────────────┐
 │ http/router → auth (scrypt, sessions, CSRF, RBAC default-deny, owner scope)   │
 │ routes/* → services/{requests,plans,reservations,orders,payments,webhooks,    │
 │            retention} → domain/{planner,compat,money,states,derive,explain}   │
 │            (pure, clock-injected)                                             │
 │ ai/{cli|anthropic|fake} + budget/rate gate   payments/{sandbox|fake}          │
 │ reconciler loop (lease-based)   retention sweep (hourly)                      │
 │ db/ (node:sqlite, WAL, busy_timeout, migrations, tx helper) ── data/app.db    │
 └──────┬───────────────────────────────┬─────────────────────────────────────────┘
        │ subprocess / HTTPS             │ HTTPS (credential-per-merchant)   ▲ webhooks
        ▼                                ▼                                   │
  Claude Code CLI / Anthropic API     PayPal Sandbox REST v2 ────────────────┘
  (untrusted output: schema-         buyer approval: www.sandbox.paypal.com (hosted)
   validated, no tools)              or fake approval page on a second listener
                                     at 127.0.0.1:<port> (cross-site in [B])
```

**Trust boundaries.**
1. **Browser ↔ server.** The client never supplies amount, currency, supplier or plan version; the server derives them from the approved plan version. RBAC is default-deny with owner-scoped queries. CSRF uses a double-submit header on every non-GET route. The only GET routes with side effects are the PayPal return and cancel routes, which are owner-checked and idempotent.
2. **Server ↔ model.** Prompt text, image bytes and catalog text are untrusted. Output must validate against the extraction JSON schema. The model has no tools, no network and no write access. The buyer confirms fields before any commitment (human in the loop). Spend is gated by a daily budget and a rate limit.
3. **Server ↔ PayPal.** Intent is persisted before every call, and every call is keyed by a deterministic operation key. Webhook signatures are verified through PayPal's verify endpoint. Lost responses lead to the `unknown` state and reconciliation.
4. **Admin tools** sit behind the admin role and a startup-provided admin password.

### Canonical fixture (RS-FIX-1, inlined from goal.md; inventory pinned by this brief)
Fixed date 2026-10-20, time zone `Asia/Amman`, clock 09:00. The buyer needs 200 cups and 200 matching lids, 250 ml, 90 mm. Deadline 11:00, budget 12000 cents (USD 120), max 2 pickup locations, tax 0 basis points, one preparation fee per supplier order. **Test prices, not market prices.**

| Supplier | Bundle (one unit) | Price (cents) | Prep fee (cents) | Ready | Compatibility | on_hand (bundles) | reserved |
|---|---|---:|---:|---|---|---:|---:|
| A | 100 cups + 100 lids | 3000 | 1000 | 10:00 | compatible (90/90 mm) | 1 | 0 |
| B | 100 cups + 100 lids | 3600 | 800 | 10:30 | compatible | 1 | 0 |
| C | 200 cups + 200 lids | 4800 | 500 | 10:00 | cups 90 mm, lids 95 mm | 1 | 0 |
| D | 200 cups + 200 lids | 6800 | 1200 | 11:20 | compatible | 1 | 0 |
| E | 100 cups + 100 lids | 4500 | 1000 | 10:40 | compatible | 1 | 0 |

**Supplier order totals with prep fee:** A 4000, B 4400, C 5300, D 8000, E 5500.

**Expected outcomes (verified by brute force, ev:ev-mv16ez5r-01e792ff and ev:ev-mv1719y8-011f6742):**
- Base: A+B, 8400 cents, 2 pickups, ready 10:30. C is rejected (incompatible) and D is rejected (late).
- Without B: A+E, 9500 cents.
- Without B and with budget 9000: no plan. Relaxations: budget 9500 gives A+E; deadline 11:20 gives D at 8000.
- Max 1 pickup: no plan.

**Why inventory is pinned:** one bundle per supplier is the only inventory, among A, B, E ∈ 0..2, that satisfies RS-06, RS-09, RS-10 and RS-11 together (ev:ev-mv16ez5r-01e792ff). With A at 2 bundles, the planner would return A×2 at 7000 cents. The seed loads this table with `demo: true` on every supplier, offer and inventory row. goal.md's table gives no inventory, so pinning it goes beyond the goal.

### Planner rules (`domain/planner.js`, pure; oracle `domain/oracle.js` for tests)
- **Inputs:**
  - the requirement: cups N, lids N, capacity, diameter, optional material;
  - budget, deadline and maxPickups;
  - offers (price, prep fee, ready time, version);
  - availability per offer = on_hand − reserved, excluding the requesting buyer's own reservation for the version being replaced;
  - tax in basis points.
- **Candidate filter (per offer).** A failing offer gets a candidate rejection code:
  - `INCOMPATIBLE_LID_DIAMETER`: cup diameter ≠ lid diameter and no confirmed compatibility row.
  - `READY_AFTER_DEADLINE`: ready time > deadline.
  - `OUT_OF_STOCK`: availability = 0.
  - Withdrawn offers are listed with `OFFER_WITHDRAWN`.
- **Multiplicity bound.** Each surviving offer k is used m_k ∈ 0..min(availability_k, ceil(N / units_k)) times, where units_k is the cups (or lids) per unit. Bundles are indivisible.
- **Feasibility:** cups ≥ N; lids ≥ N; every chosen cup/lid pair compatible; suppliers used ≤ maxPickups; max(ready) ≤ deadline; total ≤ budget; m_k ≤ availability_k.
- **Total:** Σ m_k × price_k, plus one prep fee per supplier used, plus tax rounded half up per supplier order.
- **Objective (lexicographic, deterministic):** minimise (total cents, pickup count, plan-ready time = latest supplier ready time, then the plan's sorted supplier-code string).
- **Search:** exhaustive enumeration with branch-and-bound on cost. The oracle enumerates the same space without pruning. The property test compares objective and feasibility on random catalogs of ≤ 6 offers with on_hand 0–3.
- **Output when feasible:** the best plan, up to 3 ranked alternatives, surplus, per-supplier and overall cents, and a decision trace. The trace lists the candidates, the codes of rejected offers, and why the best plan beats each alternative (the first objective component that differs).
- **Output when infeasible (no plan version is created):**
  - *Per-candidate codes* for each surviving candidate k. These are `INSUFFICIENT_QTY` if k alone, at its maximum multiplicity, cannot cover N. In addition, k gets the constraint codes (`TOO_MANY_PICKUPS`, `OVER_BUDGET`) violated by the cheapest combination that covers N and contains k (ev:ev-mv171l87-01672a57).
  - *Computed relaxations.* For each buyer-controllable constraint c ∈ {budget, deadline, maxPickups}, the planner re-solves with c removed and the others kept. If a plan results, the relaxation states c's code (`OVER_BUDGET`, `READY_AFTER_DEADLINE`, `TOO_MANY_PICKUPS`), the value the plan needs (its total, its ready time or its pickup count), and the plan's suppliers and total. If no plan results, nothing is emitted for c.
  - *Blocking constraints* are the codes of the emitted relaxations. If no relaxation exists, the blocking constraint is `INSUFFICIENT_QTY`.
  - Results for the fixture: RS-10 emits OVER_BUDGET (9500 → A+E) and READY_AFTER_DEADLINE (11:20 → D, 8000) and no max-pickups relaxation. RS-11 emits TOO_MANY_PICKUPS (2 → A+B, 8400) and READY_AFTER_DEADLINE (11:20 → D, 8000).
- **Explanations (`domain/explain.js`).** English text is rendered by fixed templates from the trace and the codes, and every number comes from the trace. Model rephrasing is opt-in (`RS_EXPLAIN_REPHRASE=1`, off by default and in [D]/[B]). When enabled, the model's text is shown beside the template text and labelled "AI-rephrased". It is discarded if it contains a number or supplier code absent from the trace.

### State machines (`domain/states.js`; transitions outside these tables are refused and audited)
**Plan version** (`plan_versions.status`):

| From | To | Trigger and guard |
|---|---|---|
| draft | proposed | planner stored a feasible plan; `planHash` computed |
| proposed | approved | buyer approves with matching `expectedTotalCents` and `planHash`; budget and deadline present |
| proposed, approved | superseded | an offer the plan uses changes price, prep fee or ready time, is withdrawn, or drops below the planned quantity in availability. Applies only while the affected supplier order is not `confirmed` and the plan is not `executing`. Also when requirements change. |
| approved | non_executable | supplier refusal; authorization DENIED or expired; buyer abandons; reservation expired; revalidation failed (reason stored) |
| approved | executing | exclusive execute claim (Payment saga step 1) |
| executing | executed | every capture COMPLETED |
| executing | non_executable | a capture DECLINED or failed; compensation starts (`CAPTURE_FAILED`) |

**Reservation** (`reservations.status`; each change writes `inventory_ledger` rows):

| From | To | Trigger |
|---|---|---|
| active | consumed | execute claim, in the same transaction (ledger `consume`: on_hand −q, reserved −q) |
| active | expired | expiry pass when `expires_at <= now`, via conditional `UPDATE … WHERE status = 'active'` (ledger `expire`: reserved −q) |
| active | released | plan superseded or non_executable before the claim (ledger `release`) |
| consumed | reconciling | compensation started |
| reconciling | released | every capture of the plan refunded and every authorization voided or failed; no `unknown` or `*_pending` operation (ledger `restock`: on_hand +q) |

The expiry pass touches only `active` rows, so it is a no-op once the claim has consumed the reservation. `reconciling` is never released while an outcome is unknown, pending or `refund_failed`.

**Payment operation** (`payment_operations.status`, one per supplier order; provider calls are journalled separately in `provider_calls`):

| From | To | Trigger |
|---|---|---|
| created | approved | return URL hit by the owner (PayPal reports the order approved) |
| created | created | cancel URL: sets `buyer_cancelled_at`; "Try approval again" re-issues the approval link |
| created, approved | voided | plan superseded, non_executable or abandoned before any authorization exists and with no authorize call in `intent` or `unknown` (local only; no provider call; labelled "cancelled before authorization") |
| approved | authorized / authorization_pending / authorization_failed / unknown | authorize answer CREATED / PENDING / DENIED or error / no response |
| authorization_pending | authorized / authorization_failed | reconciler poll or webhook (CREATED / DENIED, VOIDED or EXPIRED) |
| authorized | capture_pending / captured / unknown | capture answer PENDING / COMPLETED / no response |
| authorized | authorized (`last_error = CAPTURE_DECLINED`) | capture DECLINED; compensation then voids it |
| capture_pending | captured / authorized (`CAPTURE_DECLINED`) | reconciler poll or webhook |
| authorized | voided / unknown | void call 2xx / no response. A definitive void failure keeps `authorized` with `void_failed = 1`, which drives `failed_needs_attention`. |
| captured | refund_requested | compensation intent persisted |
| refund_requested | refund_pending | refund call sent, or provider answered PENDING |
| refund_pending | refunded / refund_failed | provider COMPLETED / FAILED or CANCELLED (polled while PENDING) |
| unknown | the state the provider reports | reconciler reads provider state. If the provider shows no effect, the previous state is restored and the call may be re-sent with the same `PayPal-Request-Id`. |

**Rules:**
- Capture never starts from `authorization_pending`, `unknown` or `created`.
- `execute` returns 409 `AUTHORIZATION_PENDING` or `AUTHORIZATION_MISSING` in those cases.

**Fulfilment** (`supplier_orders.fulfilment_status`):

| From | To | Trigger and guard |
|---|---|---|
| awaiting_supplier | confirmed | supplier commits qty ≥ planned and ready ≤ deadline; otherwise 422 |
| awaiting_supplier, confirmed | refused | supplier refuses before the execute claim; afterwards 409 `ORDER_EXECUTED` |
| awaiting_supplier, confirmed | cancelled | plan superseded or non_executable before the claim |
| confirmed | ready | plan `executed` and no operation of the plan is `unknown`, `capture_pending`, `refund_*` or `reconciling`; otherwise 409 `HANDOVER_BLOCKED` |
| ready | collected | supplier records handover (same guard); the buyer's receipt is recorded alongside |

### Rescue status derivation (`domain/derive.js`; computed on read, never stored)
**Inputs:**
- R = the request.
- P = the current plan version: the newest version of R that is not `superseded`.
- OPS(R) = payment operations across all versions of R.
- RES(P) and SO(P) = P's reservation and supplier orders.

**Limits:** `RS_UNKNOWN_ESCALATE_MIN` (default 15) and `RS_PENDING_ESCALATE_MIN` (default 1440). Rules apply top to bottom, and the first match wins.

| # | Rescue status | Condition |
|---|---|---|
| 1 | needs_input | no confirmed requirements version, or budget or deadline missing |
| 2 | failed_needs_attention | any operation in OPS(R) is `refund_failed`, or has `void_failed = 1`, or is `unknown` longer than the unknown limit, or is `*_pending` longer than the pending limit; or any reservation of R is `reconciling` with an escalation flag |
| 3 | refunding | any operation in OPS(R) is `refund_requested` or `refund_pending` |
| 4 | cancelling | an operation of a `superseded` or `non_executable` version is still `approved`, `authorization_pending`, `authorized`, `capture_pending`, `captured` or `unknown`; or a reservation of such a version is `reconciling` |
| 5 | no_feasible_plan | the latest planning run for the current requirements is infeasible and P is absent, or older than that run |
| 6 | cancelled | P is `non_executable` and no newer version exists |
| 7 | collected | P `executed`, every SO(P) `collected`, every operation of P `captured` |
| 8 | ready_for_pickup | P `executed`, every operation of P `captured`, every SO(P) `ready` or `collected` |
| 9 | purchase_confirmed | P `executed` (every operation of P `captured`) |
| 10 | payment_authorized | P `approved` with RES(P) `active` and every operation of P `authorized`; or P `executing` (captures in progress, within limits) |
| 11 | stock_reserved | P `approved` and RES(P) `active` |
| 12 | plan_found | P `proposed` or `approved`, with no active reservation |
| 13 | requirements_confirmed | requirements confirmed and no planning run yet |

The goal's states are the main sequence `plan_found … collected`, plus `cancelling`, `refunding` and `failed_needs_attention`. Rows 1, 5, 6 and 13 extend the goal so that pre-plan and closed requests have an honest value. The response also carries every underlying status and the next step, so the coarse aggregate never hides a per-operation fact.

### Payment saga (`services/payments.js`)
0. **Preconditions** (set up by the workflows):
   - plan `approved`;
   - reservation `active`;
   - one payment operation per supplier order, created and authorized after the buyer approves on PayPal;
   - every supplier order `confirmed`.

   The number of approvals equals the number of supplier orders and is announced before the first approval (A2).
1. **Exclusive claim.** One `BEGIN IMMEDIATE` transaction does all of the following, or nothing:
   - **Revalidate:** plan `approved` and not superseded; reservation `active` with `expires_at > now`; every supplier order `confirmed` with committed qty ≥ planned and committed ready ≤ deadline; every operation `authorized`, with an amount equal to its supplier-order total and a provider `expiration_time` (re-read from the provider just before the claim) more than `RS_AUTH_EXPIRY_MARGIN_MIN` (default 10) in the future.
   - **Claim:** `UPDATE plan_versions SET status='executing', executor_id=?, lease_until=now+60s WHERE id=? AND status='approved'`.
   - **Consume:** reservation `active → consumed`, with `consume` ledger rows.
   - **Persist intents:** insert one `provider_calls` row per supplier order (`kind = capture`, `operation_key = so:<supplierOrderId>:capture:1`, UNIQUE, status `intent`).

   If the claim UPDATE changes 0 rows, the request returns the current state (200) and makes no provider call. This is how two OS processes stay safe (RS-20). If revalidation fails, the transaction aborts with a named 409 (`AUTHORIZATION_EXPIRED`, `RESERVATION_EXPIRED`, `PLAN_SUPERSEDED`, `COMMITMENT_MISSING`). For an expired authorization or reservation, the void rule then runs and the plan becomes `non_executable`.
2. **Captures, sequential in supplier-code order.** Only the lease holder runs captures, renewing the lease at each step. Each capture sends `PayPal-Request-Id = operation_key` and handles the answer as follows:
   - COMPLETED → `captured`.
   - PENDING → `capture_pending`; the saga pauses until the reconciler resolves it.
   - DECLINED or an error → compensation.
   - No response → `unknown`; the reconciler reads provider state before any re-send.
3. **Success.** Once every operation is `captured`, the plan becomes `executed` and handover unlocks.
4. **Compensation.** The plan becomes `executing → non_executable` (`CAPTURE_FAILED`) and the reservation `consumed → reconciling`. Every uncaptured authorization is voided (`so:<id>:void:1`). Every captured operation goes `refund_requested → refund_pending → refunded | refund_failed` (`so:<id>:refund:1`). Handover is blocked. Once everything resolves, the reservation becomes `released` with `restock` ledger rows. A `refund_failed` or `void_failed` result raises the escalation flag (`failed_needs_attention`).
5. **Restart.** On startup, every `provider_calls` row in `intent` is treated as `unknown`, since it may have been sent. A plan in `executing` whose lease has expired is taken over by a reconciler that claims the lease with a conditional UPDATE under `BEGIN IMMEDIATE`, and the saga resumes at the first supplier order that is not `captured`.

**Void rule.** The rule fires whenever a plan version leaves the executable path before the claim:
- superseded (RS-13, including an offer withdrawn by the admin stock-depletion fault, RS-32);
- supplier refusal (RS-17);
- buyer abandons after a cancel (RS-18);
- authorization DENIED (RS-21);
- authorization expired at revalidation;
- reservation expired (RS-15).

When it fires, in the same transaction that changes the plan status:
- the reservation is released, if active, and the supplier orders are `cancelled`;
- void intents are persisted for every operation of that version in `authorized`;
- operations in `created`, or in `approved` with no authorize call recorded, become `voided` locally;
- operations in `authorization_pending`, or in `approved` with an authorize call still in `intent` or `unknown`, are voided once the reconciler sees them resolve to `authorized`, and if they resolve DENIED they end as `authorization_failed`.

Every void ends in `voided`, or in `void_failed` and therefore `failed_needs_attention`. The buyer sees a message naming the trigger, "No money was taken", which authorizations were voided, and one next step: "Review the new plan" (supersession or refusal), "Re-plan with current stock" (expiry or abandon), or "Re-plan or try another PayPal account" (DENIED).

**When supersession stops applying.** A price, fee, ready-time or availability change supersedes an approved plan only while:
- the affected supplier's order is not `confirmed`, because the confirmed order freezes its price and commitment in `supplier_orders`; and
- the plan is not `executing`.

After that, catalog changes do not touch the plan. Revalidation checks committed values, not the live catalog.

**Authorization expiry.** The validity periods are unverified (A12). Every authorization's `expiration_time` is re-read from the provider at revalidation. An authorization that has expired, or is inside the margin, is handled as a DENIED authorization (void rule, buyer re-approves under a new plan version). The reservation TTL (30 min default) keeps the normal wait far below any reported validity window.

### PayPal return and session (ARCH-10)
- **Return handler.** `GET /api/paypal/return?token=<paypal order id>` looks up `payment_operations` by `provider_order_id`. If the operation's customer is not the session customer, or no such operation exists, the answer is 404 with no state change. Otherwise the operation moves `created → approved`, and authorize is called with `operation_key = so:<id>:authorize:1`. If that key already exists in `provider_calls`, no call is sent; the stored outcome is used. Refresh and back-navigation are therefore idempotent. The handler then answers 303 to the SPA request page.
- **Cancel handler.** `GET /api/paypal/cancel?token=` makes the same owner check, sets `buyer_cancelled_at`, and redirects.
- **Session cookie.** The cookie is `HttpOnly; SameSite=Lax` (plus `Secure` over https), so the top-level navigation back from `www.sandbox.paypal.com` carries the session. Groundwork used `SameSite=Strict`, which would drop the session on this return (ev:ev-mv16ggcp-011ee455), so this is a deliberate deviation. CSRF protection stays in place: every non-GET route needs the double-submit header, and the two side-effecting GET routes are owner-checked and idempotent. They act only on a PayPal order the provider reports approved.
- **Fake approval page.** It is served by a second listener on `127.0.0.1:<port>` while tests use `localhost:<port>`. These are different sites, so [B] exercises the cross-site return. The live variants of RS-31 and RS-32 cover the real page.
- **"Try approval again"** re-issues the existing order's approval link. If the provider reports the order no longer approvable (A13), a new `create_order` call is made with attempt 2 (`so:<id>:create_order:2`).

### Idempotency and concurrency
- **Client to server: `Idempotency-Key`.** Keys are stored in `idempotency_keys(customer_id, route, key, body_sha256, response_json)`. The same key with the same body replays the stored response. The same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`. For `reserve`, the key is the reservation's `operation_key`, scoped per customer.
- **Server to PayPal: `PayPal-Request-Id`.** Its value is `provider_calls.operation_key = so:<supplierOrderId>:<kind>:<attempt>`. Because the key encodes the kind, it is unique per call type (ARCH-14), and it is reused unchanged on every re-send of that call. The database's UNIQUE constraint is the primary guard. PayPal's retention of request ids is unverified, so the provider-side id is only a backstop.
- **Fake adapter.** Its state lives in `fake_paypal_*` tables in the same database (`simulated` rows). This lets multi-process tests count calls. The adapter models request-id replay, CREATED, PENDING, DENIED, DECLINED, COMPLETED, timeouts, lost responses (the effect is applied and the response dropped), authorization expiry, duplicate webhooks and bad signatures.
- **SQLite contention.** Every connection sets `journal_mode = WAL` and `busy_timeout = 5000`. A SQLITE_BUSY after the timeout maps to 503 `DB_BUSY` with `Retry-After: 1`, never 500 (ev:ev-mv16fndw-01e46e13).

### Data model (SQLite; money as INTEGER cents; times as ISO-8601 UTC strings)
- `users(id, username UNIQUE, password_hash, role customer|supplier|admin, supplier_id, display_name, disabled, created_at)`. `sessions`, `meta`, `schema_migrations`.
- `suppliers(id, code, name, pickup_address, paypal_merchant_key, demo)`. `products(id, supplier_id, kind cup|lid|bundle, capacity_ml, diameter_mm, …, demo)`. `bundle_items`. `compatibility(cup_product_id, lid_product_id, confirmed_by, confirmed_at)`.
- `offers(id, supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, valid_from, valid_to, demo)`. `inventory(supplier_id, product_id, on_hand, reserved, version, CHECK(reserved <= on_hand), CHECK(reserved >= 0))`.
- `inventory_ledger(…, reason reserve|release|expire|consume|restock|adjust, ref_type, ref_id, actor, at)`, append-only.
- `rescue_requests(id, customer_id, raw_text, language, intake_status, deleted_at, created_at)`. This table has no rescue-status column; `intake_status` tracks only text, image and confirmation progress. `images(id, request_id, path, mime_detected, bytes, sha256, created_at)`.
- `extractions(id, request_id, provider, model, schema_ok, error_code, degraded, latency_ms, cost_usd, fields_json, created_at)`. `requirements(id, request_id, version, fields_json, confirmed_by, confirmed_at)`.
- `planning_runs(id, request_id, requirements_version, feasible, trace_json, rejections_json, candidate_codes_json, relaxations_json, offers_hash, created_at)`.
- `plan_versions(id, request_id, planning_run_id, version, status, plan_json, plan_hash, total_cents, pickup_count, ready_at, superseded_by, non_executable_reason, executor_id, lease_until, created_at)`. `plan_approvals(id, plan_version_id, customer_id, approved_hash, approved_total_cents, at)`.
- `reservations(id, plan_version_id, customer_id, operation_key UNIQUE, status, expires_at, escalation, created_at, closed_at)`. `reservation_items`.
- `supplier_orders(id, plan_version_id, supplier_id, reservation_id, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, committed_qty_json, committed_ready_at, confirmed_at, refusal_reason, ready_at, collected_at)`. `pickup_confirmations(supplier_order_id, kind handover|receipt, by_user, at)`.
- `payment_operations(id, supplier_order_id UNIQUE, status, provider, merchant_key, provider_order_id UNIQUE, provider_authorization_id, provider_capture_id, provider_refund_id, amount_cents, currency, authorization_expires_at, buyer_cancelled_at, void_failed, last_error_code, unknown_since, pending_since, archived_at)`.
- `provider_calls(id, payment_operation_id, kind create_order|authorize|capture|void|refund, attempt, operation_key UNIQUE, status intent|succeeded|failed|unknown, http_status, provider_status, error_code, request_id, created_at, finished_at)`.
- `webhook_events(id, provider, transmission_id UNIQUE, merchant_key, event_type, resource_id, signature_status, received_at, applied_at, flagged, payload_json)`. `idempotency_keys(…)`. `audit_events(…)`, append-only.

### API contracts (JSON under `/api`; error envelope `{error:{code,message,requestId,details?}}`)
- **Customer:**
  - `POST /api/requests`, `POST /api/requests/:id/image`, `POST /api/requests/:id/extract`, `POST /api/requests/:id/confirm`, `POST /api/requests/:id/plan`, `GET /api/requests/:id` (owner scope; includes the derived rescue status) and `DELETE /api/requests/:id`.
  - `POST /api/plans/:id/approve` (`expectedTotalCents`, `planHash`), `POST /api/plans/:id/reserve` (`Idempotency-Key`), `POST /api/plans/:id/execute` and `POST /api/plans/:id/abandon`.
  - `POST /api/orders/:id/paypal/create` (returns the approval URL; idempotent per attempt), `GET /api/paypal/return?token=`, `GET /api/paypal/cancel?token=` and `POST /api/orders/:id/receipt`.
- **Supplier:** `GET /api/supplier/orders`, `POST /api/supplier/orders/:id/{confirm|refuse|ready|handover}`, and `GET/PATCH /api/supplier/inventory` (own supplier only). A PATCH that would set on_hand < reserved returns 409 `RESERVED_STOCK`; the supplier refuses the order instead.
- **Admin:** `POST /api/admin/reset` (guard per RS-37), `POST /api/admin/faults` (stock depletion = withdraw the offer, which supersedes plans whose order with that supplier is not yet confirmed and so cancels those orders and voids their authorizations under the void rule (RS-32); supplier refusal; fake-adapter faults; refund order) and `GET /api/admin/timeline`.
- **Webhooks:** `POST /api/webhooks/paypal/:merchantKey` (the raw body is kept for verification).

### Major choices and alternatives
- **SQLite (`node:sqlite`) vs PostgreSQL.** PostgreSQL is not running here and would add setup to NFR1. SQLite with WAL, `BEGIN IMMEDIATE`, `busy_timeout` and CHECK constraints gives serialised conditional updates across processes. ev:ev-mv16fndw-01e46e13 shows the two-process race giving one RESERVED and one OUT_OF_STOCK when the busy timeout is set. Trade-off: single host only, which is acceptable for a demo. The experimental status of `node:sqlite` is RISK-15.
- **Exact lexicographic planner with brute-force oracle vs heuristic or greedy.** The catalog is small, and exactness makes RS-06..RS-11 and the relaxations explainable. A greedy planner would be simpler but cannot justify a rejection or prove optimality.
- **Plan-status claim vs a separate lock table.** The `approved → executing` conditional UPDATE is the lock, so one row tells both the UI and the reconciler who owns execution. A lock table would add a second source of truth.
- **Polling reconciler (primary) vs webhooks (primary).** Webhooks need a public URL that the demo may not have (`dec-mv16pz0g-01d5c4c2`, Q6). Polling works everywhere. Webhooks remain as a faster, verified secondary path.
- **Hosted PayPal approval link vs JS SDK buttons.** The hosted link keeps the client id out of the browser (RS-29) and needs no third-party script. It also forces the cross-site return, which is handled by `SameSite=Lax`.
- **`SameSite=Lax` vs `Strict` with token-then-redirect.** With `Strict`, the return handler would have to authenticate the buyer by token alone and then redirect so the SPA could act. Lax with an owner check is simpler, and the return route's effects are owner-scoped and idempotent.
- **Credential-per-merchant Sandbox apps vs PayPal Multiparty.** Partner onboarding needs permissions a hackathon account may not have. With per-supplier credentials, each order is honestly paid to one payee. With a single credential set, every supplier maps to it and the UI says so (A2, `dec-mv16pz0g-01d5c4c2`).
- **Claude Code CLI vs Anthropic API.** The CLI is authenticated here and no API key exists. The provider contract supports both. The deterministic `fake` provider keeps `npm test` offline.
- **Fault-injectable fake adapter vs HTTP mocks.** A stateful double implementing the provider contract runs RS-18..RS-26 deterministically and across processes. Mocks would couple the tests to wire formats.
- **Template explanations vs model-generated explanations.** Templates are deterministic, free and injection-proof, and no requirement asks for model prose.
- **Single process vs services.** One process is the simplest design that meets the requirements. Multi-process safety comes from the database, not from coordination between processes.

### AI feature statement
**What the model does that code cannot.** It extracts structured, provenance-tagged requirements from free-form Arabic or English text and from package photos. It does nothing else by default; explanations are templates.

**Failure modes and controls:**
- **Hallucinated measurements.** The schema requires provenance and allows `unknown`. RS-03 uses ambiguous images and requires 0 invented numbers.
- **Prompt injection.** RS-05 fixtures cover it. Model output is data only; the model has no tools, and permissions, amounts, suppliers and plan versions never derive from model output.
- **Outage or invalid output.** The degraded manual path applies, clearly labelled, and the journey continues (RS-03).
- **Cost.**
  - `haiku` is the default model, with a per-call cap of `--max-budget-usd` and a 30 s timeout.
  - A **daily runtime budget** (`RS_MODEL_DAILY_BUDGET_USD`, default 1.00, Q10) counts spend since 00:00 Asia/Amman. A call is refused when spend so far plus the per-call cap would exceed the budget.
  - A **per-customer rate limit** allows 10 extract or image-upload calls per 10 minutes. It is counted in SQLite, so it holds across processes and restarts.
  - Both refusals are labelled (NFR6).

**Human in the loop.** The buyer confirms every field before a requirements version exists. Approval requires the hash and the total. The buyer approves each PayPal authorization.

**Quality measurement.**
- **Corpus:** `npm run test:live-model` runs over the committed corpus `test/fixtures/extraction/`. `manifest.json` carries `corpusVersion: "EXT-1"` and labelled expected fields.
- **Cases:** at least 10 text cases (at least 5 Arabic/English pairs, including the RS-FIX-1 wording) and at least 6 synthetic package images made for the project (at least 3 clear, at least 2 ambiguous, at least 1 carrying injection text).
- **Thresholds:** field-level exact match ≥ 90 % on text and ≥ 80 % on clear images; 0 invented numeric values on ambiguous images; 0 injection effects.
- **Versioning and reporting:** any label change bumps `corpusVersion`. The report records the corpus version, model, cost and pass rates.

### Where this brief goes beyond goal.md (for the user's attention; goal.md is unchanged)
1. Inventory is pinned at 1 bundle per supplier.
2. The plan machine adds `executing` and `executed`.
3. The reservation machine adds `consumed → reconciling → released`.
4. The payment machine adds `authorization_pending`, `capture_pending` and local `voided` before authorization.
5. The fulfilment machine adds `cancelled`.
6. The aggregate status adds `needs_input`, `no_feasible_plan`, `cancelled` and `requirements_confirmed`.
7. The Node floor is 22.13 (Q9).
8. Images are swept automatically after 7 days (the goal says "by the admin reset").
9. The session cookie is `SameSite=Lax`.
10. A runtime model budget and rate limit are added.
11. The live-model ceiling is USD 5 per `dec-mv16pz0g-01d5c4c2` (the earlier draft of this brief said USD 1; the goal sets none).
12. Explanations are template-rendered.

## Constraints
- **Time:** the hackathon submission is reported as 12 Nov 2026 12:00 PT (unverified, Q5). The ECCode pilot budget is USD 25 / 480 min, as recorded by `eccode status`.
- **Platform:**
  - Node ≥ 22.13 (`dec-mv16pyxx-01bad0bf`; the host runs 22.22). `node:sqlite` is unflagged from 22.13 but still prints an ExperimentalWarning, so the npm scripts pass `--disable-warning=ExperimentalWarning`.
  - The busy timeout is set by PRAGMA, because the constructor option needs 22.16.
  - Zero npm runtime dependencies. `@playwright/test` is the only devDependency.
  - Playwright and Chromium are pre-installed in this build environment only. Clean clones install the browser once for `test:browser` (README).
  - No PostgreSQL.
- **Test scripts** (`dec-mv16pz32-013c4cd1`):
  - `npm test` runs offline, deterministic `node --test`.
  - `npm run test:browser` runs Playwright.
  - `npm run test:live-model` and `npm run test:live-paypal` are opt-in by environment flag.
- **Network in this build environment:**
  - `api-m.sandbox.paypal.com`, `www.sandbox.paypal.com` and `developer.paypal.com` are blocked by policy.
  - There are no PayPal credentials and no `ANTHROPIC_API_KEY`.
  - Consequences: live PayPal evidence, including the Sandbox approval-page variants of RS-31 and RS-32, must be produced by the user (Q1, Q2). Real-model evidence can be produced through the Claude Code CLI, billed to the user.
- **Compliance and honesty:** Sandbox only, and config refuses live PayPal hosts. Everything simulated, demo or Sandbox is labelled (RS-34). Secrets come only from the environment (NFR4). MIT licence, public repository (A1, Q4 default).

## Success Criteria
- `npm test` passes in this environment for all deterministic ACs. `npm run test:browser` passes for every [B] AC, including the (a) variants of RS-31 and RS-32. Both results are recorded as ECCode evidence with the suite label.
- RS-01..03 and RS-05 also pass with the real model over corpus EXT-1, at the stated thresholds and within the recorded ceiling.
- RS-18..RS-26, and the (b) variants of RS-31 and RS-32, pass against Sandbox on the user's machine. Until then they are recorded as Unverified with blocker A6/Q2. Rows weakened by single-credential mode are labelled as such (A2).
- The canonical fixture with pinned inventory produces exactly the expected outcomes: $84; C and D rejected; $95; no plan with relaxations of 9500 and 11:20; no plan at max 1 pickup.
- A judge can answer the six questions from the customer screen without reading code.
- The demo video is under 3 minutes and shows **PayPal's hosted Sandbox approval page**, not the fake page. The README clean-checkout is verified on a fresh clone. No secret appears in any artifact.

## Assumptions
- A1. RescueStock lives at `examples/rescuestock/` in the ECCode repository (MIT, public) unless the user names a dedicated repository (default recorded in `dec-mv16pz0g-01d5c4c2`, Q4). Blocks: README paths.
- A2. Multi-merchant routing uses credential-per-merchant Sandbox REST apps, one per demo supplier business account. If only one set is supplied, every supplier maps to `DEFAULT` and the UI says "All demo suppliers are paid to one Sandbox account" (`dec-mv16pz0g-01d5c4c2`, Q1).
  - **The number of buyer approvals equals the number of supplier orders** (2 in the canonical journey) and is shown before the first approval.
  - Single-credential mode weakens these live rows, which the evidence table labels accordingly: RS-22 (refund of supplier 1 and capture of supplier 2 hit one account, so cross-merchant compensation is not shown), RS-19 (payee per supplier), RS-20 (per-merchant request-id separation), RS-23/24 (one webhook id).
  - Blocks: the live evidence of those rows.
- A3. Buyer approval goes through PayPal's hosted approval link with `return_url` and `cancel_url`. No client id reaches the browser. Blocks: none.
- A4. The real model is reached through the Claude Code CLI (billed to the user) or through the Anthropic API when `ANTHROPIC_API_KEY` is set. Tests use the `fake` provider. Blocks: the live-model evidence.
- A5. Images are stored under `data/uploads/` with random names, at most 5 MB, PNG/JPEG/WebP by magic bytes. They are deleted with the request or by the automatic sweep after 7 days. Raw text, extractions and demo accounts are retained until the customer deletes the request or the admin resets the demo, and the README says so. Blocks: none.
- A6. (Environment, verified in revision 1) PayPal Sandbox hosts are unreachable from this build environment and no credentials exist. Blocks: live evidence for RS-18..RS-26 and the (b) variants of RS-31 and RS-32.
- A7. (Environment, verified in revision 1) There is no `ANTHROPIC_API_KEY`, so the CLI with `haiku` is the real-model route. Blocks: none (CLI route available).
- A8. (Environment, verified in revision 1) PostgreSQL is not running, so `node:sqlite` is the database. Blocks: none.
- A9. Hackathon facts come from secondary web sources. Blocks: schedule and submission checklist (Q5).
- A10. Sandbox webhooks need a public URL. Polling is the primary path (`dec-mv16pz0g-01d5c4c2`). Blocks: live RS-23/24 (Q6).
- A11. PayPal authorization, capture and refund can each answer PENDING, per secondary-source research marked "verify". The design handles these answers whether or not they occur. Blocks: none. Live confirmation rides on Q2.
- A12. The authorization validity and honour period (3 and 29 days in secondary sources) are unverified. The design re-reads `expiration_time` and never assumes a window. Blocks: none. RISK-13 tracks it.
- A13. A PayPal order may remain approvable after the buyer cancels. If not, "Try approval again" creates attempt 2. Blocks: none (both paths are designed).

## Open Questions
- Q1. How many PayPal Sandbox business accounts and REST credential sets will the user provide? The recorded default (`dec-mv16pz0g-01d5c4c2`) is one set per supplier when supplied and `DEFAULT` otherwise, labelled. The user may override it. Blocks: live RS-18..RS-26 and the single-credential labels (A2).
- Q2. Where will the live PayPal suite and the Sandbox approval-page journeys run (the user's machine with network access)? Blocks: the live evidence of RS-18..RS-26 and the (b) variants of RS-31 and RS-32, and the demo video.
- Q3. Model route and spend. The recorded default (`dec-mv16pz0g-01d5c4c2`) is the CLI with `haiku` and a USD 5 ceiling per live-model run. Does the user approve it, or prefer `sonnet` or an API key? Blocks: the NFR6 ceiling and the RS-01..03 live runs.
- Q4. Dedicated public repository, or keep `examples/rescuestock/`? The recorded default keeps it in this repository. Blocks: README paths and submission links.
- Q5. The user should confirm the deadline, submission requirements and judging criteria on the official Devpost page, which is blocked here. Blocks: schedule and submission checklist.
- Q6. Will a public webhook URL be available? The recorded default makes polling primary and verifies webhooks when a URL exists. Blocks: live RS-23/24.
- Q7. Devpost account and project ownership, and production of the demo video. Blocks: final submission.
- Q8. Is the English UI acceptable for Arabic-speaking buyers? The recorded default is an English UI with `dir="auto"` on text inputs. Blocks: NFR2 scope.
- Q9. **(New)** Does the user accept raising the Node floor from the goal's 22.5 to 22.13 (`dec-mv16pyxx-01bad0bf` was recorded by the orchestrator, not the user)? If not, every script adds `--experimental-sqlite` and the floor stays at 22.5. Blocks: NFR1 wording, `engines.node`, README.
- Q10. **(New)** What runtime daily model budget should the deployed demo use? The default is USD 1.00 per day, billed to the user's account. Blocks: the NFR6 default value.

## Risks
| Id | Description | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RISK-1 | PayPal Sandbox hosts are blocked from the build environment, so live PayPal evidence cannot be produced here | certain | high (the hackathon goal is PayPal integration) | Fake adapter implements the full provider contract with faults. The live suite and the RS-31/32 (b) variants are scripted for the user's machine with a runbook. The evidence table marks them Unverified with the blocker. | product-architect / devops-engineer |
| RISK-2 | No PayPal credentials and no `ANTHROPIC_API_KEY` | certain | high | Config supports env-only credentials. The CLI model route works now. The user is asked in Q1/Q3, and defaults are recorded. | delivery-lead |
| RISK-3 | Double capture (repeated clicks, two processes, retries, lost responses) | medium | critical (money) | Exclusive `approved → executing` claim under `BEGIN IMMEDIATE`. Deterministic UNIQUE operation keys, with `PayPal-Request-Id` = key. Intent persisted before each call, and `intent` treated as unknown at restart. Reconciler reads provider state before any re-send. RS-20 (two processes) and RS-25 test it. | backend-engineer |
| RISK-4 | Double reservation or oversell under concurrency | medium | critical (a paid plan that cannot be fulfilled) | Conditional UPDATE inside `BEGIN IMMEDIATE`, `busy_timeout`, CHECK constraints, UNIQUE `operation_key`, release-once ledger. RS-14/15/16 multi-process tests. | backend-engineer |
| RISK-5 | Cross-account access (customer, supplier, admin isolation), including PayPal return tokens | medium | critical (privacy, integrity) | RBAC default-deny, owner-scoped queries, return-token owner check, admin routes role-gated. RS-27/28/30 tests and a security review. | security-reviewer |
| RISK-6 | Prompt injection via image or catalog text alters extraction or downstream behaviour | medium | high | Schema-validated output treated as data, no tools, buyer confirmation, template explanations. RS-05 fixtures. | ai-engineer |
| RISK-7 | Model unavailability, latency or cost blow-up | medium | medium | Degraded manual path, `haiku` default, timeouts, per-call cap, daily budget, rate limit (RS-03, NFR6). | ai-engineer |
| RISK-8 | A lost, unknown or pending payment outcome leaves money or stock in limbo | medium | high | `unknown` and `*_pending` states, reconciler polling, `reconciling` never auto-released, escalation by age into `failed_needs_attention`. RS-21/22/25/26/36 test it. | backend-engineer |
| RISK-9 | Secrets leak into assets, logs, screenshots or the submission | low | high | Config redaction, hosted approval link, RS-29/NFR6 scans, `.env.example` placeholders | security-reviewer |
| RISK-10 | Hackathon facts are unverified, so the deadline or rules may not match | medium | medium | The user re-checks the official page (Q5), with schedule margin before 12 Nov | delivery-lead |
| RISK-11 | Scope breadth vs time budget | high | high | Slices ordered by risk. Fake adapters make the deterministic suite complete early. The frontend is minimal and state-driven. | delivery-lead |
| RISK-12 | Sandbox webhooks are unreachable in the demo (no public URL) | medium | medium | Polling is primary (`dec-mv16pz0g-01d5c4c2`). The verify-signature path is tested with the fake adapter and recorded payloads. | backend-engineer |
| RISK-13 | An authorization expires, or passes its honour window, while the saga waits for supplier confirmations. The validity periods are unverified (A12). | low | high (capture fails after the buyer approved) | Re-read `expiration_time` at revalidation, with a 10-minute margin. An expired authorization is voided and handled like DENIED: the buyer re-approves under a new version. The 30-minute reservation TTL bounds the wait. The fake adapter models expiry. | backend-engineer |
| RISK-14 | Playwright's browser download on judges' clean clones is network beyond npm and may fail | medium | medium | Browser suites run only under `npm run test:browser` (`dec-mv16pz32-013c4cd1`). `npm test` never launches a browser (NFR1/NFR3 ACs). The README documents the one-time `npx playwright install chromium`. | devops-engineer |
| RISK-15 | `node:sqlite` is experimental: it is flagged before 22.13 and warns on 22.22 (ev:ev-mv16fndw-01e46e13), and its API may change | medium | high | Node ≥ 22.13 floor (`dec-mv16pyxx-01bad0bf`) with an engines field and a startup check. `--disable-warning=ExperimentalWarning`. PRAGMA instead of version-specific constructor options. A thin `db/` wrapper isolates the API. Residual: API churn in future Node versions. | backend-engineer |
| RISK-16 | The session is lost on the cross-site PayPal return (`SameSite=Strict` inherited from Groundwork), breaking authorization in the real Sandbox only | medium | high | `SameSite=Lax`, owner-checked idempotent return handler, a fake approval page on a different site in [B], and the RS-31/32 (b) live variants | backend-engineer |
| RISK-17 | Runtime model spend abuse (looping extract or upload) billed to the user's account | medium | medium | Daily budget, per-customer rate limit and per-call cap. NFR6 asserts them deterministically. | ai-engineer |
| RISK-18 | Single-credential Sandbox mode makes the live RS-19/20/22/23/24 evidence weaker than claimed | medium | medium | Mode recorded in every live report. Weakened rows labelled in the evidence table (A2). Per-supplier credentials requested (Q1). | delivery-lead |

No embedded directives attempting to change role, scope or permissions were found in the inputs (the review, the goal, the plan, the research notes and the evidence logs). When this revision was placed, the review, the goal and the recorded decisions were read again, with the same result. The plan and the research notes were not re-read at placement.
