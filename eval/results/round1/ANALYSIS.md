# Round 1 of the official evaluation: what happened and what it means

Generated numbers are in `report.md` and `summary.json` (valid trials), `as-run-before-quarantine/` (the same report before 13 disturbed trials were re-run), and `invalid-holdout-trials.json` (the 13 quarantined trials with their original outcomes). Toolkit under test: ECCode at the commit in `eval/suite/frozen-toolkit.json` ("toolkit v1"). Baseline: original ECC at `ef648e01`.

## Verdict against the predeclared targets (`eval/suite/targets.json`)

| Target | Result | |
|---|---|---|
| L1 learning raises org-rule compliance (C2 − C1 ≥ 40 pp, REL) | 83.3 % vs 40 % | **met** |
| L2 learning halves repeated mistakes (REL) | 3 vs 9 | **met** |
| L3 learning raises success on related unfamiliar tasks (≥ 25 pp) | 75 % vs 25 % | **met** |
| L4 learning does no harm when a lesson must be rejected (DEC) | 6/6 vs 6/6 | **met** |
| L5 learning overhead bounded (≤ 1.5× cost) | $1.18 vs $0.99 | **met** |
| E1 enhanced ECC with learning beats original ECC (≥ +20 pp success, ALL) | 83.3 % vs **100 %** | **NOT met** |
| E2 no more regressions than original ECC | 0 vs 0 | met |
| E3 no more human intervention than original ECC | 0 vs 0 | met |
| E4 cost per success ≤ 3× original ECC | $1.30 vs $0.28 (**4.6×**) | **NOT met** |

**Not all mandatory targets were met, so requirement R7 failed in round 1.** The claim that orchestration alone helps (O1) does not hold either: discoverable-requirement pass rate is 100 % for C0 and C1.

## What the data say

1. **Learning works inside ECCode.** Without it (C1) the toolkit fails every org-rule check it was never told about (12/30 passed). With verified lessons promoted from training (C2) it passes 25/30, and the three decoy-style cases (a CSV for a non-accounting consumer, a stale-state bug with a different cause, a read-only endpoint) were all handled correctly: the lessons were offered and set aside with reasons that name the condition that does not hold.
2. **The original ECC with its own learning route is a very strong baseline on this suite.** C0 was given the same QA feedback in training and was told to use `/ecc:learn`. It saved three skills under `~/.claude/skills` and then solved all 18 holdout trials, in about one minute and $0.28 each, with no sub-agent dispatches at all. The targets E1/E4 were declared after two pilot trials, on the expectation that the baseline would not retain unwritten organisational rules and that ECCode's overhead would stay within 3×. Both expectations were wrong. This is a result, not an artefact of the harness: the baseline is not handicapped (same model, same limits, own HOME, own learning route, same feedback).
3. **ECCode costs 3.4× more per trial and takes 6.7× longer than the baseline** (`O3`): a plan author, a plan reviewer, an implementer and a phase reviewer, all independent, and several full CLI turns by the orchestrator. On tasks this small the extra process buys nothing measurable in task success. What it buys instead (an auditable, hash-chained record, enforced author ≠ approver, resumability) is not scored by the predeclared targets.
4. **ECCode's remaining failures are a real defect in how lessons are applied.** All three C2 failures on related tasks (H2 r3, H3 r1, H3 r2) have the same shape. The lesson was retrieved and shown; the implementer recorded `not-applicable` with a plausible reason that boils down to "the ticket does not mention this rule" (H3: "the acceptance criteria define the list as a bare array"; H2: "idempotency was ruled out of scope by the reviewer"), and the independent reviewer approved. Organisational rules exist precisely for what tickets leave unsaid. The engine accepted any written reason of 30 characters, and reviewers were never required to judge the decisions. Toolkit v2 addresses this (see below); it has not yet been evaluated on unseen tasks.

## Deviations from the protocol, disclosed

- **Usage limit.** At about 14:46 UTC the account's session usage limit was reached in the middle of the holdout. 13 of 54 trials had the message "You've hit your session limit" in their transcripts: 8 never ran at all (0 tool calls, $0), 5 were cut short or had a subagent affected. No rule for such trials was predeclared. I introduced one afterwards (`eval/harness/quarantine-invalid.js`): **every** holdout trial whose transcript contains the limit message is set aside, whatever its condition and outcome, and re-run from the same snapshot with the same repeat number. The originals are kept. The "as-run" report, before quarantine, is in `as-run-before-quarantine/` (C0 88.9 %, C1 33.3 %, C2 72.2 %; E1, E3, E4 not met; L1–L5 met). The target verdicts are the same set in both versions apart from E3, which was an artefact of a limit-affected trial.
- The 13 re-runs happened about 20 minutes after the originals, after the limit had reset. They used the same toolkit export, snapshots and parameters.
- Targets were declared after two pilot trials and ECCode was modified using pilot data; see the disclosures in `eval/suite/frozen-toolkit.json`.
- The maintainer (me) saw the holdout task names and validation summaries before the run, and read the failed trials' details **after** it, for the diagnosis above. The round-1 holdout is therefore spent: any change motivated by it must be evaluated on tasks written afterwards. That is round 2.

## What changed after round 1 (toolkit v2, `git log` from `57f186f`)

- A plan is refused until it answers for every verified lesson that matches its tasks (`lessonDecisions`); a lesson marked `incorporated` must appear in the task's inputs and acceptance criteria and then **binds** the implementer (setting it aside is refused at completion).
- Approving a plan or a phase that records lesson decisions requires a `lessons` criterion with evidence: reviewers must judge every decision.
- Claim-time cards state that a ticket's silence is not a reason to skip a rule.
- Change mode: the orchestrator reads only the request and dispatches in the foreground (fewer full-context turns).

Round 2 (`eval/results/round2/`) evaluates v2 against the same baseline on new, mid-sized tasks written by an independent author.
