# Paired grid completion: 2026-10-22, claude-sonnet, remaining two tasks, n=3

With this run the grid is complete: **two models × all five tasks** (98 runs
total across the four recorded suites). Sonnet findings on the two remaining
tasks, honestly read:

- **Hidden checks: 24/24 passed in both variants** (grid total now 160/160
  across every run, task, model and variant).
- **The test-discipline effect repeats and strengthens:** bare Sonnet shipped
  a test in 0 of 3 csv-sum runs; with the skill, 3 of 3 — its +5 median lines
  ARE the tests. Combined over all 30 Sonnet runs: 15/15 with the skill wrote
  or changed a test vs 10/15 bare. Over both models: 40/40 vs 33/40.
- fix-last-page trended smaller with the skill (−7, p=0.100 at n=3); csv-sum
  larger because of the added tests (+5, p=0.100). Neither significant alone
  at n=3; the per-model pattern is.
- Dependencies: 0/12 runs added one (0/98 across the whole grid).

Grid summary: the discipline's measurable effect lands wherever the model's
default has a gap — diff bloat on haiku (three tasks individually significant
at exact p ≤ 0.016), skipped tests on sonnet (10/15 → 15/15) — while hidden
correctness stays at 100% in both variants. These are two models and five
small tasks; the reports compute their own exact statistics and say exactly
what they can and cannot support.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| csv-sum | without | 3 | 6/6 | 17 | 0/3 | 0/3 | 16 |
| csv-sum | with | 3 | 6/6 | 22 | 0/3 | 3/3 | 20 |
| csv-sum | **paired Δ** |  |  | +5 (exact permutation p=0.100 over 20 splits) |  |  |  |
| fix-last-page | without | 3 | 6/6 | 15 | 0/3 | 3/3 | 30 |
| fix-last-page | with | 3 | 6/6 | 8 | 0/3 | 3/3 | 23 |
| fix-last-page | **paired Δ** |  |  | -7 (exact permutation p=0.100 over 20 splits) |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 1, the larger on 1, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| csv-sum | without | 2/2 | +16/−0 | — | 0 | 16 | 0 |
| csv-sum | without | 2/2 | +17/−0 | — | 0 | 23 | 0 |
| csv-sum | without | 2/2 | +17/−0 | — | 0 | 15 | 0 |
| csv-sum | with | 2/2 | +21/−1 | — | 1 | 23 | 0 |
| csv-sum | with | 2/2 | +23/−1 | — | 1 | 20 | 0 |
| csv-sum | with | 2/2 | +22/−1 | — | 1 | 20 | 0 |
| fix-last-page | without | 2/2 | +17/−4 | — | 1 | 30 | 0 |
| fix-last-page | without | 2/2 | +15/−4 | — | 1 | 27 | 0 |
| fix-last-page | without | 2/2 | +14/−4 | — | 1 | 31 | 0 |
| fix-last-page | with | 2/2 | +8/−4 | — | 1 | 19 | 0 |
| fix-last-page | with | 2/2 | +8/−4 | — | 1 | 26 | 0 |
| fix-last-page | with | 2/2 | +10/−4 | — | 1 | 23 | 0 |
