# phase:f-compensation: security review, iteration 1 (DRAFT, in progress)

Reviewer: security-reviewer, run run-mv44kln2-0180671d. Gate: `phase:f-compensation`. Submission: `sub-mv44juz3-01ac72c7`
(handoffs f1 ho-mv40suhb-012306c3, f2 ho-mv41a3s6-0138e24d, f3 ho-mv403lay-01fa3938 + ho-mv42ei0w-019037ae,
f4 ho-mv43p246-01228012). The technical-reviewer records the gate (every `review.recorded` event so far is by
technical-reviewer); this draft is input to its decision.

Status: IN PROGRESS. Verdict pending.

## Scope and threat model

Attack surface touched by phase F:
- `POST /api/admin/reset` (forced reset, SEC-11) and `POST /api/admin/faults` (`refund_order`, `supplier_refusal`,
  `stock_depletion`) - admin policy.
- `POST /api/supplier/orders/:id/refuse` - supplier policy, reason text shown to the buyer.
- The saga, the reconciler takeover, the compensation and the refund/void call protocol (`saga.js`, `reconciler.js`,
  `calls.js`).
- The recovery UI (`public/js/**`): refusal reason, compensation section, stranded list, fault result text.

Probes live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-f/`.

## Findings

(in progress)

## Evidence

(in progress)
