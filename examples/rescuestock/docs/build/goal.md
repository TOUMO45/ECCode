# RescueStock: goal, scope and requirements

**Source of the goal.** The user's master prompt of 2026-10-09 ("Harden ECCode and Build RescueStock Through a Verified Engineering Workflow"), sections 5–20. This file restates it as stable, versioned requirement IDs with observable acceptance criteria. Requirement text is not weakened here; where a criterion depends on an external integration that this environment cannot reach, the evidence table (`evidence.md`) says Unverified with the exact blocker.

**Requirements version:** RS-REQ-1 (2026-10-09). A change to any requirement bumps this version and reopens the affected ECCode gate.

## Problem and target user
A small café has an order or a day's operation threatened because supplies are missing or a supplier cancelled. The owner needs matching cups and lids, within a budget, before a deadline, from pickup points they can reach. RescueStock turns a written problem (Arabic or English) plus an optional product-package photo into structured purchasing requirements, computes feasible supply plans from participating demonstration suppliers, explains choices and rejections, and coordinates buyer approval, inventory reservation, supplier confirmation and PayPal Sandbox payments (authorize now, capture only after every condition holds).

## Version-one scope
**In:** cafés; beverage cups, matching lids, indivisible cup-and-lid bundles; one declared demonstration city (Amman, time zone `Asia/Amman`); USD only; pickup from participating demonstration suppliers; buyer-defined maximum number of pickup locations; English interface; Arabic and English written requests; optional clear package images; customer accounts, demonstration supplier accounts, protected demo administrator; PayPal Sandbox only.

**Out:** arbitrary internet shopping; real payments; currency conversion; delivery or driver tracking; simulated AI-to-AI negotiation; wallets or escrow; food substitutions or allergy decisions; commercial marketplace onboarding.

All demonstration data, simulations, test providers and Sandbox transactions are labelled in the UI and the API (`"simulated": true`, provider badges, a persistent banner when a fake adapter is active).

## Six questions the application must answer on screen
1. What does the buyer need? (extracted requirements with provenance)
2. Why were these products and suppliers selected? (planner decision trace)
3. Why were other options rejected? (rejection codes per supplier/bundle)
4. What is the final total? (integer cents, per supplier and overall)
5. What readiness and pickup times has each supplier confirmed? (catalog offer vs supplier-confirmed commitment, shown separately)
6. What happens if part of the plan fails? (compensation state and next step)

## Honest statuses (separate state machines)
- Plan: `draft → proposed → approved | superseded | non_executable`
- Reservation: `active → consumed | expired | released | reconciling`
- Payment operation (per supplier order): `created → approved → authorized → captured | voided | authorization_failed`; captures: `refund_requested → refund_pending → refunded | refund_failed`; `unknown` after a lost response until reconciled
- Fulfilment (per supplier order): `awaiting_supplier → confirmed | refused`, then `ready → collected`; blocked while payment is compensating or unknown
- Rescue (aggregate, derived, never stored as "done" by a plan alone): `plan_found → stock_reserved → payment_authorized → purchase_confirmed → ready_for_pickup → collected`, plus `cancelling | refunding | failed_needs_attention`

## Canonical demonstration fixture (RS-FIX-1)
Fixed date 2026-10-20, time zone `Asia/Amman`, clock 09:00. Buyer needs 200 cups + 200 matching lids, 250 ml, 90 mm, deadline 11:00, budget USD 120, max 2 pickup locations, tax 0, one preparation fee per supplier order.

| Supplier | Bundle | Price | Prep fee | Ready | Compatibility |
|---|---|---:|---:|---|---|
| A | 100 cups + 100 lids | $30 | $10 | 10:00 | compatible |
| B | 100 cups + 100 lids | $36 | $8 | 10:30 | compatible |
| C | 200 cups + 200 lids | $48 | $5 | 10:00 | cups 90 mm, lids 95 mm |
| D | 200 cups + 200 lids | $68 | $12 | 11:20 | compatible |
| E | 100 cups + 100 lids | $45 | $10 | 10:40 | compatible |

Expected: base A+B $84; C rejected (incompatible); D rejected (late); without B: A+E $95; without B and budget $90: no plan; max 1 pickup: no plan. Test prices, not market prices.

