# RescueStock: architecture and build plan

## 1. Stack (reuses the repository's convention; zero runtime dependencies)
- **Runtime:** Node ≥ 22.5, ESM. `node:http`, `node:sqlite` (WAL, `BEGIN IMMEDIATE` transactions), `node:crypto`. No npm dependencies, no lockfile. Same as the delivered Groundwork example, whose auth/session/CSRF/router/migration patterns are reused (copied and adapted, not imported across examples).
- **Frontend:** vanilla ES modules + one stylesheet, no build step. Three dashboards (customer, supplier, admin) in one SPA with hash routing.
- **Tests:** `node --test` for unit/API/integration (real SQLite file for concurrency tests, separate processes), Playwright with the pre-installed Chromium for browser journeys at 360 px and 1280 px. Live suites: `RS_LIVE_MODEL=1` (real model) and `RS_LIVE_PAYPAL=1` (real Sandbox) are separate scripts.
- **Clock:** every service takes `clock()`; tests pin it. Sandbox live tests use the real clock and compute deadlines relative to now.

## 2. Modules (`src/`)
```
config.js            env parsing with documented defaults; refuses invalid values; never logs secrets
db/                  connection (tx helper), checksummed migrations, migrations/*.sql
http/                router, body cap, cookies, envelope (fixed error codes), security headers
auth/                scrypt passwords, server sessions, double-submit CSRF, RBAC (default deny)
domain/money.js      integer cents, tax (basis points, round half up per supplier order), formatting
domain/compat.js     cup/lid compatibility: explicit diameter equality or a confirmed compatibility row
domain/planner.js    exact lexicographic planner (cost, pickups, ready time) over indivisible bundles
domain/oracle.js     brute-force reference planner for property tests (tests only)
domain/states.js     state machines + allowed transitions (plan, reservation, payment, fulfilment)
services/requests.js rescue requests, extraction provenance, clarification
services/plans.js    plan versions (immutable JSON), approvals, supersession on price/availability change
services/reservations.js  atomic reserve (conditional UPDATE), idempotent by operation key, expiry, release-once
services/orders.js   supplier orders, supplier confirmation/refusal, readiness, handover
services/payments.js payment operations state machine, saga (reserve→authorize all→confirm all→revalidate→capture), compensation, reconciliation
services/webhooks.js verify + dedupe (unique transmission id) + ordered application
ai/                  provider contract, cli (claude -p --json-schema, stream-json for images), anthropic (API), fake (deterministic double), prompt, schema (extraction JSON schema + validator), explain.js (grounded explanations from planner trace)
payments/            provider contract, sandbox.js (PayPal REST v2: orders, authorize, capture, void, refund, verify-webhook-signature; PayPal-Request-Id = operation id; credential-per-merchant), fake.js (fault-injectable double)
routes/              auth, requests, plans, reservations, orders, payments, webhooks, supplier, admin, static
app.js, index.js     wiring, reconciler loop, graceful shutdown
```

