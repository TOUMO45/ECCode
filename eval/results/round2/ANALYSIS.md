# Round 2: toolkit v2 on new, mid-sized tasks

Protocol: `eval/suite/round2-protocol.md` (committed before the first trial). Official numbers: `report.md` and `summary.json` in this folder. Two sensitivity analyses (not official) sit in `sensitivity-*`. Toolkit v2 = commit `57f186fa`; baseline = the same original-ECC export as round 1. No trial was disturbed by a usage limit (`quarantine-invalid.js --dry-run` found none), so none was set aside or re-run.

## Official verdict (targets unchanged from `eval/suite/targets.json`)

| Target | Result | |
|---|---|---|
| L1 learning raises org-rule compliance (≥ +40 pp, REL) | C2 100 % (48/48) vs C1 12.5 % (6/48) | **met** |
| L2 learning halves repeated mistakes | C2 0 vs C1 12 | **met** |
| L3 learning raises success on related tasks (≥ +25 pp) | C2 41.7 % vs C1 0 % | **met** |
| L4 no harm on decoys | 6/6 vs 6/6 | **met** |
| L5 learning overhead ≤ 1.5× | $1.29 vs $1.05 | **met** |
| E1 enhanced ECC with learning beats original ECC by ≥ 20 pp | **61.1 % vs 61.1 %** | **NOT met** |
| E2 no more regressions than original ECC | 0 vs 1 | met |
| E3 no more human intervention than original ECC | **1 vs 0** | **NOT met** |
| E4 cost per success ≤ 3× original ECC | $1.90 vs $0.66 (2.9×) | met (narrowly) |

**R7 is not met: E1 and E3 failed in round 2, and E1 and E4 failed in round 1.** The comparison with the original ECC does not support the claim that enhanced ECC with learning beats it on task success in this suite.

## What round 2 shows

1. **v2 fixed the learning defect found in round 1.** Round 1: C2 failed 3 related trials by setting an applicable rule aside (25/30 org checks, 3 repeated mistakes). Round 2: C2 passed all 48 org-rule checks and made no repeated mistake, while C1 (same toolkit, learning off) passed 6/48. The plan now carries the rule as an acceptance criterion and the implementer is bound to it. Caveat: the original ECC with its own `/learn` route also passed 48/48.
2. **Per-trial results of C0 and C2 are close.** 11/18 each. Both lost the same two tasks (M1, M2, 0/3 each) on discoverable checks and tied on M3 (2/3) and M4 (3/3 each) and on both decoys (3/3). The 95 % intervals (38.6–79.7 %) overlap almost entirely: with 6 tasks × 3 repeats this suite cannot separate them.
3. **Orchestration alone (C1) did not help** (claim O1: no; O2: no, 2 regression trials vs 1). Without learning it fails the organisational rules it was never told.
4. **Cost.** ECCode costs $1.16 per trial against $0.40 (2.9×), 7× the wall time. Overhead is mostly fixed (four independent sessions), so the ratio fell from 4.6× (round 1, $0.28 tasks) to 2.9× on tasks that cost the baseline $0.40–0.66 per success.
5. **E3 is a real escalation, not a harness artefact.** In one successful trial (M4, r3) the orchestrator ended with "the missing security review record needs your decision to reopen the gate". The hidden grader passed, but the run ended asking the user, which the predeclared definition counts.

## Validity problems in the sealed tasks (found after the run)

Two hidden checks that every condition failed in every repeat were read after the run:
- **M2 AC3** compares the `proration` object with `deepStrictEqual` against five fields, while the task text says the object has "the same fields as the quote" (eight fields, including `effectiveOn`, `planCode` and `seats`). An implementation that follows the text fails the check. It is a grader defect.
- **M1 AC7** expects a `status: "returned"` field in the return response. The task says the response is "the loan, with its fine and the number of overdue days"; `status` is only mentioned for the history listing. Ambiguous rather than wrong.

Official numbers keep both checks: the protocol said no trial would be excluded, and the checks cannot be edited after the run without breaking the frozen hashes. Mechanical sensitivity analyses (dropping the check from the success definition, nothing re-run):

| | M2 AC3 dropped | M2 AC3 and M1 AC7 dropped |
|---|---|---|
| C0 success | 66.7 % | 83.3 % |
| C2 success | 77.8 % | 94.4 % |
| E1 (≥ +20 pp) | not met (+11 pp) | not met (+11 pp) |
| E3 | not met | not met |
| E4 | met (2.4×) | met (2.5×) |

So the verdict on E1, E3 and E4 does not depend on the two defective checks. The task author's own validation did not catch them (it checks that the reference solution passes, which it does).

## Limits of this evidence
- One model (`claude-sonnet-5-5`), 6 tasks per round, 3 repeats, tasks written by an agent. Intervals are wide.
- C0 never dispatched a subagent: the original ECC's `/ecc:orch-*` commands ran as a single session in this headless setup. "Original ECC" here means Claude Code with ECC's skills, commands and its own learning route, not a full multi-agent run.
- The "intervention" metric is a text heuristic plus budget and timeout; it produced one true positive here.
- Round 2 was designed after round 1's results (larger tasks, v2 toolkit). It is a second test, not an independent replication of round 1.
- The learning evidence (`docs/evidence/learning-round2`) is for organisational rules; debugging-lesson reuse and rejection are shown separately in `docs/evidence/debug-lesson/` if that demo has been run.

## What this means for the claim "enhanced ECC beats original ECC"
Supported: with learning on, ECCode keeps and applies verified organisational lessons (L1–L5, in both rounds), halves-to-eliminates repeated mistakes, and has fewer regression trials than the baseline in round 2.
Not supported: higher task success than original ECC with its own learning route, equal or lower human intervention, and (in round 1) bounded cost. Orchestration alone adds no measured quality. What ECCode adds beyond ECC in this evidence is enforcement and auditability (gates, independent review records, resumability), which the predeclared targets do not score.
