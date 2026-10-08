# A debugging lesson: learned, reused, and rejected where the cause differs (requirement R6)

Produced by `eval/learning-demo/debug-lesson.js`, with real headless Claude Code sessions in the evaluation sandbox (toolkit v2.1, see below). It is **not** part of the R7 evaluation.

| Step | Session | Outcome |
|---|---|---|
| **Learn** | `/eccode:investigate` on a work-order service whose cached authorization decisions use an incomplete memo key (the naive solution of an evaluation task) | a lesson was recorded with a reproduction that **fails** and the same check **passing** after the fix, failed attempts, applicability limits (`shared-records.json`); an **independent** `technical-reviewer` re-ran the checks and verified it (review notes in the record); it was promoted to shared memory. This run's learn step: `run1-first-learning-and-h5/log.json`. |
| **Reuse** (fresh session, different service, same kind of defect: a quote cache keyed on the SKU only) | `/eccode:change` | the lesson was offered at the plan and **incorporated** as an acceptance criterion, then **applied** with a test; the hidden grader passed (4/4) |
| **Reject** (fresh session, stale and corrupted cached menu costs whose causes are missing invalidation and in-place mutation, not keys) | `/eccode:change` | the lesson was offered at the plan and set aside there and again at the claim, each time **naming the "not applicable when" condition that holds** ("a stale value after the underlying data changed ... rather than a key collision"; "costs and menuReport are keyed by their single argument"); the real causes were fixed; the hidden grader passed |

`evidence.json` lists, per fresh session, the lessons offered, the plan decisions, the completion decisions and the grader result. The reviewers' `lessons` criterion approving those decisions is in each trial's record (not copied here).

## What did not go as planned (kept on record)
- **First attempt, toolkit v2:** `/eccode:investigate` in a directory with no ECCode project fixed the bug and recorded no lesson ("No ECCode project"). That was a gap in the command, fixed by the commit "investigate: start a change-mode project when none exists" (toolkit **v2.1**, a post-evaluation change; the R7 results used v2).
- **Second attempt with the evaluation's own decoy H5 (`run1-first-learning-and-h5/`):** the lesson was *applied*, not rejected, and the hidden grader passed. On reading the task's reference solution, H5 itself contains a key-normalisation fix (route params are strings, row ids numbers), so the lesson legitimately applies and H5 is not a clean decoy for this lesson. The clean decoy is the round-2 task M6, used above.
- The rejection is by a **written reason naming the condition**, not by an experiment-backed `memory assess`. The engine accepts either; the independent reviewer is the check on whether the reason is true.