## 3. Data model (SQLite; all money INTEGER cents; all times ISO-8601 UTC strings)
- `users(id, username UNIQUE, password_hash, role customer|supplier|admin, supplier_id NULL, display_name, disabled, created_at)`
- `suppliers(id, code A..E, name, pickup_address, paypal_merchant_key, catalog_version)` — `paypal_merchant_key` names the env credential set, never the secret
- `products(id, supplier_id, kind cup|lid|bundle, name, capacity_ml, diameter_mm, material, spec_source)`; `bundle_items(bundle_id, product_id, qty)` — bundles are indivisible
- `compatibility(cup_product_id, lid_product_id, confirmed_by, confirmed_at)` — explicit confirmations beyond diameter equality
- `offers(id, supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, valid_from, valid_to)` — versioned price/readiness quotes (catalog readiness = offer, not commitment)
- `inventory(supplier_id, product_id, on_hand, reserved, version)` with CHECK `reserved <= on_hand`, `reserved >= 0`
- `inventory_ledger(id, supplier_id, product_id, delta_on_hand, delta_reserved, reason, ref_type, ref_id, actor, at)` — append-only audit of every inventory transition
- `rescue_requests(id, customer_id, raw_text, language, image_id, status, created_at)`
- `extractions(id, request_id, provider, model, schema_ok, latency_ms, cost_usd, fields_json, created_at)` — `fields_json` holds each field with `value|unknown`, `provenance user_text|image|catalog|manual`, `original_wording`
- `requirements(id, request_id, version, fields_json, confirmed_by, confirmed_at)` — buyer-confirmed, versioned
- `plan_versions(id, request_id, requirements_version, version, status, plan_json, total_cents, pickup_count, ready_at, rejections_json, offers_hash, created_at, superseded_by, non_executable_reason)`
- `plan_approvals(id, plan_version_id, customer_id, approved_at, approved_hash)`
- `reservations(id, plan_version_id, customer_id, operation_key UNIQUE, status, expires_at, created_at, released_at)`; `reservation_items(reservation_id, supplier_id, product_id, qty)`
- `supplier_orders(id, plan_version_id, supplier_id, reservation_id, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, supplier_confirmed_qty_json, supplier_ready_at, supplier_confirmed_at, refusal_reason, ready_marked_at, collected_at, created_at)`
- `payment_operations(id, supplier_order_id, operation_key UNIQUE, kind create_order|authorize|capture|void|refund, status, provider, provider_order_id, provider_authorization_id, provider_capture_id, provider_refund_id, amount_cents, currency, request_id, intent_persisted_at, started_at, finished_at, last_error_code, attempts, unknown_since)` — intent persisted before every external call
- `webhook_events(id, provider, transmission_id UNIQUE, merchant_key, event_type, resource_id, signature_status, received_at, applied_at, payload_json)`
- `pickup_confirmations(id, supplier_order_id, confirmed_by_role, confirmed_by_user, kind handover|receipt, at)`
- `audit_events(id, at, actor_id, actor_role, action, entity_type, entity_id, detail_json, request_id)` — append-only (trigger forbids UPDATE/DELETE)
- `sessions`, `meta`, `schema_migrations`, `images(id, request_id, path, mime, bytes, sha256, created_at)`

## 4. Contracts (JSON over `/api`, cookie session + CSRF header; fixed error envelope `{error:{code,message,requestId,details?}}`)
Customer: `POST /api/requests` (text, language, maxPickups, budgetCents?, deadline?), `POST /api/requests/:id/image` (multipart or raw body with content-type), `POST /api/requests/:id/extract`, `POST /api/requests/:id/confirm` (manual field confirmations → requirements version), `POST /api/requests/:id/plan` (compute plan versions), `GET /api/requests/:id` (everything, scoped to owner), `POST /api/plans/:id/approve` (body carries `expectedTotalCents` and `planHash`; mismatch → 409 `PLAN_CHANGED`), `POST /api/plans/:id/reserve` (idempotent via `Idempotency-Key` header = operation key), `POST /api/orders/:id/paypal/create` (returns approval URL), `GET /api/paypal/return?token=` and `/cancel`, `POST /api/plans/:id/execute` (server-side: revalidate + capture saga; idempotent), `POST /api/orders/:id/receipt`.
Supplier: `GET /api/supplier/orders`, `POST /api/supplier/orders/:id/confirm` (qty, readyAt), `.../refuse`, `.../ready`, `.../handover`; `GET/PATCH /api/supplier/inventory` (own supplier only).
Admin: `POST /api/admin/reset` (refuses while any payment operation is `authorized|captured|refund_pending|unknown` unless `--force` with a recorded reason; never deletes payment_operations rows: archives them), `POST /api/admin/faults` (stock depletion, supplier refusal, fake-adapter faults), `GET /api/admin/timeline`.
Webhooks: `POST /api/webhooks/paypal/:merchantKey` (raw body kept for verification).

