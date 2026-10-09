# RescueStock — Architecture Brief

Author: product-architect. Gate: architecture. Requirements version: RS-REQ-1 (2026-10-09).
Sources: `docs/build/goal.md` (the user's master goal, requirement ids RS-01..RS-33, RS-NF-1..4, fixture RS-FIX-1, assumptions A1–A5) and `docs/build/plan.md` (architecture draft). Every user requirement id is kept verbatim and unweakened. Ids RS-34+ and NFR5+ are additions by this role; the gate's criterion parser accepts one hyphen per id, so the four non-functional ids are listed as `NFR1 (RS-NF-1)` … `NFR4 (RS-NF-4)` with the user's id preserved in parentheses.

## Users
- **Primary: café owner/manager (customer role).** Job: when a supplier cancels or stock runs out, get matching cups and lids within a budget, before a deadline, from at most N pickup points, and pay only once every condition holds. Writes requests in Arabic or English, may attach a package photo, approves plans and PayPal authorizations, collects goods.
- **Secondary: demonstration supplier (supplier role).** Job: keep inventory and offers current, confirm or refuse incoming supplier orders with committed quantity and ready time, mark orders ready, record handover. Sees only its own orders and inventory.
- **Secondary: demo administrator (admin role, protected).** Job: seed/reset demonstration data, inject faults (stock depletion, supplier refusal, adapter faults), read the timeline. Inaccessible to ordinary users (RS-30).
- **Tertiary: hackathon judges and reviewers.** Job: understand in under three minutes what the buyer needed, why the plan was chosen, what was rejected, the exact total, what each supplier committed to and what happens on partial failure (the six on-screen questions).

## Problem
- **Pain (evidence: the user's goal statement).** A café's order or day is at risk because supplies are missing or a supplier cancelled. Finding compatible cups and lids across several suppliers, within budget and deadline, with limited pickups, is a constrained combinatorial decision made under time pressure; paying several suppliers safely (no double charge, no payment for an unfulfillable plan) is error-prone by hand.
- **Frequency and cost (assumption, not measured).** Treated as an occasional but high-cost event per café (a lost service day or a spoiled order). No market research was done in this environment; impact figures must not be claimed in submission materials without a source.
- **What a model adds that code cannot.** Turning free-text Arabic/English and a package photo into structured, provenance-tagged requirements. Everything after extraction (planning, money, inventory, payments) is deterministic code and verifiable by tests and a brute-force oracle.

## Requirements
Functional ids are the user's (RS-01..RS-33, grouped as in the goal). Each is testable; the Acceptance Criteria section phrases the pass/fail test per id.

**Extraction:** RS-01 bilingual equivalence; RS-02 image provenance; RS-03 ambiguous image → clarification, never invented measurements; RS-04 missing budget/deadline blocks approval and order creation; RS-05 injection via image/catalog text ends as data only.

**Planning:** RS-06 canonical A+B $84; RS-07 C rejected `INCOMPATIBLE_LID_DIAMETER`; RS-08 D rejected `READY_AFTER_DEADLINE`; RS-09 without B → A+E $95; RS-10 without B and budget $90 → no plan with blocking constraints and suggestions; RS-11 max 1 pickup → infeasible; RS-12 insufficient quantities cannot be approved; RS-13 price change supersedes the approved plan version.

**Inventory:** RS-14 exactly one of two concurrent reservations wins (real database, separate processes); RS-15 expiry releases exactly once; RS-16 same operation key → same reservation; RS-17 supplier refusal reaches the customer and starts replanning.

**Payments:** RS-18 cancelled approval → no capture; RS-19 browser amount tampering has no effect; RS-20 no double capture under repeated clicks/requests; RS-21 one authorization failure prevents capture of the plan; RS-22 partial capture failure → void/refund compensation with accurate statuses; RS-23 duplicate webhooks idempotent; RS-24 invalid webhook signatures rejected; RS-25 lost response after capture → reconciliation before retry; RS-26 restart preserves orders, payment operations and recovery progress.

**Authorization:** RS-27 customers isolated from each other; RS-28 suppliers isolated from each other; RS-29 PayPal secrets never in frontend assets, responses, logs, screenshots or submission materials; RS-30 demo tools inaccessible to ordinary users.

**Complete journeys:** RS-31 happy path request → collection; RS-32 replacement flow after B becomes unavailable ($95 plan); RS-33 infeasible request ends with explanation and no purchase.

**Added functional requirements (RS-34+, derived from the goal's scope text and the six questions; mandatory for the demonstration):**
- RS-34 Every demonstration/simulated element is labelled: `"simulated": true` in API payloads, provider badges in the UI, a persistent banner while a fake adapter is active.
- RS-35 The customer screen answers the six questions: extracted requirements with provenance; planner decision trace; rejection codes per supplier/bundle; totals in integer cents per supplier and overall; catalog offer vs supplier-confirmed commitment shown separately; compensation state and next step.
- RS-36 Plan, reservation, payment operation and fulfilment are separate persisted state machines; the rescue status is derived from them and is never stored as "done" by a plan alone.
- RS-37 Admin reset refuses while any payment operation is `authorized|captured|refund_pending|unknown` unless forced with a recorded reason, and never deletes `payment_operations` rows (archives them).
- RS-38 Every inventory transition and every security-relevant action is written to append-only ledgers (`inventory_ledger`, `audit_events`; UPDATE/DELETE forbidden by trigger).
- RS-39 Image uploads: PNG/JPEG/WebP only, max 5 MB, random file names, deleted with the request or by admin reset after 7 days (A5).

**Non-functional:**
- NFR1 (RS-NF-1) Clean-checkout setup from the README on Node ≥ 22.5 with no network beyond npm; zero runtime dependencies.
- NFR2 (RS-NF-2) Desktop and mobile layouts, keyboard navigation, visible focus, accessible labels, text-based status indicators; loading, empty, error, retry, timeout and expired-reservation states.
- NFR3 (RS-NF-3) Real-model extraction suite and real PayPal Sandbox suite are separate from the deterministic suite and labelled.
- NFR4 (RS-NF-4) Secrets only via environment variables; `.env.example` holds names and placeholders only.
- NFR5 Performance: the planner solves RS-FIX-1 and any catalog of ≤ 12 offers in < 1 s; API p95 < 300 ms on the deterministic suite; deterministic suite completes offline in < 5 min.
- NFR6 Cost and observability: live model suite uses `haiku` by default with a documented per-run ceiling (≤ USD 1); every response and log line carries a `requestId`; logs never contain secrets or raw card/PayPal payloads beyond ids.

## Main Workflows
1. **Rescue request (customer).** Sign in → write the problem (ar/en), optionally upload a package photo → `extract` runs the configured AI provider (fake in tests) → fields show value or `unknown`, provenance and original wording → customer answers clarification questions / confirms fields → a requirements version is created. Missing budget or deadline leaves the request in `needs_input` (RS-04).
2. **Planning and approval.** `plan` computes plan versions from current offers and availability → UI shows best plan, ranked alternatives, rejections with codes, surplus, total in cents, pickup count, plan-ready time → customer approves with `expectedTotalCents` + `planHash`; mismatch → 409 `PLAN_CHANGED` (RS-13, RS-19).
3. **Reservation and supplier orders.** `reserve` with an `Idempotency-Key` → one atomic conditional UPDATE per item in a `BEGIN IMMEDIATE` transaction → reservation `active` with `expires_at`; one supplier order per supplier (`awaiting_supplier`). Expiry job releases exactly once (RS-15/16).
4. **Payment authorization.** Per supplier order: persist payment-operation intent → create PayPal order (intent AUTHORIZE, server-derived amount, `PayPal-Request-Id` = operation key) → customer approves on PayPal's hosted page → return URL → authorize. Cancel URL → operation `voided`, no capture (RS-18).
5. **Supplier confirmation.** Supplier confirms quantity and ready time, or refuses; refusal notifies the customer and opens replanning (RS-17, RS-32).
6. **Execution saga.** `execute` (idempotent): revalidate (plan approved and current, reservation active, offers unchanged, all authorizations valid, commitments ≤ deadline) → capture sequentially → stop at first failure → compensation (void uncaptured, refund captured, reservation `reconciling`, handover blocked, escalation flag on failed compensation) (RS-20..22). Lost response → `unknown` → reconciler fetches provider state before any retry (RS-25).
7. **Readiness and collection.** Supplier marks ready → customer sees pickup addresses and committed times → supplier records handover, customer records receipt → rescue status `collected`.
8. **Webhooks.** `POST /api/webhooks/paypal/:merchantKey` → verify signature via provider → dedupe on transmission id → apply only allowed transitions; otherwise record and flag (RS-23/24).
9. **Admin demo.** Reset (guarded), inject faults, read timeline (RS-30, RS-37).

## Acceptance Criteria
Each item is pass/fail by a test or an inspection. The id is the user's requirement id (traceability is 1:1); the test suite that proves it is named in brackets: [D] deterministic `node --test`, [B] Playwright browser, [LM] live model, [LP] live PayPal Sandbox, [I] inspection.

- RS-01: Equivalent Arabic and English requests (RS-FIX-1 wording) yield identical core fields: product type, quantities, capacity, diameter, deadline, budget, max pickups. [D with fake provider; LM with real model, equality on normalised fields]
- RS-02: A clear package image yields capacity/diameter specifications carrying `provenance: "image"`. [D fake; LM real]
- RS-03: An ambiguous image yields `unknown` for unreadable fields plus at least one clarification question, and no numeric value absent from the image. [D fake; LM real]
- RS-04: With budget or deadline missing, `POST /api/plans/:id/approve` and `POST /api/orders/:id/paypal/create` return 409 with a named reason (`MISSING_BUDGET` / `MISSING_DEADLINE`) and no reservation or payment operation is created. [D]
- RS-05: Injection strings in image text and catalog text appear only as data in `fields_json`/catalog; after extraction no permission, amount, supplier, plan version or role differs from the control run. [D fake with injection fixtures; LM real]
- RS-06: Canonical RS-FIX-1 returns plan A+B with total 8400 cents, 2 pickups, ready 10:30. [D]
- RS-07: Supplier C's bundle is listed under rejections with code `INCOMPATIBLE_LID_DIAMETER`. [D]
- RS-08: Supplier D's bundle is rejected with code `READY_AFTER_DEADLINE`. [D]
- RS-09: With B removed (out of stock or offer withdrawn) the best plan is A+E at 9500 cents. [D]
- RS-10: With B removed and budget 9000 cents the planner returns no feasible plan, lists the blocking constraints (`OVER_BUDGET`) and at least one suggestion (raise budget to 9500, allow later ready time, or more pickups). [D]
- RS-11: With max pickups = 1 the canonical scenario is infeasible with `TOO_MANY_PICKUPS`/`INSUFFICIENT_QTY` explanations per candidate. [D]
- RS-12: A plan whose cups or lids total < required quantity cannot be produced as feasible, and approval of a tampered plan body is refused with 409. [D]
- RS-13: After an offer price changes, the approved plan version becomes `superseded`, totals are recalculated in a new version, and reserve/execute on the old version is refused until the new version is approved. [D]
- RS-14: Two separate OS processes reserve the last bundle concurrently against the same SQLite file; exactly one reservation is `active`, the other receives `OUT_OF_STOCK`; `reserved <= on_hand` holds. [D, multi-process]
- RS-15: An expired reservation is released exactly once: inventory returns to its prior value, the ledger holds one release row, and a second expiry pass is a no-op. [D]
- RS-16: Two `reserve` calls with the same `Idempotency-Key` return the same reservation id and create no second reservation or ledger row. [D]
- RS-17: Supplier refusal sets the order to `refused`, the customer request shows the refusal with next step, and a new plan version is computed excluding that supplier. [D; B]
- RS-18: Cancelling on PayPal (cancel URL) leaves the operation `voided`/`created`, no capture row exists, and `execute` refuses. [D fake; LP]
- RS-19: A client-supplied amount/currency/supplier on any payment route is ignored; the PayPal order amount equals the server-approved plan total. [D; LP]
- RS-20: N concurrent or repeated `execute` requests produce exactly one capture per supplier order (operation key unique, `PayPal-Request-Id` reused). [D fake; LP]
- RS-21: If one supplier's authorization fails, no capture occurs on any supplier order and the plan is `non_executable` with reason. [D]
- RS-22: With capture failing on the second supplier, the first capture is refunded, uncaptured authorizations voided, statuses read `refund_requested → refund_pending → refunded|refund_failed`, reservation `reconciling`, handover blocked. [D fake faults]
- RS-23: Delivering the same webhook (same transmission id) twice applies its effect once. [D; LP]
- RS-24: A webhook with an invalid signature is rejected (4xx), recorded with `signature_status: invalid`, and applies no transition. [D; LP]
- RS-25: After a simulated lost response on capture, the operation is `unknown`; the reconciler fetches provider state and only then marks `captured` or retries; no second capture. [D fake]
- RS-26: Killing and restarting the server mid-saga preserves orders, payment operations and recovery progress; the reconciler completes the saga. [D]
- RS-27: Customer X requesting customer Y's request or order id receives 404/403 and no data. [D]
- RS-28: Supplier A patching supplier B's inventory receives 403 and B's inventory is unchanged. [D]
- RS-29: A scan of built frontend assets, API responses, logs, screenshots and submission files finds no client id/secret value; config redacts secrets in errors. [D scan; I]
- RS-30: Customer and supplier sessions calling admin fault/reset routes receive 403; unauthenticated 401. [D]
- RS-31: Browser journey at 360 px and 1280 px: request → review → plan → reservation → PayPal approvals (fake adapter page) → supplier confirmations → capture → readiness → collection, with screenshots. [B]
- RS-32: Browser journey: B becomes unavailable after approval; buyer reviews and approves the $95 plan; old plan `superseded`; replacement flow completes. [B]
- RS-33: Browser journey: an infeasible request ends on an explanation screen with blocking constraints and suggestions; no reservation, order or payment operation exists. [B]
- RS-34: API payloads from fake adapters carry `"simulated": true`; UI shows provider badges and a persistent banner while a fake adapter is active. [D; B]
- RS-35: The request page shows all six answers (requirements with provenance, decision trace, rejections, cents totals, offer vs commitment, compensation state). [B; I]
- RS-36: State tables persist plan, reservation, payment operation and fulfilment statuses separately; the rescue status endpoint is computed and has no stored column. [D; I]
- RS-37: Admin reset returns 409 while any payment operation is `authorized|captured|refund_pending|unknown`; forced reset records a reason and archives rather than deletes payment operations. [D]
- RS-38: Any UPDATE/DELETE on `audit_events` or `inventory_ledger` fails; every reservation/release/consume writes a ledger row. [D]
- RS-39: Upload rejects >5 MB and non-PNG/JPEG/WebP; stored name is random; deletion with the request is verified. [D]
- NFR1 (RS-NF-1): A clean clone on Node ≥ 22.5 runs `npm test` and the server from the README with no network beyond npm; `package.json` has no `dependencies`. [D; I]
- NFR2 (RS-NF-2): Playwright checks at 360 px and 1280 px: keyboard-only completion of the happy path, visible focus, labelled controls, text status indicators; loading/empty/error/retry/timeout/expired-reservation states rendered. [B]
- NFR3 (RS-NF-3): `npm test` (deterministic), `npm run test:live-model` (`RS_LIVE_MODEL=1`) and `npm run test:live-paypal` (`RS_LIVE_PAYPAL=1`) are separate scripts; live reports are labelled. [I]
- NFR4 (RS-NF-4): Config reads secrets only from `process.env`; `.env.example` contains names and placeholders only; a test asserts no real-looking value. [D; I]
- NFR5: Planner on RS-FIX-1 and random catalogs ≤ 12 offers completes < 1 s; deterministic suite < 5 min offline. [D timing]
- NFR6: Every response and log line carries `requestId`; live model run cost is reported and ≤ USD 1. [D; LM report]

## Scope
**In:** cafés; cups, matching lids, indivisible cup-and-lid bundles; one demo city (Amman, `Asia/Amman`); USD; pickup from participating demo suppliers; buyer-defined max pickups; English interface; Arabic and English written requests; optional package images; customer, supplier and protected admin accounts; PayPal Sandbox only (authorize now, capture after all conditions).

**Out, with reason:** arbitrary internet shopping (no verifiable catalog/inventory); real payments (hackathon requires Sandbox; liability); currency conversion (adds rate risk without demo value); delivery/driver tracking (pickup model keeps the saga bounded); AI-to-AI negotiation (would be simulated theatre, contradicts honesty labelling); wallets/escrow (regulatory scope); food substitutions/allergy decisions (safety); marketplace onboarding (not needed for demo suppliers); Arabic UI/RTL layout (requests are bilingual, interface English per the goal; see Q8).

## Architecture
**Shape:** one Node process (zero runtime dependencies) serving a JSON API under `/api` and static ES-module SPA; SQLite file via `node:sqlite` (WAL, `BEGIN IMMEDIATE`); outbound calls only to the AI provider (Claude Code CLI subprocess or Anthropic API) and PayPal Sandbox REST; inbound webhooks from PayPal. Modules, data model, contracts, planner and saga are as specified in `docs/build/plan.md` §2–§6 and are adopted unchanged here.

```
 Browser (customer | supplier | admin SPA, hash routing, no secrets)
   │ cookie session + CSRF header, JSON, Idempotency-Key
   ▼
 ┌──────────────────────── Node 22 process ─────────────────────────┐
 │ http/router → auth (scrypt, sessions, CSRF, RBAC default-deny)   │
 │ routes/* → services/{requests,plans,reservations,orders,         │
 │            payments,webhooks} → domain/{planner,compat,money,     │
 │            states} (pure, clock-injected)                         │
 │ ai/{cli|anthropic|fake}  payments/{sandbox|fake}   reconciler loop│
 │ db/ (node:sqlite WAL, migrations, tx helper)  ── data/app.db     │
 └──────┬──────────────────────────────┬─────────────────────────────┘
        │ subprocess / HTTPS            │ HTTPS (credential-per-merchant)
        ▼                               ▼                 ▲ webhooks
  Claude Code CLI / Anthropic API    PayPal Sandbox REST v2 ┘
  (trust boundary: model output      (trust boundary: provider state is
   is untrusted data, schema-        truth; every call keyed by operation
   validated, no tool access)        id; signatures verified via provider)
```

**Trust boundaries.** (1) Browser ↔ server: the client never supplies amount, currency, supplier or plan version; server derives them from the approved plan version; RBAC default-deny with owner-scoped queries. (2) Server ↔ model: prompt text, image bytes and catalog text are untrusted; output must validate against the extraction JSON schema; the model has no tools, no network and no write access; fields are shown to the buyer for confirmation before any commitment (human-in-the-loop). (3) Server ↔ PayPal: intent persisted before every call; `PayPal-Request-Id` = operation key; webhook signatures verified through PayPal's verify endpoint; `unknown` state and reconciliation on lost responses. (4) Admin tools behind the admin role and a startup-provided admin password.

**Major choices and alternatives.**
- *SQLite (`node:sqlite`) vs PostgreSQL:* PostgreSQL is not running in this environment and would add setup to NFR1; SQLite with WAL + `BEGIN IMMEDIATE` + CHECK constraints gives serialisable conditional updates sufficient for RS-14 across processes. Trade-off: single-host only, acceptable for a demo.
- *Exact lexicographic planner with brute-force oracle vs heuristic/greedy:* the catalog is small (≤ tens of offers); exactness makes RS-06..RS-11 explainable and the oracle property test guards regressions. Greedy would be simpler but cannot justify rejections or optimality.
- *Hosted PayPal approval link vs JS SDK buttons:* the hosted link keeps the client id off the browser (RS-29) and needs no third-party script; the SDK would improve UX but requires a client id in the page.
- *Credential-per-merchant Sandbox apps vs PayPal partner/marketplace (Multiparty) API:* partner onboarding needs permissions a hackathon account may not have; per-supplier credentials map one order to one payee honestly. If only one business account exists, all suppliers map to it and the UI says so (A2).
- *Claude Code CLI subprocess (`claude -p --json-schema`) vs Anthropic API:* the CLI is present and authenticated here while no API key exists; the provider contract supports both, chosen by config. A deterministic `fake` provider keeps the required suite offline (NFR3).
- *Fault-injectable fake PayPal adapter vs HTTP mocks:* a stateful double that implements the same provider contract (orders, authorize, capture, void, refund, webhooks, faults: timeout, lost response, capture failure, duplicate webhook, bad signature) lets RS-18..RS-26 run deterministically; mocks would couple tests to wire formats.
- *Single process vs services:* one process is the simplest design meeting the requirements; the reconciler is an in-process loop with persisted progress (RS-26).

**AI feature statement.** The model extracts structured requirements from text and images and drafts grounded explanations from the planner trace (`ai/explain.js` renders from the trace; the model may only rephrase, never add facts). Failure modes and controls: hallucinated measurements → schema requires provenance and `unknown` is allowed; RS-03 tests ambiguous images. Prompt injection → RS-05 fixtures; output is data; no tools. Outages/cost → fake provider for tests, `haiku` default, timeout and budget caps, extraction row records latency and cost. Human-in-the-loop → buyer confirms every field before a requirements version exists; approval requires hash and total. Quality measurement → live-model suite over a labelled set of ≥ 10 bilingual requests and ≥ 6 images; thresholds: field-level exact match ≥ 90 % on text, ≥ 80 % on clear images, 0 invented numeric values on ambiguous images, 0 injection effects.

## Constraints
- **Time:** hackathon submission reported as 12 Nov 2026 12:00 PT (unverified, Q5); ECCode pilot budget USD 25 / 480 min as recorded by `eccode status`.
- **Platform:** Node 22.22 here (requirement ≥ 22.5), `node:sqlite`, Playwright + Chromium pre-installed, no PostgreSQL. Zero npm runtime dependencies (NFR1).
- **Network in this build environment:** `api-m.sandbox.paypal.com` and `developer.paypal.com` are blocked by policy; no PayPal credentials; no `ANTHROPIC_API_KEY`. Consequence: live PayPal evidence cannot be produced here and must be run by the user (Q1, Q2); real-model evidence can be produced through the Claude Code CLI, billed to the user.
- **Compliance/honesty:** Sandbox only; all simulations labelled (RS-34); secrets via env only (NFR4); MIT licence, public repository (A1).

## Success Criteria
- All RS-01..RS-39 and NFR1..NFR6 pass in the deterministic/browser suites in this environment; RS-01..03, RS-05 additionally pass with the real model; RS-18..RS-26 additionally pass against Sandbox on the user's machine, each recorded as ECCode evidence with the suite label.
- The canonical fixture produces exactly the expected outcomes ($84, C/D rejections, $95, no-plan, max-1 infeasible).
- A judge can answer the six questions from the customer screen without reading code.
- Demo video < 3 min, README clean-checkout verified on a fresh clone, no secret in any artifact.

## Assumptions
- A1. RescueStock lives at `examples/rescuestock/` in the ECCode repository (MIT, public) until the user names a dedicated repository.
- A2. Credential-per-merchant Sandbox REST apps, one per demo supplier business account; if only one account is supplied, all suppliers map to it and the UI says so.
- A3. Buyer approval through PayPal's hosted approval link with `return_url`/`cancel_url`; no client id in the browser.
- A4. Real model via the Claude Code CLI (`claude -p --json-schema`, billed to the user) or the Anthropic API when `ANTHROPIC_API_KEY` is set; tests use the `fake` provider.
- A5. Image retention: `data/uploads/`, random names, ≤ 5 MB, PNG/JPEG/WebP, deleted with the request or by admin reset after 7 days.
- A6. (Environment, verified here) PayPal Sandbox hosts are unreachable from this build environment and no credentials exist, so the live PayPal suite is designed to be run by the user; its code paths are covered deterministically by the fake adapter. Blocks: live evidence for RS-18..RS-26.
- A7. (Environment, verified here) No `ANTHROPIC_API_KEY`; the CLI route with `haiku` (default) or `sonnet` is the real-model route. Blocks: cost ceiling in NFR6.
- A8. (Environment, verified here) PostgreSQL is not running; `node:sqlite` is the database. Blocks: none (RS-14 is provable with SQLite across processes).
- A9. Hackathon facts (dates, rules, judging) come from secondary web sources; the Devpost pages are blocked here. Blocks: schedule and submission checklist (Q5).
- A10. Sandbox webhooks need a publicly reachable URL; the live suite also supports polling PayPal order state so RS-23/24 are provable without a tunnel (Q6).

## Open Questions
- Q1. How many PayPal Sandbox business accounts and REST app credentials will the user provide (one per supplier A–E, or one shared)? Blocks: A2 wiring, live RS-18..RS-26, UI "single payee" notice.
- Q2. Where will the live PayPal suite run (user's machine with network access)? Blocks: evidence plan for NFR3 live label and the verification gate's live rows.
- Q3. Model route and spend: CLI `haiku` (default) or `sonnet`, or an `ANTHROPIC_API_KEY`? Approved per-run ceiling? Blocks: NFR6 ceiling, RS-01..03 live runs.
- Q4. Dedicated public repository or keep `examples/rescuestock/` in ECCode for submission? Blocks: README paths, submission links (A1).
- Q5. User to confirm deadline, submission requirements and judging criteria on the official Devpost page (blocked here). Blocks: schedule and submission checklist.
- Q6. Will a public webhook URL (tunnel) be available for Sandbox webhooks, or is polling acceptable for the live demo? Blocks: live RS-23/24 design.
- Q7. Devpost account/project ownership and demo video production (the Devpost connector needs authorization in an interactive session). Blocks: final submission.
- Q8. Is an English-only interface acceptable for Arabic-speaking buyers (goal says English interface, bilingual requests)? Blocks: NFR2 scope (RTL not planned).

## Risks
| Id | Description | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RISK-1 | PayPal Sandbox hosts blocked from the build environment; live PayPal evidence cannot be produced here | certain | high (hackathon goal is PayPal integration) | Fake adapter implements the full provider contract with faults; live suite scripted for the user's machine with a runbook; evidence table marks Unverified with blocker | product-architect / devops-engineer |
| RISK-2 | No PayPal credentials and no `ANTHROPIC_API_KEY` | certain | high | Config supports env-only credentials; CLI model route works now; user asked in Q1/Q3 | delivery-lead |
| RISK-3 | Double capture (repeated clicks, retries, lost responses) | medium | critical (money) | Unique operation key per payment operation, `PayPal-Request-Id` = key, intent persisted before call, state machine forbids capture from `captured`/`unknown`, reconciler before retry; RS-20/25 tests | backend-engineer |
| RISK-4 | Double reservation / oversell under concurrency | medium | critical (unfulfillable paid plan) | Conditional UPDATE `reserved + q <= on_hand` in `BEGIN IMMEDIATE` tx, CHECK constraints, unique `operation_key`, release-once ledger; RS-14/15/16 multi-process tests | backend-engineer |
| RISK-5 | Cross-account access (customer/supplier/admin isolation) | medium | critical (privacy, integrity) | RBAC default-deny, owner-scoped queries at the service layer, admin routes role-gated; RS-27/28/30 tests; security review | security-reviewer |
| RISK-6 | Prompt injection via image/catalog text alters extraction or downstream behaviour | medium | high | Model output schema-validated, treated as data, no tools; permissions/amounts never derived from model output; buyer confirmation; RS-05 fixtures | ai-engineer |
| RISK-7 | Model unavailability, latency or cost blow-up | medium | medium | Fake provider for tests; `haiku` default; timeouts; per-run cost cap and recorded cost | ai-engineer |
| RISK-8 | Lost/unknown payment outcome leaves money or stock in limbo | medium | high | `unknown` state, reconciler fetches provider state, reservation `reconciling` never auto-released, escalation flag; RS-22/25/26 | backend-engineer |
| RISK-9 | Secrets leak into assets, logs, screenshots or submission | low | high | Config redaction, hosted approval link, secret scan test RS-29, `.env.example` placeholders | security-reviewer |
| RISK-10 | Hackathon facts unverified; deadline or rule mismatch | medium | medium | User re-checks the official page (Q5); schedule margin before 12 Nov | delivery-lead |
| RISK-11 | Scope breadth vs time budget (33 mandatory tests, three dashboards) | high | high | Slices S1–S8 ordered by risk; fake adapters make the deterministic suite complete early; frontend minimal and state-driven | delivery-lead |
| RISK-12 | Sandbox webhooks unreachable in demo (no public URL) | medium | medium | Verify-signature path tested with fake and recorded Sandbox payloads; polling fallback for order state (A10, Q6) | backend-engineer |

No embedded directives attempting to change role, scope or permissions were found in the inputs.
