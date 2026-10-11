# phase:e-payments: security review, iteration 1 (IN PROGRESS)

Reviewer: security-reviewer, run run-mv3vuj08-018c990d. Gate: `phase:e-payments`. Submission: `sub-mv3vs3h1-0181fd20`.
The technical-reviewer records the gate; this draft is input to its decision.

Status: IN PROGRESS (not final; do not fold yet).

Progress (working notes, superseded by the final text):
- ev:ev-mv3w0yzr-01677589 e3 plan command verbatim: 96/96.
- ev:ev-mv3w48uy-0190adfa probe W-ORDER: a late validly signed PAYMENT.AUTHORIZATION.CREATED moves capture_pending -> authorized (plan then compensated, buyer charged and refunded) and unknown(prev authorized) -> authorized (capture re-sent without a read after a failed read). Candidate finding SEC-E-1.
