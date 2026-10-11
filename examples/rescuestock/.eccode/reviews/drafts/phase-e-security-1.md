# phase:e-payments: security review, iteration 1 (IN PROGRESS)

Reviewer: security-reviewer, run run-mv3vuj08-018c990d. Gate: `phase:e-payments`. Submission: `sub-mv3vs3h1-0181fd20`.
The technical-reviewer records the gate; this draft is input to its decision.

Status: IN PROGRESS (not final; do not fold yet).

Progress (working notes, superseded by the final text):
- ev:ev-mv3w0yzr-01677589 e3 plan command verbatim: 96/96.
- ev:ev-mv3w48uy-0190adfa probe W-ORDER: a late validly signed PAYMENT.AUTHORIZATION.CREATED moves capture_pending -> authorized (plan then compensated, buyer charged and refunded) and unknown(prev authorized) -> authorized (capture re-sent without a read after a failed read). Candidate finding SEC-E-1.
- ev:ev-mv3w6n02-01e20cac probe W-SEC: webhook battery all met (headers, splicing, merchant scope, per-IP limit, body cap, cert URL, unmapped, payer data).
- ev:ev-mv3wasl0-0199c6ae probe P-AUTHZ: RS-27/RBAC/CSRF scope/RS-19 all met.
- ev:ev-mv3wcx8e-0176eb51 probe P-RACE: concurrency invariants all met.
- ev:ev-mv3weypr-01b9ee01 probe P-HOSTS: listener, host pinning, live refusal all met.