## 5. Planner (exact, verifiable)
Inputs: requirement (cups N, lids N, capacity, diameter, material?), budget, deadline, maxPickups, offers with inventory availability (on_hand − reserved), tax bp, fees. Candidates: every (supplier, bundle or single product) offer compatible with the spec; indivisible bundles count whole. Search: enumerate multiplicities 0..ceil(N/qty) per offer with branch-and-bound on cost; feasibility = cups ≥ N, lids ≥ N, every chosen cup/lid pair compatible, suppliers used ≤ maxPickups, max(ready_at) ≤ deadline, total ≤ budget, availability. Objective: lexicographic (total cents, pickup count, plan-ready time = latest supplier ready time). Ties beyond that broken by supplier code for determinism. Output: best plan, ranked alternatives (next 3 feasible), rejections with codes `INCOMPATIBLE_LID_DIAMETER`, `READY_AFTER_DEADLINE`, `OVER_BUDGET`, `TOO_MANY_PICKUPS`, `OUT_OF_STOCK`, `INSUFFICIENT_QTY`, surplus per plan. Oracle: brute force over the same candidate space without pruning; property test on random small catalogs (≤ 6 offers) asserts equality of objective and feasibility.

## 6. Payment saga and invariants
Order: reserve → create one PayPal order per supplier (intent AUTHORIZE, exact server amount, `PayPal-Request-Id` = operation key) → buyer approves each on PayPal → authorize each → collect every supplier confirmation → revalidate (plan approved & current, reservation active, offers unchanged, authorizations `CREATED`/valid, supplier commitments ≤ deadline) → capture sequentially; stop at first failure; compensation: void uncaptured authorizations, refund captured ones (`refund_requested → pending → refunded|failed`), reservation → `reconciling` (never released while an outcome is unknown), handover blocked; escalation flag for failed compensation. Lost response → operation `unknown` → reconciler fetches provider state before any retry. Webhooks: verify (provider), dedupe on transmission id, apply only transitions the state machine allows, otherwise record and flag. Client never sends amount, currency, supplier identity or plan version: the server derives them from the approved plan version.

## 7. Slices (each ends with tests, an ECCode handoff and an independent review)
- S1 Foundation: config, db, migrations, auth, router, envelope, seed, static, health. (RS-NF-1, RS-27/28/30 scaffolding)
- S2 Domain: money, compat, planner + oracle, states; canonical fixture tests. (RS-06..RS-13)
- S3 Requests, extraction with fake provider, confirmation, plan versions, approval with hash. (RS-04, RS-12, RS-13)
- S4 Reservations with concurrency, expiry, idempotency; supplier orders, confirmation/refusal. (RS-14..RS-17)
- S5 Payments: provider contract, fake adapter with faults, saga, compensation, reconciliation, webhooks (verify via provider, dedupe). (RS-18..RS-26 deterministic)
- S6 Real adapters: Claude CLI/API extraction with image via stream-json; PayPal Sandbox REST; live suites. (RS-01..03, RS-05, RS-24 real)
- S7 Frontend: customer, supplier, admin dashboards; states; browser journeys. (RS-31..33, RS-NF-2)
- S8 Replanning and restart tests; docs, submission materials, acceptance report.

## 8. ECCode pilot (how this build is run)
Level: **High-impact** (payments, authentication) → full delivery profile: architecture → review → design → review → plan → review → phases → verification → deliver. Pilot toolkit version frozen at the commit recorded in `docs/build/state.md` after the independent verification passes its readiness gate. Roles are dispatched as separate general-purpose subagents carrying the ECCode role prompts; the PreToolUse guard is not installed in this cloud harness, so identity binding is by the CLI's `--actor` discipline and the engine's rules, not the hook. This is disclosed in the pilot report.
