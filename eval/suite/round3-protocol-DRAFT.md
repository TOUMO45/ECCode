# Round 3 protocol (DRAFT, not registered, nothing has run)

**Status.** A proposal for the user to authorise. It is not pre-registered until it is committed without the DRAFT marker, with its targets frozen, before any trial. Requirement 7 failed on the targets in `eval/suite/targets.json` in both rounds; a new round cannot change that verdict and this draft does not try to. It proposes a **different, honestly stated claim** for a new comparison, so that the next decision is yours and informed. This revision folds in the seven recommendations of the independent review (`docs/evidence/review-bundle/ECCode-independent-review.md`, "Evaluation: what it establishes and what it does not").

## Why a third round cannot rescue the old claim
- E1 ("ECCode with learning beats original ECC by ≥ 20 pp on success") lost 83 % vs 100 % and tied 61 % vs 61 %. Pooling rounds 2 and 3 (same toolkit v2.1, same conditions) is the only legitimate use of a third round on that claim, and under pooling E3 is already unmeetable (one escalation against none) and E1 would need a round-3 gap of about 40 points. Picking round 3 alone would be selecting the round that passes.
- The review adds the structural point: a 20-point advantage cannot be met when the baseline already exceeds 80 %. The target failed as written; a new target is a new evaluation and does not pass the old one retroactively.
- The evidence says where ECCode loses: cost (fixed overhead of independent sessions) and one escalation; and where it wins: organisational-rule compliance 100 % vs 12.5 % with learning off, zero repeated mistakes, fewer regression trials. The old targets score the first and ignore the second.

## The claim this round would test (to be fixed before any trial)
"On unfamiliar mid-sized service tasks across representative categories, **ECCode with verified learning matches the original ECC on task success within 10 points, at no more than 2.5× the cost per accepted task, with no unnecessary human escalation, with fewer escaped defects, while producing an audit record that the original ECC does not** (independent review of every phase, evidence-backed approvals, resumability)."

Proposed targets (numbers to be frozen at registration; these are the draft values):

| id | what | metric | set | rule |
|---|---|---|---|---|
| P1 | parity on success | success rate | ALL | C2 ≥ C0 − 0.10, on paired task-level results with a 90 % interval reported |
| P2 | bounded cost | cost per accepted task | ALL | C2 ≤ 2.5 × C0 |
| P3 | no unnecessary escalation | unnecessary interventions (an ask the orchestrator could have dispatched itself) | ALL | C2 = 0; legitimate escalations (`USER_AUTH_REQUIRED` actions, scope questions) are counted separately and reported, never rewarded or penalised |
| P4 | no more regressions | regressions | ALL | C2 ≤ C0 |
| P5 | fewer escaped defects | defects found by the hidden checks after the run reported done | ALL | C2 < C0 |
| P6 | review precision | share of reviewer findings that the hidden checks or the final patch confirm | C2 only | ≥ 0.7 (reported for C3) |
| L1–L5 | unchanged from `targets.json` | | | unchanged |
| A1 | audit record present | every C2 trial's record passes `eccode audit`, has an independent approval per phase with the required criteria covered, and resumes from the record in a fresh session (sampled: 5 trials) | ALL | 100 % |

Also measured and reported, not targeted: rework count, recovery success after an injected interruption (one trial per task), latency (wall time), cost per trial.

P3 is deliberately strict: the round-2 escalation was the orchestrator asking the user to reopen a gate for a missing security review it could have dispatched; the orchestrate skill now says so (§7). Under the 0.3.0 engine an orchestrator cannot act as the user at all, so a run that needs a user-reserved action records a legitimate escalation and stops; the task is then scored as not completed, and the escalation is reported as legitimate.

## What would change versus round 2 (the review's recommendations, applied)
1. **Frozen before any trial:** toolkit version (a tagged release, not a branch head), supported host and model versions, protocol, metrics, limits, grading rules. The failed historical results stay published.
2. **Representative categories**, at least four tasks each: UI/accessibility, API/authentication, database migration, multi-service integration, AI evaluation, an unfamiliar bug, interrupted work (a resume after an injected kill), malicious or stale inputs (a prompt-injected ticket, an outdated dependency note).
3. **Sample size:** 32 distinct tasks in the pilot (four per category), 2 repeats per task per condition per model in the pilot; the final sample size is chosen from the pilot's task-level variance with a precision target of ±10 points on P1 at 90 % confidence (the calculation is committed before the main run). Analysis is paired at the task level; intervals are reported for every target. More repeats of six tasks do not create coverage, so the round-2 task set is not reused except as a sanity check.
4. **Grader validity:** every hidden assertion is checked by an independent evaluator agent against the task text, with at least two reference implementations per task (the round-2 defects M2 AC3 and M1 AC7 came from a single reference). Invalid graders and infrastructure failures are handled as declared here: a task whose grader fails validation is dropped before the run, never after; trials lost to infrastructure are re-run once, and a second loss is reported as missing, not excluded silently.
5. **Conditions:** C0 original ECC in its supported operation (its own `/learn` route, same export bytes as rounds 1–2); C2 ECCode adaptive (change mode by default, risk-based routing per the orchestrate skill §1); C3 ECCode strict (full delivery profile); C1 ECCode learning off, as the matched memory-disabled comparison for every learning claim. Dispatch behaviour is verified from the records (which agents actually ran), and budgets are comparable per trial.
6. **Metrics:** escaped defects, review precision, rework, recovery success, legitimate versus unnecessary escalations, cost per accepted task, latency (the table above). Bypassing human authorization is never rewarded: a run that forges a user action is a failed trial.
7. **Replay bundle:** per-trial results, final patches, check logs, version manifests, usage and intervention records are preserved in a sanitised bundle under `eval/results/round3/` so the whole experiment can be recomputed by someone else; summaries alone are not evidence.

Validity rule, declared now: no trial excluded after the run; usage-limit disturbances handled by `quarantine-invalid.js` as in round 1, declared here before the run rather than after.

## Cost and time (estimate, not a cap)
Pilot: 32 tasks × 2 repeats × 4 conditions × 2 models = 512 trials at $0.40–$2 per trial: roughly $200–1,000 and 2–4 days of wall time, plus task authoring and grader validation (agent time, about a day). The main run follows from the pilot's sample-size calculation and is costed before it starts. The user sets the cap (`--budget-usd`) before registration; the pilot alone needs a separate cap.

## What authorisation looks like
Reply with: the pilot cap in dollars, the second model, and "register round 3 pilot". The orchestrator then removes the DRAFT marker, freezes the task set and graders (`freeze.js --split holdout3`), commits, and only then runs `holdout.js`. Any change after that commit is a new protocol. The main run needs a second authorisation with its own cap once the pilot's sample-size calculation is committed.
