# Round 3 protocol (DRAFT, not registered, nothing has run)

**Status.** This is a proposal for the user to authorise. It is not pre-registered until it is committed without the DRAFT marker, with its targets, before any trial. Requirement 7 failed on the targets in `eval/suite/targets.json` in both rounds; a new round cannot change that verdict and this draft does not try to. It proposes a **different, honestly stated claim** for a new comparison, so that the next decision is yours and informed.

## Why a third round cannot rescue the old claim
- E1 ("ECCode with learning beats original ECC by ≥ 20 pp on success") lost 83 % vs 100 % and tied 61 % vs 61 %. Pooling rounds 2 and 3 (same toolkit v2.1, same conditions) is the only legitimate use of a third round on that claim, and under pooling E3 is already unmeetable (one escalation against none) and E1 would need a round-3 gap of about 40 points. Picking round 3 alone would be selecting the round that passes.
- The evidence says where ECCode loses: cost (fixed overhead of independent sessions) and one escalation; and where it wins: organisational-rule compliance 100 % vs 12.5 % with learning off, zero repeated mistakes, fewer regression trials. The old targets score the first and ignore the second.

## The claim this round would test (to be fixed before any trial)
"On unfamiliar mid-sized service tasks, **ECCode with verified learning matches the original ECC on task success within 10 points, at no more than 2.5× the cost per success, with no human escalation, while producing an audit record that the original ECC does not** (independent review of every phase, evidence-backed approvals, resumability)."

Proposed targets (numbers to be frozen at registration; these are the draft values):

| id | what | metric | set | rule |
|---|---|---|---|---|
| P1 | parity on success | success rate | ALL | C2 ≥ C0 − 0.10 |
| P2 | bounded cost | costPerSuccess | ALL | C2 ≤ 2.5 × C0 |
| P3 | no escalation | interventions | ALL | C2 = 0 |
| P4 | no more regressions | regressions | ALL | C2 ≤ C0 |
| L1–L5 | unchanged from `targets.json` | | | unchanged |
| A1 | audit record present | every C2 trial's record passes `eccode audit`, has an independent approval per phase, and resumes from the record in a fresh session (sampled: 3 trials) | ALL | 100 % |

P3 is deliberately strict: the round-2 escalation was the orchestrator asking the user to reopen a gate for a missing security review it could have dispatched; the orchestrate skill now says so (§7), and this round measures whether that holds.

## What would change versus round 2
- **Tasks:** 8 new mid-sized tasks by an independent author agent, sealed before registration, each hidden check validated by a second agent against the task text (the round-2 defects M2 AC3 and M1 AC7 came from missing this step). Repeats: 4 per task per condition (96 trials).
- **Models:** two (`claude-sonnet-5-5` and one other), reported separately; a target is met only if met on both.
- **Conditions:** C0 original ECC (same export bytes as rounds 1–2), C1 ECCode learning off, C2 ECCode learning on; the same prior experience snapshots.
- **Change mode by default for C1/C2** (the adaptive-path rule in the orchestrate skill), since the tasks are bounded changes; this is where the cost ratio is expected to move.
- **Validity rule, declared now:** no trial excluded after the run; usage-limit disturbances handled by `quarantine-invalid.js` as in round 1, declared here before the run rather than after.

## Cost and time (estimate, not a cap)
About 96 trials × 3 conditions × 2 models at $0.40–$2 per trial: roughly $300–600 and 8–14 hours of wall time, plus task authoring. The user sets the cap (`--budget-usd`) before registration.

## What authorisation looks like
Reply with: the cap in dollars, the second model, and "register round 3". The orchestrator then removes the DRAFT marker, freezes the task set (`freeze.js --split holdout3`), commits, and only then runs `holdout.js`. Any change after that commit is a new protocol.