## Mandatory acceptance tests (IDs are stable; meanings are the user's)
### Extraction
- **RS-01** Equivalent Arabic and English requests produce equivalent core requirements (product type, quantities, capacity, diameter, deadline, budget, max pickups).
- **RS-02** A clear image yields supported specifications with `provenance: image`.
- **RS-03** An ambiguous image produces a clarification (`unknown` fields + question) rather than invented measurements.
- **RS-04** Missing budget or deadline blocks commitment and payment (plan approval and order creation refused with a named reason).
- **RS-05** Malicious image/catalog text cannot change permissions or payment behaviour (injection strings end up as data; no permission, amount, supplier or plan change).
### Planning
- **RS-06** Canonical scenario returns A+B for $84.
- **RS-07** C rejected for incompatibility (`INCOMPATIBLE_LID_DIAMETER`).
- **RS-08** D rejected for lateness (`READY_AFTER_DEADLINE`).
- **RS-09** Removing B produces A+E for $95.
- **RS-10** Removing B with budget $90 produces no feasible plan with blocking constraints and suggestions.
- **RS-11** One allowed pickup location makes the base scenario infeasible.
- **RS-12** Insufficient quantities cannot be approved.
- **RS-13** Price changes recalculate totals and invalidate old approval (plan version `superseded`, new approval required).
### Inventory
- **RS-14** Two customers compete for the last bundle; exactly one reservation succeeds (real database, concurrent processes).
- **RS-15** Reservation expiry releases inventory exactly once.
- **RS-16** Refresh/retry does not create another reservation (same operation key → same reservation).
- **RS-17** Supplier refusal reaches the customer and initiates the replanning path.
### Payments
- **RS-18** Cancelled PayPal approval produces no capture.
- **RS-19** Browser-side amount tampering cannot change the server-approved price.
- **RS-20** Repeated clicks or requests cannot double-capture.
- **RS-21** One supplier authorization failure prevents capture of the plan.
- **RS-22** Partial capture failure triggers cancellation/refund compensation with accurate statuses.
- **RS-23** Duplicate payment webhooks do not duplicate effects.
- **RS-24** Invalid webhook signatures are rejected.
- **RS-25** Connection loss after capture triggers reconciliation before retry.
- **RS-26** Restart preserves orders, payment operations and recovery progress.
### Authorization
- **RS-27** Customers cannot read another customer's requests or orders.
- **RS-28** Suppliers cannot modify another supplier's inventory.
- **RS-29** PayPal secrets do not appear in frontend assets, responses, logs, screenshots or submission materials.
- **RS-30** Ordinary users cannot access demo fault/reset tools.
### Complete journeys
- **RS-31** Request → review → plan → reservation → PayPal approvals → supplier confirmations → capture → readiness → collection.
- **RS-32** B becomes unavailable; the buyer reviews and approves the new $95 plan and completes the replacement flow.
- **RS-33** An infeasible request ends with an explanation and no purchase.

## Non-functional requirements
- **RS-NF-1** Clean-checkout setup works from the README with Node ≥ 22.5 and no network beyond npm (zero runtime dependencies).
- **RS-NF-2** Desktop and mobile layouts, keyboard navigation, visible focus, accessible labels, text-based status indicators; loading, empty, error, retry, timeout and expired-reservation states.
- **RS-NF-3** Real-model extraction suite and real PayPal Sandbox suite are separate from the deterministic suite and labelled.
- **RS-NF-4** Secrets only via environment variables; `.env.example` has names and placeholders only.

## Assumptions (stated, reversible)
- A1. RescueStock lives at `examples/rescuestock/` in the ECCode repository (MIT), following the Groundwork/TriageDesk convention, until the user names a dedicated repository. The hackathon requires a public repository with an open-source licence; this repository satisfies that if kept public.
- A2. Multi-merchant routing uses one Sandbox REST app (client id/secret) per demonstration supplier business account ("credential-per-merchant"), so each supplier order is created by, and paid to, that supplier's own account. No partner/marketplace permissions are assumed. If only one Sandbox business account is supplied, every demonstration supplier maps to it and the UI says so.
- A3. Buyer approval uses PayPal's hosted approval link (the order's `payer-action`/`approve` link with `return_url`/`cancel_url`), so no client id reaches the browser.
- A4. The real model is reached through the Claude Code CLI (`claude -p --json-schema`, available in this environment and billed to the user's account) or the Anthropic API when `ANTHROPIC_API_KEY` is set. Tests use a deterministic double labelled `fake`.
- A5. Image retention: uploads are stored under `data/uploads/` with random names, max 5 MB, PNG/JPEG/WebP only, deleted with the request or after 7 days by the admin reset; documented in the README.

## Hackathon facts (checked 2026-10-09 through web search; the Devpost pages themselves are blocked from this environment, so these are **unverified against the primary source** and must be re-checked by the user before submission)
- Event: PayPal AI Hackathon, https://paypalaihackathon.devpost.com/ (rules: `/rules`).
- Submission period reported: 1 Oct 2026 09:15 PT → **12 Nov 2026 12:00 PT** (one secondary source says 14:00 PT; use the official page).
- Requirements reported: integrate the PayPal developer platform using the free **sandbox** plus an AI tool/model; public open-source repository with run instructions; working demo; demo video under 3 minutes (secondary sources say YouTube); text description.
- Judging reported: technical implementation, design, potential impact, innovation, presentation.
