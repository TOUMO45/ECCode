# Benchmark run — 2026-10-23, claude -p (haiku), replication at n=10 per variant

> **Follow-up.** The non-significant result below was followed by one pre-registered n=25 replication of both tasks, which was decisive (relative-time −11 median lines, p = 6.0e-5; slugify-reuse −4, p = 1.0e-5): [2026-10-23-haiku-n25-preregistered.md](2026-10-23-haiku-n25-preregistered.md).

A replication of the two strongest n=5 effects (`relative-time`,
`slugify-reuse`, both p=0.0079 on 2026-10-22) at double the sample size:
n=10 per variant per task, 40 fresh agent runs, exact permutation test over
all 184,756 splits.

**Direction replicates; magnitude does not.** The with-variant median diff is
again smaller on both tasks (−4.5 and −2 lines), but today's deltas are not
significant (p=0.185 and p=0.138): this batch's unskilled baseline behaved
better than yesterday's — it wrote tests in 10/10 runs on both tasks — so
there was less for the skill to correct. Model behavior drifts between
batches, and a result that was significant in one sample and is not in its
larger replication gets reported exactly that way.

**What holds across every recorded batch** (recomputed by `eccode bench
tally`, nothing excluded): 162 runs, 324/324 hidden checks passed, 0
dependency additions, 0 agent failures — and per task-batch paired medians,
the with-variant diff was smaller in 13, larger in 3, equal in 2. A two-sided
sign test on 13-vs-3 gives p ≈ 0.021 across all 18 recorded task-batches,
nulls and reversals included. The stable, replicated effect of the skill is
discipline (tests present, no dependency creep, helpers reused) with a small,
batch-dependent reduction in diff size; the stable property of the harness is
that it measures the same way whichever direction the result points.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| relative-time | without | 10 | 20/20 | 39.5 | 0/10 | 10/10 | 23 |
| relative-time | with | 10 | 20/20 | 35 | 0/10 | 10/10 | 25 |
| relative-time | **paired Δ** |  |  | -4.5 (exact permutation p=0.185 over 184756 splits) |  |  |  |
| slugify-reuse | without | 10 | 20/20 | 14 | 0/10 | 10/10 | 18 |
| slugify-reuse | with | 10 | 20/20 | 12 | 0/10 | 10/10 | 22 |
| slugify-reuse | **paired Δ** |  |  | -2 (exact permutation p=0.138 over 184756 splits) |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 2, the larger on 0, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| relative-time | without | 2/2 | +35/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +38/−2 | — | 1 | 20 | 0 |
| relative-time | without | 2/2 | +39/−2 | — | 1 | 20 | 0 |
| relative-time | without | 2/2 | +43/−2 | — | 1 | 22 | 0 |
| relative-time | without | 2/2 | +40/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +52/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +62/−2 | — | 1 | 27 | 0 |
| relative-time | without | 2/2 | +50/−2 | — | 1 | 35 | 0 |
| relative-time | without | 2/2 | +36/−2 | — | 1 | 21 | 0 |
| relative-time | without | 2/2 | +30/−2 | — | 1 | 24 | 0 |
| relative-time | with | 2/2 | +34/−2 | — | 1 | 24 | 0 |
| relative-time | with | 2/2 | +32/−2 | — | 1 | 24 | 0 |
| relative-time | with | 2/2 | +59/−2 | — | 1 | 28 | 0 |
| relative-time | with | 2/2 | +35/−2 | — | 1 | 27 | 0 |
| relative-time | with | 2/2 | +37/−2 | — | 1 | 24 | 0 |
| relative-time | with | 2/2 | +32/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +35/−2 | — | 1 | 23 | 0 |
| relative-time | with | 2/2 | +38/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +37/−2 | — | 1 | 30 | 0 |
| relative-time | with | 2/2 | +30/−2 | — | 1 | 22 | 0 |
| slugify-reuse | without | 2/2 | +11/−2 | — | 1 | 21 | 0 |
| slugify-reuse | without | 2/2 | +11/−2 | — | 1 | 21 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +22/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +15/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 15 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 19 | 0 |
| slugify-reuse | without | 2/2 | +22/−2 | — | 1 | 24 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 28 | 0 |
| slugify-reuse | with | 2/2 | +15/−2 | — | 1 | 24 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 21 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 22 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 26 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 18 | 0 |
| slugify-reuse | with | 2/2 | +14/−2 | — | 1 | 19 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 22 | 0 |
| slugify-reuse | with | 2/2 | +15/−2 | — | 1 | 22 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 25 | 0 |
