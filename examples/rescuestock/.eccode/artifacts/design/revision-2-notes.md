# Design revision 2: finding → section map

Responds to review `rev-mv1cta5m-0114480d` (submission `sub-mv1c60sc-01174690`) and to `.eccode/reviews/drafts/design-security-1.md`. Sections refer to `.eccode/artifacts/design/spec.md`. The full disposition, with reasons, is in the spec's "Findings disposition (revision 2)" section.

## Majors
| Finding | Resolved in |
|---|---|
| F-TR-1 (= SEC-4) | Interface Contracts › Conventions › Idempotency; Background › Reservation step 1; 003_planning.sql `reservations` (`idempotency_key`, UNIQUE (customer_id, idempotency_key), `operation_key = res:<customerId>:<planVersionId>:<key>`); 004_payments.sql `idempotency_keys` (scope (user, key) + fingerprint); Traceability RS-16 |
| F-TR-2 | Background › Rescue status derivation (revision 2): rows 4a and 14, re-plan queue semantics, property test; 003_planning.sql `replan_queue`; Supersession › Replan; Testing Strategy › Unit |
| F-TR-3 | Background › Provider call protocol §7 Sender table; Return handler step 5; Void rule step 3; Derivation row 2 (a); Reconciler step 6; Recovery; Testing › `return-crash` |
| F-TR-4 | Deployment › Node floor (flag-free `scripts/check-node.cjs` gate); Testing Strategy › Commands; Testing › `start-old-node`; Components (`scripts/check-node.cjs`) |
| SEC-1 | Interface Contracts › Authentication › Throttle; Security › Rate limiting; Threat T8 |
| SEC-2 | Conventions › Limits; Reservation step 3; Customer routes (`POST /api/requests`, reserve); Error catalog `RESERVATION_LIMIT`; Threat T8b; 002/003 DDL; Deployment env vars |
| SEC-3 | Conventions › Labels (test mode); Security › Allow-listed outbound hosts; Threat T18; PayPal wire mapping (approval host); Frontend › Labels; Traceability RS-34; Deployment env `RS_TEST_OFFLINE` |

## Minors and info
| Finding | Resolved in |
|---|---|
| F-TR-5 | Derivation rows 5a, 7–9; Open Questions OQ-D2 |
| F-TR-6 | Void rule step 6; Admin routes › test-only faults (`capture_lands_after_void_intent`) |
| F-TR-7 | Payment saga step 3; Reconciler steps 2 and 5; Traceability RS-22 |
| F-TR-8 | Testing Strategy › Integration `rs20-two-process-execute` |
| F-TR-9 | Traceability rows RS-03 and RS-36 |
| F-TR-10 | AI › Runtime controls step 1 |
| F-TR-11 | Shared response objects `Order.presentation`; Supplier routes `SupplierOrder`; Frontend section 7 |
| F-TR-12 | 002_requests.sql `model_spend` (micro-dollars), `extractions.cost_micro_usd`; AI › Runtime controls |
| F-TR-13 | AI › Evaluation plan (`schemaAccepted`) |
| SEC-5 | Authentication › Provisioning; Security › Secrets (placeholder refusal); Deployment env vars and README |
| SEC-6 | Webhooks (rate limit, pre-checks, scoping); Retention › Other data; Threat T13 |
| SEC-7 | AI › wire schema (`questions` enum), local validation, normalisation (image wording); Shared objects `Question`, `FieldValue`; Evaluation plan metric |
| SEC-8 | Customer routes › confirm; AI › Untrusted-input isolation |
| SEC-9 | Authentication › Throttle (key normalisation) |
| SEC-10 | AI › Runtime controls step 2–3 (concurrency 1 per customer, share setting default off); Open Questions OQ-D7. **Partly deferred** to the plan and the user (Q10). |
| SEC-11 | Admin routes › Forced reset; audit for faults/refund_order |
| SEC-12 | Interface Contracts › Fake approval listener |
| SEC-13 | Conventions › Host check; Error catalog 421; Security › Host and CORS |
| SEC-14 | Retention and deletion › File modes; README |
| SEC-15 | Threat T25 (8 MiB, same as the CLI adapter) |
| SEC-16 | Webhooks flow step 3 |
| SEC-17 | AI › Opt-in rephrasing; Threat T10 (DB-fixture planting) |
| SEC-18 | Risks › residual risks (layers 4–5 stay verify; evidence-table wording) |
| SEC-19 | Security › Allow-listed outbound hosts; Deployment env vars |
| SEC-20 | Authentication (register rotation); Conventions › CORS |

## New evidence (technical-designer, design gate)
| Evidence | What it shows |
|---|---|
| ev:ev-mv1cxbbt-01ff7b59 | F-TR-4: the flag-free gate before flagged `node` names the floor on Node 20.20 / 21.7 for both Q9 branches; on 22.22 the app starts |
| ev:ev-mv1d13ib-01f6f742 | F-TR-2/3/5: the revised derivation passes the reviewer's S09–S20 scenarios; a 20,000-walk model never reaches row 14 (the walk found and fixed one more gap, an `unknown` admin refund, now in row 3) |
| ev:ev-mv1d1u17-01b84ac4 | F-TR-1, SEC-1, SEC-2, SEC-9: the revised rules block the reviewers' attack paths H1, H2 and H6 in node:sqlite |
| ev:ev-mv1dbzry-01cf8ba0 | security reviewer's structural spec walk, re-run: PASS |
| ev:ev-mv1dbzmk-013f9d68 | security reviewer's probes H1–H15, re-run: 0 confirmed (text-level) |
| ev:ev-mv1dc6eq-01ea78b5 | technical reviewer's traceability check on the final spec: 45 ids, 0 problems, 0 tag warnings |

Probe scripts: `.eccode/drafts/design-r2-node-gate.mjs`, `.eccode/drafts/design-r2-derive-walk.mjs`, `.eccode/drafts/design-r2-sec-model.mjs`.
